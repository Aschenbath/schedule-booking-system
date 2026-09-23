import type { AppContext } from '../context';
import { getSetting } from '../db';
import type { EventRow } from '../db';
import { MapError, haversineKm, type LatLng } from '../map';
import { dayjs, fromIso, toIso, fmtDateTime, now as clockNow, type Dayjs } from '../clock';

export interface TravelInfo {
  status: 'ok' | 'same_place' | 'unverified';
  minutes?: number;
  reason?: string;
}
export interface NeighborCheck {
  eventId: string;
  subject: string;
  start: string;
  end: string;
  location: string;
  gapMin: number;
  travel: TravelInfo;
  /** true 够 / false 赶不上 / null 未核实 */
  enough: boolean | null;
  /** 赶不上时建议的新开始时间（ISO） */
  suggestStart?: string;
}
export interface Suggestion {
  start: string;
  end: string;
  label: string;
}
export interface Analysis {
  start: string;
  end: string;
  location: string;
  conflicts: Array<{ id: string; subject: string; start: string; end: string; location: string }>;
  before?: NeighborCheck;
  after?: NeighborCheck;
  /** none = 前后没有需要赶路的日程 */
  travelStatus: 'ok' | 'tight' | 'unverified' | 'none';
  suggestions: Suggestion[];
}

/** 把“公司/家/已知地点名”解析成标准地址，便于判断同一地点 */
export function resolveAddress(ctx: AppContext, loc: string): string {
  const s = (loc ?? '').trim();
  if (!s) return '';
  if (/^(公司|办公室|总部|本部|公司总部)/.test(s) || /^(公司|总部)?(\d+楼|[一二三四五六七八九十]+楼)?(大?会议室|办公室)/.test(s)) {
    return getSetting(ctx.db, 'company_address') || s;
  }
  if (/^(家|老板家|家里)$/.test(s)) return getSetting(ctx.db, 'home_address') || s;
  const place = ctx.db.prepare('SELECT address FROM places WHERE name = ? OR ? LIKE name || \'%\' ORDER BY length(name) DESC LIMIT 1').get(s, s) as
    | { address: string }
    | undefined;
  return place?.address ?? s;
}

export async function geocodeCached(ctx: AppContext, address: string): Promise<LatLng> {
  const row = ctx.db.prepare('SELECT lng, lat FROM geocache WHERE address = ?').get(address) as { lng: number; lat: number } | undefined;
  if (row) return row;
  const p = await ctx.map.geocode(address);
  ctx.db
    .prepare('INSERT INTO geocache(address, lng, lat, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(address) DO UPDATE SET lng = excluded.lng, lat = excluded.lat, updated_at = excluded.updated_at')
    .run(address, p.lng, p.lat, toIso(clockNow()));
  return p;
}

/** 估算两地驾车时长；地图失败时返回 unverified，绝不返回猜测值 */
export async function estimateTravel(ctx: AppContext, fromLoc: string, toLoc: string): Promise<TravelInfo> {
  const a = resolveAddress(ctx, fromLoc);
  const b = resolveAddress(ctx, toLoc);
  if (!a || !b) return { status: 'unverified', reason: '地点为空' };
  if (a === b) return { status: 'same_place' };
  try {
    const [pa, pb] = [await geocodeCached(ctx, a), await geocodeCached(ctx, b)];
    if (haversineKm(pa, pb) < 0.3) return { status: 'same_place' };
    const minutes = await ctx.map.drivingMinutes(pa, pb);
    return { status: 'ok', minutes };
  } catch (e) {
    const reason = e instanceof MapError ? e.message : `地图服务异常: ${(e as Error)?.message ?? e}`;
    return { status: 'unverified', reason };
  }
}

const ceilTo = (d: Dayjs, step: number) => {
  const m = d.minute();
  const r = m % step === 0 ? 0 : step - (m % step);
  return d.add(r, 'minute').second(0).millisecond(0);
};

function eventsBetween(ctx: AppContext, from: Dayjs, to: Dayjs, excludeId?: string): EventRow[] {
  return (ctx.db.prepare('SELECT * FROM events WHERE start < ? AND end > ? AND (? IS NULL OR id != ?) ORDER BY start').all(toIso(to), toIso(from), excludeId ?? null, excludeId ?? null) as unknown) as EventRow[];
}

