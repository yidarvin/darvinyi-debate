// Factory: returns the right AgentRunner instance for a given Prisma Agent row.
//
// Uses dynamic imports so this module can be loaded before all adapter files
// exist. Prompts 7-10 each implement one adapter; until each is implemented,
// calling getAgentRunner for that provider throws "module not found".
//
// API keys are read from environment variables, looked up by provider.

/**
 * @param {{ id: string, displayName: string, provider: string, modelId: string }} agentRow
 * @returns {Promise<import('./AgentRunner.js').AgentRunner>}
 */
export async function getAgentRunner(agentRow) {
  const apiKey = getApiKeyForProvider(agentRow.provider);
  if (!apiKey) {
    throw new Error(
      `API key for provider '${agentRow.provider}' is not set in environment. ` +
        `Expected env var: ${getApiKeyEnvVarName(agentRow.provider)}.`,
    );
  }

  const config = {
    id: agentRow.id,
    displayName: agentRow.displayName,
    provider: agentRow.provider,
    modelId: agentRow.modelId,
    apiKey,
  };

  switch (agentRow.provider) {
    case 'anthropic': {
      const { AnthropicAgent } = await import('./AnthropicAgent.js');
      return new AnthropicAgent(config);
    }
    case 'openai': {
      const { OpenAIAgent } = await import('./OpenAIAgent.js');
      return new OpenAIAgent(config);
    }
    case 'google': {
      const { GoogleAgent } = await import('./GoogleAgent.js');
      return new GoogleAgent(config);
    }
    case 'xai': {
      const { XaiAgent } = await import('./XaiAgent.js');
      return new XaiAgent(config);
    }
    default:
      throw new Error(`Unknown provider: '${agentRow.provider}'`);
  }
}

function getApiKeyEnvVarName(provider) {
  switch (provider) {
    case 'anthropic': return 'ANTHROPIC_API_KEY';
    case 'openai':    return 'OPENAI_API_KEY';
    case 'google':    return 'GOOGLE_API_KEY';
    case 'xai':       return 'XAI_API_KEY';
    default:          return `unknown (${provider})`;
  }
}

function getApiKeyForProvider(provider) {
  switch (provider) {
    case 'anthropic': return process.env.ANTHROPIC_API_KEY;
    case 'openai':    return process.env.OPENAI_API_KEY;
    case 'google':    return process.env.GOOGLE_API_KEY;
    case 'xai':       return process.env.XAI_API_KEY;
    default:          return null;
  }
}
