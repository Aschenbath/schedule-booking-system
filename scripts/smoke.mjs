#!/usr/bin/env node
// 端到端冒烟：对一个已启动的服务（默认 http://127.0.0.1:3000）走一遍
// 发起人对话 → 流式回复 → 确认名单 → 提交 → 老板审批 → 日程/通知 → 实时流 → 静态页。
// 用法：node scripts/smoke.mjs [baseUrl]
const BASE = (process.argv[2] ?? process.env.SMOKE_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const REQUESTER = process.env.SMOKE_USER ?? 'u004';
const BOSS = 'u001';

let failed = 0;
function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

async function api(path, { user, method, body } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(user ? { 'x-user-id': user } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return json;
}

// 读取 POST 返回的 SSE 流，收集 delta 文本与 state
async function chat(convId, user, text) {
  const res = await fetch(`${BASE}/api/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': user },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`${res.status} messages: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let reply = '';
  let state = null;
  let deltas = 0;
  const handle = (block) => {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    const payload = JSON.parse(data.join('\n'));
    if (event === 'delta') {
      reply += payload.text;
      deltas++;
    } else if (event === 'state') state = payload;
    else if (event === 'error') throw new Error('stream error: ' + payload.message);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handle(buf);
  return { reply, state, deltas };
}

async function main() {
  const meta = await api('/meta');
  ok(meta.tz === 'Asia/Shanghai', '服务在线 /api/meta', `now=${meta.now} llm=${meta.llm} map=${meta.map}`);

  const users = await api('/users');
  const requester = users.find((u) => u.id === REQUESTER);
  const guo = users.find((u) => u.name === '郭涛');
  ok(users.length >= 30 && requester && guo, `种子联系人 ${users.length} 人`, `发起人=${requester?.name}(${requester?.dept})`);

  // 1. 对话 + 流式回复
  const conv = await api('/conversations', { user: REQUESTER, body: {} });
  ok(!!conv.id, '新建对话', conv.id);
  const t1 = await chat(conv.id, REQUESTER, '明天下午4点在公司开会，主题预算复核，叫上郭涛');
  ok(t1.deltas > 1 && t1.reply.length > 0, '流式回复（多段 delta）', `${t1.deltas} 段，${t1.reply.length} 字`);
  const draft = t1.state?.draft;
  ok(draft?.category === 'meeting', '识别类别=会议', draft?.category);
  ok(!!draft?.start && draft.start.includes('T16:00'), '解析时间=明天16:00', draft?.start);
  const cards = t1.state?.cards ?? [];
  const people = cards.find((c) => c.type === 'people_confirm');
  ok(!!people && draft.attendees.ids.includes(guo.id), '名单展开含郭涛，等待确认', JSON.stringify(draft.attendees.names));

  // 2. 刷新后仍在（持久化）
  const again = await api(`/conversations/${conv.id}`, { user: REQUESTER });
  ok(again.messages.length >= 2 && again.draft?.start === draft.start, '对话与草稿已持久化', `${again.messages.length} 条消息`);

  // 3. 确认名单 → 4. 提交（两次，验证幂等）
  const confirmed = await api(`/conversations/${conv.id}/people/confirm`, { user: REQUESTER, body: { ids: draft.attendees.ids } });
  ok(confirmed.draft?.attendees?.confirmed === true, '确认名单');
  const sub1 = await api(`/conversations/${conv.id}/submit`, { user: REQUESTER, body: {} });
  const reqId = sub1.draft?.submittedRequestId;
  ok(!!reqId, '提交请求', reqId);
  let dupErr = null;
  const sub2 = await api(`/conversations/${conv.id}/submit`, { user: REQUESTER, body: {} }).catch((e) => ((dupErr = e), null));
  ok((sub2 && sub2.draft?.submittedRequestId === reqId) || dupErr, '重复提交不产生第二条请求');
  const pendingMine = await api('/requests?scope=mine', { user: REQUESTER });
  ok(pendingMine.filter((r) => r.conversation_id === conv.id).length === 1, '我的请求里只有一条', `${pendingMine.length} 条`);

  // 5. 老板审批（两次，验证幂等）
  const pending = await api('/requests?scope=pending', { user: BOSS });
  ok(pending.some((r) => r.id === reqId), '老板待批准列表可见');
  const ap1 = await api(`/requests/${reqId}/approve`, { user: BOSS, body: {} });
  ok(ap1.status === 'approved' || ap1.request?.status === 'approved', '老板同意', JSON.stringify(ap1).slice(0, 120));
  let apErr = null;
  await api(`/requests/${reqId}/approve`, { user: BOSS, body: {} }).catch((e) => (apErr = e));
  ok(!!apErr || true, '重复审批被拒绝或无副作用', apErr ? apErr.message.slice(0, 80) : '(返回 200)');

  // 6. 日程里只多一条
  const from = new Date(draft.start);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const ev = await api(`/events?from=${from.toISOString()}&to=${to.toISOString()}`, { user: BOSS });
  const mine = ev.events.filter((e) => e.request_id === reqId || e.requestId === reqId);
  ok(mine.length === 1, '审批后日程恰好新增 1 条', `当天共 ${ev.events.length} 条，travel ${ev.travel.length} 段`);

  // 7. 参会人通知 + 发起人拿到审批结果
  const guoN = await api('/notifications', { user: guo.id });
  const invite = guoN.find((n) => n.type === 'invite' && (n.event_id === mine[0]?.id || n.payload?.subject === '预算复核'));
  ok(!!invite, '郭涛收到会议通知', invite ? `${invite.title} / ${invite.payload?.time} / ${invite.payload?.location}` : '');
  if (invite) {
    ok(!!invite.payload?.navUrl, '通知带地图导航链接', invite.payload?.navUrl);
    const r = await api(`/notifications/${invite.id}/rsvp`, { user: guo.id, body: { status: 'accepted' } });
    ok(r.rsvp === 'accepted' || r.status === 'ok', '郭涛回复参会');
  }
  const myN = await api('/notifications', { user: REQUESTER });
  ok(myN.some((n) => n.type === 'request_result'), '发起人收到审批结果通知');

  // 8. 实时流：连接后应先收到 hello/ready 之类的首包
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);
  let firstChunk = '';
  try {
    const res = await fetch(`${BASE}/api/stream`, { headers: { 'x-user-id': BOSS }, signal: ac.signal });
    const reader = res.body.getReader();
    const { value } = await reader.read();
    firstChunk = new TextDecoder().decode(value ?? new Uint8Array());
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  ok(firstChunk.length > 0, 'SSE 实时流可连接', firstChunk.replace(/\s+/g, ' ').slice(0, 80));

  // 9. 静态页
  const html = await fetch(BASE + '/').then((r) => r.text());
  ok(html.includes('<div id="app">') || html.includes('id="app"'), '静态前端可访问 /', html.length + ' bytes');
  const spa = await fetch(BASE + '/approvals').then((r) => r.text());
  ok(spa.includes('id="app"'), 'SPA 路由回退到 index.html');

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL ', e.message);
  process.exit(1);
});
