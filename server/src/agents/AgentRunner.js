// Abstract base class for every provider adapter.
//
// The contract is intentionally tight:
//   - One method: `async *runTurn(...)`
//   - Yields events of four types (see below)
//   - Always ends with exactly one `turn_complete` event
//   - Honors `signal.aborted` by stopping cleanly (no more events after abort)
//
// See /context/AGENT_SPEC.md for the full event-stream contract.

/**
 * @typedef {Object} TextDeltaEvent
 * @property {'text_delta'} type
 * @property {string} text
 */

/**
 * @typedef {Object} ToolCallStartEvent
 * @property {'tool_call_start'} type
 * @property {string} tool
 * @property {object} input
 */

/**
 * @typedef {Object} ToolCallEndEvent
 * @property {'tool_call_end'} type
 * @property {string} tool
 * @property {string} outputSummary
 */

/**
 * @typedef {Object} TurnCompleteEvent
 * @property {'turn_complete'} type
 * @property {string} content                          // final accumulated text
 * @property {Array<{tool: string, input: object, outputSummary: string}>} toolCalls
 * @property {number} tokensIn
 * @property {number} tokensOut
 * @property {number} durationMs
 */

/**
 * @typedef {TextDeltaEvent | ToolCallStartEvent | ToolCallEndEvent | TurnCompleteEvent} AgentEvent
 */

/**
 * @typedef {Object} AgentRunnerConfig
 * @property {string} id
 * @property {string} displayName
 * @property {string} provider
 * @property {string} modelId
 * @property {string} apiKey
 */

/**
 * @typedef {Object} RunTurnParams
 * @property {string} systemPrompt
 * @property {Array<{role: 'user' | 'assistant', content: string}>} conversation
 * @property {AbortSignal} [signal]
 * @property {number} [maxIterations=8]
 */

export class AgentRunner {
  /** @param {AgentRunnerConfig} config */
  constructor({ id, displayName, provider, modelId, apiKey }) {
    if (!id || !displayName || !provider || !modelId) {
      throw new Error('AgentRunner requires id, displayName, provider, and modelId');
    }
    if (!apiKey) {
      throw new Error(`AgentRunner requires apiKey for ${provider}/${modelId}`);
    }
    this.id = id;
    this.displayName = displayName;
    this.provider = provider;
    this.modelId = modelId;
    this.apiKey = apiKey;
  }

  /**
   * Run a single turn. Adapters override this. Yields AgentEvent objects.
   * Always ends with a `turn_complete` event.
   *
   * @param {RunTurnParams} params
   * @returns {AsyncGenerator<AgentEvent>}
   */
  // eslint-disable-next-line no-unused-vars, require-yield
  async *runTurn(params) {
    throw new Error(`${this.constructor.name}.runTurn() is not implemented`);
  }
}

export default AgentRunner;
