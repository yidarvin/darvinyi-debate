// End-to-end orchestrator test.
//
// Creates a real Debate row, runs runDebate() against real APIs, verifies all
// 6 turns are saved with non-empty content, then cleans up.
//
// Usage:
//   cd server && node scripts/test-orchestrator.js
//
// Override agents via env (must be valid agent ids from the roster):
//   AFF_AGENT_ID=claude-sonnet-4-6 NEG_AGENT_ID=gemini-2-5-pro node scripts/test-orchestrator.js
//
// Cost: $0.50-$5.00 depending on agent pairing. Default is Sonnet vs Gemini
// (one of the cheapest combos in the roster).

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

  // Round 1: no previous turns. Affirmative side. Should have exactly 1 user msg.
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

  // Round 2: prev turn is aff's R1. Negative's view: 1 user msg with opponent content + instruction.
  conv = buildConversation({
    previousTurns: [
      { roundNumber: 1, roundName: 'Affirmative Constructive', side: 'aff', content: 'AFF R1 CONTENT.' },
    ],
    currentRound: ROUNDS[1],
    currentSide: 'neg',
  });
  console.assert(conv.length === 1, `R2 expected length 1 (merged), got ${conv.length}`);
  console.assert(conv[0].role === 'user', `R2 expected user, got ${conv[0].role}`);
  console.assert(conv[0].content.includes('OPPONENT [Round 1'), `R2 content missing OPPONENT prefix`);
  console.assert(conv[0].content.includes('AFF R1 CONTENT.'), `R2 content missing aff R1 body`);
  console.assert(conv[0].content.includes('Round 2: Negative Constructive'), `R2 content missing instruction`);
  console.log('  ✓ R2 negative — opponent block + instruction merged');

  // Round 3: prev turns are aff R1, neg R2. Affirmative's view:
  //   - assistant: aff R1
  //   - user: opp R2 + instruction
  conv = buildConversation({
    previousTurns: [
      { roundNumber: 1, roundName: 'Affirmative Constructive', side: 'aff', content: 'AFF R1.' },
      { roundNumber: 2, roundName: 'Negative Constructive', side: 'neg', content: 'NEG R2.' },
    ],
    currentRound: ROUNDS[2],
    currentSide: 'aff',
  });
  console.assert(conv.length === 2, `R3 expected length 2, got ${conv.length}`);
  console.assert(conv[0].role === 'assistant', `R3 conv[0] should be assistant (own R1)`);
  console.assert(conv[0].content === 'AFF R1.', `R3 conv[0] content should be 'AFF R1.'`);
  console.assert(conv[1].role === 'user', `R3 conv[1] should be user (opp + instruction)`);
  console.assert(conv[1].content.includes('NEG R2.'), `R3 conv[1] missing neg R2 body`);
  console.assert(conv[1].content.includes('Round 3: Affirmative Rebuttal'), `R3 conv[1] missing instruction`);
  console.log('  ✓ R3 affirmative — assistant turn + merged opponent+instruction');

  // Round 6: full history. Negative's view ends with own R4 as assistant, then opp R5 + instruction.
  const turns = [
    { roundNumber: 1, roundName: 'Affirmative Constructive', side: 'aff', content: 'A1' },
    { roundNumber: 2, roundName: 'Negative Constructive', side: 'neg', content: 'N2' },
    { roundNumber: 3, roundName: 'Affirmative Rebuttal', side: 'aff', content: 'A3' },
    { roundNumber: 4, roundName: 'Negative Rebuttal', side: 'neg', content: 'N4' },
    { roundNumber: 5, roundName: 'Affirmative Closing', side: 'aff', content: 'A5' },
  ];
  conv = buildConversation({
    previousTurns: turns,
    currentRound: ROUNDS[5],
    currentSide: 'neg',
  });
  // From neg's POV: user A1, assistant N2, user A3, assistant N4, user A5 + instruction
  console.assert(conv.length === 5, `R6 expected length 5, got ${conv.length}`);
  console.assert(conv[0].role === 'user' && conv[0].content.includes('A1'), `R6 conv[0] should be user/A1`);
  console.assert(conv[1].role === 'assistant' && conv[1].content === 'N2', `R6 conv[1] should be assistant/N2`);
  console.assert(conv[2].role === 'user' && conv[2].content.includes('A3'), `R6 conv[2] should be user/A3`);
  console.assert(conv[3].role === 'assistant' && conv[3].content === 'N4', `R6 conv[3] should be assistant/N4`);
  console.assert(conv[4].role === 'user' && conv[4].content.includes('A5'), `R6 conv[4] should be user/A5`);
  console.assert(conv[4].content.includes('Round 6: Negative Closing'), `R6 final missing instruction`);
  console.log('  ✓ R6 negative — full 5-message history with merged final block');
}

async function unitTestPickAgents() {
  console.log('\n=== UNIT TEST: pickRandomAgents ===');
  // Run several times to spot-check distinctness.
  for (let i = 0; i < 5; i++) {
    const { affAgent, negAgent } = await pickRandomAgents();
    console.assert(affAgent.id !== negAgent.id, `picked same agent for both sides: ${affAgent.id}`);
    console.assert(affAgent.id && negAgent.id, 'agents must have ids');
  }
  console.log('  ✓ 5 picks all distinct');
}

