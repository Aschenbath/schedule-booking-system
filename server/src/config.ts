import fs from 'node:fs';
import path from 'node:path';

// 读取 .env：优先仓库根目录，其次 server 目录（都不存在则忽略）
function loadEnv() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
    path.resolve(import.meta.dirname ?? '.', '..', '..', '.env'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        process.loadEnvFile(file);
        return file;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}
export const ENV_FILE = loadEnv();

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

export const config = {
  port: Number(env('PORT', '3000')),
  dbPath: env('DB_PATH', './data/app.db'),
  now: env('NOW'),
  nowMode: env('NOW_MODE', 'offset') as 'offset' | 'frozen',
  llm: {
    provider: env('LLM_PROVIDER', 'rules') as 'rules' | 'openai',
    baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL', 'gpt-4o-mini'),
    timeoutMs: Number(env('LLM_TIMEOUT_MS', '30000')),
    /** 备用渠道（OpenAI 兼容）：LLM_FALLBACK_BASE_URL / _API_KEY / _MODEL，多个用逗号分隔、按位置对应 */
    fallbacks: env('LLM_FALLBACK_BASE_URL')
      .split(',')
      .map((u, i) => ({
        baseUrl: u.trim().replace(/\/+$/, ''),
        apiKey: (env('LLM_FALLBACK_API_KEY').split(',')[i] ?? '').trim(),
        model: (env('LLM_FALLBACK_MODEL').split(',')[i] ?? '').trim() || env('LLM_MODEL', 'gpt-4o-mini'),
      }))
      .filter((c) => c.baseUrl),
  },
  map: {
    provider: env('MAP_PROVIDER', 'mock') as 'mock' | 'amap',
    amapKey: env('AMAP_KEY'),
  },
};
