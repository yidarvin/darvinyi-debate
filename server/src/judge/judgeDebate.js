// Judge module. Evaluates ONE LEG of a two-leg match and produces a structured
// verdict with per-axis scores + reasoning. Always uses Claude Opus 4.7 with
// NO tools (pure text evaluation).
//
// Anonymization: judge sees only AFFIRMATIVE/NEGATIVE labels within this leg —
// never agent names, ids, providers, or model strings. The judge does NOT know
// that leg-2-AFF is the same agent as leg-1-NEG. buildJudgePrompt enforces this;
// do not extend the prompt with identity or cross-leg references.
//
// Does NOT touch debate.status — the SSE wrapper transitions status to
// 'judging' before invoking, and to 'completed' after both legs are judged
// and ELO is applied.

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { buildJudgePrompt } from '../agents/systemPrompts.js';

const JUDGE_MODEL = 'claude-opus-4-7';
const JUDGE_MAX_TOKENS = 4096;
const MIN_REASONING_LENGTH = 200;
const ERROR_MESSAGE_MAX_LENGTH = 1000;

const VALID_WINNERS = new Set(['aff', 'neg', 'draw']);
const SCORE_AXES = ['argument', 'evidence', 'responsiveness', 'persuasion'];

/**
 * Evaluate a single leg of a debate.
 *
 * @param {object} params
 * @param {string} params.debateId
 * @param {1 | 2} params.leg
 * @param {(event: object) => void | Promise<void>} params.onEvent - judge_thinking, judge_text_delta, evaluation_complete
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{evaluation: object}>} the saved Evaluation row
 */
export async function judgeLeg({ debateId, leg, onEvent, signal }) {
  if (leg !== 1 && leg !== 2) {
    throw new Error(`judgeLeg: leg must be 1 or 2 (got ${leg})`);
  }

  const emit = async (event) => {
    try {
      await onEvent(event);
    } catch (err) {
      console.error('[judge] onEvent threw:', err);
    }
  };

  // Load debate + this leg's turns. Notably: NOT loading agentA/agentB. The
  // judge has no business knowing identities.
  const debate = await prisma.debate.findUnique({
    where: { id: debateId },
    include: {
      turns: {
        where: { leg },
        orderBy: { roundNumber: 'asc' },
      },
      evaluations: { where: { leg }, select: { id: true } },
    },
  });

  if (!debate) {
    throw new Error(`Debate not found: ${debateId}`);
  }
  if (debate.evaluations.length > 0) {
    throw new Error(`Debate ${debateId} leg ${leg} already has an evaluation; refusing to re-judge`);
  }
  if (debate.turns.length !== 6) {
    throw new Error(`Cannot judge leg ${leg}: expected 6 turns, got ${debate.turns.length}`);
  }
  for (let i = 0; i < 6; i++) {
    if (debate.turns[i].roundNumber !== i + 1) {
      throw new Error(`Leg ${leg} turn at index ${i} has roundNumber ${debate.turns[i].roundNumber}`);
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set; required by the judge module');
  }

  const judgePrompt = buildJudgePrompt({
    topic: debate.topic,
    turns: debate.turns.map((t) => ({
      roundNumber: t.roundNumber,
      roundName: t.roundName,
      side: t.side,
      content: t.content,
    })),
  });

  await emit({ type: 'judge_thinking', leg });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages = [{ role: 'user', content: judgePrompt }];

  let parsed = null;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    let fullResponse = '';

    const stream = client.messages.stream(
      {
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        messages,
      },
      { signal },
    );

    try {
      for await (const event of stream) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta'
        ) {
          const delta = event.delta.text;
          fullResponse += delta;
          if (attempt === 0) {
            await emit({ type: 'judge_text_delta', leg, text: delta });
          }
        }
      }

      await stream.finalMessage();
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) {
        await markFailed(debateId, `Judge aborted: ${err.message ?? ''}`.trim());
        throw err;
      }
      if (attempt === 0) {
        lastError = err;
        messages.push({ role: 'assistant', content: fullResponse || '(empty)' });
        messages.push({
          role: 'user',
          content:
            'Your previous response was interrupted or incomplete. Please retry. Reply with ONLY the JSON object matching the schema, with no surrounding text or markdown fences.',
        });
        continue;
      }
      await markFailed(debateId, `Judge stream failed: ${err.message ?? err}`);
      throw err;
    }

    const parseResult = tryParseJudgeOutput(fullResponse);

    if (parseResult.success) {
      parsed = parseResult.data;
      break;
    }

    lastError = new Error(parseResult.error);

    if (attempt === 0) {
      console.warn(`[judge] Leg ${leg} attempt 1 parse failed: ${parseResult.error}. Retrying.`);
      messages.push({ role: 'assistant', content: fullResponse });
      messages.push({
        role: 'user',
        content:
          'Your previous response could not be parsed as JSON. Please reply with ONLY the JSON object matching the schema below — no surrounding text, no markdown fences, no commentary.',
      });
      continue;
    }

    await markFailed(debateId, `Judge produced unparseable output for leg ${leg} after retry: ${parseResult.error}`);
    throw new Error(`Judge produced unparseable output after retry: ${parseResult.error}`);
  }

  if (!parsed) {
    await markFailed(debateId, `Judge: no parsed output (last error: ${lastError?.message})`);
    throw new Error(`Judge: no parsed output (last error: ${lastError?.message})`);
  }

  const clamped = clampScores(parsed);
  const affTotal = sumScores(clamped.aff_scores);
  const negTotal = sumScores(clamped.neg_scores);

  const saved = await prisma.evaluation.create({
    data: {
      debateId,
      leg,
      winner: clamped.winner,
      affArgument: clamped.aff_scores.argument,
      affEvidence: clamped.aff_scores.evidence,
      affResponsive: clamped.aff_scores.responsiveness,
      affPersuasion: clamped.aff_scores.persuasion,
      affTotal,
      negArgument: clamped.neg_scores.argument,
      negEvidence: clamped.neg_scores.evidence,
      negResponsive: clamped.neg_scores.responsiveness,
      negPersuasion: clamped.neg_scores.persuasion,
      negTotal,
      reasoning: clamped.reasoning,
      judgeModel: JUDGE_MODEL,
    },
  });

  await emit({
    type: 'evaluation_complete',
    leg,
    winner: clamped.winner,
    affScores: {
      argument: clamped.aff_scores.argument,
      evidence: clamped.aff_scores.evidence,
      responsive: clamped.aff_scores.responsiveness,
      persuasion: clamped.aff_scores.persuasion,
      total: affTotal,
    },
    negScores: {
      argument: clamped.neg_scores.argument,
      evidence: clamped.neg_scores.evidence,
      responsive: clamped.neg_scores.responsiveness,
      persuasion: clamped.neg_scores.persuasion,
      total: negTotal,
    },
    reasoning: clamped.reasoning,
    judgeModel: JUDGE_MODEL,
  });

  return { evaluation: saved };
}

