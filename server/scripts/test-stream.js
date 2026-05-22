// End-to-end SSE streaming test for two-leg matches.
//
// Requires:
//   - Dev server running on PORT (default 3001): `npm run dev` in /server
//   - DEBATE_KEYPHRASE configured in /server/.env
//
// Usage: cd server && node scripts/test-stream.js
//
// Override base URL or agent pairing via env:
//   BASE_URL=http://localhost:3001 node scripts/test-stream.js
//   AGENT_A_ID=claude-sonnet-4-6 AGENT_B_ID=gemini-2-5-pro node scripts/test-stream.js
//
// Cost: $1.00-$10.00 (two-leg debate against real models).

import 'dotenv/config';
import { prisma } from '../src/db.js';

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const KEYPHRASE = process.env.DEBATE_KEYPHRASE;
const TEST_TOPIC =
  'TEST DEBATE — SSE stream end-to-end. A four-day workweek would improve overall economic productivity in developed nations.';

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

if (!KEYPHRASE || KEYPHRASE === 'change_me_before_deploying') {
  console.error('DEBATE_KEYPHRASE must be set to a real value in /server/.env');
  process.exit(1);
}

// ============================================================================
// SSE parser
// ============================================================================

async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex;
    while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      if (rawEvent.startsWith(':')) continue;

      let eventType = 'message';
      let dataLine = null;

      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine = line.slice(5).trim();
        }
      }

      if (dataLine === null) continue;

      let data;
      try {
        data = JSON.parse(dataLine);
      } catch {
        data = { raw: dataLine };
      }

      yield { type: eventType, data };
    }
  }
}

// ============================================================================
// Pre-flight
// ============================================================================

async function preflightAuth() {
  console.log('\n=== PHASE A: Auth and validation ===');

  let r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TEST_TOPIC }),
  });
  console.assert(r.status === 401, `No-key POST expected 401, got ${r.status}`);
  console.log('  ✓ POST without key → 401');

  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': 'wrong-key' },
    body: JSON.stringify({ topic: TEST_TOPIC }),
  });
  console.assert(r.status === 401, `Wrong-key POST expected 401, got ${r.status}`);
  console.log('  ✓ POST with wrong key → 401');

  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ topic: '' }),
  });
  console.assert(r.status === 400, `Empty-topic expected 400, got ${r.status}`);
  console.log('  ✓ POST with empty topic → 400');

  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ topic: 'x'.repeat(501) }),
  });
  console.assert(r.status === 400, `Too-long topic expected 400, got ${r.status}`);
  console.log('  ✓ POST with >500-char topic → 400');

  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ rerunOf: 'nonexistent-debate-id' }),
  });
  console.assert(r.status === 404, `Nonexistent rerunOf expected 404, got ${r.status}`);
  console.log('  ✓ POST with nonexistent rerunOf → 404');

  r = await fetch(`${BASE_URL}/api/debates/nonexistent-debate-id/stream`);
  console.assert(r.status === 404, `Nonexistent stream expected 404, got ${r.status}`);
  console.log('  ✓ GET /:nonexistent/stream → 404');
}

// ============================================================================
// End-to-end stream
// ============================================================================

