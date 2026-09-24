import { randomUUID, createHash } from 'node:crypto';
import type { AppContext } from '../context';
import { transaction, getBoss, getContact, type RequestRow, type EventRow, type NotificationRow } from '../db';
import { now, toIso, fromIso, fmtRange } from '../clock';
import { CATEGORY_LABEL, type Category, type Draft, draftTitle } from '../agent/schema';
import { createNotification, type Hub } from './notifications';
import { navigationUrl } from '../map';
import { resolveAddress } from '../agent/schedule';

export class RequestError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export function getRequest(ctx: AppContext, id: string): RequestRow | undefined {
  return ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as unknown as RequestRow | undefined;
}

export function requestView(ctx: AppContext, r: RequestRow) {
  const attendees = (JSON.parse(r.attendees) as string[]).map((id) => getContact(ctx.db, id)).filter(Boolean);
  const requester = getContact(ctx.db, r.requester_id);
  return {
    ...r,
    attendees: attendees.map((c) => ({ id: c!.id, name: c!.name, dept: c!.dept, title: c!.title })),
    requester: requester ? { id: requester.id, name: requester.name, dept: requester.dept } : null,
    analysis: r.analysis ? JSON.parse(r.analysis) : null,
    categoryLabel: CATEGORY_LABEL[r.category as Category] ?? r.category,
    timeLabel: fmtRange(r.start, r.end),
  };
}

/** 幂等键：同一会话 + 同样的核心内容 → 同一个请求 */
export function idempotencyKey(conversationId: string, d: Draft): string {
  const core = { c: d.category, s: d.subject, st: d.start, en: d.end, l: d.location, a: [...d.attendees.ids].sort(), v: d.visitor, cp: d.counterpart, h: d.headcount };
  return createHash('sha1').update(conversationId + '|' + JSON.stringify(core)).digest('hex');
}

const DONE_TEXT: Record<string, string> = { approved: '被老板同意', rejected: '被老板拒绝', withdrawn: '被发起人撤回' };

/** 员工提交：重复提交返回同一条请求（被拒、已撤回的请求在处理时已让出幂等键，同样内容再交是新请求） */
export function submitRequest(ctx: AppContext, hub: Hub | null, conversationId: string, requesterId: string, d: Draft): { request: RequestRow; created: boolean } {
  if (!d.category || !d.start || !d.end) throw new RequestError('信息不完整，无法提交');
  const key = idempotencyKey(conversationId, d);
  const existing = ctx.db.prepare('SELECT * FROM requests WHERE idempotency_key = ?').get(key) as unknown as RequestRow | undefined;
  if (existing) return { request: existing, created: false };
  // 同一会话已有待批准请求也视为重复（防止改一个字重复刷请求）
  const pendingInConv = ctx.db.prepare("SELECT * FROM requests WHERE conversation_id = ? AND status = 'pending'").get(conversationId) as unknown as RequestRow | undefined;
  if (pendingInConv) return { request: pendingInConv, created: false };
  // 换了个会话把同样的事再提一遍（同一发起人、同样的类别/主题/起止/地点，且还在待批准或已同意）也算重复
  const sameElsewhere = ctx.db
    .prepare("SELECT * FROM requests WHERE requester_id = ? AND category = ? AND subject = ? AND start = ? AND end = ? AND location = ? AND status IN ('pending', 'approved')")
    .get(requesterId, d.category, draftTitle(d), d.start, d.end, d.location ?? '') as unknown as RequestRow | undefined;
  if (sameElsewhere) return { request: sameElsewhere, created: false };

  const id = randomUUID();
  const created = transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO requests(id, idempotency_key, conversation_id, requester_id, category, subject, start, end, location, attendees, headcount, visitor, counterpart, note, analysis, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        key,
        conversationId,
        requesterId,
        d.category,
        draftTitle(d),
        d.start!,
        d.end!,
        d.location ?? '',
        JSON.stringify(d.attendees.ids),
        d.headcount ?? null,
        d.visitor ?? null,
        d.counterpart ?? null,
        d.note ?? null,
        d.analysis ? JSON.stringify(d.analysis) : null,
        toIso(now()),
      );
    const boss = getBoss(ctx.db);
    const requester = getContact(ctx.db, requesterId);
    if (requesterId === boss.id) return ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as unknown as RequestRow;
    createNotification(ctx.db, {
      user_id: boss.id,
      type: 'request_new',
      request_id: id,
      title: `新的预约请求：${draftTitle(d)}`,
      body: { requestId: id, requester: requester?.name ?? requesterId, category: CATEGORY_LABEL[d.category!], time: fmtRange(d.start!, d.end!), location: d.location ?? '', travelStatus: d.analysis?.travelStatus ?? 'none' },
    });
    return ctx.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as unknown as RequestRow;
  });
  // 老板给自己加日程：不用自己审批自己，直接同意并写入日程、通知参与人
  if (requesterId === getBoss(ctx.db).id) return { request: approveRequest(ctx, hub, id, { note: '老板本人添加' }).request, created: true };
  hub?.flush(ctx.db, getBoss(ctx.db).id);
  return { request: created, created: true };
}

