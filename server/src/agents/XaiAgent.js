// xAI adapter for the AgentRunner contract.
//
// xAI's API is OpenAI-compatible: we use the `openai` Node SDK with baseURL
// pointed at xAI's endpoint. Chat Completions only (no Responses API at xAI).
//
// Tools exposed:
//   - web_search: xAI Live Search via `search_parameters` in the request body.
//                 Citations are returned out-of-band and synthesized into a
//                 single web_search tool_call_start/end pair per turn.
//   - web_fetch:  standard OpenAI function tool wrapping webFetch().

import OpenAI from 'openai';
import { AgentRunner } from './AgentRunner.js';
import { webFetch, summarizeWebFetchResult, WEB_FETCH_TOOL_SCHEMA } from '../tools/webFetch.js';

const XAI_BASE_URL = 'https://api.x.ai/v1';
const MAX_OUTPUT_TOKENS = 4096;

// Live Search configuration. `mode: 'auto'` lets Grok decide whether to search.
const LIVE_SEARCH_PARAMETERS = {
  mode: 'auto',
  return_citations: true,
};

export class XaiAgent extends AgentRunner {
  constructor(config) {
    super(config);
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: XAI_BASE_URL,
    });
  }

  async *runTurn({ systemPrompt, conversation, signal, maxIterations = 8 }) {
    const startTime = Date.now();
    let accumulatedText = '';
    const allToolCalls = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    // Track whether we've already synthesized a web_search event so we don't
    // double-emit if multiple iterations each produce citations.
    let webSearchAnnounced = false;

    // Convert conversation to Chat Completions messages with system prompt at the front.
    const messages = [{ role: 'system', content: systemPrompt }, ...conversation];

    // Standard OpenAI function tool format for web_fetch.
    const tools = [
      {
        type: 'function',
        function: {
          name: WEB_FETCH_TOOL_SCHEMA.name,
          description: WEB_FETCH_TOOL_SCHEMA.description,
          parameters: WEB_FETCH_TOOL_SCHEMA.input_schema,
        },
      },
    ];

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const params = {
        model: this.modelId,
        messages,
        tools,
        stream: true,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream_options: { include_usage: true },
        // xAI extension. The OpenAI SDK passes through unknown fields.
        search_parameters: LIVE_SEARCH_PARAMETERS,
      };

      let stream;
      try {
        stream = await this.client.chat.completions.create(params, { signal });
      } catch (err) {
        // If search_parameters is rejected (unknown field on older endpoints, or
        // 410 "Live search deprecated" on newer ones), retry without it. xAI has
        // since migrated to a separate Agent Tools API that isn't OpenAI-compatible,
        // so Grok runs without native search in that case — web_fetch still works.
        const message = (err.message || '').toLowerCase();
        const isSearchParamsRejection =
          err.status === 410 ||
          message.includes('search_parameters') ||
          message.includes('live search') ||
          message.includes('deprecated') ||
          message.includes('agent tools') ||
          message.includes('unknown') ||
          message.includes('unrecognized');
        if (isSearchParamsRejection) {
          console.warn(
            `[xai-agent] search_parameters rejected by API (${err.message}). Retrying without Live Search.`,
          );
          delete params.search_parameters;
          stream = await this.client.chat.completions.create(params, { signal });
        } else {
          throw err;
        }
      }

      // Per-iteration accumulators.
      const pendingToolCalls = new Map(); // index -> { id, name, argsJson }
      let finishReason = null;
      let citations = []; // accumulated; last non-empty wins

      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          const choice = chunk.choices?.[0];

          // Text deltas
          if (choice?.delta?.content) {
            accumulatedText += choice.delta.content;
            yield { type: 'text_delta', text: choice.delta.content };
          }

          // Tool call deltas (function calls)
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) {
                pendingToolCalls.set(tc.index, { id: tc.id || '', name: '', argsJson: '' });
              }
              const entry = pendingToolCalls.get(tc.index);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name && !entry.name) {
                entry.name = tc.function.name;
                yield { type: 'tool_call_start', tool: entry.name, input: {} };
              }
              if (tc.function?.arguments) {
                entry.argsJson += tc.function.arguments;
              }
            }
          }

          if (choice?.finish_reason) finishReason = choice.finish_reason;

          // Usage (xAI may include with stream_options: include_usage)
          if (chunk.usage) {
            totalTokensIn = chunk.usage.prompt_tokens ?? totalTokensIn;
            totalTokensOut += chunk.usage.completion_tokens ?? 0;
          }

          // Citations: xAI surfaces them on chunks. Check multiple possible locations.
          const chunkCitations =
            chunk.citations ||
            choice?.delta?.citations ||
            choice?.citations ||
            null;
          if (Array.isArray(chunkCitations) && chunkCitations.length > 0) {
            citations = chunkCitations;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        throw new Error(`XaiAgent stream failed: ${err.message ?? err}`);
      }

      // Synthesize a single web_search tool_call pair if citations were returned.
      if (citations.length > 0 && !webSearchAnnounced) {
        webSearchAnnounced = true;
        yield { type: 'tool_call_start', tool: 'web_search', input: {} };
        yield {
          type: 'tool_call_end',
          tool: 'web_search',
          outputSummary: `${citations.length} citation${citations.length === 1 ? '' : 's'} from Live Search`,
        };
        allToolCalls.push({
          tool: 'web_search',
          input: {},
          outputSummary: `${citations.length} citations from Live Search`,
        });
      }

      // If no function calls or finish_reason indicates done, exit loop.
      if (pendingToolCalls.size === 0 || finishReason === 'stop' || finishReason === 'length') {
        break;
      }

      // Append assistant message containing the tool_calls so the next API call
      // sees the conversation correctly.
      const assistantToolCalls = [...pendingToolCalls.values()].map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson },
      }));
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: assistantToolCalls,
      });

      // Execute each tool call and append a tool message per call.
      for (const [, tc] of pendingToolCalls.entries()) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let inputObj;
        try {
          inputObj = tc.argsJson ? JSON.parse(tc.argsJson) : {};
        } catch {
          inputObj = {};
        }

        let summary;
        let resultText;

        if (tc.name === 'web_fetch') {
          const result = await webFetch(inputObj.url);
          summary = summarizeWebFetchResult(result);
          if (result.error) {
            resultText = `Fetch failed: ${result.error}`;
          } else {
            const truncMarker = result.truncated ? '\n\n[truncated at 5000 chars]' : '';
            resultText =
              `URL: ${result.url}\n` +
              `Title: ${result.title || '(no title)'}\n\n` +
              `${result.text}${truncMarker}`;
          }
        } else {
          summary = `Unknown tool: ${tc.name}`;
          resultText = `Error: tool '${tc.name}' is not implemented.`;
        }

        allToolCalls.push({
          tool: tc.name,
          input: inputObj,
          outputSummary: summary,
        });

        yield { type: 'tool_call_end', tool: tc.name, outputSummary: summary };

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
      }
    }

    if (iteration >= maxIterations) {
      console.warn(`[xai-agent] Hit max iterations (${maxIterations}) without natural completion`);
    }

    yield {
      type: 'turn_complete',
      content: accumulatedText.trim(),
      toolCalls: allToolCalls,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      durationMs: Date.now() - startTime,
    };
  }
}

export default XaiAgent;
