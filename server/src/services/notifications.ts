import { randomUUID } from 'node:crypto';
import type { DB, NotificationRow } from '../db';
import { now, toIso } from '../clock';

export type Sender = (event: string, data: unknown) => void;

/**
 * SSE 连接中心。
 * 关键设计：每条通知只“投递”给同一用户的一个连接（多标签页不重复弹），
 * 投递后立刻标记 delivered_at（错过的提醒下次打开只显示一次）。
 */
export class Hub {
  private conns = new Map<string, Set<Sender>>();

  register(userId: string, send: Sender): () => void {
    if (!this.conns.has(userId)) this.conns.set(userId, new Set());
    this.conns.get(userId)!.add(send);
    return () => {
      const set = this.conns.get(userId);
      set?.delete(send);
      if (set && set.size === 0) this.conns.delete(userId);
    };
  }

  connectionCount(userId: string) {
    return this.conns.get(userId)?.size ?? 0;
  }

  /** 给该用户的所有标签页广播（用于刷新列表，不弹窗） */
  broadcast(userId: string, event: string, data: unknown) {
    for (const send of this.conns.get(userId) ?? []) {
      try {
        send(event, data);
      } catch {
        /* ignore */
      }
    }
  }

  /** 把该用户所有未投递的通知发给“一个”连接，并标记已投递 */
  flush(db: DB, userId: string): NotificationRow[] {
    const set = this.conns.get(userId);
    if (!set || set.size === 0) return [];
    const target = [...set][set.size - 1];
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND delivered_at IS NULL ORDER BY created_at').all(userId) as unknown as NotificationRow[];
    const delivered: NotificationRow[] = [];
    const mark = db.prepare('UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL');
    for (const row of rows) {
      const r = mark.run(toIso(now()), row.id);
      if (Number(r.changes) === 0) continue; // 其他进程/连接已投递
      try {
        target('notification', { ...row, body: JSON.parse(row.body) });
        delivered.push(row);
      } catch {
        /* 连接已断，回滚投递标记，等下一个连接 */
        db.prepare('UPDATE notifications SET delivered_at = NULL WHERE id = ?').run(row.id);
      }
    }
    if (delivered.length) this.broadcast(userId, 'refresh', { kind: 'notifications' });
    return delivered;
  }
}

export interface NewNotification {
  user_id: string;
  type: NotificationRow['type'] | 'request_new' | 'request_withdrawn';
  event_id?: string | null;
  request_id?: string | null;
  title: string;
  body: Record<string, unknown>;
}

/** 幂等创建：同一用户、同一类型、同一事件/请求只会有一条 */
export function createNotification(db: DB, n: NewNotification): NotificationRow | null {
  const id = randomUUID();
  const r = db
    .prepare(
      'INSERT OR IGNORE INTO notifications(id, user_id, type, event_id, request_id, title, body, rsvp, created_at, delivered_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL)',
    )
    .run(id, n.user_id, n.type, n.event_id ?? null, n.request_id ?? null, n.title, JSON.stringify(n.body), toIso(now()));
  if (Number(r.changes) === 0) return null;
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as unknown as NotificationRow;
}

export function listNotifications(db: DB, userId: string, limit = 100): Array<NotificationRow & { payload: Record<string, unknown> }> {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit) as unknown as NotificationRow[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.body) }));
}
