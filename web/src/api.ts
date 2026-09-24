import { store } from './store';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function headers(extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', 'x-user-id': store.userId, ...extra };
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: headers(),
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(data?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

/** POST 并按 SSE 逐条读取事件（用于流式对话） */
export async function apiStream(path: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`/api${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(msg, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flushBlock = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    let data: any = raw;
    try {
      data = JSON.parse(raw);
    } catch {
      /* keep raw */
    }
    onEvent(event, data);
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) flushBlock(block);
    }
  }
  if (buf.trim()) flushBlock(buf);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/**
 * 时区一律按 Asia/Shanghai，不跟浏览器走：把任意时刻换成“北京时间墙上时钟”的 Date，
 * 之后用 getHours()/getDate() 等本地取值拿到的就是北京时间（上海没有夏令时，固定 +08:00）。
 */
export const sh = (t: string | number | Date) => {
  const ms = new Date(t).getTime();
  return new Date(ms + (480 + new Date(ms).getTimezoneOffset()) * 60_000);
};
/** sh() 得到的墙上时钟 Date → 带 +08:00 的 ISO，发给后端 */
export const shIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00+08:00`;

export const fmtTime = (iso: string) => {
  const d = sh(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