// ============================================================================
// End-to-end test
// ============================================================================

async function endToEndTest() {
  console.log('\n=== END-TO-END TEST: full 6-round orchestrator run ===');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not set; needed for default Sonnet agent.');
  }
  if (!process.env.GOOGLE_API_KEY && !process.env.NEG_AGENT_ID) {
    throw new Error('GOOGLE_API_KEY not set; needed for default Gemini agent (or set NEG_AGENT_ID).');
  }

  const affAgentId = process.env.AFF_AGENT_ID || 'claude-sonnet-4-6';
  const negAgentId = process.env.NEG_AGENT_ID || 'gemini-2-5-pro';

  const affAgent = await prisma.agent.findUnique({ where: { id: affAgentId } });
  const negAgent = await prisma.agent.findUnique({ where: { id: negAgentId } });
  if (!affAgent || !negAgent) {
    throw new Error(`Agents not found: aff=${affAgentId}, neg=${negAgentId}. Run the seed first.`);
  }
  console.log(`  Affirmative: ${affAgent.displayName} (${affAgent.id})`);
  console.log(`  Negative:    ${negAgent.displayName} (${negAgent.id})`);

  const debate = await prisma.debate.create({
    data: {
      topic: TEST_TOPIC,
      status: 'pending',
      affAgentId: affAgent.id,
      negAgentId: negAgent.id,
    },
  });
  console.log(`  Created debate: ${debate.id}`);

  let eventCount = 0;
  let textDeltaCount = 0;
  let toolCallStartCount = 0;
  let toolCallEndCount = 0;
  const roundsCompleted = new Set();
  let allRoundsCompleteFired = false;

  const startTime = Date.now();

  await runDebate({
    debateId: debate.id,
    onEvent: (event) => {
      eventCount++;
      if (event.type === 'text_delta') textDeltaCount++;
      else if (event.type === 'tool_call_start') toolCallStartCount++;
      else if (event.type === 'tool_call_end') toolCallEndCount++;
      else if (event.type === 'round_complete') {
        roundsCompleted.add(event.round);
        process.stdout.write(`\n  ✓ Round ${event.round} (${event.side}) complete — ${event.content.length} chars, ${event.tokensIn}/${event.tokensOut} tokens, ${event.durationMs}ms\n`);
      } else if (event.type === 'all_rounds_complete') {
        allRoundsCompleteFired = true;
      } else if (event.type === 'debate_start') {
        process.stdout.write(`  Started debate ${event.debateId}\n`);
      } else if (event.type === 'error') {
        process.stdout.write(`  ! ERROR: ${event.message}\n`);
      }
    },
  });

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n  Total events emitted: ${eventCount}`);
  console.log(`  text_delta events:   ${textDeltaCount}`);
  console.log(`  tool_call pairs:     start=${toolCallStartCount}, end=${toolCallEndCount}`);
  console.log(`  Rounds completed:    ${[...roundsCompleted].sort().join(', ')}`);
  console.log(`  all_rounds_complete: ${allRoundsCompleteFired}`);
  console.log(`  Elapsed:             ${elapsedSec}s`);

  // Assertions
  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

  if (roundsCompleted.size !== 6) fail(`Expected 6 rounds, got ${roundsCompleted.size}`);
  for (let r = 1; r <= 6; r++) {
    if (!roundsCompleted.has(r)) fail(`Round ${r} did not complete`);
  }
  if (!allRoundsCompleteFired) fail('all_rounds_complete event not emitted');

  // Verify DB state.
  const finalDebate = await prisma.debate.findUnique({
    where: { id: debate.id },
    include: { turns: { orderBy: { roundNumber: 'asc' } } },
  });

  if (finalDebate.status !== 'in_progress') {
    fail(`Expected debate.status === 'in_progress' (judge transitions to completed in Prompt 13), got '${finalDebate.status}'`);
  }
  if (finalDebate.turns.length !== 6) fail(`Expected 6 saved turns, got ${finalDebate.turns.length}`);

  for (const t of finalDebate.turns) {
    if (!t.content || t.content.length < 50) fail(`Round ${t.roundNumber} content too short (${t.content?.length} chars)`);
    const expectedSide = t.roundNumber % 2 === 1 ? 'aff' : 'neg';
    if (t.side !== expectedSide) fail(`Round ${t.roundNumber} side ${t.side} should be ${expectedSide}`);
  }

  console.log('\n  --- First 200 chars of each turn ---');
  for (const t of finalDebate.turns) {
    console.log(`  R${t.roundNumber} (${t.side}): ${t.content.slice(0, 200)}${t.content.length > 200 ? '…' : ''}`);
  }

  return debate.id;
}

// ============================================================================
// Cleanup
// ============================================================================

async function cleanup(debateId) {
  console.log('\n=== CLEANUP ===');
  if (debateId) {
    await prisma.debate.delete({ where: { id: debateId } });
    console.log(`  Deleted test debate ${debateId}`);
  }
  // Also sweep any other TEST DEBATE rows from prior runs.
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — orchestrator' } },
  });
  console.log(`  Swept ${swept.count} stale test debate(s).`);
}

// ============================================================================
// Main
// ============================================================================

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
