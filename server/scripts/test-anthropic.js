// Smoke test for AnthropicAgent.
//
// Runs ONE debater turn against the real API. Verifies:
//   - Event stream emits text_delta, optionally tool_call_start/end, and exactly one turn_complete
//   - turn_complete has non-empty content
//   - Token counts are populated
//   - AbortController interrupts the stream cleanly
//
// Usage: cd server && node scripts/test-anthropic.js
//   (Optionally: MODEL=claude-opus-4-7 node scripts/test-anthropic.js)
//
// Cost: typically $0.01-$0.05 per run. Two runs (normal + abort test) = ~$0.02-$0.10.

import 'dotenv/config';
import { AnthropicAgent } from '../src/agents/AnthropicAgent.js';
import { buildDebaterSystemPrompt } from '../src/agents/systemPrompts.js';

const MODEL = process.env.MODEL || 'claude-sonnet-4-6'; // Sonnet is cheaper for testing

const testConfig = {
  id: MODEL,
  displayName: MODEL,
  provider: 'anthropic',
  modelId: MODEL,
  apiKey: process.env.ANTHROPIC_API_KEY,
};

const TOPIC = 'A four-day workweek would improve overall economic productivity in developed nations.';

const systemPrompt = buildDebaterSystemPrompt({
  side: 'aff',
  topic: TOPIC,
  roundName: 'Affirmative Constructive',
  roundNumber: 1,
  roundDescription:
    'Open the case FOR the proposition. Lay out your 2-3 strongest arguments with specific evidence. Be brief (200-400 words is fine for this test).',
  wordLimit: 400,
});

// ============================================================================
// Run 1: Normal completion
// ============================================================================

async function testNormalCompletion() {
  console.log('\n=== TEST 1: Normal completion ===\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set in /server/.env');
  }

  const agent = new AnthropicAgent(testConfig);

  const events = [];
  const textChunks = [];
  let turnComplete = null;

  let charCount = 0;

  for await (const ev of agent.runTurn({
    systemPrompt,
    conversation: [{ role: 'user', content: `Begin the Affirmative Constructive on: "${TOPIC}"` }],
  })) {
    events.push({ type: ev.type, ...('tool' in ev ? { tool: ev.tool } : {}) });

    if (ev.type === 'text_delta') {
      textChunks.push(ev.text);
      charCount += ev.text.length;
      // Visual progress without spamming
      if (charCount % 100 < ev.text.length) {
        process.stdout.write('.');
      }
    } else if (ev.type === 'tool_call_start') {
      process.stdout.write(`\n  → ${ev.tool} start: ${JSON.stringify(ev.input).slice(0, 80)}\n`);
    } else if (ev.type === 'tool_call_end') {
      process.stdout.write(`  ← ${ev.tool} end: ${ev.outputSummary}\n`);
    } else if (ev.type === 'turn_complete') {
      turnComplete = ev;
      process.stdout.write('\n');
    }
  }

  // Assertions
  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

  if (!turnComplete) fail('Did not receive turn_complete event');
  if (events.filter((e) => e.type === 'turn_complete').length !== 1) fail('turn_complete fired more than once');
  if (!turnComplete.content || turnComplete.content.length < 200) {
    fail(`turn_complete.content too short (${turnComplete.content?.length} chars)`);
  }
  if (typeof turnComplete.tokensIn !== 'number' || turnComplete.tokensIn === 0) fail('tokensIn not populated');
  if (typeof turnComplete.tokensOut !== 'number' || turnComplete.tokensOut === 0) fail('tokensOut not populated');
  if (typeof turnComplete.durationMs !== 'number' || turnComplete.durationMs < 100) fail('durationMs missing or unrealistic');

  console.log('\n--- TURN CONTENT (first 500 chars) ---');
  console.log(turnComplete.content.slice(0, 500));
  console.log(turnComplete.content.length > 500 ? '...[truncated]' : '');
  console.log('--- END TURN CONTENT ---\n');

  console.log(`✓ events: ${events.length} total`);
  console.log(`✓ text_delta count: ${events.filter((e) => e.type === 'text_delta').length}`);
  console.log(`✓ tool_call pairs: start=${events.filter((e) => e.type === 'tool_call_start').length}, end=${events.filter((e) => e.type === 'tool_call_end').length}`);
  console.log(`✓ tools used: ${turnComplete.toolCalls.map((t) => t.tool).join(', ') || '(none)'}`);
  console.log(`✓ content length: ${turnComplete.content.length} chars`);
  console.log(`✓ tokensIn: ${turnComplete.tokensIn}, tokensOut: ${turnComplete.tokensOut}`);
  console.log(`✓ duration: ${turnComplete.durationMs}ms`);
}

// ============================================================================
// Run 2: Abort mid-stream
// ============================================================================

async function testAbort() {
  console.log('\n=== TEST 2: Abort mid-stream ===\n');

  const agent = new AnthropicAgent(testConfig);
  const controller = new AbortController();

  // Abort after first 5 text deltas
  let textDeltaCount = 0;
  let aborted = false;
  let unexpectedEventsAfterAbort = 0;

  try {
    for await (const ev of agent.runTurn({
      systemPrompt,
      conversation: [{ role: 'user', content: `Begin the Affirmative Constructive on: "${TOPIC}"` }],
      signal: controller.signal,
    })) {
      if (aborted) {
        unexpectedEventsAfterAbort++;
        if (unexpectedEventsAfterAbort > 5) break; // safety
      }
      if (ev.type === 'text_delta') {
        textDeltaCount++;
        if (textDeltaCount === 5 && !aborted) {
          process.stdout.write('  Aborting after 5 text deltas...\n');
          aborted = true;
          controller.abort();
        }
      }
    }
    console.log('✗ Stream completed without throwing — abort may not be honored');
    process.exit(1);
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.toLowerCase().includes('abort')) {
      console.log(`✓ Stream aborted cleanly with: ${err.name} (${err.message})`);
    } else {
      console.error(`✗ Stream threw non-abort error: ${err.message}`);
      process.exit(1);
    }
  }

  if (unexpectedEventsAfterAbort > 0) {
    console.warn(`⚠ Saw ${unexpectedEventsAfterAbort} events after abort signal — adapter should stop emitting promptly`);
  } else {
    console.log('✓ No events emitted after abort signal');
  }
}

// ============================================================================
// Main
// ============================================================================

(async () => {
  try {
    await testNormalCompletion();
    await testAbort();
    console.log('\n=== ALL TESTS PASSED ===');
  } catch (err) {
    console.error('\nFAILED:', err);
    process.exit(1);
  }
})();
