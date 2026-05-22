// Applies the ELO consequences of a judged debate to the database.
//
// Loads the debate + both agents + the evaluation, derives scoreA from the
// winner, computes the new ratings, and atomically:
//   - Updates affAgent.elo + wins/losses/draws
//   - Updates negAgent.elo + wins/losses/draws
//   - Creates two EloChange rows (one per agent, capturing before/after/delta)
//
// Refuses to double-apply: if EloChange rows already exist for this debate,
// throws. This makes the function safe to retry without corrupting ratings.

import { prisma } from '../db.js';
import { calculateNewRatings } from './calculate.js';

const VALID_WINNERS = new Set(['aff', 'neg', 'draw']);

/**
 * @param {string} debateId
 * @returns {Promise<{
 *   aff: { agentId: string, before: number, after: number, delta: number },
 *   neg: { agentId: string, before: number, after: number, delta: number }
 * }>}
 */
export async function applyEloChange(debateId) {
  return prisma.$transaction(async (tx) => {
    const debate = await tx.debate.findUnique({
      where: { id: debateId },
      include: {
        affAgent: true,
        negAgent: true,
        evaluation: true,
      },
    });

    if (!debate) throw new Error(`Debate not found: ${debateId}`);
    if (!debate.evaluation) {
      throw new Error(`Cannot apply ELO: debate ${debateId} has no evaluation (judge has not run)`);
    }

    const winner = debate.evaluation.winner;
    if (!VALID_WINNERS.has(winner)) {
      throw new Error(`Invalid evaluation winner: ${winner}`);
    }

    // Idempotency: bail if changes already exist.
    const existing = await tx.eloChange.findMany({ where: { debateId } });
    if (existing.length > 0) {
      throw new Error(
        `ELO changes already applied for debate ${debateId} (found ${existing.length} EloChange rows)`,
      );
    }

    const scoreA = winner === 'aff' ? 1 : winner === 'neg' ? 0 : 0.5;

    const { newA, newB, deltaA, deltaB } = calculateNewRatings({
      ratingA: debate.affAgent.elo,
      ratingB: debate.negAgent.elo,
      scoreA,
    });

    // Per-side win/loss/draw counter increments.
    const affWin = winner === 'aff' ? 1 : 0;
    const affLoss = winner === 'neg' ? 1 : 0;
    const affDraw = winner === 'draw' ? 1 : 0;

    const negWin = winner === 'neg' ? 1 : 0;
    const negLoss = winner === 'aff' ? 1 : 0;
    const negDraw = winner === 'draw' ? 1 : 0;

    await tx.agent.update({
      where: { id: debate.affAgent.id },
      data: {
        elo: newA,
        wins: { increment: affWin },
        losses: { increment: affLoss },
        draws: { increment: affDraw },
      },
    });

    await tx.agent.update({
      where: { id: debate.negAgent.id },
      data: {
        elo: newB,
        wins: { increment: negWin },
        losses: { increment: negLoss },
        draws: { increment: negDraw },
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.affAgent.id,
        debateId,
        before: debate.affAgent.elo,
        after: newA,
        delta: deltaA,
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.negAgent.id,
        debateId,
        before: debate.negAgent.elo,
        after: newB,
        delta: deltaB,
      },
    });

    return {
      aff: {
        agentId: debate.affAgent.id,
        before: debate.affAgent.elo,
        after: newA,
        delta: deltaA,
      },
      neg: {
        agentId: debate.negAgent.id,
        before: debate.negAgent.elo,
        after: newB,
        delta: deltaB,
      },
    };
  });
}
