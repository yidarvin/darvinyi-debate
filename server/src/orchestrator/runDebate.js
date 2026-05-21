// Orchestrates a six-round debate end-to-end.
//
// Responsibilities:
//   1. Load debate + both agents from DB.
//   2. Transition status pending -> in_progress.
//   3. Emit `debate_start` (agent identities NOT revealed).
//   4. For each of the 6 rounds:
//        - Build system prompt + conversation from prior turns (this agent's POV).
//        - Invoke the agent's runTurn async generator.
//        - Forward text_delta, tool_call_start, tool_call_end events to onEvent,
//          annotated with round+side metadata.
//        - On turn_complete: save a DebateTurn row, emit `round_complete`.
//   5. Emit `all_rounds_complete`.
//   6. Leave debate in `in_progress` — the judge module (Prompt 13) transitions to `completed`.
//
// On any thrown error (including AbortError), mark debate `failed`, save error
// message, emit an `error` event, then re-throw so the SSE wrapper can clean up.

import { prisma } from '../db.js';
import { getAgentRunner } from '../agents/index.js';
import { buildDebaterSystemPrompt } from '../agents/systemPrompts.js';
import { ROUNDS, ROUND_DESCRIPTIONS } from './rounds.js';
import { buildConversation } from './buildConversation.js';

const ERROR_MESSAGE_MAX_LENGTH = 1000;

/**
 * Run a debate end-to-end.
 *
 * @param {object} params
 * @param {string} params.debateId
 * @param {(event: object) => void | Promise<void>} params.onEvent - called with each event (sync or async, awaited)
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<void>}
 */
export async function runDebate({ debateId, onEvent, signal }) {
  const emit = async (event) => {
    try {
      await onEvent(event);
    } catch (err) {
      // onEvent failures don't fail the debate — log and continue.
      console.error('[orchestrator] onEvent threw:', err);
    }
  };

  // Load debate + both agents.
  const debate = await prisma.debate.findUnique({
    where: { id: debateId },
    include: { affAgent: true, negAgent: true },
  });

  if (!debate) {
    throw new Error(`Debate not found: ${debateId}`);
  }

  if (debate.status !== 'pending' && debate.status !== 'in_progress') {
    throw new Error(
      `Cannot run debate ${debateId} in status '${debate.status}'. Expected 'pending' or 'in_progress'.`,
    );
  }

  // Transition to in_progress (idempotent — safe if already in_progress).
  if (debate.status === 'pending') {
    await prisma.debate.update({
      where: { id: debateId },
      data: { status: 'in_progress' },
    });
  }

  // Emit debate_start. Agent identities are NOT included.
  await emit({
    type: 'debate_start',
    debateId,
    topic: debate.topic,
  });

  // Resolve the AgentRunner for each side.
  let affRunner;
  let negRunner;
  try {
    affRunner = await getAgentRunner(debate.affAgent);
    negRunner = await getAgentRunner(debate.negAgent);
  } catch (err) {
    await markDebateFailed(debateId, err.message);
    await emit({ type: 'error', message: 'Failed to initialize agents' });
    throw err;
  }

  // Resume support: load any turns already saved (e.g. from a prior in_progress run).
  // In v1 we don't support true resume, but loading them keeps the conversation
  // builder accurate if this function is somehow re-invoked.
  const existingTurns = await prisma.debateTurn.findMany({
    where: { debateId },
    orderBy: { roundNumber: 'asc' },
  });
  const previousTurns = existingTurns.map((t) => ({
    roundNumber: t.roundNumber,
    roundName: t.roundName,
    side: t.side,
    content: t.content,
  }));

  try {
    for (const round of ROUNDS) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Skip rounds already saved (resume safety).
      if (previousTurns.some((t) => t.roundNumber === round.number)) {
        const existing = previousTurns.find((t) => t.roundNumber === round.number);
        // Re-emit a round_complete so a re-attached viewer can catch up.
        await emit({
          type: 'round_complete',
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
        topic: debate.topic,
        roundName: round.name,
        roundNumber: round.number,
        roundDescription: ROUND_DESCRIPTIONS[round.number],
        wordLimit: round.wordLimit,
      });

      const conversation = buildConversation({
        previousTurns,
        currentRound: round,
        currentSide: round.side,
      });

      let turnComplete = null;

      for await (const event of runner.runTurn({ systemPrompt, conversation, signal })) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        if (event.type === 'turn_complete') {
          turnComplete = event;
          // Don't forward turn_complete — handled below as round_complete.
          continue;
        }

        // Annotate every other event with round + side context.
        await emit({ ...event, round: round.number, side: round.side });
      }

      if (!turnComplete) {
        throw new Error(`Agent did not yield turn_complete for round ${round.number} (${round.name})`);
      }

      const content = (turnComplete.content || '').trim();
      if (!content) {
        throw new Error(
          `Round ${round.number} produced empty content from ${round.side === 'aff' ? debate.affAgent.id : debate.negAgent.id}`,
        );
      }

      // Persist the turn.
      await prisma.debateTurn.create({
        data: {
          debateId,
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

      previousTurns.push({
        roundNumber: round.number,
        roundName: round.name,
        side: round.side,
        content,
      });

      await emit({
        type: 'round_complete',
        round: round.number,
        side: round.side,
        content,
        toolCalls: turnComplete.toolCalls ?? [],
        tokensIn: turnComplete.tokensIn ?? 0,
        tokensOut: turnComplete.tokensOut ?? 0,
        durationMs: turnComplete.durationMs ?? 0,
      });
    }

    await emit({ type: 'all_rounds_complete' });
  } catch (err) {
    const isAbort = err.name === 'AbortError' || signal?.aborted;
    const reason = isAbort ? `Aborted: ${err.message ?? ''}`.trim() : err.message ?? String(err);
    await markDebateFailed(debateId, reason);
    await emit({
      type: 'error',
      message: isAbort ? 'Debate aborted' : 'Debate failed during orchestration',
    });
    throw err;
  }
}

async function markDebateFailed(debateId, reason) {
  try {
    const trimmed = String(reason).slice(0, ERROR_MESSAGE_MAX_LENGTH);
    await prisma.debate.update({
      where: { id: debateId },
      data: { status: 'failed', errorMessage: trimmed },
    });
  } catch (err) {
    // Best-effort. If we can't even mark failed, just log.
    console.error('[orchestrator] Failed to mark debate failed:', err);
  }
}
