import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { AppContext } from '../context';
import { getContact, allContacts, getSetting, setSetting, type EventRow, type RequestRow } from '../db';
import { now, toIso, fromIso, clock, TZ, fmtRange } from '../clock';
import type { Agent } from '../agent/agent';
import { expandPeople } from '../agent/people';
import { travelBetweenEvents } from '../agent/schedule';
import { CATEGORY_LABEL, type Category } from '../agent/schema';
import { Hub, listNotifications } from '../services/notifications';
import { approveRequest, rejectRequest, requestView, rsvp, RequestError, getRequest } from '../services/requests';
import { tickReminders } from '../services/reminders';
import { config } from '../config';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createApp(ctx: AppContext, hub: Hub, agent: Agent, opts: { staticDir?: string } = {}) {
  const app = new Hono();
  const db = ctx.db;
  app.use('/api/*', cors());
  app.onError((err, c) => {
    if (err instanceof RequestError) return c.json({ error: err.message }, err.status as 400);
    console.error('[http]', err);
    return c.json({ error: (err as Error).message || 'server error' }, 500);
  });

  const userIdOf = (c: any): string => (c.req.header('x-user-id') || c.req.query('user') || '').trim();
  const requireUser = (c: any) => {
    const u = getContact(db, userIdOf(c));
    if (!u) throw new RequestError('请先在右上角选择用户', 401);
    return u;
  };
  const requireBoss = (c: any) => {
    const u = requireUser(c);
    if (u.role !== 'boss') throw new RequestError('只有老板可以执行这个操作', 403);
    return u;
  };

  // ---- 元信息 / 用户 ----
  app.get('/api/meta', (c) =>
    c.json({
      now: toIso(now()),
      nowOverridden: clock.isOverridden(),
      tz: TZ,
      llm: ctx.llm.mode,
      llmModel: ctx.llm.mode === 'openai' ? config.llm.model : null,
      map: ctx.map.name,
      mapSimulateFailure: getSetting(db, 'map_simulate_failure', '0') === '1',
    }),
  );
  app.get('/api/users', (c) => c.json(allContacts(db)));
  app.get('/api/people/expand', (c) => c.json(expandPeople(db, c.req.query('q') ?? '')));

  // ---- 会话 ----
  app.get('/api/conversations', (c) => c.json(agent.listConversations(requireUser(c).id)));
  app.post('/api/conversations', (c) => c.json(agent.createConversation(requireUser(c).id)));
  app.get('/api/conversations/:id', (c) => {
    const u = requireUser(c);
    const conv = agent.getConversation(c.req.param('id'));
    if (conv.userId !== u.id) throw new RequestError('无权查看该会话', 403);
    return c.json(conv);
  });
  app.post('/api/conversations/:id/messages', async (c) => {
    const u = requireUser(c);
    const id = c.req.param('id');
    const conv = agent.getConversationRow(id);
    if (!conv || conv.user_id !== u.id) throw new RequestError('会话不存在', 404);
    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
    const text = (body.text ?? '').trim();
    if (!text) throw new RequestError('消息不能为空');
    return streamSSE(c, async (stream) => {
      try {
        for await (const ev of agent.handleMessage(id, text)) {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
        }
      } catch (e) {
        console.error('[chat]', e);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: (e as Error).message }) });
      }
    });
  });
  app.post('/api/conversations/:id/people/confirm', async (c) => {
    requireUser(c);
    const body = await c.req.json<{ ids?: string[] }>();
    return c.json(agent.confirmPeople(c.req.param('id'), Array.isArray(body.ids) ? body.ids : []));
  });
  app.post('/api/conversations/:id/submit', (c) => {
    requireUser(c);
    const r = agent.submit(c.req.param('id'));
    return c.json({ ...r, request: requestView(ctx, r.request) });
  });

  // ---- 请求 / 审批 ----
  app.get('/api/requests', (c) => {
    const u = requireUser(c);
    const scope = c.req.query('scope') ?? (u.role === 'boss' ? 'pending' : 'mine');
    let rows: RequestRow[];
    if (scope === 'mine') rows = db.prepare('SELECT * FROM requests WHERE requester_id = ? ORDER BY created_at DESC LIMIT 50').all(u.id) as unknown as RequestRow[];
    else if (scope === 'pending') rows = db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY start").all() as unknown as RequestRow[];
    else rows = db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT 100').all() as unknown as RequestRow[];
    return c.json(rows.map((r) => requestView(ctx, r)));
  });
  app.get('/api/requests/:id', (c) => {
    requireUser(c);
    const r = getRequest(ctx, c.req.param('id'));
    if (!r) throw new RequestError('请求不存在', 404);
    return c.json(requestView(ctx, r));
  });
  app.post('/api/requests/:id/approve', async (c) => {
    requireBoss(c);
    const body = await c.req.json<{ start?: string; end?: string; note?: string }>().catch(() => ({}) as { start?: string; end?: string; note?: string });
    const r = approveRequest(ctx, hub, c.req.param('id'), body);
    return c.json({ request: requestView(ctx, r.request), event: r.event, created: r.created });
  });
  app.post('/api/requests/:id/reject', async (c) => {
    requireBoss(c);
    const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return c.json(requestView(ctx, rejectRequest(ctx, hub, c.req.param('id'), body.reason)));
  });

  // ---- 日程 ----
  app.get('/api/events', async (c) => {
    requireUser(c);
    const from = c.req.query('from') ? fromIso(c.req.query('from')!) : now().startOf('day');
    const to = c.req.query('to') ? fromIso(c.req.query('to')!) : from.add(1, 'day');
    const events = db.prepare('SELECT * FROM events WHERE start < ? AND end > ? ORDER BY start').all(toIso(to), toIso(from)) as unknown as EventRow[];
    const travel = await travelBetweenEvents(ctx, events);
    return c.json({
      events: events.map((e) => ({
        ...e,
        attendees: (JSON.parse(e.attendees) as string[]).map((id) => getContact(db, id)?.name ?? id),
        categoryLabel: CATEGORY_LABEL[e.category as Category] ?? e.category,
        timeLabel: fmtRange(e.start, e.end),
      })),
      travel,
    });
  });

  // ---- 通知 ----
  app.get('/api/notifications', (c) => c.json(listNotifications(db, requireUser(c).id)));
  app.post('/api/notifications/:id/rsvp', async (c) => {
    const u = requireUser(c);
    const body = await c.req.json<{ status?: 'accepted' | 'declined' }>();
    if (body.status !== 'accepted' && body.status !== 'declined') throw new RequestError('status 必须是 accepted 或 declined');
    return c.json(rsvp(ctx, u.id, c.req.param('id'), body.status));
  });
  app.post('/api/notifications/:id/read', (c) => {
    const u = requireUser(c);
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').run(toIso(now()), c.req.param('id'), u.id);
    return c.json({ ok: true });
  });
  app.post('/api/notifications/read-all', (c) => {
    const u = requireUser(c);
    db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ?').run(toIso(now()), u.id);
    return c.json({ ok: true });
  });

  // ---- 实时推送（SSE）----
  app.get('/api/stream', (c) => {
    const u = requireUser(c);
    return streamSSE(c, async (stream) => {
      const unregister = hub.register(u.id, (event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      stream.onAbort(() => unregister());
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ userId: u.id, now: toIso(now()) }) });
      hub.flush(db, u.id); // 错过的提醒：只投递一次
      while (!stream.aborted) {
        await stream.sleep(20000);
        if (stream.aborted) break;
        await stream.writeSSE({ event: 'ping', data: toIso(now()) });
      }
      unregister();
    });
  });

  // ---- 设置 ----
  const SETTING_KEYS = ['company_address', 'home_address', 'reminder_lead_minutes', 'work_start', 'work_end', 'map_simulate_failure'];
  app.get('/api/settings', (c) => {
    requireUser(c);
    return c.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k)])));
  });
  app.put('/api/settings', async (c) => {
    requireBoss(c);
    const body = await c.req.json<Record<string, string>>();
    for (const k of SETTING_KEYS) {
      if (body[k] === undefined) continue;
      let v = String(body[k]).trim();
      if (k === 'reminder_lead_minutes') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1 || n > 1440) throw new RequestError('提前提醒分钟数需在 1-1440 之间');
        v = String(Math.round(n));
      }
      if (k === 'map_simulate_failure') v = v === '1' || v === 'true' ? '1' : '0';
      setSetting(db, k, v);
      if (k === 'company_address' || k === 'home_address') {
        db.prepare("UPDATE places SET address = ? WHERE name = ?").run(v, k === 'company_address' ? '公司' : '家');
      }
    }
    return c.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(db, k)])));
  });

  // ---- 演示辅助：立即执行一次提醒检查 ----
  app.post('/api/admin/tick-reminders', async (c) => {
    requireUser(c);
    return c.json({ created: await tickReminders(ctx, hub) });
  });

  // ---- 静态资源（生产模式：serve web/dist，SPA 回退到 index.html）----
  const staticDir = opts.staticDir;
  if (staticDir && fs.existsSync(staticDir)) {
    app.get('*', async (c) => {
      const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
      let file = path.join(staticDir, urlPath);
      if (!file.startsWith(staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(staticDir, 'index.html');
      const ext = path.extname(file).toLowerCase();
      const data = await fs.promises.readFile(file);
      return c.body(data, 200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    });
  }
  return app;
}
