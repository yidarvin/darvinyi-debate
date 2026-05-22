// Tests for the human vote system.
//   Phase A: AGREE path — vote matches judge, no ELO change, agreement recorded
//   Phase B: DISAGREE path — vote differs, ELO reversed + reapplied, override recorded
//   Phase C: ROUND-TRIP IDENTITY — judge picks aff, human flips to neg; final ELO
//            should equal what it would have been if neg had been declared winner
//            from the start. This is the critical invariant.
//   Phase D: DOUBLE VOTE refused
//   Phase E: VOTE ON UNCOMPLETED DEBATE refused
//
// Usage: cd server && node scripts/test-human-vote.js
//
// No LLM calls. Uses synthetic completed debates seeded directly.

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { applyEloChange } from '../src/elo/applyEloChange.js';
import { applyHumanVote } from '../src/elo/applyHumanVote.js';
import { calculateNewRatings } from '../src/elo/calculate.js';

const TOPIC_PREFIX = 'TEST DEBATE — human vote';

// ============================================================================
// Helpers
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
    where: { topic: { startsWith: TOPIC_PREFIX } },
  });
  return swept.count;
}

/**
 * Creates a synthetic completed debate with evaluation + EloChange rows.
 * Returns the debateId. Uses the two first agents by id-alphabetical sort.
 */
async function createSyntheticCompletedDebate({ topicSuffix, judgeWinner }) {
  const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });

  const debate = await prisma.debate.create({
    data: {
      topic: `${TOPIC_PREFIX} ${topicSuffix}`,
      status: 'completed',
      winner: judgeWinner,
      completedAt: new Date(),
      affAgentId: agentA.id,
      negAgentId: agentB.id,
      evaluation: {
        create: {
          winner: judgeWinner,
          affArgument: 8, affEvidence: 8, affResponsive: 8, affPersuasion: 8, affTotal: 32,
          negArgument: 7, negEvidence: 7, negResponsive: 7, negPersuasion: 7, negTotal: 28,
          reasoning: 'Test reasoning ' + 'Lorem ipsum '.repeat(30),
          judgeModel: 'claude-opus-4-7',
        },
      },
    },
  });

  await applyEloChange(debate.id);
  return debate.id;
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

// ============================================================================
// Phase A — Agreement
// ============================================================================

async function phaseA() {
  console.log('\n=== PHASE A: AGREE path ===');

  const debateId = await createSyntheticCompletedDebate({ topicSuffix: 'phase-A', judgeWinner: 'aff' });

  const agentsBeforeVote = await prisma.agent.findMany();
  const eloChangesBefore = await prisma.eloChange.findMany({ where: { debateId } });
  if (eloChangesBefore.length !== 2) throw new Error('Expected 2 EloChange rows after applyEloChange');

  const result = await applyHumanVote(debateId, 'aff');

  console.log(`  agreed: ${result.agreed}, humanWinner: ${result.humanWinner}, judgeWinner: ${result.judgeWinner}`);
  if (!result.agreed) throw new Error('Expected agreed=true');
  if (result.finalWinner !== 'aff') throw new Error('Final winner should be aff');

  const agentsAfterVote = await prisma.agent.findMany();
  for (const before of agentsBeforeVote) {
    const after = agentsAfterVote.find((a) => a.id === before.id);
    if (!approxEqual(before.elo, after.elo)) {
      throw new Error(`Agent ${before.id} elo changed on agreement (${before.elo} → ${after.elo})`);
    }
    if (before.wins !== after.wins || before.losses !== after.losses || before.draws !== after.draws) {
      throw new Error(`Agent ${before.id} W/L/D changed on agreement`);
    }
  }
  console.log('  ✓ No ELO or W/L/D changes after agreement');

  const evaluation = await prisma.evaluation.findFirst({ where: { debateId } });
  if (evaluation.humanWinner !== 'aff') throw new Error('humanWinner not set');
  if (evaluation.humanAgreedWithJudge !== true) throw new Error('humanAgreedWithJudge should be true');
  if (!evaluation.humanVotedAt) throw new Error('humanVotedAt should be set');
  console.log('  ✓ Evaluation flags set correctly');

  return debateId;
}

