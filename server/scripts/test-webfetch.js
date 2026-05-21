// Smoke test for /server/src/tools/webFetch.js.
//
// Tests against real URLs — requires internet connectivity.
// Run: cd server && node scripts/test-webfetch.js

import { webFetch, summarizeWebFetchResult } from '../src/tools/webFetch.js';

const tests = [
  {
    name: 'happy path — small page',
    url: 'https://example.com',
    expect: (r) => r.text && r.text.includes('Example Domain') && !r.error,
  },
  {
    name: 'large page — should be truncated',
    url: 'https://en.wikipedia.org/wiki/Lincoln%E2%80%93Douglas_debates',
    expect: (r) => r.text && r.truncated === true && !r.error,
  },
  {
    name: 'invalid URL scheme — file://',
    url: 'file:///etc/passwd',
    expect: (r) => r.error && r.error.includes('scheme'),
  },
  {
    name: 'malformed URL',
    url: 'not a url at all',
    expect: (r) => r.error && r.error.includes('Invalid URL'),
  },
  {
    name: '404 response',
    url: 'https://httpbin.org/status/404',
    expect: (r) => r.error && r.error.includes('404'),
  },
  {
    name: 'unreachable host',
    url: 'https://this-domain-definitely-does-not-exist-12345.example',
    expect: (r) => Boolean(r.error),
  },
  {
    name: 'empty string',
    url: '',
    expect: (r) => r.error && r.error.toLowerCase().includes('required'),
  },
];

async function main() {
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`[${test.name}] ... `);
    const result = await webFetch(test.url);
    const summary = summarizeWebFetchResult(result);
    if (test.expect(result)) {
      console.log(`PASS — ${summary}`);
      passed++;
    } else {
      console.log(`FAIL — ${summary}`);
      console.log('  Result:', JSON.stringify(result, null, 2).slice(0, 500));
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
