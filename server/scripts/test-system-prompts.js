// Smoke test for /server/src/agents/systemPrompts.js.
// Run: cd server && node scripts/test-system-prompts.js

import {
  buildDebaterSystemPrompt,
  buildJudgePrompt,
} from '../src/agents/systemPrompts.js';

let passed = 0;
let failed = 0;

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function assertThrows(label, fn, expectedSubstring = '') {
  try {
    fn();
    console.log(`  ✗ ${label} — did not throw`);
    failed++;
  } catch (err) {
    if (!expectedSubstring || err.message.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.log(`  ✗ ${label} — wrong error: ${err.message}`);
      failed++;
    }
  }
}

// ===== buildDebaterSystemPrompt =====
console.log('buildDebaterSystemPrompt:');

const debaterPrompt = buildDebaterSystemPrompt({
  side: 'aff',
  topic: 'A four-day workweek would improve overall economic productivity in developed nations.',
  roundName: 'Affirmative Constructive',
  roundNumber: 1,
  roundDescription: 'Open the case FOR the proposition. Lay out your strongest 2–4 arguments.',
  wordLimit: 800,
});

assert('returns non-empty string', typeof debaterPrompt === 'string' && debaterPrompt.length > 500);
assert('contains topic', debaterPrompt.includes('A four-day workweek would improve'));
assert('contains AFFIRMATIVE label', debaterPrompt.includes('YOUR ASSIGNED SIDE: AFFIRMATIVE'));
assert('contains round number and name', debaterPrompt.includes('Round 1 of 6 — Affirmative Constructive'));
assert('contains word limit', debaterPrompt.includes('WORD LIMIT: 800 words'));
assert('contains round description', debaterPrompt.includes('Lay out your strongest 2–4 arguments'));
assert('contains "non-negotiable" assignment language', debaterPrompt.includes('non-negotiable'));
assert('contains tool reference (web_search)', debaterPrompt.includes('web_search'));
assert('contains tool reference (web_fetch)', debaterPrompt.includes('web_fetch'));
assert('contains "Begin your response now"', debaterPrompt.includes('Begin your response now'));

const negPrompt = buildDebaterSystemPrompt({
  side: 'neg',
  topic: 'Some topic',
  roundName: 'Negative Rebuttal',
  roundNumber: 4,
  roundDescription: 'Defend your case.',
  wordLimit: 700,
});
assert('NEGATIVE side label flips correctly', negPrompt.includes('YOUR ASSIGNED SIDE: NEGATIVE'));

// Validation
assertThrows('rejects invalid side', () => buildDebaterSystemPrompt({
  side: 'maybe', topic: 't', roundName: 'r', roundNumber: 1, roundDescription: 'd', wordLimit: 500,
}), 'side must be');
assertThrows('rejects missing topic', () => buildDebaterSystemPrompt({
  side: 'aff', topic: '', roundName: 'r', roundNumber: 1, roundDescription: 'd', wordLimit: 500,
}), 'topic');
assertThrows('rejects roundNumber out of range', () => buildDebaterSystemPrompt({
  side: 'aff', topic: 't', roundName: 'r', roundNumber: 7, roundDescription: 'd', wordLimit: 500,
}), 'roundNumber');
assertThrows('rejects non-positive wordLimit', () => buildDebaterSystemPrompt({
  side: 'aff', topic: 't', roundName: 'r', roundNumber: 1, roundDescription: 'd', wordLimit: 0,
}), 'wordLimit');

// ===== buildJudgePrompt =====
console.log('\nbuildJudgePrompt:');

const sampleTurns = [1, 2, 3, 4, 5, 6].map((n) => ({
  roundNumber: n,
  roundName: ['Affirmative Constructive', 'Negative Constructive', 'Affirmative Rebuttal', 'Negative Rebuttal', 'Affirmative Closing', 'Negative Closing'][n - 1],
  side: n % 2 === 1 ? 'aff' : 'neg',
  content: `Test content for round ${n}. Sample argument body goes here.`,
}));

const judgePrompt = buildJudgePrompt({
  topic: 'A test proposition.',
  turns: sampleTurns,
});

assert('returns non-empty string', typeof judgePrompt === 'string' && judgePrompt.length > 1000);
assert('contains topic', judgePrompt.includes('A test proposition.'));
assert('contains all 6 round headers', [1, 2, 3, 4, 5, 6].every((n) => judgePrompt.includes(`ROUND ${n}`)));
assert('contains all 6 turn contents', [1, 2, 3, 4, 5, 6].every((n) => judgePrompt.includes(`Test content for round ${n}`)));
assert('contains AFFIRMATIVE and NEGATIVE labels', judgePrompt.includes('AFFIRMATIVE: AFFIRMATIVE CONSTRUCTIVE') && judgePrompt.includes('NEGATIVE: NEGATIVE CONSTRUCTIVE'));
assert('does NOT mention any agent identity', !/(claude|gpt|gemini|grok|opus|sonnet|anthropic|openai|google|xai)/i.test(judgePrompt));
assert('contains JSON schema instruction', judgePrompt.includes('"winner": "aff" | "neg" | "draw"'));
assert('contains rubric: argument', judgePrompt.includes('ARGUMENT QUALITY'));
assert('contains rubric: evidence', judgePrompt.includes('EVIDENCE'));
assert('contains rubric: responsiveness', judgePrompt.includes('RESPONSIVENESS'));
assert('contains rubric: persuasion', judgePrompt.includes('PERSUASION'));
assert('contains penalty language', judgePrompt.includes('PENALTIES'));

// Validation
assertThrows('rejects empty topic', () => buildJudgePrompt({ topic: '', turns: sampleTurns }), 'topic');
assertThrows('rejects wrong turn count', () => buildJudgePrompt({ topic: 't', turns: sampleTurns.slice(0, 5) }), 'exactly 6');

const outOfOrderTurns = [...sampleTurns];
[outOfOrderTurns[0], outOfOrderTurns[1]] = [outOfOrderTurns[1], outOfOrderTurns[0]];
assertThrows('rejects out-of-order turns', () => buildJudgePrompt({ topic: 't', turns: outOfOrderTurns }), 'roundNumber');

const emptyContentTurns = sampleTurns.map((t, i) => i === 2 ? { ...t, content: '' } : t);
assertThrows('rejects empty turn content', () => buildJudgePrompt({ topic: 't', turns: emptyContentTurns }), 'empty content');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
