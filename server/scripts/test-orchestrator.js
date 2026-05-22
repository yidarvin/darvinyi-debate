// End-to-end orchestrator test for two-leg matches.
//
// Creates a real Debate row, runs runDebate() against real APIs, verifies all
// 12 turns are saved with non-empty content across two legs, then cleans up.
//
// Usage:
//   cd server && node scripts/test-orchestrator.js
//
// Override agents via env (must be valid agent ids from the roster):
//   AGENT_A_ID=claude-sonnet-4-6 AGENT_B_ID=gemini-2-5-pro node scripts/test-orchestrator.js
//
// Cost: $1.00-$10.00 (two legs at ~6 turns each).

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { runDebate } from '../src/orchestrator/runDebate.js';
import { pickRandomAgents } from '../src/orchestrator/pickAgents.js';
import { buildConversation } from '../src/orchestrator/buildConversation.js';
import { ROUNDS } from '../src/orchestrator/rounds.js';

const TEST_TOPIC =
  'TEST DEBATE — orchestrator end-to-end. A four-day workweek would improve overall economic productivity in developed nations.';

// ============================================================================
// Inline unit tests for pure modules.
// ============================================================================

function unitTestBuildConversation() {
  console.log('\n=== UNIT TEST: buildConversation ===');

  let conv = buildConversation({
    previousTurns: [],
    currentRound: ROUNDS[0],
    currentSide: 'aff',
  });
  console.assert(conv.length === 1, `R1 expected length 1, got ${conv.length}`);
  console.assert(conv[0].role === 'user', `R1 expected user, got ${conv[0].role}`);
  console.assert(
    conv[0].content.includes('Round 1: Affirmative Constructive') &&
      conv[0].content.includes('AFFIRMATIVE') &&
      conv[0].content.includes('800 words'),
    `R1 instruction content malformed: ${conv[0].content}`,
  );
  console.log('  ✓ R1 affirmative — single user instruction');

  conv = buildConversation({
    previousTurns: [
      { roundNumber: 1, roundName: 'Affirmative Constructive', side: 'aff', content: 'AFF R1 CONTENT.' },
    ],
    currentRound: ROUNDS[1],
    currentSide: 'neg',
  });
  console.assert(conv.length === 1, `R2 expected length 1 (merged), got ${conv.length}`);
  console.assert(conv[0].content.includes('OPPONENT [Round 1'), `R2 content missing OPPONENT prefix`);
  console.assert(conv[0].content.includes('AFF R1 CONTENT.'), `R2 content missing aff R1 body`);
  console.assert(conv[0].content.includes('Round 2: Negative Constructive'), `R2 content missing instruction`);
  console.log('  ✓ R2 negative — opponent block + instruction merged');

  console.log('  ✓ buildConversation is leg-agnostic (caller filters to current leg)');
}

async function unitTestPickAgents() {
  console.log('\n=== UNIT TEST: pickRandomAgents ===');
  for (let i = 0; i < 5; i++) {
    const { agentA, agentB } = await pickRandomAgents();
    console.assert(agentA.id !== agentB.id, `picked same agent for both sides: ${agentA.id}`);
    console.assert(agentA.id && agentB.id, 'agents must have ids');
  }
  console.log('  ✓ 5 picks all distinct, returned as { agentA, agentB }');
}

// ============================================================================
// End-to-end test
// ============================================================================

