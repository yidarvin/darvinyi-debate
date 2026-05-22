// Google Gemini adapter for the AgentRunner contract.
//
// Uses @google/genai SDK with Gemini 2.5 Pro. Exposes:
//   - web_fetch:  function declaration wrapping webFetch()
//
// Grounding (googleSearch) is NOT exposed: Gemini 2.5 Pro rejects requests
// that combine built-in tools (googleSearch) with function declarations
// ("Built-in tools and Function Calling cannot be combined in the same
// request"). We prefer function calling so web_fetch keeps working; web_search
// becomes an advertised-but-unused tool from the model's perspective, which
// is acceptable since the system prompt is calibrated for both.

import { GoogleGenAI } from '@google/genai';
import { AgentRunner } from './AgentRunner.js';
import { webFetch, summarizeWebFetchResult, WEB_FETCH_TOOL_SCHEMA } from '../tools/webFetch.js';

const MAX_OUTPUT_TOKENS = 4096;

export class GoogleAgent extends AgentRunner {
  constructor(config) {
    super(config);
    this.client = new GoogleGenAI({ apiKey: this.apiKey });
  }

  async *runTurn({ systemPrompt, conversation, signal, maxIterations = 8 }) {
    const startTime = Date.now();
    let accumulatedText = '';
    const allToolCalls = [];
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    // Convert AgentRunner conversation to Gemini contents.
    // Roles: 'user' stays 'user', 'assistant' becomes 'model'.
    const contents = conversation.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const tools = [
      {
        functionDeclarations: [
          {
            name: WEB_FETCH_TOOL_SCHEMA.name,
            description: WEB_FETCH_TOOL_SCHEMA.description,
            parameters: WEB_FETCH_TOOL_SCHEMA.input_schema,
          },
        ],
      },
    ];

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration++;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const config = {
        systemInstruction: systemPrompt,
        tools,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      };

      const stream = await this.client.models.generateContentStream({
        model: this.modelId,
        contents,
        config,
      });

      // Per-iteration accumulators.
      const functionCalls = []; // { name, args }
      const modelParts = []; // accumulated parts for the model turn (added back to contents on tool calls)

      try {
        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          // Text streaming.
          const chunkText = typeof chunk.text === 'function' ? chunk.text() : chunk.text;
          if (chunkText) {
            accumulatedText += chunkText;
            yield { type: 'text_delta', text: chunkText };
          }

          // Walk candidate parts.
          const candidate = chunk.candidates?.[0];
          if (candidate?.content?.parts) {
            for (const part of candidate.content.parts) {
              modelParts.push(part);
              if (part.functionCall) {
                functionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                });
              }
            }
          }

          // Token counting.
          if (chunk.usageMetadata) {
            totalTokensIn = chunk.usageMetadata.promptTokenCount ?? totalTokensIn;
            totalTokensOut = chunk.usageMetadata.candidatesTokenCount ?? totalTokensOut;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) throw err;
        throw new Error(`GoogleAgent stream failed: ${err.message ?? err}`);
      }

      // If no function calls remain, we're done with this turn.
      if (functionCalls.length === 0) break;

      // Append the model's turn (including any function_call parts) to contents.
      contents.push({ role: 'model', parts: modelParts });

      // Execute each function call and build function_response parts for the next turn.
      const functionResponseParts = [];
      for (const fc of functionCalls) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        yield { type: 'tool_call_start', tool: fc.name, input: fc.args };

        let summary;
        let responseObject;

        if (fc.name === 'web_fetch') {
          const result = await webFetch(fc.args?.url);
          summary = summarizeWebFetchResult(result);
          if (result.error) {
            responseObject = { error: result.error };
          } else {
            responseObject = {
              url: result.url,
              title: result.title || '',
              text: result.text,
              truncated: result.truncated === true,
            };
          }
        } else {
          summary = `Unknown tool: ${fc.name}`;
          responseObject = { error: `Tool '${fc.name}' not implemented` };
        }

        allToolCalls.push({
          tool: fc.name,
          input: fc.args,
          outputSummary: summary,
        });

        yield { type: 'tool_call_end', tool: fc.name, outputSummary: summary };

        functionResponseParts.push({
          functionResponse: {
            name: fc.name,
            response: responseObject,
          },
        });
      }

      // Append function responses as a user turn for the next iteration.
      contents.push({ role: 'user', parts: functionResponseParts });
    }

    if (iteration >= maxIterations) {
      console.warn(`[google-agent] Hit max iterations (${maxIterations}) without natural completion`);
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

export default GoogleAgent;