// ============================================================================
// Output parsing + validation
// ============================================================================

function tryParseJudgeOutput(raw) {
  if (!raw || typeof raw !== 'string') {
    return { success: false, error: 'Empty or non-string output' };
  }

  let cleaned = raw.trim();

  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '').trim();

  if (!cleaned.startsWith('{')) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { success: false, error: `JSON.parse failed: ${err.message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { success: false, error: 'Parsed value is not an object' };
  }

  if (!VALID_WINNERS.has(parsed.winner)) {
    return { success: false, error: `Invalid winner: ${JSON.stringify(parsed.winner)}` };
  }

  for (const sideKey of ['aff_scores', 'neg_scores']) {
    const scores = parsed[sideKey];
    if (!scores || typeof scores !== 'object') {
      return { success: false, error: `Missing ${sideKey}` };
    }
    for (const axis of SCORE_AXES) {
      const v = scores[axis];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { success: false, error: `${sideKey}.${axis} is not a finite number (got ${JSON.stringify(v)})` };
      }
    }
  }

  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim().length < MIN_REASONING_LENGTH) {
    return {
      success: false,
      error: `reasoning too short or missing (got ${parsed.reasoning?.length ?? 0} chars, need ${MIN_REASONING_LENGTH})`,
    };
  }

  return { success: true, data: parsed };
}

function clampScores(parsed) {
  const clamp = (n) => Math.max(0, Math.min(10, n));
  return {
    winner: parsed.winner,
    aff_scores: {
      argument: clamp(parsed.aff_scores.argument),
      evidence: clamp(parsed.aff_scores.evidence),
      responsiveness: clamp(parsed.aff_scores.responsiveness),
      persuasion: clamp(parsed.aff_scores.persuasion),
    },
    neg_scores: {
      argument: clamp(parsed.neg_scores.argument),
      evidence: clamp(parsed.neg_scores.evidence),
      responsiveness: clamp(parsed.neg_scores.responsiveness),
      persuasion: clamp(parsed.neg_scores.persuasion),
    },
    reasoning: parsed.reasoning.trim(),
  };
}

function sumScores(scores) {
  return scores.argument + scores.evidence + scores.responsiveness + scores.persuasion;
}

async function markFailed(debateId, reason) {
  try {
    await prisma.debate.update({
      where: { id: debateId },
      data: {
        status: 'failed',
        errorMessage: String(reason).slice(0, ERROR_MESSAGE_MAX_LENGTH),
      },
    });
  } catch (err) {
    console.error('[judge] Failed to mark debate failed:', err);
  }
}
