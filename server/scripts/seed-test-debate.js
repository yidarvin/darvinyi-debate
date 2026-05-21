// Inserts one synthetic completed debate for endpoint testing.
//
// Usage:   cd server && node scripts/seed-test-debate.js
// Cleanup: cd server && node scripts/cleanup-test-debate.js
//
// Does NOT update Agent.elo or win/loss stats. Cleanup is the inverse:
// it deletes the Debate row, which cascades to DebateTurn, Evaluation, and
// EloChange via the schema's onDelete: Cascade relations.
//
// Topic is prefixed with "TEST DEBATE — " so cleanup can target it precisely.

import 'dotenv/config';
import { prisma } from '../src/db.js';

const TEST_TOPIC = 'TEST DEBATE — synthetic data for endpoint verification. A four-day workweek would improve overall economic productivity in developed nations.';

const TURN_CONTENT = {
  1: "The four-day workweek isn't a utopian thought experiment — it's an empirically validated productivity strategy. Iceland's national trials covering 2,500 workers showed productivity holding steady or improving in 86% of workplaces while shifting to 35–36 hour weeks. (TEST CONTENT.)",
  2: "My opponent's evidence is selective. Iceland's 'trial' was not a productivity study — it was a wage-protected reduction of hours in public-sector roles where output is notoriously hard to measure. (TEST CONTENT.)",
  3: "The negative concedes the case in knowledge sectors, then pivots to industries where it's harder. That's a meaningful concession: roughly 40% of OECD employment is now in information-intensive roles. (TEST CONTENT.)",
  4: "The Microsoft Japan figure is misquoted. The actual report measured 'sales per employee' over one month, not productivity. The remaining 60% of the workforce either sees no benefit or sees cost increases. (TEST CONTENT.)",
  5: "The resolution doesn't require mandating a uniform standard overnight — it asks whether the policy direction improves productivity. The negative has conceded the knowledge sector case. (TEST CONTENT.)",
  6: "The affirmative's closing is a retreat from the resolution as stated. The evidence supports voluntary knowledge-sector adoption only, not aggregate productivity gains across developed economies. (TEST CONTENT.)",
};

const TURN_DEFS = [
  { roundNumber: 1, roundName: 'Affirmative Constructive', side: 'aff', tokensIn: 1200, tokensOut: 580, durationMs: 14000 },
  { roundNumber: 2, roundName: 'Negative Constructive',    side: 'neg', tokensIn: 1500, tokensOut: 620, durationMs: 16000 },
  { roundNumber: 3, roundName: 'Affirmative Rebuttal',     side: 'aff', tokensIn: 1900, tokensOut: 510, durationMs: 14000 },
  { roundNumber: 4, roundName: 'Negative Rebuttal',        side: 'neg', tokensIn: 2200, tokensOut: 540, durationMs: 15000 },
  { roundNumber: 5, roundName: 'Affirmative Closing',      side: 'aff', tokensIn: 2700, tokensOut: 400, durationMs: 12000 },
  { roundNumber: 6, roundName: 'Negative Closing',         side: 'neg', tokensIn: 2900, tokensOut: 400, durationMs: 12500 },
];

const SAMPLE_TOOL_CALLS = [
  { tool: 'web_search', input: { query: 'Iceland four-day workweek productivity' }, outputSummary: '5 sources returned' },
  { tool: 'web_fetch',  input: { url: 'https://example.com/iceland-trial' }, outputSummary: 'Fetched Iceland trial summary (2891 chars)' },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed-test-debate] DATABASE_URL not set. Run from /server with .env configured.');
    process.exit(1);
  }

  // Confirm both agents exist (need a stable affAgent and negAgent for the test debate).
  const affAgent = await prisma.agent.findUnique({ where: { id: 'claude-opus-4-7' } });
  const negAgent = await prisma.agent.findUnique({ where: { id: 'gpt-5' } });
  if (!affAgent || !negAgent) {
    console.error('[seed-test-debate] Required test agents (claude-opus-4-7, gpt-5) not found. Run the main seed first: node src/seed.js');
    process.exit(1);
  }

  const debate = await prisma.debate.create({
    data: {
      topic: TEST_TOPIC,
      status: 'completed',
      affAgentId: 'claude-opus-4-7',
      negAgentId: 'gpt-5',
      winner: 'aff',
      completedAt: new Date(),
      turns: {
        create: TURN_DEFS.map((t) => ({
          ...t,
          content: TURN_CONTENT[t.roundNumber],
          // Each turn gets a couple of sample tool calls — gives the UI realistic badges to render.
          toolCalls: SAMPLE_TOOL_CALLS,
        })),
      },
      evaluation: {
        create: {
          winner: 'aff',
          affArgument: 8.5,
          affEvidence: 9.0,
          affResponsive: 8.0,
          affPersuasion: 8.5,
          affTotal: 34.0,
          negArgument: 7.5,
          negEvidence: 7.0,
          negResponsive: 8.5,
          negPersuasion: 7.5,
          negTotal: 30.5,
          reasoning:
            'TEST EVALUATION. The affirmative built the stronger empirical foundation, drawing on three distinct national trials with citable outcomes. The negative\'s critiques of the Iceland and Microsoft figures were sharp and well-targeted, but the negative ultimately conceded the knowledge-sector case, which is where the bulk of productivity weight in developed economies sits.\n\nResponsiveness was roughly even: both sides directly engaged each other\'s claims rather than talking past each other. Sourcing slightly favored the affirmative for breadth, though the negative deserves credit for more rigorous source-quality critique.',
          judgeModel: 'claude-opus-4-7',
        },
      },
      eloChanges: {
        create: [
          { agentId: 'claude-opus-4-7', before: 1200, after: 1214, delta: 14 },
          { agentId: 'gpt-5',           before: 1200, after: 1186, delta: -14 },
        ],
      },
    },
  });

  console.log(`[seed-test-debate] Created test debate: ${debate.id}`);
  console.log('[seed-test-debate] Note: Agent.elo and stats are NOT updated by this script.');
  console.log('[seed-test-debate] To remove: cd server && node scripts/cleanup-test-debate.js');
}

main()
  .catch((err) => {
    console.error('[seed-test-debate] FAILED:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
