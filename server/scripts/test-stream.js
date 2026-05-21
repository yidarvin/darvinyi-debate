// End-to-end SSE streaming test.
//
// Requires:
//   - Dev server running on PORT (default 3001): `npm run dev` in /server
//   - DEBATE_KEYPHRASE configured in /server/.env
//
// Usage: cd server && node scripts/test-stream.js
//
// Override base URL or agent pairing via env:
//   BASE_URL=http://localhost:3001 node scripts/test-stream.js
//   AFF_AGENT_ID=claude-sonnet-4-6 NEG_AGENT_ID=gemini-2-5-pro node scripts/test-stream.js
//
// Cost: $0.50-$5.00 (default pairing is the cheapest, but still a full debate).

import 'dotenv/config';
import { prisma } from '../src/db.js';

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const KEYPHRASE = process.env.DEBATE_KEYPHRASE;
const TEST_TOPIC =
  'TEST DEBATE — SSE stream end-to-end. A four-day workweek would improve overall economic productivity in developed nations.';

if (!KEYPHRASE || KEYPHRASE === 'change_me_before_deploying') {
  console.error('DEBATE_KEYPHRASE must be set to a real value in /server/.env');
  process.exit(1);
}

// ============================================================================
// SSE parser — minimal, handles the wire format we emit.
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

      // Skip heartbeat comments
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
// Pre-flight checks
// ============================================================================

