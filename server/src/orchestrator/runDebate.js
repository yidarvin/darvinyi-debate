// Orchestrates a two-leg match.
//
// Leg 1: agent A = affirmative, agent B = negative
// Leg 2: agent A = negative,    agent B = affirmative (swapped)
//
// Each leg runs all six Lincoln-Douglas rounds with fresh context — the
// agents do NOT see leg 1's transcript when running leg 2. They argue the
// opposite side as if it were their first encounter with the topic.
//
// On all 12 rounds done, emit `all_legs_complete`. The judge + ELO + reveal
// are handled by the SSE wrapper (routes/debates.js).

import { prisma } from '../db.js';
import { getAgentRunner } from '../agents/index.js';
import { buildDebaterSystemPrompt } from '../agents/systemPrompts.js';
import { ROUNDS, ROUND_DESCRIPTIONS } from './rounds.js';
import { buildConversation } from './buildConversation.js';
import { truncateToWordLimit } from './truncateToWordLimit.js';

const ERROR_MESSAGE_MAX_LENGTH = 1000;

/**
 * Run a two-leg match end-to-end.
 *
 * @param {object} params
 * @param {string} params.debateId
 * @param {(event: object) => void | Promise<void>} params.onEvent
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<void>}
 */
export async function runDebate({ debateId, onEvent, signal }) {
  const emit = async (event) => {
    try {
      await onEvent(event);
    } catch (err) {
      console.error('[orchestrator] onEvent threw:', err);
    }
  };

  const debate = await prisma.debate.findUnique({
    where: { id: debateId },
    include: { agentA: true, agentB: true },
  });

  if (!debate) throw new Error(`Debate not found: ${debateId}`);
  if (debate.status !== 'pending' && debate.status !== 'in_progress') {
    throw new Error(
      `Cannot run debate ${debateId} in status '${debate.status}'. Expected 'pending' or 'in_progress'.`,
    );
  }

  if (debate.status === 'pending') {
    await prisma.debate.update({
      where: { id: debateId },
      data: { status: 'in_progress' },
    });
  }

  await emit({ type: 'debate_start', debateId, topic: debate.topic });

  let runnerA;
  let runnerB;
  try {
    runnerA = await getAgentRunner(debate.agentA);
    runnerB = await getAgentRunner(debate.agentB);
  } catch (err) {
    await markFailed(debateId, `Failed to initialize agents: ${err.message}`);
    await emit({ type: 'error', message: 'Failed to initialize agents' });
    throw err;
  }

  // Existing turns for resume-safety. Group by leg.
  const existingTurns = await prisma.debateTurn.findMany({
    where: { debateId },
    orderBy: [{ leg: 'asc' }, { roundNumber: 'asc' }],
  });

  try {
    // ----- LEG 1: A = aff, B = neg -----
    await runLeg({
      debateId,
      leg: 1,
      topic: debate.topic,
      affRunner: runnerA,
      negRunner: runnerB,
      existingTurns: existingTurns.filter((t) => t.leg === 1),
      emit,
      signal,
    });

    // ----- LEG 2: A = neg, B = aff (swapped) -----
    await runLeg({
      debateId,
      leg: 2,
      topic: debate.topic,
      affRunner: runnerB,
      negRunner: runnerA,
      existingTurns: existingTurns.filter((t) => t.leg === 2),
      emit,
      signal,
    });

    await emit({ type: 'all_legs_complete' });
  } catch (err) {
    const isAbort = err.name === 'AbortError' || signal?.aborted;
    const reason = isAbort ? `Aborted: ${err.message ?? ''}`.trim() : err.message ?? String(err);
    await markFailed(debateId, reason);
    await emit({
      type: 'error',
      message: isAbort ? 'Debate aborted' : 'Debate failed during orchestration',
    });
    throw err;
  }
}

async function runLeg({
  debateId,
  leg,
  topic,
  affRunner,
  negRunner,
  existingTurns,
  emit,
  signal,
}) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  await emit({ type: 'leg_start', leg });

  const previousTurnsInLeg = existingTurns.map((t) => ({
    roundNumber: t.roundNumber,
    roundName: t.roundName,
    side: t.side,
    content: t.content,
  }));

  for (const round of ROUNDS) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Skip rounds already saved (resume safety within a leg).
    if (previousTurnsInLeg.some((t) => t.roundNumber === round.number)) {
      const existing = previousTurnsInLeg.find((t) => t.roundNumber === round.number);
      await emit({
        type: 'round_complete',
        leg,
        round: round.number,
        side: round.side,
        content: existing.content,
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
        resumed: true,
      });
      continue;
    }

    const runner = round.side === 'aff' ? affRunner : negRunner;

    const systemPrompt = buildDebaterSystemPrompt({
      side: round.side,
      topic,
      roundName: round.name,
      roundNumber: round.number,
      roundDescription: ROUND_DESCRIPTIONS[round.number],
      wordLimit: round.wordLimit,
    });

    const conversation = buildConversation({
      previousTurns: previousTurnsInLeg,
      currentRound: round,
      currentSide: round.side,
    });

    let turnComplete = null;

    for await (const event of runner.runTurn({ systemPrompt, conversation, signal })) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (event.type === 'turn_complete') {
        turnComplete = event;
        continue;
      }

      await emit({ ...event, leg, round: round.number, side: round.side });
    }

    if (!turnComplete) {
      throw new Error(`Agent did not yield turn_complete for leg ${leg} round ${round.number}`);
    }

    const rawContent = (turnComplete.content || '').trim();
    if (!rawContent) {
      throw new Error(`Leg ${leg} Round ${round.number} produced empty content`);
    }

    const { content, originalWordCount, truncated } = truncateToWordLimit(
      rawContent,
      round.wordLimit,
    );
    if (truncated) {
      console.log(
        `[orchestrator] Leg ${leg} Round ${round.number} truncated: ${originalWordCount} → ${round.wordLimit} words`,
      );
    }

    await prisma.debateTurn.create({
      data: {
        debateId,
        leg,
        roundNumber: round.number,
        roundName: round.name,
        side: round.side,
        content,
        toolCalls: turnComplete.toolCalls ?? [],
        tokensIn: turnComplete.tokensIn ?? 0,
        tokensOut: turnComplete.tokensOut ?? 0,
        durationMs: turnComplete.durationMs ?? 0,
      },
    });

    previousTurnsInLeg.push({
      roundNumber: round.number,
      roundName: round.name,
      side: round.side,
      content,
    });

    await emit({
      type: 'round_complete',
      leg,
      round: round.number,
      side: round.side,
      content,
      toolCalls: turnComplete.toolCalls ?? [],
      tokensIn: turnComplete.tokensIn ?? 0,
      tokensOut: turnComplete.tokensOut ?? 0,
      durationMs: turnComplete.durationMs ?? 0,
      truncated,
      originalWordCount,
      wordLimit: round.wordLimit,
    });
  }

  await emit({ type: 'leg_complete', leg });
}

async function markFailed(debateId, reason) {
  try {
    const trimmed = String(reason).slice(0, ERROR_MESSAGE_MAX_LENGTH);
    await prisma.debate.update({
      where: { id: debateId },
      data: { status: 'failed', errorMessage: trimmed },
    });
  } catch (err) {
    console.error('[orchestrator] Failed to mark debate failed:', err);
  }
}
