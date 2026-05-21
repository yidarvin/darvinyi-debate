// Universal web_fetch tool.
//
// Every provider adapter exposes this tool to its model using the provider's
// native function-tool format. When the model calls it, the adapter invokes
// webFetch(url) here and submits the result back to the model.
//
// Contract (from /context/AGENT_SPEC.md):
//   - http or https URLs only
//   - 10-second total timeout
//   - 5MB response body cap (streams and aborts on exceed)
//   - User-Agent identifies this app
//   - HTML parsed with cheerio, noise tags stripped (script/style/nav/footer/aside/form/header/iframe/noscript)
//   - Main content extracted from <article>, falling back to <main>, falling back to <body>
//   - Whitespace collapsed, truncated to 5000 chars (truncated flag set if cut)
//   - NEVER throws — always returns { url, ... } object
//
// Return shapes:
//   Success: { url, title, text, truncated }
//   Failure: { url, error }

import { fetch } from 'undici';
import * as cheerio from 'cheerio';

const MAX_RESPONSE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 5000;
const USER_AGENT = 'DebateArena/1.0 (+https://debate.darvinyi.com)';

export const WEB_FETCH_TOOL_SCHEMA = Object.freeze({
  name: 'web_fetch',
  description:
    'Fetch the text content of a web page by URL. Returns up to 5000 characters of cleaned main text. Useful when web_search results indicate a specific URL is worth reading in full.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch. Must be http or https.',
      },
    },
    required: ['url'],
  },
});

/**
 * Fetch and clean a web page's main text content.
 *
 * @param {string} url
 * @returns {Promise<{url: string, title?: string, text?: string, truncated?: boolean, error?: string}>}
 */
export async function webFetch(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return { url: String(url ?? ''), error: 'URL is required and must be a string' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, error: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url, error: `URL scheme must be http or https (got ${parsed.protocol})` };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      return { url, error: `HTTP ${response.status} ${response.statusText}` };
    }

    // Stream the body, enforcing the 5MB cap. async iteration on web ReadableStream
    // works in Node 20+, which is the project's minimum.
    let received = 0;
    const chunks = [];

    for await (const chunk of response.body) {
      received += chunk.byteLength;
      if (received > MAX_RESPONSE_SIZE_BYTES) {
        controller.abort();
        return { url, error: 'Response exceeded 5MB limit' };
      }
      chunks.push(chunk);
    }

    const html = Buffer.concat(chunks).toString('utf8');

    // Parse and strip noise.
    const $ = cheerio.load(html);
    $('script, style, nav, footer, aside, form, header, iframe, noscript').remove();

    // Pick the best main-content container available.
    let $main = $('article').first();
    if ($main.length === 0) $main = $('main').first();
    if ($main.length === 0) $main = $('body');

    // Extract text, collapse whitespace, trim.
    let text = $main
      .text()
      .replace(/[\s ]+/g, ' ')
      .trim();

    let truncated = false;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS).trimEnd() + '…';
      truncated = true;
    }

    const title = ($('title').first().text() || '').trim() || undefined;

    return { url, title, text, truncated };
  } catch (err) {
    if (err.name === 'AbortError') {
      // Could be either the timeout firing or the size guard aborting; the size
      // guard returns above before reaching this catch, so this is the timeout case.
      return { url, error: `Request timed out after ${FETCH_TIMEOUT_MS / 1000} seconds` };
    }
    return { url, error: err.message || 'Fetch failed' };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Format a webFetch result into a short human-readable outputSummary string
 * suitable for the `tool_call_end` event's outputSummary field.
 *
 * @param {Awaited<ReturnType<typeof webFetch>>} result
 * @returns {string}
 */
export function summarizeWebFetchResult(result) {
  if (result.error) {
    return `Fetch failed: ${result.error}`;
  }
  const titlePart = result.title ? ` "${result.title}"` : '';
  const truncPart = result.truncated ? ', truncated' : '';
  return `Fetched${titlePart} (${result.text.length} chars${truncPart})`;
}