// ============================================================================
// Phase B — Disagreement
// ============================================================================

async function phaseB() {
  console.log('\n=== PHASE B: DISAGREE path ===');

  const debateId = await createSyntheticCompletedDebate({ topicSuffix: 'phase-B', judgeWinner: 'aff' });

  const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });
  const affEloAfterJudge = agentA.elo;
  const negEloAfterJudge = agentB.elo;
  const affWinsAfterJudge = agentA.wins;
  const negLossesAfterJudge = agentB.losses;

  console.log(`  After judge: aff=${affEloAfterJudge.toFixed(2)} (${affWinsAfterJudge}W), neg=${negEloAfterJudge.toFixed(2)} (${negLossesAfterJudge}L)`);

  const result = await applyHumanVote(debateId, 'neg');

  console.log(`  agreed: ${result.agreed}, humanWinner: ${result.humanWinner}, judgeWinner: ${result.judgeWinner}`);
  if (result.agreed) throw new Error('Expected agreed=false');
  if (result.finalWinner !== 'neg') throw new Error('Final winner should be neg');

  const [agentAAfter, agentBAfter] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });

  console.log(`  After human:  aff=${agentAAfter.elo.toFixed(2)} (${agentAAfter.wins}W ${agentAAfter.losses}L), neg=${agentBAfter.elo.toFixed(2)} (${agentBAfter.wins}W ${agentBAfter.losses}L)`);

  // Aff should have lost ELO (no longer wins)
  if (agentAAfter.elo >= affEloAfterJudge) {
    throw new Error(`Aff elo should have decreased after override (was ${affEloAfterJudge}, now ${agentAAfter.elo})`);
  }
  if (agentAAfter.wins !== affWinsAfterJudge - 1) {
    throw new Error(`Aff wins should have decremented from ${affWinsAfterJudge} to ${affWinsAfterJudge - 1}, got ${agentAAfter.wins}`);
  }
  if (agentAAfter.losses !== agentA.losses - 0 + 1) {
    throw new Error(`Aff losses should have incremented`);
  }
  console.log('  ✓ Aff lost a win and gained a loss');

  // Neg should have gained ELO
  if (agentBAfter.elo <= negEloAfterJudge) {
    throw new Error(`Neg elo should have increased after override`);
  }
  if (agentBAfter.wins !== agentB.wins + 1) {
    throw new Error(`Neg wins should have incremented`);
  }
  if (agentBAfter.losses !== negLossesAfterJudge - 1) {
    throw new Error(`Neg losses should have decremented`);
  }
  console.log('  ✓ Neg gained a win and lost a loss');

  // EloChange rows should now reflect the new verdict
  const eloChanges = await prisma.eloChange.findMany({ where: { debateId } });
  if (eloChanges.length !== 2) throw new Error(`Expected 2 EloChange rows, got ${eloChanges.length}`);
  const affChange = eloChanges.find((c) => c.agentId === agentA.id);
  if (affChange.delta >= 0) throw new Error(`Aff EloChange.delta should be negative (aff lost), got ${affChange.delta}`);
  console.log('  ✓ New EloChange rows reflect neg-wins verdict');

  // Debate.winner should now be 'neg'
  const debate = await prisma.debate.findUnique({ where: { id: debateId } });
  if (debate.winner !== 'neg') throw new Error(`debate.winner should be 'neg', got ${debate.winner}`);
  console.log('  ✓ debate.winner updated to neg');

  // Evaluation flags
  const evaluation = await prisma.evaluation.findFirst({ where: { debateId } });
  if (evaluation.winner !== 'aff') throw new Error('evaluation.winner should still be aff (judge unchanged)');
  if (evaluation.humanWinner !== 'neg') throw new Error('evaluation.humanWinner should be neg');
  if (evaluation.humanAgreedWithJudge !== false) throw new Error('humanAgreedWithJudge should be false');
  console.log('  ✓ Evaluation: judge=aff, human=neg, agreed=false');

  return debateId;
}

// ============================================================================
// Phase C — Round-trip identity
// ============================================================================

