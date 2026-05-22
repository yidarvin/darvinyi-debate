// Inline unit tests for truncateToWordLimit.
//
// Usage: cd server && node scripts/test-truncate.js

import { truncateToWordLimit } from '../src/orchestrator/truncateToWordLimit.js';

let failed = 0;
function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('=== truncateToWordLimit ===');

assertEq(
  truncateToWordLimit('one two three four five', 10),
  { content: 'one two three four five', originalWordCount: 5, truncated: false },
  'under limit: passes through unchanged',
);

assertEq(
  truncateToWordLimit('one two three four five', 5),
  { content: 'one two three four five', originalWordCount: 5, truncated: false },
  'exactly at limit: not truncated',
);

assertEq(
  truncateToWordLimit('one two three four five six seven', 5),
  { content: 'one two three four five', originalWordCount: 7, truncated: true },
  'over limit: cuts after the Nth word',
);

assertEq(
  truncateToWordLimit('one  two   three\nfour\tfive six', 4),
  { content: 'one  two   three\nfour', originalWordCount: 6, truncated: true },
  'preserves original whitespace up to the cut',
);

assertEq(
  truncateToWordLimit('', 5),
  { content: '', originalWordCount: 0, truncated: false },
  'empty input',
);

assertEq(
  truncateToWordLimit('   leading whitespace then five more words after', 3),
  { content: '   leading whitespace then', originalWordCount: 7, truncated: true },
  'handles leading whitespace',
);

assertEq(
  truncateToWordLimit('hello world. another sentence here.', 2),
  { content: 'hello world.', originalWordCount: 5, truncated: true },
  'punctuation is part of the word',
);

try {
  truncateToWordLimit('whatever', 0);
  console.error('  ✗ rejects wordLimit=0 — should have thrown');
  failed++;
} catch {
  console.log('  ✓ rejects wordLimit=0');
}

try {
  truncateToWordLimit('whatever', -3);
  console.error('  ✗ rejects negative wordLimit — should have thrown');
  failed++;
} catch {
  console.log('  ✓ rejects negative wordLimit');
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
