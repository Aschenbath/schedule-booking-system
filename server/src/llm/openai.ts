import type { LlmClient, ExtractInput, Extraction, ReplyFacts, ChatTurn } from './types';
import { extractSystemPrompt, REPLY_SYSTEM_PROMPT } from './prompts';
import type { Category } from '../agent/schema';

export interface OpenAiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

const CATS = new Set(['meeting', 'reception', 'dinner', 'other', 'unsure']);
const INTENTS = new Set(['submit', 'cancel', 'restart', 'confirm_people']);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown) => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : null);

/** 任意 OpenAI 兼容接口（/chat/completions） */
export class OpenAiLlm implements LlmClient {
  readonly mode = 'openai' as const;
  constructor(private readonly cfg: OpenAiConfig) {}

  async extract(input: ExtractInput): Promise<Extraction> {
    const directoryNames = input.directory.names.length > 60 ? input.directory.names.slice(0, 60) : input.directory.names;
    const messages: Msg[] = [
      { role: 'system', content: extractSystemPrompt(input.now, { ...input.directory, names: directoryNames }, input.draft, input.pendingFields) },
      ...input.history.slice(-6).map((h) => ({ role: h.role, content: h.content }) as Msg),
      { role: 'user', content: input.text },
    ];
    const raw = await this.complete(messages, { temperature: 0, json: true });
    return sanitize(parseJson(raw));
  }

  async *streamReply(facts: ReplyFacts, history: ChatTurn[]): AsyncIterable<string> {
    const messages: Msg[] = [
      { role: 'system', content: REPLY_SYSTEM_PROMPT },
      ...history.slice(-6).map((h) => ({ role: h.role, content: h.content }) as Msg),
      { role: 'user', content: `【事实】\n${JSON.stringify(facts)}\n\n请根据事实回复员工。` },
    ];
    yield* this.stream(messages);
  }

  private async complete(messages: Msg[], opts: { temperature: number; json?: boolean }): Promise<string> {
    const body: Record<string, unknown> = { model: this.cfg.model, messages, temperature: opts.temperature, stream: false };
    if (opts.json) body.response_format = { type: 'json_object' };
    let res = await this.post(body);
    if (!res.ok && opts.json) {
      // 有些站点不支持 response_format，去掉再试一次
      delete body.response_format;
      res = await this.post(body);
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('LLM 返回内容为空');
    return content;
  }

  private async *stream(messages: Msg[]): AsyncIterable<string> {
    const res = await this.post({ model: this.cfg.model, messages, temperature: 0.3, stream: true });
    if (!res.ok || !res.body) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      return await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseJson(raw: string): any {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`LLM 输出不是合法 JSON: ${raw.slice(0, 200)}`);
  }
}

export function sanitize(o: any): Extraction {
  if (!o || typeof o !== 'object') return {};
  const out: Extraction = {};
  if (typeof o.category === 'string' && CATS.has(o.category)) out.category = o.category as Category | 'unsure';
  out.subject = str(o.subject);
  out.time_text = str(o.time_text);
  out.start = str(o.start);
  out.end = str(o.end);
  out.location = str(o.location);
  out.visitor = str(o.visitor);
  out.counterpart = str(o.counterpart);
  const hc = Number(o.headcount);
  out.headcount = Number.isFinite(hc) && hc > 0 ? Math.round(hc) : null;
  out.note = str(o.note);
  out.people_queries = strList(o.people_queries);
  out.remove_people = strList(o.remove_people);
  out.intent = typeof o.intent === 'string' && INTENTS.has(o.intent) ? (o.intent as Extraction['intent']) : null;
  return out;
}
