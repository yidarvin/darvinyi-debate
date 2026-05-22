// Selects two distinct agents uniformly at random from the roster.
//
// Returns: { agentA, agentB } — two distinct Agent rows from the DB.
//
// In leg 1 of the resulting match, agent A takes affirmative and agent B takes
// negative; in leg 2 they swap. The A/B labels are arbitrary — the assignment
// is uniform random, so no side-bias exists in the data.

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

  return { agentA: shuffled[0], agentB: shuffled[1] };
}
