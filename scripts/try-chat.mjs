#!/usr/bin/env node
// 命令行试聊：把标准输入的每一行依次发给一个新对话，打印小助手回复和草稿要点。
// 用法：node scripts/try-chat.mjs [userId] [baseUrl] < lines.txt
//   或  echo "明天下午3点开会" | node scripts/try-chat.mjs u004
import readline from 'node:readline';

const USER = process.argv[2] ?? 'u004';
const BASE = (process.argv[3] ?? process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

async function api(path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function chat(convId, text) {
  const res = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reply = '';
  let state = null;
  const handle = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    const p = JSON.parse(data.join('\n'));
    if (event === 'delta') reply += p.text;
    else if (event === 'state') state = p;
    else if (event === 'error') reply += `\n[error] ${p.message}`;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handle(buf);
  return { reply, state };
}

function summarize(d) {
  if (!d) return '';
  const parts = [];
  if (d.category) parts.push(`类别=${d.category}`);
  if (d.subject) parts.push(`主题=${d.subject}`);
  if (d.start) parts.push(`时间=${d.start.slice(0, 16)}~${(d.end ?? '').slice(11, 16)}`);
  if (d.location) parts.push(`地点=${d.location}`);
  if (d.visitor) parts.push(`来访=${d.visitor}`);
  if (d.counterpart) parts.push(`对方=${d.counterpart}`);
  if (d.headcount) parts.push(`人数=${d.headcount}`);
  if (d.attendees?.names?.length) parts.push(`参与=${d.attendees.names.join('、')}${d.attendees.confirmed ? '(已确认)' : ''}`);
  if (d.pendingFields?.length) parts.push(`待问=${d.pendingFields.join(',')}`);
  if (d.analysis?.travelStatus) parts.push(`车程=${d.analysis.travelStatus}`);
  if (d.submittedRequestId) parts.push(`已提交=${d.submittedRequestId.slice(0, 8)}`);
  return parts.join(' | ');
}

const conv = await api('/conversations', {});
console.log(`[对话 ${conv.id.slice(0, 8)}] 用户 ${USER} @ ${BASE}`);
const rl = readline.createInterface({ input: process.stdin });
for await (const raw of rl) {
  const text = raw.trim();
  if (!text || text.startsWith('#')) continue;
  console.log(`\n> ${text}`);
  const { reply, state } = await chat(conv.id, text);
  console.log(reply.trim());
  const cards = (state?.cards ?? []).map((c) => c.type).join(',');
  console.log(`  [草稿] ${summarize(state?.draft)}${cards ? `  [卡片] ${cards}` : ''}`);
}