async function endToEndStream() {
  console.log('\n=== PHASE B: End-to-end live stream (two-leg) ===');

  const createRes = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ topic: TEST_TOPIC }),
  });

  if (createRes.status !== 201) {
    const body = await createRes.text();
    throw new Error(`POST failed with ${createRes.status}: ${body}`);
  }

  const { debateId } = await createRes.json();
  console.log(`  Created debate: ${debateId}`);

  const streamRes = await fetch(`${BASE_URL}/api/debates/${debateId}/stream`);
  console.assert(streamRes.status === 200, `Stream status expected 200, got ${streamRes.status}`);
  console.assert(
    streamRes.headers.get('content-type')?.includes('text/event-stream'),
    `Expected text/event-stream content-type, got ${streamRes.headers.get('content-type')}`,
  );
  console.log('  Stream opened (200, text/event-stream)');

  const counts = {
    debate_start: 0,
    leg_start: 0,
    leg_complete: 0,
    text_delta: 0,
    tool_call_start: 0,
    tool_call_end: 0,
    round_complete: 0,
    all_legs_complete: 0,
    judge_thinking: 0,
    judge_text_delta: 0,
    evaluation_complete: 0,
    elo_updated: 0,
    debate_complete: 0,
    error: 0,
  };

  const roundsSeen = new Set();
  let lastRound = null;
  const start = Date.now();
  let finalDebateComplete = null;

  for await (const event of parseSSE(streamRes)) {
    counts[event.type] = (counts[event.type] || 0) + 1;

    if (event.type === 'round_complete') {
      roundsSeen.add(`${event.data.leg}.${event.data.round}`);
      const key = `${event.data.leg}.${event.data.round}`;
      if (key !== lastRound) {
        process.stdout.write(
          `\n  ✓ Leg ${event.data.leg} Round ${event.data.round} (${event.data.side}) — ${event.data.content?.length ?? 0} chars`,
        );
        lastRound = key;
      }
    } else if (event.type === 'text_delta') {
      if (counts.text_delta % 50 === 0) process.stdout.write('.');
    } else if (event.type === 'tool_call_start') {
      process.stdout.write(`\n    → ${event.data.tool}`);
    } else if (event.type === 'tool_call_end') {
      process.stdout.write(`\n    ← ${event.data.tool}: ${event.data.outputSummary}`);
    } else if (event.type === 'leg_start') {
      process.stdout.write(`\n  ▶ leg ${event.data.leg} start`);
    } else if (event.type === 'leg_complete') {
      process.stdout.write(`\n  ■ leg ${event.data.leg} complete`);
    } else if (event.type === 'all_legs_complete') {
      process.stdout.write('\n  ✓ all_legs_complete');
    } else if (event.type === 'judge_thinking') {
      process.stdout.write(`\n  ⚖  judge_thinking leg=${event.data.leg}`);
    } else if (event.type === 'evaluation_complete') {
      process.stdout.write(`\n  ⚖  evaluation_complete leg=${event.data.leg} → ${event.data.winner}`);
    } else if (event.type === 'elo_updated') {
      process.stdout.write('\n  📈 elo_updated');
    } else if (event.type === 'debate_complete') {
      process.stdout.write('\n  ✓ debate_complete');
      finalDebateComplete = event.data;
    } else if (event.type === 'error') {
      console.log(`\n  ! error: ${event.data.message}`);
    } else if (event.type === 'debate_start') {
      // pass
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n\n  Elapsed:   ${elapsed}s`);
  console.log(`  Counts:    ${JSON.stringify(counts)}`);
  console.log(`  Rounds:    ${[...roundsSeen].sort().join(', ')}`);

  if (finalDebateComplete) {
    console.log(`  Identities: A=${finalDebateComplete.agentA?.displayName}, B=${finalDebateComplete.agentB?.displayName}`);
    console.log(`  Match winner: ${finalDebateComplete.winner}`);
    if (finalDebateComplete.matchOutcome) {
      console.log(`  Match scores: aTotal=${finalDebateComplete.matchOutcome.aTotal}, bTotal=${finalDebateComplete.matchOutcome.bTotal}`);
      console.log(`  Per-leg winners: leg1=${finalDebateComplete.matchOutcome.leg1Winner}, leg2=${finalDebateComplete.matchOutcome.leg2Winner}`);
    }
  }

  const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

  if (counts.debate_start !== 1) fail(`Expected 1 debate_start, got ${counts.debate_start}`);
  if (counts.leg_start !== 2) fail(`Expected 2 leg_start, got ${counts.leg_start}`);
  if (counts.leg_complete !== 2) fail(`Expected 2 leg_complete, got ${counts.leg_complete}`);
  if (roundsSeen.size !== 12) fail(`Expected 12 rounds (6 per leg × 2), got ${roundsSeen.size}`);
  if (counts.all_legs_complete !== 1) fail(`Expected 1 all_legs_complete, got ${counts.all_legs_complete}`);
  if (counts.evaluation_complete !== 2) fail(`Expected 2 evaluation_complete, got ${counts.evaluation_complete}`);
  if (counts.debate_complete !== 1) fail(`Expected 1 debate_complete, got ${counts.debate_complete}`);
  if (counts.elo_updated !== 1) fail(`Expected 1 elo_updated, got ${counts.elo_updated}`);
  if (counts.text_delta < 50) fail(`Expected substantial text streaming, got ${counts.text_delta} deltas`);
  if (counts.error !== 0) fail(`Expected no error events, got ${counts.error}`);

  console.log('\n  ✓ All assertions passed');

  return debateId;
}

// ============================================================================
// Replay
// ============================================================================

async function replayCompleted(debateId) {
  console.log('\n=== PHASE C: Replay completed debate via stream ===');

  const streamRes = await fetch(`${BASE_URL}/api/debates/${debateId}/stream`);
  console.assert(streamRes.status === 200, `Re-stream status expected 200, got ${streamRes.status}`);

  const eventTypes = [];

  for await (const event of parseSSE(streamRes)) {
    eventTypes.push(event.type);
  }

  console.log(`  Event types received: ${eventTypes.join(', ')}`);

  console.assert(eventTypes.includes('debate_start'), 'Replay missing debate_start');
  console.assert(eventTypes.filter((t) => t === 'leg_start').length === 2, 'Replay missing 2 leg_start');
  console.assert(eventTypes.filter((t) => t === 'leg_complete').length === 2, 'Replay missing 2 leg_complete');
  console.assert(eventTypes.filter((t) => t === 'round_complete').length === 12, 'Replay missing 12 round_complete');
  console.assert(eventTypes.filter((t) => t === 'evaluation_complete').length === 2, 'Replay missing 2 evaluation_complete');
  console.assert(eventTypes.includes('debate_complete'), 'Replay missing debate_complete');

  console.log('  ✓ Replay returned saved turns + evaluations + reveal');
}

// ============================================================================

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — SSE stream' } },
  });
  console.log(`  Swept ${swept.count} test debate(s).`);
}

(async () => {
  let debateId = null;
  let agentSnapshot = null;
  try {
    agentSnapshot = await snapshotAllAgents();
    console.log(`Snapshotted ${agentSnapshot.length} agents for non-destructive testing.`);

    await preflightAuth();
    debateId = await endToEndStream();
    if (debateId) await replayCompleted(debateId);
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (agentSnapshot) {
      await restoreAllAgents(agentSnapshot);
      console.log(`Restored agent state for ${agentSnapshot.length} agents.`);
    }
    await prisma.$disconnect();
  }
})();
