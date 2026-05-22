// Tests for the ELO module.
//
//   PHASE A: pure function (no DB). Verifies the formula against hand-computed
//           expected values from /context/ELO_SPEC.md.
//   PHASE B: end-to-end DB integration. Creates a fake completed debate + evaluation,
//           applies ELO, verifies agent rows updated + EloChange rows created.
//           SNAPSHOTS and RESTORES agent stats so test runs are non-destructive.
//
// Usage: cd server && node scripts/test-elo.js
//
// No LLM calls — this test is essentially free.

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { calculateNewRatings } from '../src/elo/calculate.js';
import { applyEloChange } from '../src/elo/applyEloChange.js';

// ============================================================================
// Phase A — pure function tests
// ============================================================================

function approxEqual(actual, expected, tolerance = 0.5) {
  return Math.abs(actual - expected) < tolerance;
}

const PURE_CASES = [
  {
    name: 'Equal ratings, A wins',
    input:    { ratingA: 1200, ratingB: 1200, scoreA: 1 },
    expected: { newA: 1212,    newB: 1188,    deltaA: 12,    deltaB: -12 },
  },
  {
    name: 'Equal ratings, draw',
    input:    { ratingA: 1200, ratingB: 1200, scoreA: 0.5 },
    expected: { newA: 1200,    newB: 1200,    deltaA: 0,     deltaB: 0 },
  },
  {
    name: 'Equal ratings, A loses',
    input:    { ratingA: 1200, ratingB: 1200, scoreA: 0 },
    expected: { newA: 1188,    newB: 1212,    deltaA: -12,   deltaB: 12 },
  },
  {
    // Computed for K=24, standard ELO: expectedA = 1/(1+10^0.5) = 0.24025,
    // deltaA = 24 * (1 - 0.24025) = 18.234. Prompt's 20.85 was a mis-derivation.
    name: 'Underdog wins (1100 vs 1300)',
    input:    { ratingA: 1100, ratingB: 1300, scoreA: 1 },
    expected: { newA: 1118.23, newB: 1281.77, deltaA: 18.23, deltaB: -18.23 },
  },
  {
    name: 'Favorite wins as expected (1300 vs 1100)',
    input:    { ratingA: 1300, ratingB: 1100, scoreA: 1 },
    expected: { newA: 1305.77, newB: 1094.23, deltaA: 5.77,  deltaB: -5.77 },
  },
  {
    name: 'Underdog draws (1100 vs 1300)',
    input:    { ratingA: 1100, ratingB: 1300, scoreA: 0.5 },
    expected: { newA: 1106.23, newB: 1293.77, deltaA: 6.23,  deltaB: -6.23 },
  },
  {
    name: 'Favorite draws (1300 vs 1100)',
    input:    { ratingA: 1300, ratingB: 1100, scoreA: 0.5 },
    expected: { newA: 1293.77, newB: 1106.23, deltaA: -6.23, deltaB: 6.23 },
  },
];

