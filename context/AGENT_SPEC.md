# Agent specification

## Roster

Five agents at launch. Each is identified by a stable `id`. The `modelId` is the literal string passed to the provider's API.

| id | displayName | provider | modelId | API key env var |
|---|---|---|---|---|
| `claude-opus-4-7` | Claude Opus 4.7 | `anthropic` | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `anthropic` | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `gpt-5` | GPT-5 | `openai` | `gpt-5` | `OPENAI_API_KEY` |
| `gemini-2-5-pro` | Gemini 2.5 Pro | `google` | `gemini-2.5-pro` | `GOOGLE_API_KEY` |
| `grok-4` | Grok 4 | `xai` | `grok-4` | `XAI_API_KEY` |

When implementing a provider adapter, verify the exact current model ID by checking the provider's official documentation. Model strings can change; the table above reflects intent. If a provider has renamed or deprecated a model, use the current canonical name and note the substitution in a code comment.

## AgentRunner interface

Every provider adapter extends a single base class:

```js
class AgentRunner {
  constructor({ id, displayName, provider, modelId, apiKey }) {
    this.id = id;
    this.displayName = displayName;
    this.provider = provider;
    this.modelId = modelId;
    this.apiKey = apiKey;
  }

  /**
   * Run a single turn of the debate.
   * Yields events as the turn progresses. Always ends with a turn_complete event.
   *
   * @param {object} params
   * @param {string} params.systemPrompt - The full system prompt for this turn
   * @param {Array<{role: 'user' | 'assistant', content: string}>} params.conversation - Prior turns
   * @param {AbortSignal} params.signal - Cancel signal
   * @param {number} [params.maxIterations=8] - Maximum tool-use loop iterations
   * @yields {AgentEvent}
   */
  async *runTurn({ systemPrompt, conversation, signal, maxIterations = 8 }) {
    throw new Error('runTurn() not implemented');
  }
}
```

The async generator pattern is mandatory. Streaming events flow through `yield`. Callers consume via `for await (const event of runner.runTurn(...))`.

## Event types

Every event yielded by `runTurn` is an object with a `type` field. Five event types exist:

```js
// Text token(s) streamed from the model
{ type: 'text_delta', text: string }

// A tool call is starting
{ type: 'tool_call_start', tool: string, input: object }

// A tool call has returned a result
{ type: 'tool_call_end', tool: string, outputSummary: string }

// The turn is complete. Always the final event yielded.
{
  type: 'turn_complete',
  content: string,                            // accumulated final text
  toolCalls: Array<{                          // ordered list of tool invocations
    tool: string,
    input: object,
    outputSummary: string
  }>,
  tokensIn: number,                           // input tokens billed
  tokensOut: number,                          // output tokens billed
  durationMs: number                          // wall-clock time
}
```

### Example event stream from a single turn

```
{ type: 'text_delta', text: 'The four-day workweek' }
{ type: 'text_delta', text: ' is not a thought experiment' }
{ type: 'tool_call_start', tool: 'web_search', input: { query: 'Iceland four-day workweek productivity' } }
{ type: 'tool_call_end', tool: 'web_search', outputSummary: '5 sources returned' }
{ type: 'text_delta', text: '. Iceland\'s 2015–2019 national trials...' }
{ type: 'turn_complete', content: 'The four-day workweek is not a thought experiment...', toolCalls: [...], tokensIn: 3204, tokensOut: 612, durationMs: 18430 }
```

## Tools available to every agent

Two tools are exposed to every debater:

### `web_search`

Provider-native if available (Anthropic server tool, OpenAI Responses API tool, Gemini grounding, xAI Live Search). Each adapter is responsible for translating the provider's native search results into `tool_call_start` and `tool_call_end` events with `tool: 'web_search'`.

If a provider doesn't expose native search at runtime, that adapter operates without native search and relies only on `web_fetch`. This is acceptable as a known limitation — document it in the adapter's code comment.

### `web_fetch`

Universal, server-implemented. Defined once in `/server/src/tools/webFetch.js`. Each adapter exposes it to its provider via the provider's tool-use mechanism (Anthropic client tool, OpenAI function tool, Gemini function declaration, xAI function tool).

