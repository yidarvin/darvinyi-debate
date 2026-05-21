// OpenAI adapter for the AgentRunner contract.
//
// Uses the Responses API (client.responses.*) so native web_search is available.
// If Responses isn't accessible at runtime (SDK version too old, model
// incompatible, etc.), falls back to Chat Completions with only web_fetch.
//
// Tools exposed:
//   - web_search: built-in Responses API tool (server-executed by OpenAI)
//   - web_fetch:  function tool wrapping webFetch()
//
// Event emission contract matches AnthropicAgent — see /context/AGENT_SPEC.md.

import OpenAI from 'openai';
import { AgentRunner } from './AgentRunner.js';
import { webFetch, summarizeWebFetchResult, WEB_FETCH_TOOL_SCHEMA } from '../tools/webFetch.js';

const MAX_OUTPUT_TOKENS = 4096;
const WEB_SEARCH_TOOL_TYPE = 'web_search'; // If SDK rejects, try 'web_search_preview'

export class OpenAIAgent extends AgentRunner {
  constructor(config) {
    super(config);
    this.client = new OpenAI({ apiKey: this.apiKey });
  }

  async *runTurn({ systemPrompt, conversation, signal, maxIterations = 8 }) {
    // Try Responses API first; fall back to Chat Completions if it fails fundamentally.
    try {
      yield* this._runViaResponsesAPI({ systemPrompt, conversation, signal, maxIterations });
    } catch (err) {
      // Only fall back on errors that indicate the API isn't usable at all,
      // not on abort or transient errors.
      if (err.name === 'AbortError' || signal?.aborted) throw err;

      const message = (err.message || '').toLowerCase();
      const isApiUnavailable =
        message.includes('responses') &&
        (message.includes('not found') || message.includes('unsupported') || message.includes('404'));

      if (!isApiUnavailable) throw err;

      console.warn(
        `[openai-agent] Responses API unavailable (${err.message}). Falling back to Chat Completions with web_fetch only. Native web_search will not be available.`,
      );
      yield* this._runViaChatCompletions({ systemPrompt, conversation, signal, maxIterations });
    }
  }

  async *_runViaResponsesAPI({ systemPrompt, conversation, signal, maxIterations }) {
    const startTime = Date.now();
    let accumulatedText = '';
    const allToolCalls = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    let nextInput = conversation.map((m) => ({ role: m.role, content: m.content }));
    let previousResponseId = null;

    const tools = [
      { type: WEB_SEARCH_TOOL_TYPE },
      {
        type: 'function',
        name: WEB_FETCH_TOOL_SCHEMA.name,
        description: WEB_FETCH_TOOL_SCHEMA.description,
        parameters: WEB_FETCH_TOOL_SCHEMA.input_schema,
      },
    ];

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Per-iteration state.
      const pendingFunctionCalls = new Map(); // item_id -> { call_id, name, argsJson }
      const announcedSearchItems = new Set(); // item_ids already yielded as tool_call_start

      const params = {
        model: this.modelId,
        instructions: systemPrompt,
        input: nextInput,
        tools,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      };
      if (previousResponseId) params.previous_response_id = previousResponseId;

      // SDK API: prefer client.responses.stream(params, { signal }) if available.
      // If only client.responses.create exists, pass { stream: true } and iterate.
      let stream;
      if (typeof this.client.responses.stream === 'function') {
        stream = this.client.responses.stream(params, { signal });
      } else {
        stream = await this.client.responses.create({ ...params, stream: true }, { signal });
      }

      let finalResponse = null;

      try {
        for await (const event of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          switch (event.type) {
            case 'response.created': {
              if (event.response?.id) previousResponseId = event.response.id;
              break;
            }

            case 'response.output_item.added': {
              const item = event.item;
              if (!item) break;

              if (item.type === 'web_search_call' && !announcedSearchItems.has(item.id)) {
                announcedSearchItems.add(item.id);
                const query = item.action?.query || item.input?.query || '';
                yield {
                  type: 'tool_call_start',
                  tool: 'web_search',
                  input: query ? { query } : {},
                };
              } else if (item.type === 'function_call') {
                pendingFunctionCalls.set(item.id, {
                  call_id: item.call_id,
                  name: item.name,
                  argsJson: '',
                });
                yield {
                  type: 'tool_call_start',
                  tool: item.name,
                  input: {},
                };
              }
              break;
            }

            case 'response.output_text.delta': {
              if (event.delta) {
                accumulatedText += event.delta;
                yield { type: 'text_delta', text: event.delta };
              }
              break;
            }

            case 'response.function_call_arguments.delta': {
              const fc = pendingFunctionCalls.get(event.item_id);
              if (fc) fc.argsJson += event.delta;
              break;
            }

            case 'response.function_call_arguments.done': {
              const fc = pendingFunctionCalls.get(event.item_id);
              if (fc && event.arguments) fc.argsJson = event.arguments;
              break;
            }

            case 'response.output_item.done': {
              const item = event.item;
              if (item?.type === 'web_search_call') {
                yield {
                  type: 'tool_call_end',
                  tool: 'web_search',
                  outputSummary: 'Web search completed',
                };
                // Record server-side search in toolCalls for the final summary.
                allToolCalls.push({
                  tool: 'web_search',
                  input: item.action?.query ? { query: item.action.query } : {},
                  outputSummary: 'Web search completed',
                });
              }
              break;
            }

            case 'response.completed': {
              finalResponse = event.response;
              if (finalResponse?.usage) {
                totalTokensIn += finalResponse.usage.input_tokens ?? 0;
                totalTokensOut += finalResponse.usage.output_tokens ?? 0;
              }
              break;
            }

            // Other event types (response.in_progress, response.content_part.added, etc.)
            // are not needed for our event emission. Ignored.
            default:
              break;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        throw new Error(`OpenAIAgent (Responses) stream failed: ${err.message ?? err}`);
      }

      if (!finalResponse && pendingFunctionCalls.size === 0) {
        // Stream ended without a clear completion event but no pending tools — treat as done.
        break;
      }

      if (finalResponse?.id) previousResponseId = finalResponse.id;

      // If no client function calls to execute, we're done.
      if (pendingFunctionCalls.size === 0) break;

      // Execute each function call and prepare outputs for the next iteration.
      const functionOutputs = [];
      for (const [, fc] of pendingFunctionCalls.entries()) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let inputObj;
        try {
          inputObj = fc.argsJson ? JSON.parse(fc.argsJson) : {};
        } catch {
          inputObj = {};
        }

        let summary;
        let outputContent;

        if (fc.name === 'web_fetch') {
          const result = await webFetch(inputObj.url);
          summary = summarizeWebFetchResult(result);
          if (result.error) {
            outputContent = `Fetch failed: ${result.error}`;
          } else {
            const truncMarker = result.truncated ? '\n\n[truncated at 5000 chars]' : '';
            outputContent =
              `URL: ${result.url}\n` +
              `Title: ${result.title || '(no title)'}\n\n` +
              `${result.text}${truncMarker}`;
          }
        } else {
          summary = `Unknown tool: ${fc.name}`;
          outputContent = `Error: tool '${fc.name}' is not implemented.`;
        }

        allToolCalls.push({
          tool: fc.name,
          input: inputObj,
          outputSummary: summary,
        });

        yield { type: 'tool_call_end', tool: fc.name, outputSummary: summary };

        functionOutputs.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: outputContent,
        });
      }

