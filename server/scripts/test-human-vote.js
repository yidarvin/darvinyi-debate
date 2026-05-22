// Tests for the per-leg human vote system.
//
// Human votes are agreement-tracking ONLY — they don't touch ELO or W/L/D.
// Phases:
//   A: AGREE     — vote matches judge for a leg, agreement recorded
//   B: DISAGREE  — vote differs, override recorded; ELO must NOT change
//   D: DOUBLE-VOTE per leg refused
//   E: VOTE on leg without evaluation refused
//
// Usage: cd server && node scripts/test-human-vote.js
//
// No LLM calls. Uses synthetic completed debates seeded directly.

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { applyEloChange } from '../src/elo/applyEloChange.js';
import { recordHumanVote } from '../src/elo/applyHumanVote.js';

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
 * Creates a synthetic completed two-leg debate with two evaluations + applies ELO.
 * Both legs have the same per-leg winner (specified by leg1Winner/leg2Winner).
 */
async function createSyntheticCompletedDebate({ topicSuffix, leg1Winner, leg2Winner }) {
  const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });

  // Make scores reflect the winners. Margin of 4 to keep things simple.
  const eval1 = scoresForWinner(leg1Winner);
  const eval2 = scoresForWinner(leg2Winner);

  const debate = await prisma.debate.create({
    data: {
      topic: `${TOPIC_PREFIX} ${topicSuffix}`,
      status: 'judging',
      agentAId: agentA.id,
      agentBId: agentB.id,
      evaluations: {
        create: [
          { leg: 1, ...eval1, judgeModel: 'claude-opus-4-7' },
          { leg: 2, ...eval2, judgeModel: 'claude-opus-4-7' },
        ],
      },
    },
  });

  await applyEloChange(debate.id);
  return debate.id;
}

function scoresForWinner(winner) {
  // 4 axes per side. Strong side gets 8s, weak gets 7s; draw is equal.
  if (winner === 'aff') {
    return {
      winner: 'aff',
      affArgument: 8, affEvidence: 8, affResponsive: 8, affPersuasion: 8, affTotal: 32,
      negArgument: 7, negEvidence: 7, negResponsive: 7, negPersuasion: 7, negTotal: 28,
      reasoning: `Reasoning aff. ` + 'Lorem ipsum '.repeat(30),
    };
  }
  if (winner === 'neg') {
    return {
      winner: 'neg',
      affArgument: 7, affEvidence: 7, affResponsive: 7, affPersuasion: 7, affTotal: 28,
      negArgument: 8, negEvidence: 8, negResponsive: 8, negPersuasion: 8, negTotal: 32,
      reasoning: `Reasoning neg. ` + 'Lorem ipsum '.repeat(30),
    };
  }
  return {
    winner: 'draw',
    affArgument: 7.5, affEvidence: 7.5, affResponsive: 7.5, affPersuasion: 7.5, affTotal: 30,
    negArgument: 7.5, negEvidence: 7.5, negResponsive: 7.5, negPersuasion: 7.5, negTotal: 30,
    reasoning: `Reasoning draw. ` + 'Lorem ipsum '.repeat(30),
  };
}

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

// ============================================================================
// Phase A — Agreement
// ============================================================================

async function phaseA() {
  console.log('\n=== PHASE A: AGREE path ===');

  const debateId = await createSyntheticCompletedDebate({
    topicSuffix: 'phase-A',
    leg1Winner: 'aff',
    leg2Winner: 'neg',
  });

  const agentsBeforeVote = await prisma.agent.findMany();

  const result = await recordHumanVote(debateId, 1, 'aff');

  console.log(`  Leg 1 vote — agreed: ${result.agreed}, humanWinner: ${result.humanWinner}, judgeWinner: ${result.judgeWinner}`);
  if (!result.agreed) throw new Error('Expected agreed=true');
  if (result.leg !== 1) throw new Error(`leg expected 1, got ${result.leg}`);

  const agentsAfterVote = await prisma.agent.findMany();
  for (const before of agentsBeforeVote) {
    const after = agentsAfterVote.find((a) => a.id === before.id);
    if (!approxEqual(before.elo, after.elo)) {
      throw new Error(`Agent ${before.id} elo changed on vote (${before.elo} → ${after.elo})`);
    }
    if (before.wins !== after.wins || before.losses !== after.losses || before.draws !== after.draws) {
      throw new Error(`Agent ${before.id} W/L/D changed on vote`);
    }
  }
  console.log('  ✓ No ELO or W/L/D changes on vote');

  const evaluations = await prisma.evaluation.findMany({ where: { debateId }, orderBy: { leg: 'asc' } });
  const leg1Eval = evaluations[0];
  const leg2Eval = evaluations[1];
  if (leg1Eval.humanWinner !== 'aff') throw new Error('leg1 humanWinner not set');
  if (leg1Eval.humanAgreedWithJudge !== true) throw new Error('leg1 humanAgreedWithJudge should be true');
  if (!leg1Eval.humanVotedAt) throw new Error('leg1 humanVotedAt should be set');
  if (leg2Eval.humanWinner !== null) throw new Error('leg2 humanWinner should still be null');
  console.log('  ✓ Leg 1 evaluation flags set; leg 2 unaffected');

  return debateId;
}

