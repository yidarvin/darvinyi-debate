// Tests for the ELO module.
//
//   PHASE A: pure function (no DB). Verifies the formula against hand-computed
//           expected values from /context/ELO_SPEC.md.
//   PHASE B: end-to-end DB integration with two-leg matches. Creates a debate
//           with 2 evaluations, applies ELO based on the summed match outcome,
//           verifies agent rows + EloChange rows.
//
// Usage: cd server && node scripts/test-elo.js
//
// No LLM calls — this test is essentially free.

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { calculateNewRatings } from '../src/elo/calculate.js';
import { applyEloChange } from '../src/elo/applyEloChange.js';
import { computeMatchOutcome } from '../src/match/computeMatchOutcome.js';

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

  for (const c of PURE_CASES) {
    const r = calculateNewRatings(c.input);
    if (!approxEqual(r.deltaA + r.deltaB, 0, 0.001)) {
      console.log(`  ✗ Symmetry violated for ${c.name}: Δ sum = ${r.deltaA + r.deltaB}`);
      failed++;
    }
  }
  console.log(`  ✓ Symmetry: deltaA + deltaB ≈ 0 for all cases`);
  passed++;

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

  // computeMatchOutcome sanity
  {
    const out = computeMatchOutcome({
      eval1: { winner: 'aff', affTotal: 34, negTotal: 30 },
      eval2: { winner: 'neg', affTotal: 29, negTotal: 32 },
    });
    // aTotal = 34 + 32 = 66; bTotal = 30 + 29 = 59 → A wins.
    if (out.winner !== 'A' || out.aTotal !== 66 || out.bTotal !== 59) {
      console.log(`  ✗ computeMatchOutcome basic: got ${JSON.stringify(out)}`);
      failed++;
    } else {
      console.log(`  ✓ computeMatchOutcome basic: A wins with aTotal=66, bTotal=59`);
      passed++;
    }
  }
  {
    const out = computeMatchOutcome({
      eval1: { winner: 'aff', affTotal: 30, negTotal: 30 },
      eval2: { winner: 'neg', affTotal: 30, negTotal: 30 },
    });
    if (out.winner !== 'draw' || out.aTotal !== 60 || out.bTotal !== 60) {
      console.log(`  ✗ computeMatchOutcome tie: got ${JSON.stringify(out)}`);
      failed++;
    } else {
      console.log(`  ✓ computeMatchOutcome tie: draw with aTotal=bTotal=60`);
      passed++;
    }
  }

  console.log(`\n  Phase A: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ============================================================================
// Phase B — DB integration (two-leg match)
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

async function createTwoLegDebate({ topicSuffix, eval1Scores, eval2Scores, agentAId, agentBId }) {
  return prisma.debate.create({
    data: {
      topic: `TEST DEBATE — elo module ${topicSuffix}`,
      status: 'judging',
      agentAId,
      agentBId,
      evaluations: {
        create: [
          { leg: 1, ...eval1Scores, judgeModel: 'claude-opus-4-7' },
          { leg: 2, ...eval2Scores, judgeModel: 'claude-opus-4-7' },
        ],
      },
    },
  });
}

async function runIntegrationTest() {
  console.log('\n=== PHASE B: DB integration (two-leg) ===\n');

  const snapshot = await snapshotAllAgents();
  console.log(`  Snapshotted ${snapshot.length} agents`);

  let createdDebateIds = [];

  try {
    const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });
    if (!agentA || !agentB) throw new Error('Need at least 2 agents');

    const beforeA = agentA.elo;
    const beforeB = agentB.elo;
    const beforeAWins = agentA.wins;
    const beforeBLosses = agentB.losses;

    console.log(`  Agent A (${agentA.id}): elo=${beforeA} wins=${beforeAWins}`);
    console.log(`  Agent B (${agentB.id}): elo=${beforeB} losses=${beforeBLosses}`);

    // ---- Case 1: agent A wins the match ----
    // Leg 1 (A=aff): aff=34, neg=30. Aff wins.
    // Leg 2 (A=neg): aff=29, neg=32. Neg wins (A wins this leg too as neg).
    // aTotal = 34 + 32 = 66; bTotal = 30 + 29 = 59. A wins.
    const debateAWin = await createTwoLegDebate({
      topicSuffix: 'a-wins',
      agentAId: agentA.id,
      agentBId: agentB.id,
      eval1Scores: {
        winner: 'aff',
        affArgument: 8.5, affEvidence: 8.5, affResponsive: 8.5, affPersuasion: 8.5, affTotal: 34,
        negArgument: 7.5, negEvidence: 7.5, negResponsive: 7.5, negPersuasion: 7.5, negTotal: 30,
        reasoning: 'Leg 1 reasoning. ' + 'Lorem ipsum '.repeat(20),
      },
      eval2Scores: {
        winner: 'neg',
        affArgument: 7.25, affEvidence: 7.25, affResponsive: 7.25, affPersuasion: 7.25, affTotal: 29,
        negArgument: 8.0, negEvidence: 8.0, negResponsive: 8.0, negPersuasion: 8.0, negTotal: 32,
        reasoning: 'Leg 2 reasoning. ' + 'Lorem ipsum '.repeat(20),
      },
    });
    createdDebateIds.push(debateAWin.id);

    const result = await applyEloChange(debateAWin.id);

    console.log(`\n  Case 1 — A wins:`);
    console.log(`    outcome: ${result.outcome.winner} (aTotal=${result.outcome.aTotal}, bTotal=${result.outcome.bTotal})`);
    for (const c of result.eloChanges) {
      console.log(`    ${c.agentId}: ${c.before} → ${c.after} (Δ${c.delta.toFixed(2)})`);
    }

    if (result.outcome.winner !== 'A') throw new Error(`Expected match winner A, got ${result.outcome.winner}`);
    if (result.outcome.aTotal !== 66) throw new Error(`aTotal expected 66, got ${result.outcome.aTotal}`);
    if (result.outcome.bTotal !== 59) throw new Error(`bTotal expected 59, got ${result.outcome.bTotal}`);

    const aAfter = await prisma.agent.findUnique({ where: { id: agentA.id } });
    const bAfter = await prisma.agent.findUnique({ where: { id: agentB.id } });

    const fail = (m) => { throw new Error(m); };

    if (aAfter.wins !== beforeAWins + 1) fail(`A.wins should be ${beforeAWins + 1}, got ${aAfter.wins}`);
    if (bAfter.losses !== beforeBLosses + 1) fail(`B.losses should be ${beforeBLosses + 1}, got ${bAfter.losses}`);
    if (aAfter.elo <= beforeA) fail(`A.elo should have increased`);
    if (bAfter.elo >= beforeB) fail(`B.elo should have decreased`);

    const dbDebate = await prisma.debate.findUnique({ where: { id: debateAWin.id } });
    if (dbDebate.status !== 'completed') fail(`debate.status should be 'completed', got '${dbDebate.status}'`);
    if (dbDebate.winner !== 'A') fail(`debate.winner should be 'A', got '${dbDebate.winner}'`);
    if (!dbDebate.completedAt) fail('completedAt should be set');

    console.log('  ✓ Agent rows updated, debate marked completed with winner A');

    // Idempotency
    let secondCallThrew = false;
    try {
      await applyEloChange(debateAWin.id);
    } catch (err) {
      if (err.message.includes('already applied')) secondCallThrew = true;
    }
    if (!secondCallThrew) fail('Second call should refuse to double-apply');
    console.log('  ✓ Refuses to double-apply');

    // ---- Case 2: draw (equal totals) ----
    const debateDraw = await createTwoLegDebate({
      topicSuffix: 'draw',
      agentAId: agentA.id,
      agentBId: agentB.id,
      eval1Scores: {
        winner: 'draw',
        affArgument: 7.5, affEvidence: 7.5, affResponsive: 7.5, affPersuasion: 7.5, affTotal: 30,
        negArgument: 7.5, negEvidence: 7.5, negResponsive: 7.5, negPersuasion: 7.5, negTotal: 30,
        reasoning: 'Draw test leg 1. ' + 'Lorem ipsum '.repeat(20),
      },
      eval2Scores: {
        winner: 'draw',
        affArgument: 8, affEvidence: 8, affResponsive: 8, affPersuasion: 8, affTotal: 32,
        negArgument: 8, negEvidence: 8, negResponsive: 8, negPersuasion: 8, negTotal: 32,
        reasoning: 'Draw test leg 2. ' + 'Lorem ipsum '.repeat(20),
      },
    });
    createdDebateIds.push(debateDraw.id);

    const drawResult = await applyEloChange(debateDraw.id);
    console.log(`\n  Case 2 — draw: outcome=${drawResult.outcome.winner} aTotal=${drawResult.outcome.aTotal} bTotal=${drawResult.outcome.bTotal}`);
    if (drawResult.outcome.winner !== 'draw') fail(`Expected draw, got ${drawResult.outcome.winner}`);

    const aDraws = await prisma.agent.findUnique({ where: { id: agentA.id } });
    if (aDraws.draws !== 1) fail(`A.draws expected 1, got ${aDraws.draws}`);
    if (Math.abs(drawResult.eloChanges[0].delta + drawResult.eloChanges[1].delta) > 0.01)
      fail('Draw deltas should sum to ~0');
    console.log('  ✓ Draw: both agents draws+=1, deltas sum to ~0');

    // ---- Case 3: B wins ----
    const debateBWin = await createTwoLegDebate({
      topicSuffix: 'b-wins',
      agentAId: agentA.id,
      agentBId: agentB.id,
      eval1Scores: {
        winner: 'neg',
        affArgument: 7, affEvidence: 7, affResponsive: 7, affPersuasion: 7, affTotal: 28,
        negArgument: 8.5, negEvidence: 8.5, negResponsive: 8.5, negPersuasion: 8.5, negTotal: 34,
        reasoning: 'Leg 1 reasoning. ' + 'Lorem ipsum '.repeat(20),
      },
      eval2Scores: {
        winner: 'aff',
        affArgument: 8.5, affEvidence: 8.5, affResponsive: 8.5, affPersuasion: 8.5, affTotal: 34,
        negArgument: 7, negEvidence: 7, negResponsive: 7, negPersuasion: 7, negTotal: 28,
        reasoning: 'Leg 2 reasoning. ' + 'Lorem ipsum '.repeat(20),
      },
    });
    createdDebateIds.push(debateBWin.id);

    const bResult = await applyEloChange(debateBWin.id);
    console.log(`\n  Case 3 — B wins: outcome=${bResult.outcome.winner} aTotal=${bResult.outcome.aTotal} bTotal=${bResult.outcome.bTotal}`);
    if (bResult.outcome.winner !== 'B') fail(`Expected B winner, got ${bResult.outcome.winner}`);
    // aTotal = 28 + 28 = 56; bTotal = 34 + 34 = 68.
    if (bResult.outcome.aTotal !== 56) fail(`aTotal expected 56, got ${bResult.outcome.aTotal}`);
    if (bResult.outcome.bTotal !== 68) fail(`bTotal expected 68, got ${bResult.outcome.bTotal}`);
    console.log('  ✓ B-wins outcome computed correctly');
  } finally {
    if (createdDebateIds.length > 0) {
      await prisma.debate.deleteMany({ where: { id: { in: createdDebateIds } } });
      console.log(`\n  Cleaned up ${createdDebateIds.length} test debate(s)`);
    }
    await cleanupTestDebates();

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
