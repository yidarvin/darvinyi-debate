// Anthropic adapter for the AgentRunner contract.
//
// Handles all anthropic-provider models: claude-opus-4-7, claude-sonnet-4-6,
// and any future Claude models that share the messages API. The modelId field
// controls which is called.
//
// Tools exposed:
//   - web_search: native Anthropic server tool. Executed by Anthropic; results
//     are returned inline in the same response.
//   - web_fetch:  client tool wrapping our webFetch() function.
//
// Event emission contract (see /context/AGENT_SPEC.md):
//   - text_delta:        on every text streaming chunk
//   - tool_call_start:   when a tool_use or server_tool_use content block opens
//   - tool_call_end:     after a server tool result block is received, OR
//                        after a client tool is executed (post-stream)
//   - turn_complete:     exactly once, at the very end

import Anthropic from '@anthropic-ai/sdk';
import { AgentRunner } from './AgentRunner.js';
import { webFetch, summarizeWebFetchResult, WEB_FETCH_TOOL_SCHEMA } from '../tools/webFetch.js';

// Per-turn token budget. Anthropic enforces this as max_tokens on each call.
// 4096 is plenty for an 800-word debate turn plus tool use scratch.
const MAX_TOKENS_PER_TURN = 4096;

// Native web_search server tool identifier. Anthropic versions server tools
// by date string. SDK 0.97.1 ships both web_search_20250305 and the newer
// web_search_20260209. The 20260209 variant wraps each search inside a
// code_execution block (agentic search pattern), which adds noisy
// server_tool_use events to the stream. We use the simpler 20250305 — direct
// tool calls only, which matches the contract documented in AGENT_SPEC.md.
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
const WEB_SEARCH_MAX_USES = 5;

export class AnthropicAgent extends AgentRunner {
  constructor(config) {
    super(config);
    this.client = new Anthropic({ apiKey: this.apiKey });
  }