async function phaseC() {
  console.log('\n=== PHASE C: ROUND-TRIP identity ===');
  console.log('  Setup: two fresh debates with identical starting state. Debate 1 has judge=aff');
  console.log('  then human flips to neg. Debate 2 has judge=neg directly. Final ELO must match.');

  // Snapshot original state.
  const snapshot = await snapshotAllAgents();

  // Path A: judge says aff, human flips to neg.
  const debate1Id = await createSyntheticCompletedDebate({ topicSuffix: 'phase-C-pathA', judgeWinner: 'aff' });
  await applyHumanVote(debate1Id, 'neg');
  const pathAResult = await prisma.agent.findMany({ orderBy: { id: 'asc' } });

  // Restore for Path B.
  await restoreAllAgents(snapshot);

  // Path B: judge says neg directly. No human vote.
  const debate2Id = await createSyntheticCompletedDebate({ topicSuffix: 'phase-C-pathB', judgeWinner: 'neg' });
  const pathBResult = await prisma.agent.findMany({ orderBy: { id: 'asc' } });

  // Compare.
  for (let i = 0; i < pathAResult.length; i++) {
    const a = pathAResult[i];
    const b = pathBResult[i];
    if (a.id !== b.id) throw new Error(`Mismatched agent order`);
    if (!approxEqual(a.elo, b.elo, 0.01)) {
      throw new Error(`Agent ${a.id} ELO mismatch: pathA=${a.elo} vs pathB=${b.elo} (diff ${(a.elo - b.elo).toFixed(4)})`);
    }
    if (a.wins !== b.wins) throw new Error(`Agent ${a.id} wins mismatch: pathA=${a.wins} pathB=${b.wins}`);
    if (a.losses !== b.losses) throw new Error(`Agent ${a.id} losses mismatch: pathA=${a.losses} pathB=${b.losses}`);
    if (a.draws !== b.draws) throw new Error(`Agent ${a.id} draws mismatch`);
  }

  console.log(`  ✓ Path A (judge=aff → human=neg) produces identical agent state to Path B (judge=neg directly)`);
  console.log(`    Both paths end at: ${pathAResult.map(a => `${a.id}=${a.elo.toFixed(2)}/${a.wins}W/${a.losses}L`).join(', ')}`);
}

// ============================================================================
// Phase D — Double vote refused
// ============================================================================

async function phaseD() {
  console.log('\n=== PHASE D: Double vote refused ===');

  const debateId = await createSyntheticCompletedDebate({ topicSuffix: 'phase-D', judgeWinner: 'aff' });
  await applyHumanVote(debateId, 'aff');

  let threw = false;
  try {
    await applyHumanVote(debateId, 'aff');
  } catch (err) {
    if (err.message.includes('already has a human vote')) threw = true;
    else throw err;
  }
  if (!threw) throw new Error('Second vote should have been refused');
  console.log('  ✓ Second vote on same debate refused with clear error');

  return debateId;
}

// ============================================================================
// Phase E — Vote on uncompleted debate refused
// ============================================================================

async function phaseE() {
  console.log('\n=== PHASE E: Vote on uncompleted debate refused ===');

  const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });

  const debate = await prisma.debate.create({
    data: {
      topic: `${TOPIC_PREFIX} phase-E-pending`,
      status: 'pending',
      affAgentId: agentA.id,
      negAgentId: agentB.id,
    },
  });

  let threw = false;
  try {
    await applyHumanVote(debate.id, 'aff');
  } catch (err) {
    if (err.message.includes('no evaluation') || err.message.includes('status')) threw = true;
    else throw err;
  }
  if (!threw) throw new Error('Vote on pending debate should have been refused');
  console.log('  ✓ Vote on pending debate refused');

  return debate.id;
}

// ============================================================================
// Main
// ============================================================================

(async () => {
  const snapshot = await snapshotAllAgents();
  console.log(`Snapshotted ${snapshot.length} agents for non-destructive testing.`);

  let createdIds = [];

  try {
    createdIds.push(await phaseA());
    createdIds.push(await phaseB());
    await phaseC();   // restores between paths internally; no top-level id to push
    createdIds.push(await phaseD());
    createdIds.push(await phaseE());

    console.log('\n=== ALL PHASES PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    await cleanupTestDebates();
    await restoreAllAgents(snapshot);
    console.log('Cleanup complete; agents restored.');
    await prisma.$disconnect();
  }
})();
