// Applies the ELO consequences of a two-leg match to the database.
//
// Loads the debate + both agents + both leg evaluations, computes the match
// outcome by summing the judge's per-leg scores, derives scoreA from the
// match winner, computes new ratings, and atomically:
//   - Updates agentA.elo + W/L/D
//   - Updates agentB.elo + W/L/D
//   - Creates two EloChange rows (one per agent, capturing before/after/delta)
//   - Sets debate.winner = match outcome ('A' | 'B' | 'draw'),
//     debate.status = 'completed', debate.completedAt = now.
//
// Refuses to double-apply: if EloChange rows already exist for this debate,
// throws.

import { prisma } from '../db.js';
import { calculateNewRatings } from './calculate.js';
import { computeMatchOutcome } from '../match/computeMatchOutcome.js';

/**
 * @param {string} debateId
 * @returns {Promise<{
 *   outcome: { winner: 'A'|'B'|'draw', aTotal: number, bTotal: number, leg1Winner: string, leg2Winner: string },
 *   eloChanges: Array<{ agentId: string, before: number, after: number, delta: number }>
 * }>}
 */
export async function applyEloChange(debateId) {
  return prisma.$transaction(async (tx) => {
    const debate = await tx.debate.findUnique({
      where: { id: debateId },
      include: {
        agentA: true,
        agentB: true,
        evaluations: { orderBy: { leg: 'asc' } },
      },
    });

    if (!debate) throw new Error(`Debate not found: ${debateId}`);
    if (debate.evaluations.length !== 2) {
      throw new Error(
        `Cannot apply ELO: debate ${debateId} expected 2 evaluations, got ${debate.evaluations.length}`,
      );
    }

    const [eval1, eval2] = debate.evaluations;
    if (eval1.leg !== 1 || eval2.leg !== 2) {
      throw new Error(
        `Cannot apply ELO: evaluations not ordered as leg 1, leg 2 (got ${eval1.leg}, ${eval2.leg})`,
      );
    }

    // Idempotency: bail if changes already exist.
    const existing = await tx.eloChange.findMany({ where: { debateId } });
    if (existing.length > 0) {
      throw new Error(
        `ELO changes already applied for debate ${debateId} (found ${existing.length} EloChange rows)`,
      );
    }

    const outcome = computeMatchOutcome({ eval1, eval2 });

    const scoreA = outcome.winner === 'A' ? 1 : outcome.winner === 'B' ? 0 : 0.5;

    const { newA, newB, deltaA, deltaB } = calculateNewRatings({
      ratingA: debate.agentA.elo,
      ratingB: debate.agentB.elo,
      scoreA,
    });

    const aWin = outcome.winner === 'A' ? 1 : 0;
    const aLoss = outcome.winner === 'B' ? 1 : 0;
    const aDraw = outcome.winner === 'draw' ? 1 : 0;

    const bWin = outcome.winner === 'B' ? 1 : 0;
    const bLoss = outcome.winner === 'A' ? 1 : 0;
    const bDraw = outcome.winner === 'draw' ? 1 : 0;

    await tx.agent.update({
      where: { id: debate.agentA.id },
      data: {
        elo: newA,
        wins: { increment: aWin },
        losses: { increment: aLoss },
        draws: { increment: aDraw },
      },
    });

    await tx.agent.update({
      where: { id: debate.agentB.id },
      data: {
        elo: newB,
        wins: { increment: bWin },
        losses: { increment: bLoss },
        draws: { increment: bDraw },
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.agentA.id,
        debateId,
        before: debate.agentA.elo,
        after: newA,
        delta: deltaA,
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.agentB.id,
        debateId,
        before: debate.agentB.elo,
        after: newB,
        delta: deltaB,
      },
    });

    await tx.debate.update({
      where: { id: debateId },
      data: {
        winner: outcome.winner,
        status: 'completed',
        completedAt: new Date(),
      },
    });

    return {
      outcome,
      eloChanges: [
        { agentId: debate.agentA.id, before: debate.agentA.elo, after: newA, delta: deltaA },
        { agentId: debate.agentB.id, before: debate.agentB.elo, after: newB, delta: deltaB },
      ],
    };
  });
}
