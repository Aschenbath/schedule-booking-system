import type { LlmClient, ExtractInput, Extraction, ReplyFacts, ChatTurn } from './types';
import { RulesLlm } from './rules';
import { OpenAiLlm } from './openai';
import { config } from '../config';

export type { LlmClient } from './types';
export { RulesLlm } from './rules';
export { OpenAiLlm } from './openai';

/** 主渠道失败时依次换备用渠道；都不行才抛错，由 Agent 退回离线规则 */
export class FallbackLlm implements LlmClient {
  readonly mode = 'openai' as const;
  constructor(private readonly chain: { name: string; llm: LlmClient }[]) {}

  async extract(input: ExtractInput): Promise<Extraction> {
    let last: unknown;
    for (const { name, llm } of this.chain) {
      try {
        return await llm.extract(input);
      } catch (e) {
        last = e;
        console.warn(`[llm] ${name} extract failed:`, (e as Error).message.slice(0, 200));
      }
    }
    throw last;
  }

  async *streamReply(facts: ReplyFacts, history: ChatTurn[]): AsyncIterable<string> {
    let last: unknown;
    for (const { name, llm } of this.chain) {
      let started = false;
      try {
        for await (const chunk of llm.streamReply(facts, history)) {
          started = true;
          yield chunk;
        }
        if (started) return;
        throw new Error('empty reply');
      } catch (e) {
        if (started) throw e; // 已经吐出一半，不能换渠道重来
        last = e;
        console.warn(`[llm] ${name} streamReply failed:`, (e as Error).message.slice(0, 200));
      }
    }
    throw last;
  }
}

export function createLlm(): LlmClient {
  if (config.llm.provider !== 'openai') return new RulesLlm();
  const chain = [config.llm, ...config.llm.fallbacks]
    .filter((c) => c.apiKey)
    .map((c) => ({ name: `${new URL(c.baseUrl).host}/${c.model}`, llm: new OpenAiLlm({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, timeoutMs: config.llm.timeoutMs }) }));
  if (!chain.length) return new RulesLlm();
  return chain.length === 1 ? chain[0].llm : new FallbackLlm(chain);
}