async function preflightAuth() {
  console.log('\n=== PHASE A: Auth and validation ===');

  // No key → 401
  let r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TEST_TOPIC }),
  });
  console.assert(r.status === 401, `No-key POST expected 401, got ${r.status}`);
  console.log('  ✓ POST without key → 401');

  // Wrong key → 401
  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': 'wrong-key' },
    body: JSON.stringify({ topic: TEST_TOPIC }),
  });
  console.assert(r.status === 401, `Wrong-key POST expected 401, got ${r.status}`);
  console.log('  ✓ POST with wrong key → 401');

  // Empty topic → 400
  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ topic: '' }),
  });
  console.assert(r.status === 400, `Empty-topic expected 400, got ${r.status}`);
  console.log('  ✓ POST with empty topic → 400');

  // Too-long topic → 400
  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ topic: 'x'.repeat(501) }),
  });
  console.assert(r.status === 400, `Too-long topic expected 400, got ${r.status}`);
  console.log('  ✓ POST with >500-char topic → 400');

  // Nonexistent rerun → 404
  r = await fetch(`${BASE_URL}/api/debates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debate-Key': KEYPHRASE },
    body: JSON.stringify({ rerunOf: 'nonexistent-debate-id' }),
  });
  console.assert(r.status === 404, `Nonexistent rerunOf expected 404, got ${r.status}`);
  console.log('  ✓ POST with nonexistent rerunOf → 404');

  // Stream of nonexistent debate → 404
  r = await fetch(`${BASE_URL}/api/debates/nonexistent-debate-id/stream`);
  console.assert(r.status === 404, `Nonexistent stream expected 404, got ${r.status}`);
  console.log('  ✓ GET /:nonexistent/stream → 404');
}

// ============================================================================
// End-to-end streaming
// ============================================================================

async function endToEndStream() {
  console.log('\n=== PHASE B: End-to-end live stream ===');

  // 1. Create debate.
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

  // 2. Open the stream.
  const streamRes = await fetch(`${BASE_URL}/api/debates/${debateId}/stream`);
  console.assert(streamRes.status === 200, `Stream status expected 200, got ${streamRes.status}`);
  console.assert(
    streamRes.headers.get('content-type')?.includes('text/event-stream'),
    `Expected text/event-stream content-type, got ${streamRes.headers.get('content-type')}`,
  );
  console.log('  Stream opened (200, text/event-stream)');

  // 3. Consume events.
  const counts = {
    debate_start: 0,
    text_delta: 0,
    tool_call_start: 0,
    tool_call_end: 0,
    round_complete: 0,
    all_rounds_complete: 0,
    debate_complete: 0,
    error: 0,
  };

  const roundsSeen = new Set();
  let lastRound = null;
  const start = Date.now();

  for await (const event of parseSSE(streamRes)) {
    counts[event.type] = (counts[event.type] || 0) + 1;

    if (event.type === 'round_complete') {
      roundsSeen.add(event.data.round);
      if (event.data.round !== lastRound) {
        process.stdout.write(
          `\n  ✓ Round ${event.data.round} (${event.data.side}) — ${event.data.content?.length ?? 0} chars`,
        );
        lastRound = event.data.round;
      }
    } else if (event.type === 'text_delta') {
      if (counts.text_delta % 50 === 0) process.stdout.write('.');
    } else if (event.type === 'tool_call_start') {
      process.stdout.write(`\n    → ${event.data.tool}`);
    } else if (event.type === 'tool_call_end') {
      process.stdout.write(`\n    ← ${event.data.tool}: ${event.data.outputSummary}`);
    } else if (event.type === 'all_rounds_complete') {
      process.stdout.write('\n  ✓ all_rounds_complete');
    } else if (event.type === 'debate_complete') {
      process.stdout.write('\n  ✓ debate_complete');
      console.log(
        `\n     Identities: aff=${event.data.affAgent?.displayName}, neg=${event.data.negAgent?.displayName}`,
      );
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

  // Assertions
  const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

  if (counts.debate_start !== 1) fail(`Expected 1 debate_start, got ${counts.debate_start}`);
  if (roundsSeen.size !== 6) fail(`Expected 6 rounds, got ${roundsSeen.size}`);
  if (counts.all_rounds_complete !== 1) fail(`Expected 1 all_rounds_complete, got ${counts.all_rounds_complete}`);
  if (counts.debate_complete !== 1) fail(`Expected 1 debate_complete, got ${counts.debate_complete}`);
  if (counts.text_delta < 50) fail(`Expected substantial text streaming, got ${counts.text_delta} deltas`);
  if (counts.error !== 0) fail(`Expected no error events, got ${counts.error}`);

  console.log('\n  ✓ All assertions passed');

  return debateId;
}

// ============================================================================
// Replay test — re-opening the stream on a completed debate
// ============================================================================

async function replayCompleted(debateId) {
  console.log('\n=== PHASE C: Replay completed debate via stream ===');

  // The debate should now be in_progress (orchestrator finished, judge not run).
  // For Prompt 12 we accept that state. Phase C verifies the in_progress path:
  // the stream replays saved turns and emits an info-level error message.
  const streamRes = await fetch(`${BASE_URL}/api/debates/${debateId}/stream`);
  console.assert(streamRes.status === 200, `Re-stream status expected 200, got ${streamRes.status}`);

  const eventTypes = [];
  let firstError = null;

  for await (const event of parseSSE(streamRes)) {
    eventTypes.push(event.type);
    if (event.type === 'error' && !firstError) {
      firstError = event.data.message;
    }
  }

  console.log(`  Event types received: ${eventTypes.join(', ')}`);
  if (firstError) console.log(`  First error message: ${firstError}`);

  console.assert(eventTypes.includes('debate_start'), 'Replay missing debate_start');
  console.assert(eventTypes.filter((t) => t === 'round_complete').length === 6, 'Replay missing 6 round_complete events');

  console.log('  ✓ Replay returned saved turns');
}

// ============================================================================
// Cleanup
// ============================================================================

async function cleanup() {
  console.log('\n=== CLEANUP ===');
  const swept = await prisma.debate.deleteMany({
    where: { topic: { startsWith: 'TEST DEBATE — SSE stream' } },
  });
  console.log(`  Swept ${swept.count} test debate(s).`);
}

// ============================================================================
// Main
// ============================================================================

(async () => {
  let debateId = null;
  try {
    await preflightAuth();
    debateId = await endToEndStream();
    if (debateId) await replayCompleted(debateId);
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
})();