// ============================================================================
// Phase B — Disagreement
// ============================================================================

async function phaseB() {
  console.log('\n=== PHASE B: DISAGREE path ===');

  const debateId = await createSyntheticCompletedDebate({
    topicSuffix: 'phase-B',
    leg1Winner: 'aff',
    leg2Winner: 'neg',
  });

  const agentsBefore = await prisma.agent.findMany();
  const debateBefore = await prisma.debate.findUnique({ where: { id: debateId } });

  const result = await recordHumanVote(debateId, 2, 'aff');

  console.log(`  Leg 2 vote (neg→aff) — agreed: ${result.agreed}`);
  if (result.agreed) throw new Error('Expected agreed=false');
  if (result.leg !== 2) throw new Error(`leg expected 2, got ${result.leg}`);

  // Verify ELO/W/L/D didn't change
  const agentsAfter = await prisma.agent.findMany();
  for (const before of agentsBefore) {
    const after = agentsAfter.find((a) => a.id === before.id);
    if (!approxEqual(before.elo, after.elo)) {
      throw new Error(`Agent ${before.id} elo changed on disagree vote (${before.elo} → ${after.elo})`);
    }
    if (before.wins !== after.wins || before.losses !== after.losses || before.draws !== after.draws) {
      throw new Error(`Agent ${before.id} W/L/D changed on disagree vote`);
    }
  }
  console.log('  ✓ No ELO or W/L/D changes on disagree (votes are tracking-only)');

  // Debate.winner should be unchanged
  const debateAfter = await prisma.debate.findUnique({ where: { id: debateId } });
  if (debateAfter.winner !== debateBefore.winner)
    throw new Error(`debate.winner changed (${debateBefore.winner} → ${debateAfter.winner}); votes must not affect match outcome`);
  console.log('  ✓ debate.winner unchanged by vote');

  const evaluations = await prisma.evaluation.findMany({ where: { debateId }, orderBy: { leg: 'asc' } });
  if (evaluations[1].winner !== 'neg') throw new Error('judge verdict should remain neg');
  if (evaluations[1].humanWinner !== 'aff') throw new Error('humanWinner should be aff');
  if (evaluations[1].humanAgreedWithJudge !== false) throw new Error('humanAgreedWithJudge should be false');
  console.log('  ✓ Leg 2 evaluation: judge=neg, human=aff, agreed=false');

  return debateId;
}

// ============================================================================
// Phase D — Double vote on same leg refused
// ============================================================================

async function phaseD() {
  console.log('\n=== PHASE D: Double-vote on same leg refused ===');

  const debateId = await createSyntheticCompletedDebate({
    topicSuffix: 'phase-D',
    leg1Winner: 'aff',
    leg2Winner: 'aff',
  });

  await recordHumanVote(debateId, 1, 'aff');

  let threw = false;
  try {
    await recordHumanVote(debateId, 1, 'aff');
  } catch (err) {
    if (err.message.includes('already has a human vote')) threw = true;
    else throw err;
  }
  if (!threw) throw new Error('Second vote on same leg should have been refused');
  console.log('  ✓ Second vote on leg 1 refused');

  // Voting on leg 2 should still work.
  const r2 = await recordHumanVote(debateId, 2, 'neg');
  if (r2.leg !== 2) throw new Error('Leg 2 vote failed');
  console.log('  ✓ Leg 2 vote still allowed (independent of leg 1)');

  return debateId;
}

// ============================================================================
// Phase E — Vote on leg without evaluation refused
// ============================================================================

async function phaseE() {
  console.log('\n=== PHASE E: Vote on leg without evaluation refused ===');

  const [agentA, agentB] = await prisma.agent.findMany({ take: 2, orderBy: { id: 'asc' } });

  const debate = await prisma.debate.create({
    data: {
      topic: `${TOPIC_PREFIX} phase-E-pending`,
      status: 'pending',
      agentAId: agentA.id,
      agentBId: agentB.id,
    },
  });

  let threw = false;
  try {
    await recordHumanVote(debate.id, 1, 'aff');
  } catch (err) {
    if (err.message.includes('No evaluation found')) threw = true;
    else throw err;
  }
  if (!threw) throw new Error('Vote on debate without evaluations should have been refused');
  console.log('  ✓ Vote on leg without evaluation refused');

  // Invalid leg value
  threw = false;
  try {
    await recordHumanVote(debate.id, 3, 'aff');
  } catch (err) {
    if (err.message.includes('leg must be')) threw = true;
    else throw err;
  }
  if (!threw) throw new Error('Vote on leg=3 should have been refused');
  console.log('  ✓ Invalid leg value refused');

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