/** 冲突 + 前后车程分析 */
export async function analyzeSlot(ctx: AppContext, startIso: string, endIso: string, location: string, excludeEventId?: string): Promise<Analysis> {
  const start = fromIso(startIso);
  const end = fromIso(endIso);
  const dayEvents = eventsBetween(ctx, start.startOf('day'), start.endOf('day'), excludeEventId);
  const conflicts = dayEvents.filter((e) => fromIso(e.start).isBefore(end) && fromIso(e.end).isAfter(start));
  const before = [...dayEvents].reverse().find((e) => !fromIso(e.end).isAfter(start));
  const after = dayEvents.find((e) => !fromIso(e.start).isBefore(end));

  const analysis: Analysis = {
    start: startIso,
    end: endIso,
    location,
    conflicts: conflicts.map((e) => ({ id: e.id, subject: e.subject, start: e.start, end: e.end, location: e.location })),
    travelStatus: 'none',
    suggestions: [],
  };

  const check = async (nb: EventRow, side: 'before' | 'after'): Promise<NeighborCheck> => {
    const travel = side === 'before' ? await estimateTravel(ctx, nb.location, location) : await estimateTravel(ctx, location, nb.location);
    const gapMin = side === 'before' ? start.diff(fromIso(nb.end), 'minute') : fromIso(nb.start).diff(end, 'minute');
    let enough: boolean | null = null;
    let suggestStart: string | undefined;
    if (travel.status === 'same_place') enough = true;
    else if (travel.status === 'ok') {
      enough = gapMin >= (travel.minutes ?? 0);
      if (!enough) {
        const dur = end.diff(start, 'minute');
        const s = side === 'before' ? ceilTo(fromIso(nb.end).add(travel.minutes ?? 0, 'minute'), 5) : ceilTo(fromIso(nb.start).subtract((travel.minutes ?? 0) + dur, 'minute'), 5);
        suggestStart = toIso(s);
      }
    }
    return { eventId: nb.id, subject: nb.subject, start: nb.start, end: nb.end, location: nb.location, gapMin, travel, enough, suggestStart };
  };

  if (location && before && conflicts.length === 0) analysis.before = await check(before, 'before');
  if (location && after && conflicts.length === 0) analysis.after = await check(after, 'after');

  const checks = [analysis.before, analysis.after].filter(Boolean) as NeighborCheck[];
  const moving = checks.filter((c) => c.travel.status !== 'same_place');
  if (moving.some((c) => c.travel.status === 'unverified')) analysis.travelStatus = 'unverified';
  else if (moving.some((c) => c.enough === false)) analysis.travelStatus = 'tight';
  else if (moving.length > 0) analysis.travelStatus = 'ok';
  else analysis.travelStatus = 'none';

  if (conflicts.length > 0 || analysis.travelStatus === 'tight') {
    analysis.suggestions = await suggestSlots(ctx, start, end.diff(start, 'minute'), location, excludeEventId);
  }
  return analysis;
}

/** 在工作时间内找可用空档（考虑相邻日程的车程；车程未核实时按 30 分钟保守预留） */
export async function suggestSlots(ctx: AppContext, around: Dayjs, durationMin: number, location: string, excludeEventId?: string, limit = 3): Promise<Suggestion[]> {
  const [wsH, wsM] = (getSetting(ctx.db, 'work_start', '09:00') || '09:00').split(':').map(Number);
  const [weH, weM] = (getSetting(ctx.db, 'work_end', '18:00') || '18:00').split(':').map(Number);
  const out: Suggestion[] = [];
  const travelCache = new Map<string, TravelInfo>();
  const travelBetween = async (a: string, b: string) => {
    const k = `${a}=>${b}`;
    if (!travelCache.has(k)) travelCache.set(k, await estimateTravel(ctx, a, b));
    return travelCache.get(k)!;
  };
  const buffer = (t: TravelInfo) => (t.status === 'ok' ? t.minutes ?? 0 : t.status === 'same_place' ? 0 : 30);
  const nowT = clockNow();

  for (let dayOffset = 0; dayOffset < 3 && out.length < limit; dayOffset++) {
    const day = around.startOf('day').add(dayOffset, 'day');
    const dayStart = day.hour(wsH).minute(wsM);
    const dayEnd = day.hour(weH).minute(weM);
    const events = eventsBetween(ctx, day, day.endOf('day'), excludeEventId);
    let cursor = ceilTo(dayOffset === 0 ? (around.isAfter(dayStart) ? around : dayStart) : dayStart, 15);
    if (cursor.isBefore(nowT)) cursor = ceilTo(nowT, 15);
    while (!cursor.add(durationMin, 'minute').isAfter(dayEnd) && out.length < limit) {
      const s = cursor;
      const e = cursor.add(durationMin, 'minute');
      const overlap = events.find((ev) => fromIso(ev.start).isBefore(e) && fromIso(ev.end).isAfter(s));
      if (overlap) {
        cursor = ceilTo(fromIso(overlap.end), 15);
        continue;
      }
      const prev = [...events].reverse().find((ev) => !fromIso(ev.end).isAfter(s));
      const next = events.find((ev) => !fromIso(ev.start).isBefore(e));
      let ok = true;
      let unverified = false;
      if (prev) {
        const t = await travelBetween(prev.location, location);
        if (t.status === 'unverified') unverified = true;
        if (s.diff(fromIso(prev.end), 'minute') < buffer(t)) ok = false;
      }
      if (ok && next) {
        const t = await travelBetween(location, next.location);
        if (t.status === 'unverified') unverified = true;
        if (fromIso(next.start).diff(e, 'minute') < buffer(t)) ok = false;
      }
      if (ok) {
        out.push({ start: toIso(s), end: toIso(e), label: `${fmtDateTime(s)}–${e.format('HH:mm')}${unverified ? '（车程未核实，按30分钟预留）' : ''}` });
        cursor = cursor.add(Math.max(durationMin, 60), 'minute');
      } else cursor = cursor.add(15, 'minute');
    }
  }
  return out;
}

/** 日程视图：相邻两场之间的车程（同一天内按顺序） */
export async function travelBetweenEvents(ctx: AppContext, events: EventRow[]): Promise<Array<{ fromId: string; toId: string; travel: TravelInfo; gapMin: number; enough: boolean | null }>> {
  const out: Array<{ fromId: string; toId: string; travel: TravelInfo; gapMin: number; enough: boolean | null }> = [];
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!dayjs(a.start).isSame(dayjs(b.start), 'day')) continue;
    const travel = await estimateTravel(ctx, a.location, b.location);
    const gapMin = fromIso(b.start).diff(fromIso(a.end), 'minute');
    const enough = travel.status === 'ok' ? gapMin >= (travel.minutes ?? 0) : travel.status === 'same_place' ? true : null;
    out.push({ fromId: a.id, toId: b.id, travel, gapMin, enough });
  }
  return out;
}
