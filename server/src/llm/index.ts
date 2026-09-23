import type { LlmClient } from './types';
import { RulesLlm } from './rules';
import { OpenAiLlm } from './openai';
import { config } from '../config';

export type { LlmClient } from './types';
export { RulesLlm } from './rules';
export { OpenAiLlm } from './openai';

export function createLlm(): LlmClient {
  if (config.llm.provider === 'openai' && config.llm.apiKey) {
    return new OpenAiLlm({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey, model: config.llm.model, timeoutMs: config.llm.timeoutMs });
  }
  return new RulesLlm();
}
