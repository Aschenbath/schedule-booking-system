import type { AppContext } from '../context';
import { getBoss, getSetting, type EventRow } from '../db';
import { now, toIso, fromIso } from '../clock';
import { createNotification, type Hub } from './notifications';
import { eventBody } from './requests';
import { geocodeCached, resolveAddress } from '../agent/schedule';

/**
 * 提醒调度：开始前 N 分钟给老板建一条 reminder 通知（幂等），并尝试投递。
 * 返回本次新建的通知数量。测试可直接调用。
 */
export async function tickReminders(ctx: AppContext, hub: Hub | null): Promise<number> {
  const lead = Number(getSetting(ctx.db, 'reminder_lead_minutes', '15')) || 15;
  const t = now();
  const boss = getBoss(ctx.db);
  const due = ctx.db.prepare('SELECT * FROM events WHERE start <= ? AND end > ? ORDER BY start').all(toIso(t.add(lead, 'minute')), toIso(t)) as unknown as EventRow[];
  let created = 0;
  for (const e of due) {
    const exists = ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'reminder' AND event_id = ?").get(boss.id, e.id);
    if (exists) continue;
    // 尽量把坐标准备好，让“一点就导航”更准；失败也不影响提醒
    try {
      await geocodeCached(ctx, resolveAddress(ctx, e.location));
    } catch {
      /* ignore */
    }
    const body = eventBody(ctx, e);
    const minutes = Math.max(0, fromIso(e.start).diff(t, 'minute'));
    const n = createNotification(ctx.db, {
      user_id: boss.id,
      type: 'reminder',
      event_id: e.id,
      title: `${minutes} 分钟后：${body.category}「${e.subject}」`,
      body: { ...body, minutesBefore: minutes },
    });
    if (n) created++;
  }
  if (created && hub) hub.flush(ctx.db, boss.id);
  return created;
}

export function startReminderScheduler(ctx: AppContext, hub: Hub, intervalMs = 5000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tickReminders(ctx, hub);
    } catch (e) {
      console.error('[reminder] tick failed', e);
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