/** 能拿来导航的坐标：接了真实高德，或者是通讯录/常用地点里登记过的地点；模拟地图估出来的坐标不可信，改用关键字搜索 */
function trustedCoord(ctx: AppContext, address: string, coord: { lng: number; lat: number } | undefined) {
  if (!coord) return null;
  if (ctx.map.name === 'amap') return coord;
  const known = ctx.db.prepare('SELECT 1 FROM places WHERE address = ? AND lng IS NOT NULL').get(address);
  return known ? coord : null;
}

function eventBody(ctx: AppContext, e: EventRow) {
  const names = (JSON.parse(e.attendees) as string[]).map((id) => getContact(ctx.db, id)?.name).filter(Boolean) as string[];
  const address = resolveAddress(ctx, e.location);
  const coord = ctx.db.prepare('SELECT lng, lat FROM geocache WHERE address = ?').get(address) as { lng: number; lat: number } | undefined;
  return {
    eventId: e.id,
    category: CATEGORY_LABEL[e.category as Category] ?? e.category,
    subject: e.subject,
    start: e.start,
    end: e.end,
    time: fmtRange(e.start, e.end),
    location: e.location,
    address,
    navUrl: navigationUrl(address || e.location, trustedCoord(ctx, address, coord)),
    attendees: names,
    note: e.note ?? '',
  };
}

/** 老板同意（可改时间）。重复批准不会建出第二条日程。 */
export function approveRequest(ctx: AppContext, hub: Hub | null, id: string, opts: { start?: string; end?: string; note?: string } = {}): { request: RequestRow; event: EventRow; created: boolean } {
  const result = transaction(ctx.db, () => {
    const req = getRequest(ctx, id);
    if (!req) throw new RequestError('请求不存在', 404);
    if (req.status !== 'pending') {
      const ev = req.event_id ? (ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(req.event_id) as unknown as EventRow) : undefined;
      if (req.status === 'approved' && ev) return { request: req, event: ev, created: false };
      throw new RequestError(`该请求已${DONE_TEXT[req.status] ?? '处理'}，不能再批准`, 409);
    }
    let finalStart = req.start;
    let finalEnd = req.end;
    if (opts.start) {
      const s = fromIso(opts.start);
      if (!s.isValid()) throw new RequestError('新的开始时间无效');
      const dur = fromIso(req.end).diff(fromIso(req.start), 'minute');
      finalStart = toIso(s);
      finalEnd = opts.end && fromIso(opts.end).isValid() && fromIso(opts.end).isAfter(s) ? toIso(fromIso(opts.end)) : toIso(s.add(dur, 'minute'));
    }
    const rescheduled = finalStart !== req.start || finalEnd !== req.end;
    const eventId = 'evt_' + randomUUID().slice(0, 8);
    ctx.db
      .prepare(
        `INSERT INTO events(id, request_id, category, subject, start, end, location, attendees, note, created_by, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'request', ?)`,
      )
      .run(eventId, req.id, req.category, req.subject ?? '预约', finalStart, finalEnd, req.location ?? '', req.attendees, req.note ?? null, req.requester_id, toIso(now()));
    const upd = ctx.db
      .prepare("UPDATE requests SET status = 'approved', final_start = ?, final_end = ?, event_id = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(finalStart, finalEnd, eventId, opts.note ?? (rescheduled ? '老板改了时间后同意' : null), toIso(now()), req.id);
    if (Number(upd.changes) !== 1) throw new RequestError('请求状态已变化，请刷新', 409);
    const event = ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId) as unknown as EventRow;
    const body = eventBody(ctx, event);
    const boss = getBoss(ctx.db);
    // 通知参会人（发起人本人不需要确认参会；老板是日程主人也不需要）
    const attendeeIds = JSON.parse(event.attendees) as string[];
    for (const uid of attendeeIds) {
      if (uid === req.requester_id || uid === boss.id) continue;
      createNotification(ctx.db, { user_id: uid, type: 'invite', event_id: eventId, title: `会议通知：${event.subject}`, body });
    }
    // 告诉发起人结果
    createNotification(ctx.db, {
      user_id: req.requester_id,
      type: 'request_result',
      request_id: req.id,
      title: rescheduled ? `老板已同意（改了时间）：${event.subject}` : `老板已同意：${event.subject}`,
      body: { ...body, requestId: req.id, result: 'approved', rescheduled, notified: attendeeIds.filter((u) => u !== req.requester_id && u !== boss.id).length },
    });
    const request = getRequest(ctx, id)!;
    return { request, event, created: true, notifyUsers: [...new Set([...attendeeIds, req.requester_id])] };
  });
  if (hub && result.created) for (const uid of (result as any).notifyUsers as string[]) hub.flush(ctx.db, uid);
  return { request: result.request, event: result.event, created: result.created };
}

