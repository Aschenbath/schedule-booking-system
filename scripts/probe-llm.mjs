#!/usr/bin/env node
// 探测 .env 里配置的大模型接口是否可用：先做一次 JSON 抽取（非流式），再做一次流式回复。
// 用法：node scripts/probe-llm.mjs        （读取仓库根目录 .env）
//       LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... node scripts/probe-llm.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log('已读取', path.relative(root, envFile));
} else {
  console.log('未找到 .env，仅使用环境变量');
}

const baseUrl = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
const apiKey = (process.env.LLM_API_KEY ?? '').trim();
const model = (process.env.LLM_MODEL ?? 'gpt-4o-mini').trim();
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? '30000');
const mask = (k) => (k.length <= 8 ? '***' : `${k.slice(0, 4)}…${k.slice(-4)}`);

console.log(`LLM_PROVIDER=${process.env.LLM_PROVIDER ?? '(未设置，默认 rules)'}`);
console.log(`LLM_BASE_URL=${baseUrl}`);
console.log(`LLM_MODEL=${model}`);
console.log(`LLM_API_KEY=${apiKey ? mask(apiKey) : '(空)'}`);
if (!apiKey) {
  console.error('\n没有 LLM_API_KEY，无法探测。请把 key 写进 .env（该文件已被 .gitignore 忽略）。');
  process.exit(2);
}

async function post(body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

let failed = false;

// 1) 非流式 + JSON 抽取（和服务里的 extract 调用方式一致）
{
  const t0 = Date.now();
  const messages = [
    { role: 'system', content: '你是信息抽取器，只输出 JSON 对象，不要输出其他文字。字段：category(meeting|reception|dinner|other|unsure), subject, timeText, location, people(数组)。' },
    { role: 'user', content: '明天下午3点在公司开会，讨论海珠别墅方案，叫上设计部' },
  ];
  try {
    let res = await post({ model, messages, temperature: 0, stream: false, response_format: { type: 'json_object' } });
    let note = '';
    if (!res.ok) {
      note = `（response_format 不被支持：HTTP ${res.status}，已回退）`;
      res = await post({ model, messages, temperature: 0, stream: false });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    let parsed = null;
    try {
      parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      /* 非 JSON */
    }
    console.log(`\n[1] 非流式抽取 ${Date.now() - t0}ms ${note}`);
    console.log('    返回：', content.replace(/\s+/g, ' ').slice(0, 200));
    console.log(parsed ? `    JSON 可解析，category=${parsed.category}` : '    警告：返回不是合法 JSON，服务端会回退到规则抽取');
  } catch (e) {
    failed = true;
    console.log(`\n[1] 非流式抽取 失败：${e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message}`);
  }
}

// 2) 流式回复
{
  const t0 = Date.now();
  try {
    const res = await post({
      model,
      messages: [
        { role: 'system', content: '你是公司里帮员工预约老板时间的助手，用简体中文、口语化、两句话以内回复。' },
        { role: 'user', content: '帮我确认一下：明天下午3点，公司会议室，主题海珠别墅方案，参与人设计部6人。' },
      ],
      temperature: 0.3,
      stream: true,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let out = '';
    let chunks = 0;
    let firstAt = 0;
    outer: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') break outer;
        try {
          const d = JSON.parse(p)?.choices?.[0]?.delta?.content;
          if (d) {
            if (!firstAt) firstAt = Date.now() - t0;
            out += d;
            chunks++;
          }
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
    }
    console.log(`\n[2] 流式回复 首字 ${firstAt}ms，共 ${chunks} 段，${Date.now() - t0}ms`);
    console.log('    返回：', out.replace(/\s+/g, ' ').slice(0, 200));
    if (!chunks) {
      failed = true;
      console.log('    警告：没有收到任何流式片段');
    }
  } catch (e) {
    failed = true;
    console.log(`\n[2] 流式回复 失败：${e.name === 'AbortError' ? `超时 ${timeoutMs}ms` : e.message}`);
  }
}

console.log(failed ? '\n探测未通过：请换一个 LLM_BASE_URL / LLM_MODEL，或先用 LLM_PROVIDER=rules 离线模式。' : '\n探测通过：可以把 LLM_PROVIDER=openai 写进 .env 后启动服务。');
process.exit(failed ? 1 : 0);
