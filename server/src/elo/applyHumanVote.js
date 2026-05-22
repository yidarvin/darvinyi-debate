// Records a human vote on a single leg of a two-leg match.
//
// Human votes are agreement-tracking ONLY. They do NOT affect the match
// outcome or any agent's ELO/W/L/D counters. They simply mark whether the
// human agreed with the judge for that leg.
//
// Race-aware idempotency: the evaluation update uses `updateMany` with a WHERE
// clause that includes `humanWinner: null`. If a concurrent vote already
// landed, the update affects 0 rows and we throw.

import { prisma } from '../db.js';

const VALID_WINNERS = new Set(['aff', 'neg', 'draw']);

/**
 * @param {string} debateId
 * @param {1 | 2} leg
 * @param {'aff' | 'neg' | 'draw'} humanWinner
 * @returns {Promise<{
 *   agreed: boolean,
 *   humanWinner: 'aff' | 'neg' | 'draw',
 *   judgeWinner: 'aff' | 'neg' | 'draw',
 *   leg: 1 | 2
 * }>}
 */
export async function recordHumanVote(debateId, leg, humanWinner) {
  if (!VALID_WINNERS.has(humanWinner)) {
    throw new Error(`humanWinner must be 'aff', 'neg', or 'draw' (got ${humanWinner})`);
  }
  if (leg !== 1 && leg !== 2) {
    throw new Error(`leg must be 1 or 2 (got ${leg})`);
  }

  return prisma.$transaction(async (tx) => {
    const evaluation = await tx.evaluation.findUnique({
      where: { debateId_leg: { debateId, leg } },
    });

    if (!evaluation) {
      throw new Error(`No evaluation found for debate ${debateId} leg ${leg}`);
    }
    if (evaluation.humanWinner !== null) {
      throw new Error(`Leg ${leg} already has a human vote (${evaluation.humanWinner})`);
    }

    const agreed = humanWinner === evaluation.winner;

    const updateResult = await tx.evaluation.updateMany({
      where: { id: evaluation.id, humanWinner: null },
      data: {
        humanWinner,
        humanVotedAt: new Date(),
        humanAgreedWithJudge: agreed,
      },
    });

    if (updateResult.count === 0) {
      throw new Error('Vote already recorded (race condition)');
    }

    return {
      agreed,
      humanWinner,
      judgeWinner: evaluation.winner,
      leg,
    };
  });
}