export function rejectRequest(ctx: AppContext, hub: Hub | null, id: string, reason?: string): RequestRow {
  const req = transaction(ctx.db, () => {
    const r = getRequest(ctx, id);
    if (!r) throw new RequestError('请求不存在', 404);
    if (r.status !== 'pending') throw new RequestError(`该请求已${DONE_TEXT[r.status] ?? '处理'}`, 409);
    // 幂等键让出来：员工改好后按同样内容再交，是一条新请求，而不是返回这条被拒的
    ctx.db.prepare("UPDATE requests SET status = 'rejected', idempotency_key = idempotency_key || ':' || id, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(reason ?? null, toIso(now()), id);
    createNotification(ctx.db, {
      user_id: r.requester_id,
      type: 'request_result',
      request_id: r.id,
      title: `老板未同意：${r.subject ?? '预约'}`,
      body: { requestId: r.id, result: 'rejected', reason: reason ?? '', subject: r.subject, time: fmtRange(r.start, r.end), location: r.location },
    });
    return getRequest(ctx, id)!;
  });
  hub?.flush(ctx.db, req.requester_id);
  return req;
}

/** 发起人撤回还没批的请求：只有待批准的能撤，老板的待批准列表随即去掉它；老板已经处理过的不能撤 */
export function withdrawRequest(ctx: AppContext, hub: Hub | null, id: string, requesterId: string): RequestRow {
  const req = transaction(ctx.db, () => {
    const r = getRequest(ctx, id);
    if (!r || r.requester_id !== requesterId) throw new RequestError('请求不存在', 404);
    const upd = ctx.db.prepare("UPDATE requests SET status = 'withdrawn', idempotency_key = idempotency_key || ':' || id, decided_at = ? WHERE id = ? AND status = 'pending'").run(toIso(now()), id);
    if (Number(upd.changes) !== 1) throw new RequestError(`该请求已${DONE_TEXT[r.status] ?? '处理'}，不能撤回`, 409);
    createNotification(ctx.db, {
      user_id: getBoss(ctx.db).id,
      type: 'request_withdrawn',
      request_id: id,
      title: `预约已撤回：${r.subject ?? '预约'}`,
      body: { requestId: id, requester: getContact(ctx.db, requesterId)?.name ?? requesterId, category: CATEGORY_LABEL[r.category as Category] ?? r.category, time: fmtRange(r.start, r.end), location: r.location ?? '' },
    });
    return getRequest(ctx, id)!;
  });
  hub?.flush(ctx.db, getBoss(ctx.db).id);
  return req;
}

export function rsvp(ctx: AppContext, userId: string, notificationId: string, status: 'accepted' | 'declined') {
  const r = ctx.db.prepare("UPDATE notifications SET rsvp = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ? AND type = 'invite'").run(status, toIso(now()), notificationId, userId);
  if (Number(r.changes) === 0) throw new RequestError('通知不存在', 404);
  return ctx.db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId) as unknown as NotificationRow;
}

export { eventBody };