function runPureTests() {
  console.log('\n=== PHASE A: Pure-function tests ===\n');

  let passed = 0;
  let failed = 0;

  for (const c of PURE_CASES) {
    const result = calculateNewRatings(c.input);
    const ok =
      approxEqual(result.newA, c.expected.newA) &&
      approxEqual(result.newB, c.expected.newB) &&
      approxEqual(result.deltaA, c.expected.deltaA, 0.1) &&
      approxEqual(result.deltaB, c.expected.deltaB, 0.1);

    if (ok) {
      console.log(`  ✓ ${c.name.padEnd(40)} newA=${result.newA.toFixed(2)} newB=${result.newB.toFixed(2)} (Δ ${result.deltaA.toFixed(2)}/${result.deltaB.toFixed(2)})`);
      passed++;
    } else {
      console.log(`  ✗ ${c.name.padEnd(40)} got newA=${result.newA.toFixed(2)} newB=${result.newB.toFixed(2)} (Δ ${result.deltaA.toFixed(2)}/${result.deltaB.toFixed(2)}); expected newA=${c.expected.newA} newB=${c.expected.newB} (Δ ${c.expected.deltaA}/${c.expected.deltaB})`);
      failed++;
    }
  }

  // Symmetry: deltaA + deltaB ≈ 0 always
  for (const c of PURE_CASES) {
    const r = calculateNewRatings(c.input);
    if (!approxEqual(r.deltaA + r.deltaB, 0, 0.001)) {
      console.log(`  ✗ Symmetry violated for ${c.name}: Δ sum = ${r.deltaA + r.deltaB}`);
      failed++;
    }
  }
  console.log(`  ✓ Symmetry: deltaA + deltaB ≈ 0 for all cases`);
  passed++;

  // Validation errors
  const validationCases = [
    () => calculateNewRatings({ ratingA: 'foo', ratingB: 1200, scoreA: 1 }),
    () => calculateNewRatings({ ratingA: 1200, ratingB: NaN,   scoreA: 1 }),
    () => calculateNewRatings({ ratingA: 1200, ratingB: 1200,  scoreA: 0.7 }),
    () => calculateNewRatings({ ratingA: 1200, ratingB: 1200,  scoreA: 2 }),
    () => calculateNewRatings({ ratingA: 1200, ratingB: 1200,  scoreA: 1, K: -5 }),
  ];

  let valPassed = 0;
  for (const fn of validationCases) {
    try {
      fn();
      console.log(`  ✗ Expected throw, none happened`);
      failed++;
    } catch {
      valPassed++;
    }
  }
  console.log(`  ✓ Validation: ${valPassed}/${validationCases.length} bad inputs rejected`);
  if (valPassed === validationCases.length) passed++;
  else failed++;

  console.log(`\n  Phase A: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ============================================================================
// Phase B — DB integration
// ============================================================================

async function snapshotAllAgents() {
  return prisma.agent.findMany({
    select: { id: true, elo: true, wins: true, losses: true, draws: true },
  });
}

async function restoreAllAgents(snapshot) {
  for (const a of snapshot) {
    await prisma.agent.update({
      where: { id: a.id },
      data: { elo: a.elo, wins: a.wins, losses: a.losses, draws: a.draws },
    });
  }
}

async function cleanupTestDebates() {
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — elo module' } },
  });
  return swept.count;
}

async function runIntegrationTest() {
  console.log('\n=== PHASE B: DB integration ===\n');

  // Snapshot ALL agents — restore in finally even on failure.
  const snapshot = await snapshotAllAgents();
  console.log(`  Snapshotted ${snapshot.length} agents`);

  let createdDebateIds = [];

  try {
    // Find two agents to test with.
    const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });
    if (!agentA || !agentB) throw new Error('Need at least 2 agents');

    const beforeA = agentA.elo;
    const beforeB = agentB.elo;
    const beforeAffWins = agentA.wins;
    const beforeNegLosses = agentB.losses;

    console.log(`  Aff (${agentA.id}): elo=${beforeA} wins=${beforeAffWins}`);
    console.log(`  Neg (${agentB.id}): elo=${beforeB} losses=${beforeNegLosses}`);

    // Create a fake completed debate with evaluation. aff wins.
    const debate = await prisma.debate.create({
      data: {
        topic: 'TEST DEBATE — elo module integration. Trivial topic.',
        status: 'completed',
        winner: 'aff',
        completedAt: new Date(),
        affAgentId: agentA.id,
        negAgentId: agentB.id,
        evaluation: {
          create: {
            winner: 'aff',
            affArgument: 8, affEvidence: 8, affResponsive: 8, affPersuasion: 8, affTotal: 32,
            negArgument: 7, negEvidence: 7, negResponsive: 7, negPersuasion: 7, negTotal: 28,
            reasoning: 'Test evaluation reasoning, deliberately verbose enough to satisfy the minimum length requirement. The affirmative case is stronger. ' + 'Lorem ipsum '.repeat(20),
            judgeModel: 'claude-opus-4-7',
          },
        },
      },
    });
    createdDebateIds.push(debate.id);

    // Apply ELO.
    const result = await applyEloChange(debate.id);

    console.log(`  ELO applied:`);
    console.log(`    aff: ${result.aff.before} → ${result.aff.after} (Δ${result.aff.delta.toFixed(2)})`);
    console.log(`    neg: ${result.neg.before} → ${result.neg.after} (Δ${result.neg.delta.toFixed(2)})`);

    // Verify Agent rows updated.
    const aAfter = await prisma.agent.findUnique({ where: { id: agentA.id } });
    const bAfter = await prisma.agent.findUnique({ where: { id: agentB.id } });

    const fail = (m) => { throw new Error(m); };

    if (Math.abs(aAfter.elo - result.aff.after) > 0.01) fail('Aff agent elo mismatch in DB');
    if (Math.abs(bAfter.elo - result.neg.after) > 0.01) fail('Neg agent elo mismatch in DB');
    if (aAfter.wins !== beforeAffWins + 1) fail(`Aff wins should be ${beforeAffWins + 1}, got ${aAfter.wins}`);
    if (bAfter.losses !== beforeNegLosses + 1) fail(`Neg losses should be ${beforeNegLosses + 1}, got ${bAfter.losses}`);
    if (result.aff.delta <= 0) fail('Aff delta should be positive (aff won)');
    if (result.neg.delta >= 0) fail('Neg delta should be negative (neg lost)');
    if (Math.abs(result.aff.delta + result.neg.delta) > 0.01) fail('Deltas should sum to ~0');

    console.log('  ✓ Agent rows updated correctly');

    // Verify EloChange rows.
    const changes = await prisma.eloChange.findMany({ where: { debateId: debate.id } });
    if (changes.length !== 2) fail(`Expected 2 EloChange rows, got ${changes.length}`);
    for (const c of changes) {
      if (typeof c.before !== 'number' || typeof c.after !== 'number') fail('EloChange field types wrong');
    }
    console.log('  ✓ EloChange rows created (2)');

    // Idempotency: second call should throw.
    let secondCallThrew = false;
    try {
      await applyEloChange(debate.id);
    } catch (err) {
      if (err.message.includes('already applied')) secondCallThrew = true;
    }
    if (!secondCallThrew) fail('Second call should refuse to double-apply');
    console.log('  ✓ Refuses to double-apply');

    // Also verify draw and loss paths.
    // Draw:
    const drawDebate = await prisma.debate.create({
      data: {
        topic: 'TEST DEBATE — elo module integration. Draw case.',
        status: 'completed',
        winner: 'draw',
        completedAt: new Date(),
        affAgentId: agentA.id,
        negAgentId: agentB.id,
        evaluation: {
          create: {
            winner: 'draw',
            affArgument: 7.5, affEvidence: 7.5, affResponsive: 7.5, affPersuasion: 7.5, affTotal: 30,
            negArgument: 7.5, negEvidence: 7.5, negResponsive: 7.5, negPersuasion: 7.5, negTotal: 30,
            reasoning: 'Draw test. ' + 'Lorem ipsum '.repeat(30),
            judgeModel: 'claude-opus-4-7',
          },
        },
      },
    });
    createdDebateIds.push(drawDebate.id);

    const drawResult = await applyEloChange(drawDebate.id);
    const affAfterDraw = await prisma.agent.findUnique({ where: { id: agentA.id } });
    if (affAfterDraw.draws !== 1) fail(`Aff draws should be 1, got ${affAfterDraw.draws}`);
    if (Math.abs(drawResult.aff.delta + drawResult.neg.delta) > 0.01) fail('Draw deltas should sum to ~0');
    console.log('  ✓ Draw case: draws incremented on both sides');
  } finally {
    // Clean up debates first (cascade kills EloChange).
    if (createdDebateIds.length > 0) {
      await prisma.debate.deleteMany({ where: { id: { in: createdDebateIds } } });
      console.log(`  Cleaned up ${createdDebateIds.length} test debate(s)`);
    }
    await cleanupTestDebates();

    // Restore agent state.
    await restoreAllAgents(snapshot);
    console.log(`  Restored agent state for ${snapshot.length} agents`);
  }
}

// ============================================================================

(async () => {
  try {
    runPureTests();
    await runIntegrationTest();
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