  async *runTurn({ systemPrompt, conversation, signal, maxIterations = 8 }) {
    const startTime = Date.now();

    // Aggregate state across the (potentially multi-iteration) tool-use loop.
    let accumulatedText = '';
    const allToolCalls = []; // for turn_complete event
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    // Working messages array — grows when client tools are called.
    const messages = conversation.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Tool definitions for every iteration:
    //   - Server tool: web_search (Anthropic executes)
    //   - Client tool: web_fetch (we execute)
    const tools = [
      {
        type: WEB_SEARCH_TOOL_TYPE,
        name: 'web_search',
        max_uses: WEB_SEARCH_MAX_USES,
      },
      {
        name: WEB_FETCH_TOOL_SCHEMA.name,
        description: WEB_FETCH_TOOL_SCHEMA.description,
        input_schema: WEB_FETCH_TOOL_SCHEMA.input_schema,
      },
    ];

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      // Track per-iteration content blocks by index, so we can assemble
      // streaming tool_use inputs from input_json_delta events.
      const blocksByIndex = new Map();

      const stream = this.client.messages.stream(
        {
          model: this.modelId,
          max_tokens: MAX_TOKENS_PER_TURN,
          system: systemPrompt,
          messages,
          tools,
        },
        { signal },
      );

      try {
        for await (const event of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          switch (event.type) {
            case 'message_start': {
              if (event.message?.usage?.input_tokens) {
                totalTokensIn += event.message.usage.input_tokens;
              }
              break;
            }

            case 'content_block_start': {
              const cb = event.content_block;
              const record = { type: cb.type, partialJson: '', name: cb.name, id: cb.id, input: cb.input };
              blocksByIndex.set(event.index, record);

              if (cb.type === 'web_search_tool_result') {
                // Anthropic returns the search results inline. Summarize by item count.
                const items = Array.isArray(cb.content) ? cb.content : [];
                const summary = `${items.length} source${items.length === 1 ? '' : 's'} returned`;
                // Pair this end with the most recent server_tool_use (web_search) start
                // by walking blocks at lower indexes — the matching invocation block is
                // the most recent server_tool_use without a recorded outputSummary.
                let pairedInput = {};
                for (let i = event.index - 1; i >= 0; i--) {
                  const prev = blocksByIndex.get(i);
                  if (prev && prev.type === 'server_tool_use' && !prev._summarized) {
                    pairedInput = prev.input ?? {};
                    prev._summarized = true;
                    break;
                  }
                }
                allToolCalls.push({
                  tool: 'web_search',
                  input: pairedInput,
                  outputSummary: summary,
                });
                yield { type: 'tool_call_end', tool: 'web_search', outputSummary: summary };
              }
              // For tool_use (client) and server_tool_use (server), defer tool_call_start
              // until content_block_stop so the streamed input JSON is fully assembled.
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta;
              const record = blocksByIndex.get(event.index);
              if (!record) break;

              if (delta.type === 'text_delta') {
                accumulatedText += delta.text;
                yield { type: 'text_delta', text: delta.text };
              } else if (delta.type === 'input_json_delta') {
                record.partialJson += delta.partial_json;
              }
              break;
            }

            case 'content_block_stop': {
              const record = blocksByIndex.get(event.index);
              if (!record) break;

              if (record.type === 'tool_use' || record.type === 'server_tool_use') {
                // Assemble streamed input JSON. If absent (some blocks have input upfront),
                // fall back to the initial cb.input.
                let assembledInput = record.input ?? {};
                if (record.partialJson) {
                  try {
                    assembledInput = JSON.parse(record.partialJson);
                  } catch {
                    assembledInput = {};
                  }
                }
                record.input = assembledInput;

                if (record.type === 'tool_use') {
                  // Client tool — input now known. Execution happens after stream.
                  yield {
                    type: 'tool_call_start',
                    tool: record.name,
                    input: assembledInput,
                  };
                } else {
                  // server_tool_use — input now known. The result block follows.
                  yield {
                    type: 'tool_call_start',
                    tool: 'web_search',
                    input: assembledInput,
                  };
                }
              }
              break;
            }

            case 'message_delta': {
              if (event.usage?.output_tokens) {
                totalTokensOut += event.usage.output_tokens;
              }
              break;
            }

            case 'message_stop':
              // No-op — the for-await will finish naturally.
              break;

            default:
              // Unknown event types are ignored. Anthropic adds events over time;
              // tolerating them keeps the adapter resilient.
              break;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'APIUserAbortError' || signal?.aborted) {
          throw err;
        }
        // Non-abort error: re-throw with context.
        throw new Error(`AnthropicAgent stream failed: ${err.message ?? err}`);
      }

      // Stream exhausted. Get the assembled final message.
      const finalMessage = await stream.finalMessage();

      // Collect client tool_use blocks (web_fetch). Server tools were already handled inline.
      const clientToolUses = (finalMessage.content || []).filter((b) => b.type === 'tool_use');

      // If the model finished cleanly, or there are no client tool calls to handle, we're done.
      if (finalMessage.stop_reason === 'end_turn' || clientToolUses.length === 0) {
        break;
      }

      if (finalMessage.stop_reason !== 'tool_use') {
        // max_tokens, stop_sequence, etc. End the turn with what we have.
        console.warn(`[anthropic-agent] Unexpected stop_reason: ${finalMessage.stop_reason}`);
        break;
      }

      // Append assistant message (including the tool_use blocks) to conversation.
      messages.push({ role: 'assistant', content: finalMessage.content });

      // Execute each client tool and build tool_result blocks.
      const toolResults = [];
      for (const block of clientToolUses) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        let resultContent;
        let summary;

        if (block.name === 'web_fetch') {
          const result = await webFetch(block.input?.url);
          summary = summarizeWebFetchResult(result);
          if (result.error) {
            resultContent = `Fetch failed: ${result.error}`;
          } else {
            const truncMarker = result.truncated ? '\n\n[truncated at 5000 chars]' : '';
            resultContent =
              `URL: ${result.url}\n` +
              `Title: ${result.title || '(no title)'}\n\n` +
              `${result.text}${truncMarker}`;
          }
        } else {
          summary = `Unknown tool: ${block.name}`;
          resultContent = `Error: tool '${block.name}' is not implemented in this adapter.`;
        }

        allToolCalls.push({
          tool: block.name,
          input: block.input,
          outputSummary: summary,
        });

        yield { type: 'tool_call_end', tool: block.name, outputSummary: summary };

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: resultContent,
        });
      }

      messages.push({ role: 'user', content: toolResults });
      // Continue outer loop — next iteration calls the model with the tool results.
    }

    if (iteration >= maxIterations) {
      console.warn(`[anthropic-agent] Hit max iterations (${maxIterations}) without natural end_turn`);
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

export default AnthropicAgent;