async function endToEndTest() {
  console.log('\n=== END-TO-END TEST: full two-leg orchestrator run ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set; needed for default Sonnet agent.');
  }
  if (!process.env.GOOGLE_API_KEY && !process.env.AGENT_B_ID) {
    throw new Error('GOOGLE_API_KEY not set; needed for default Gemini agent (or set AGENT_B_ID).');
  }

  const agentAId = process.env.AGENT_A_ID || 'claude-sonnet-4-6';
  const agentBId = process.env.AGENT_B_ID || 'gemini-2-5-pro';

  const agentA = await prisma.agent.findUnique({ where: { id: agentAId } });
  const agentB = await prisma.agent.findUnique({ where: { id: agentBId } });
  if (!agentA || !agentB) {
    throw new Error(`Agents not found: A=${agentAId}, B=${agentBId}. Run the seed first.`);
  }
  console.log(`  Agent A: ${agentA.displayName} (${agentA.id})`);
  console.log(`  Agent B: ${agentB.displayName} (${agentB.id})`);

  const debate = await prisma.debate.create({
    data: {
      topic: TEST_TOPIC,
      status: 'pending',
      agentAId: agentA.id,
      agentBId: agentB.id,
    },
  });
  console.log(`  Created debate: ${debate.id}`);

  let eventCount = 0;
  let textDeltaCount = 0;
  let toolCallStartCount = 0;
  let toolCallEndCount = 0;
  const legStartCount = new Set();
  const legCompleteCount = new Set();
  const roundsCompleted = new Set();
  let allLegsCompleteFired = false;

  const startTime = Date.now();

  await runDebate({
    debateId: debate.id,
    onEvent: (event) => {
      eventCount++;
      if (event.type === 'text_delta') textDeltaCount++;
      else if (event.type === 'tool_call_start') toolCallStartCount++;
      else if (event.type === 'tool_call_end') toolCallEndCount++;
      else if (event.type === 'leg_start') {
        legStartCount.add(event.leg);
        process.stdout.write(`\n[leg ${event.leg} start]\n`);
      } else if (event.type === 'leg_complete') {
        legCompleteCount.add(event.leg);
        process.stdout.write(`\n[leg ${event.leg} complete]\n`);
      } else if (event.type === 'round_complete') {
        roundsCompleted.add(`${event.leg}.${event.round}`);
        process.stdout.write(`  ✓ Leg ${event.leg} Round ${event.round} (${event.side}) — ${event.content.length} chars, ${event.tokensIn}/${event.tokensOut} tokens, ${event.durationMs}ms\n`);
      } else if (event.type === 'all_legs_complete') {
        allLegsCompleteFired = true;
      } else if (event.type === 'debate_start') {
        process.stdout.write(`  Started debate ${event.debateId}\n`);
      } else if (event.type === 'error') {
        process.stdout.write(`  ! ERROR: ${event.message}\n`);
      }
    },
  });

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n  Total events emitted: ${eventCount}`);
  console.log(`  text_delta events:    ${textDeltaCount}`);
  console.log(`  tool_call pairs:      start=${toolCallStartCount}, end=${toolCallEndCount}`);
  console.log(`  Legs started:         ${[...legStartCount].sort().join(', ')}`);
  console.log(`  Legs completed:       ${[...legCompleteCount].sort().join(', ')}`);
  console.log(`  Rounds completed:     ${[...roundsCompleted].sort().join(', ')}`);
  console.log(`  all_legs_complete:    ${allLegsCompleteFired}`);
  console.log(`  Elapsed:              ${elapsedSec}s`);

  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

  if (legStartCount.size !== 2) fail(`Expected 2 leg_start events (1 and 2), got ${legStartCount.size}`);
  if (legCompleteCount.size !== 2) fail(`Expected 2 leg_complete events, got ${legCompleteCount.size}`);
  if (roundsCompleted.size !== 12) fail(`Expected 12 rounds (6 per leg × 2), got ${roundsCompleted.size}`);
  for (const leg of [1, 2]) {
    for (let r = 1; r <= 6; r++) {
      if (!roundsCompleted.has(`${leg}.${r}`)) fail(`Leg ${leg} Round ${r} did not complete`);
    }
  }
  if (!allLegsCompleteFired) fail('all_legs_complete event not emitted');

  const finalDebate = await prisma.debate.findUnique({
    where: { id: debate.id },
    include: { turns: { orderBy: [{ leg: 'asc' }, { roundNumber: 'asc' }] } },
  });

  if (finalDebate.status !== 'in_progress') {
    fail(`Expected debate.status === 'in_progress' (judge transitions to judging/completed), got '${finalDebate.status}'`);
  }
  if (finalDebate.turns.length !== 12) fail(`Expected 12 saved turns, got ${finalDebate.turns.length}`);

  for (const t of finalDebate.turns) {
    if (!t.content || t.content.length < 50) fail(`Leg ${t.leg} Round ${t.roundNumber} content too short (${t.content?.length} chars)`);
    const expectedSide = t.roundNumber % 2 === 1 ? 'aff' : 'neg';
    if (t.side !== expectedSide) fail(`Leg ${t.leg} Round ${t.roundNumber} side ${t.side} should be ${expectedSide}`);
  }

  console.log('\n  --- First 200 chars of each turn ---');
  for (const t of finalDebate.turns) {
    console.log(`  L${t.leg} R${t.roundNumber} (${t.side}): ${t.content.slice(0, 200)}${t.content.length > 200 ? '…' : ''}`);
  }

  return debate.id;
}

// ============================================================================

async function cleanup(debateId) {
  console.log('\n=== CLEANUP ===');
  if (debateId) {
    await prisma.debate.deleteMany({ where: { id: debateId } });
    console.log(`  Deleted test debate ${debateId}`);
  }
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — orchestrator' } },
  });
  console.log(`  Swept ${swept.count} stale test debate(s).`);
}

(async () => {
  let testDebateId = null;
  try {
    unitTestBuildConversation();
    await unitTestPickAgents();
    testDebateId = await endToEndTest();
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup(testDebateId);
    } catch (err) {
      console.error('Cleanup error:', err);
    }
    await prisma.$disconnect();
  }
})();
