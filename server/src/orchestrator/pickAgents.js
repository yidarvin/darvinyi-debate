// Selects two distinct agents uniformly at random from the roster.
// Then assigns affirmative/negative randomly.
//
// Returns: { affAgent, negAgent } — two distinct Agent rows from the DB.

import { prisma } from '../db.js';

export async function pickRandomAgents() {
  const agents = await prisma.agent.findMany();

  if (agents.length < 2) {
    throw new Error(
      `Cannot start a debate: need at least 2 agents in the database, found ${agents.length}. Run \`node src/seed.js\` first.`,
    );
  }

  // Fisher-Yates style shuffle (overkill for 5 items, but cheap and clear).
  const shuffled = [...agents];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const first = shuffled[0];
  const second = shuffled[1];

  // Coin flip for side assignment.
  const affFirst = Math.random() < 0.5;
  return {
    affAgent: affFirst ? first : second,
    negAgent: affFirst ? second : first,
  };
}