Schema:

```js
export const WEB_FETCH_TOOL_SCHEMA = {
  name: 'web_fetch',
  description: 'Fetch the text content of a web page by URL. Returns up to 5000 characters of cleaned main text. Useful when web_search results indicate a specific URL is worth reading in full.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch. Must be http or https.' }
    },
    required: ['url']
  }
};
```

Implementation contract for `webFetch(url)`:
- Validate `url` starts with `http://` or `https://`. If not, return `{ url, error: 'Invalid URL scheme' }`.
- Fetch with a 10-second timeout via `undici`.
- Limit response body to 5MB. Abort on exceed.
- Set `User-Agent: 'DebateArena/1.0 (+https://debate.darvinyi.com)'`.
- Parse HTML with `cheerio`. Strip `<script>`, `<style>`, `<nav>`, `<footer>`, `<aside>`, `<form>`. Prefer `<article>`, then `<main>`, then `<body>` for main content.
- Collapse all whitespace runs to single spaces. Strip leading/trailing whitespace.
- Truncate to 5000 characters. Set `truncated: true` if the original was longer.
- Return `{ url, title, text, truncated }` on success or `{ url, error: <message> }` on failure.
- **Never throw.** Callers must always receive an object.

The `outputSummary` for a tool_call_end event from web_fetch should be: `"Fetched <title> (<text.length> chars<, truncated>)"` on success, or `"Fetch failed: <error>"` on failure.

## System prompt construction

System prompts for debaters are built by `/server/src/agents/systemPrompts.js`. The full template is specified in `/context/DEBATE_FORMAT.md`. Adapters do not construct system prompts themselves — they receive a fully-built string.

## Provider-specific notes

### Anthropic (Opus 4.7, Sonnet 4.6)

- SDK: `@anthropic-ai/sdk`
- Use `client.messages.stream({ model, system, messages, tools, max_tokens })`.
- Native web search: server tool with `type: 'web_search_<version>'` and `name: 'web_search'`. Use the latest version available in the SDK.
- Native web search results are returned as part of the model response — no client-side execution required. Emit synthetic `tool_call_start`/`tool_call_end` events for consistency with other adapters.
- `web_fetch` is a client tool: when the model emits a `tool_use` block for `web_fetch`, execute `webFetch()` server-side, append the result as a `tool_result` content block on the next user message, continue the loop.

### OpenAI (GPT-5)

- SDK: `openai`
- Prefer the Responses API: `client.responses.stream({ model, input, instructions, tools })`. Fall back to Chat Completions if Responses API isn't available for the chosen model.
- Native web search: `{ type: 'web_search' }` tool entry (verify exact name in current docs — may be `web_search_preview`).
- `web_fetch`: define as a function tool. On tool call, execute server-side, submit tool output back to the response.

### Google (Gemini 2.5 Pro)

- SDK: `@google/genai` (or `@google/generative-ai` — use the most current package).
- Use `generateContentStream` with `tools: [{ googleSearch: {} }, { functionDeclarations: [{ name: 'web_fetch', ... }] }]`.
- Grounding results come back as `groundingMetadata` on response chunks, not as discrete tool_use events. Synthesize `tool_call_start`/`tool_call_end` events with `tool: 'web_search'` based on the grounding metadata so downstream consumers see uniform events.

### xAI (Grok 4)

- xAI's API is OpenAI-compatible. Use the `openai` SDK with `baseURL: 'https://api.x.ai/v1'`.
- Live Search: pass `search_parameters: { mode: 'auto' }` (verify current syntax in xAI docs).
- `web_fetch`: define as a function tool, same pattern as OpenAI.
- Citations from Live Search may come in a `citations` array on the response — synthesize `tool_call_start`/`tool_call_end` for them.

## Factory

`/server/src/agents/index.js` exports `getAgentRunner(agentRow)` where `agentRow` is a Prisma `Agent` row. The factory switches on `agentRow.provider` and returns an instance of the appropriate adapter, constructed with the agent's `id`, `displayName`, `modelId`, and the API key from the matching environment variable.