      nextInput = functionOutputs;
      // previousResponseId already set — next iteration uses it.
    }

    if (iteration >= maxIterations) {
      console.warn(`[openai-agent] Hit max iterations (${maxIterations}) without natural completion`);
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

  // Fallback: Chat Completions with only web_fetch. No native web search.
  async *_runViaChatCompletions({ systemPrompt, conversation, signal, maxIterations }) {
    const startTime = Date.now();
    let accumulatedText = '';
    const allToolCalls = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    const messages = [{ role: 'system', content: systemPrompt }, ...conversation];

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

      const stream = await this.client.chat.completions.create(
        {
          model: this.modelId,
          messages,
          tools,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream_options: { include_usage: true },
        },
        { signal },
      );

      const pendingToolCalls = new Map(); // index -> { id, name, argsJson }
      let finishReason = null;

      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            accumulatedText += choice.delta.content;
            yield { type: 'text_delta', text: choice.delta.content };
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) {
                pendingToolCalls.set(tc.index, { id: tc.id || '', name: '', argsJson: '' });
                if (tc.function?.name) {
                  pendingToolCalls.get(tc.index).name = tc.function.name;
                  yield { type: 'tool_call_start', tool: tc.function.name, input: {} };
                }
              }
              const entry = pendingToolCalls.get(tc.index);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name && !entry.name) {
                entry.name = tc.function.name;
                yield { type: 'tool_call_start', tool: entry.name, input: {} };
              }
              if (tc.function?.arguments) entry.argsJson += tc.function.arguments;
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            totalTokensIn = chunk.usage.prompt_tokens ?? totalTokensIn;
            totalTokensOut += chunk.usage.completion_tokens ?? 0;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        throw new Error(`OpenAIAgent (Chat Completions) stream failed: ${err.message ?? err}`);
      }

      if (pendingToolCalls.size === 0 || finishReason === 'stop') break;

      // Append assistant message with tool_calls
      const assistantToolCalls = [...pendingToolCalls.values()].map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson },
      }));
      messages.push({ role: 'assistant', content: null, tool_calls: assistantToolCalls });

      // Execute each tool call, build tool messages
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
            const truncMarker = result.truncated ? '\n\n[truncated]' : '';
            resultText = `URL: ${result.url}\nTitle: ${result.title || '(no title)'}\n\n${result.text}${truncMarker}`;
          }
        } else {
          summary = `Unknown tool: ${tc.name}`;
          resultText = `Error: tool '${tc.name}' not implemented`;
        }

        allToolCalls.push({ tool: tc.name, input: inputObj, outputSummary: summary });
        yield { type: 'tool_call_end', tool: tc.name, outputSummary: summary };

        messages.push({ role: 'tool', tool_call_id: tc.id, content: resultText });
      }
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

export default OpenAIAgent;
