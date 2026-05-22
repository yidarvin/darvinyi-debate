// Reverses ELO changes for a debate. Undoes whatever was applied previously:
//   - Subtracts each EloChange.delta from the corresponding agent's elo
//   - Decrements the appropriate W/L/D counter based on the ORIGINAL judge winner
//   - Deletes the EloChange rows
//
// Used by applyHumanVote when a human overrides the judge.
// Operates within a provided Prisma transaction client (or top-level prisma if none).

import { prisma } from '../db.js';

const VALID_WINNERS = new Set(['aff', 'neg', 'draw']);

/**
 * @param {string} debateId
 * @param {import('@prisma/client').Prisma.TransactionClient | typeof prisma} [tx] - transaction client; defaults to top-level prisma
 * @returns {Promise<void>}
 */
export async function reverseEloChange(debateId, tx) {
  const client = tx ?? prisma;

  const debate = await client.debate.findUnique({
    where: { id: debateId },
    include: {
      affAgent: { select: { id: true } },
      negAgent: { select: { id: true } },
      evaluation: { select: { winner: true } },
      eloChanges: true,
    },
  });

  if (!debate) {
    throw new Error(`reverseEloChange: debate not found: ${debateId}`);
  }
  if (!debate.evaluation) {
    throw new Error(`reverseEloChange: debate ${debateId} has no evaluation`);
  }
  if (!VALID_WINNERS.has(debate.evaluation.winner)) {
    throw new Error(`reverseEloChange: invalid evaluation.winner: ${debate.evaluation.winner}`);
  }
  if (debate.eloChanges.length === 0) {
    throw new Error(`reverseEloChange: no EloChange rows for debate ${debateId}`);
  }
  if (debate.eloChanges.length !== 2) {
    throw new Error(
      `reverseEloChange: expected exactly 2 EloChange rows, found ${debate.eloChanges.length}`,
    );
  }

  const originalWinner = debate.evaluation.winner;
  const affChange = debate.eloChanges.find((c) => c.agentId === debate.affAgent.id);
  const negChange = debate.eloChanges.find((c) => c.agentId === debate.negAgent.id);

  if (!affChange || !negChange) {
    throw new Error(`reverseEloChange: missing EloChange for one of the agents`);
  }

  // Counters to decrement, based on the ORIGINAL judge verdict.
  const affDecrements = {
    wins:   originalWinner === 'aff'  ? 1 : 0,
    losses: originalWinner === 'neg'  ? 1 : 0,
    draws:  originalWinner === 'draw' ? 1 : 0,
  };
  const negDecrements = {
    wins:   originalWinner === 'neg'  ? 1 : 0,
    losses: originalWinner === 'aff'  ? 1 : 0,
    draws:  originalWinner === 'draw' ? 1 : 0,
  };

  // Subtract the delta and decrement W/L/D. Using atomic operations so other
  // concurrent agent updates (if any) don't clobber state.
  await client.agent.update({
    where: { id: debate.affAgent.id },
    data: {
      elo:    { decrement: affChange.delta },
      wins:   { decrement: affDecrements.wins },
      losses: { decrement: affDecrements.losses },
      draws:  { decrement: affDecrements.draws },
    },
  });

  await client.agent.update({
    where: { id: debate.negAgent.id },
    data: {
      elo:    { decrement: negChange.delta },
      wins:   { decrement: negDecrements.wins },
      losses: { decrement: negDecrements.losses },
      draws:  { decrement: negDecrements.draws },
    },
  });

  await client.eloChange.deleteMany({ where: { debateId } });
}
