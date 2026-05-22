// Applies a human vote to a debate. Two paths:
//
//   AGREE: humanWinner === evaluation.winner
//     - Update evaluation with humanWinner, humanVotedAt, humanAgreedWithJudge=true
//     - No ELO changes (judge's outcome stands)
//     - debate.winner stays as is
//
//   DISAGREE: humanWinner !== evaluation.winner
//     - Reverse the existing ELO change (delegate to reverseEloChange)
//     - Compute new ELO based on humanWinner (delegate to calculateNewRatings)
//     - Apply new ELO (update agents + create new EloChange rows)
//     - Update debate.winner to humanWinner
//     - Update evaluation with humanWinner, humanVotedAt, humanAgreedWithJudge=false
//
// All work happens in a single Prisma transaction so partial state is impossible.
//
// Race-aware idempotency: the evaluation update uses `updateMany` with a WHERE
// clause that includes `humanWinner: null`. If a concurrent vote already
// landed, the update affects 0 rows and we throw.

import { prisma } from '../db.js';
import { calculateNewRatings } from './calculate.js';
import { reverseEloChange } from './reverseEloChange.js';

const VALID_WINNERS = new Set(['aff', 'neg', 'draw']);

/**
 * @param {string} debateId
 * @param {'aff' | 'neg' | 'draw'} humanWinner
 * @returns {Promise<{
 *   agreed: boolean,
 *   humanWinner: 'aff' | 'neg' | 'draw',
 *   judgeWinner: 'aff' | 'neg' | 'draw',
 *   finalWinner: 'aff' | 'neg' | 'draw',
 *   eloChanges: Array<{ agentId: string, before: number, after: number, delta: number }>
 * }>}
 */
export async function applyHumanVote(debateId, humanWinner) {
  if (!VALID_WINNERS.has(humanWinner)) {
    throw new Error(`applyHumanVote: humanWinner must be 'aff', 'neg', or 'draw' (got ${humanWinner})`);
  }

  return prisma.$transaction(async (tx) => {
    const debate = await tx.debate.findUnique({
      where: { id: debateId },
      include: {
        affAgent: true,
        negAgent: true,
        evaluation: true,
        eloChanges: true,
      },
    });

    if (!debate) throw new Error(`Debate not found: ${debateId}`);
    if (!debate.evaluation) throw new Error(`Debate ${debateId} has no evaluation; cannot vote yet`);
    if (debate.status !== 'completed') {
      throw new Error(`Cannot vote on debate with status '${debate.status}'; must be 'completed'`);
    }
    if (debate.evaluation.humanWinner !== null) {
      throw new Error(
        `Debate already has a human vote (${debate.evaluation.humanWinner}); one vote per debate`,
      );
    }

    const judgeWinner = debate.evaluation.winner;
    const agreed = humanWinner === judgeWinner;

    // Race-aware update: only proceed if no one else voted between our read and this write.
    const evalUpdateResult = await tx.evaluation.updateMany({
      where: { id: debate.evaluation.id, humanWinner: null },
      data: {
        humanWinner,
        humanVotedAt: new Date(),
        humanAgreedWithJudge: agreed,
      },
    });

    if (evalUpdateResult.count === 0) {
      throw new Error(
        `Debate ${debateId} already has a human vote (race condition detected). One vote per debate.`,
      );
    }

    if (agreed) {
      // No ELO changes. Return the existing change rows as-is.
      return {
        agreed: true,
        humanWinner,
        judgeWinner,
        finalWinner: humanWinner,
        eloChanges: debate.eloChanges.map((c) => ({
          agentId: c.agentId,
          before: c.before,
          after: c.after,
          delta: c.delta,
        })),
      };
    }

    // DISAGREE path: reverse and reapply.

    await reverseEloChange(debateId, tx);

    // Refetch agent state after reversal — agents' elo/wins/losses have been
    // adjusted; we need the current values to compute the new ELO accurately.
    const affAfterReversal = await tx.agent.findUnique({ where: { id: debate.affAgent.id } });
    const negAfterReversal = await tx.agent.findUnique({ where: { id: debate.negAgent.id } });

    if (!affAfterReversal || !negAfterReversal) {
      throw new Error('Agents disappeared between transactions; this should be impossible');
    }

    const scoreA = humanWinner === 'aff' ? 1 : humanWinner === 'neg' ? 0 : 0.5;
    const { newA, newB, deltaA, deltaB } = calculateNewRatings({
      ratingA: affAfterReversal.elo,
      ratingB: negAfterReversal.elo,
      scoreA,
    });

    const affIncrements = {
      wins:   humanWinner === 'aff'  ? 1 : 0,
      losses: humanWinner === 'neg'  ? 1 : 0,
      draws:  humanWinner === 'draw' ? 1 : 0,
    };
    const negIncrements = {
      wins:   humanWinner === 'neg'  ? 1 : 0,
      losses: humanWinner === 'aff'  ? 1 : 0,
      draws:  humanWinner === 'draw' ? 1 : 0,
    };

    await tx.agent.update({
      where: { id: debate.affAgent.id },
      data: {
        elo: newA,
        wins:   { increment: affIncrements.wins },
        losses: { increment: affIncrements.losses },
        draws:  { increment: affIncrements.draws },
      },
    });

    await tx.agent.update({
      where: { id: debate.negAgent.id },
      data: {
        elo: newB,
        wins:   { increment: negIncrements.wins },
        losses: { increment: negIncrements.losses },
        draws:  { increment: negIncrements.draws },
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.affAgent.id,
        debateId,
        before: affAfterReversal.elo,
        after: newA,
        delta: deltaA,
      },
    });

    await tx.eloChange.create({
      data: {
        agentId: debate.negAgent.id,
        debateId,
        before: negAfterReversal.elo,
        after: newB,
        delta: deltaB,
      },
    });

    await tx.debate.update({
      where: { id: debateId },
      data: { winner: humanWinner },
    });

    return {
      agreed: false,
      humanWinner,
      judgeWinner,
      finalWinner: humanWinner,
      eloChanges: [
        { agentId: debate.affAgent.id, before: affAfterReversal.elo, after: newA, delta: deltaA },
        { agentId: debate.negAgent.id, before: negAfterReversal.elo, after: newB, delta: deltaB },
      ],
    };
  });
}
