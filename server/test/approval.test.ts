import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, chat, card, type TestEnv } from './helpers';
import { approveRequest, rejectRequest, rsvp } from '../src/services/requests';
import { tickReminders } from '../src/services/reminders';
import { setSetting, type NotificationRow } from '../src/db';
import { fromIso } from '../src/clock';

const fmt = (iso?: string) => (iso ? fromIso(iso).format('YYYY-MM-DD HH:mm') : undefined);
const BOSS = 'u001';
const LIU_YANG = 'u004';

async function submitMeeting(env: TestEnv) {
  const conv = env.agent.createConversation(LIU_YANG);
  const t = await chat(env.agent, conv.id, '后天上午10点在公司开会，主题是海珠别墅方案评审，叫上设计部和孙磊');
  env.agent.confirmPeople(conv.id, card(t.cards, 'people_confirm')!.selectedIds);
  return env.agent.submit(conv.id).request;
}

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

describe('审批与通知', () => {
  it('同意后写入日程并通知参会人；发起人不需要确认参会；老板不在通知名单', async () => {
    const req = await submitMeeting(env);
    const { event } = approveRequest(env.ctx, env.hub, req.id);
    const invites = env.db.prepare("SELECT user_id FROM notifications WHERE type = 'invite' AND event_id = ?").all(event.id) as { user_id: string }[];
    const ids = invites.map((r) => r.user_id).sort();
    expect(ids).toEqual(['u003', 'u005', 'u006', 'u007', 'u008', 'u010']); // 设计部其他 5 人 + 孙磊
    expect(ids).not.toContain(LIU_YANG);
    expect(ids).not.toContain(BOSS);
    const result = env.db.prepare("SELECT * FROM notifications WHERE type = 'request_result' AND user_id = ?").get(LIU_YANG) as unknown as NotificationRow;
    expect(result.title).toContain('老板已同意');
    expect(JSON.parse(result.body).notified).toBe(6);
  });

  it('参会人可以回复参会/不参会', async () => {
    const req = await submitMeeting(env);
    const { event } = approveRequest(env.ctx, env.hub, req.id);
    const n = env.db.prepare("SELECT * FROM notifications WHERE type = 'invite' AND event_id = ? AND user_id = 'u003'").get(event.id) as unknown as NotificationRow;
    const updated = rsvp(env.ctx, 'u003', n.id, 'declined');
    expect(updated.rsvp).toBe('declined');
    expect(() => rsvp(env.ctx, 'u005', n.id, 'accepted')).toThrow(); // 不能替别人回复
  });

  it('改时间后同意：日程用新时间，发起人被告知改了时间', async () => {
    const req = await submitMeeting(env);
    const { event, request } = approveRequest(env.ctx, env.hub, req.id, { start: '2026-09-25T14:00:00+08:00' });
    expect(fmt(event.start)).toBe('2026-09-25 14:00');
    expect(fmt(event.end)).toBe('2026-09-25 15:00'); // 保持原时长
    expect(request.final_start).toBe(event.start);
    const result = env.db.prepare("SELECT title FROM notifications WHERE type = 'request_result' AND user_id = ?").get(LIU_YANG) as { title: string };
    expect(result.title).toContain('改了时间');
  });

  it('拒绝后不能再批准，发起人收到结果', async () => {
    const req = await submitMeeting(env);
    rejectRequest(env.ctx, env.hub, req.id, '那天出差');
    expect(() => approveRequest(env.ctx, env.hub, req.id)).toThrow();
    expect(env.db.prepare('SELECT COUNT(*) c FROM events WHERE request_id = ?').get(req.id)).toEqual({ c: 0 });
    const result = env.db.prepare("SELECT title, body FROM notifications WHERE type = 'request_result' AND user_id = ?").get(LIU_YANG) as { title: string; body: string };
    expect(result.title).toContain('未同意');
    expect(JSON.parse(result.body).reason).toBe('那天出差');
  });
});

describe('提醒', () => {
  it('开始前 N 分钟给老板建提醒，内容齐全、带导航链接，且只建一次', async () => {
    // NOW=09:00，10:00 有周经营例会；提前 15 分钟还不到点
    expect(await tickReminders(env.ctx, env.hub)).toBe(0);
    setSetting(env.db, 'reminder_lead_minutes', '60');
    expect(await tickReminders(env.ctx, env.hub)).toBe(1);
    expect(await tickReminders(env.ctx, env.hub)).toBe(0); // 幂等
    const n = env.db.prepare("SELECT * FROM notifications WHERE type = 'reminder' AND user_id = ?").get(BOSS) as unknown as NotificationRow;
    const body = JSON.parse(n.body);
    expect(n.title).toContain('周经营例会');
    expect(body).toMatchObject({ category: '会议', subject: '周经营例会', location: '公司' });
    expect(body.time).toContain('10:00');
    expect(body.attendees).toEqual(['王芳', '郑强', '梁静', '邓丽']);
    expect(body.navUrl).toMatch(/^https:\/\/uri\.amap\.com\/navigation\?to=113\.3236,23\.1206/);
  });

  it('错过的提醒下次打开只投递一次；多个标签页不重复弹', async () => {
    setSetting(env.db, 'reminder_lead_minutes', '60');
    await tickReminders(env.ctx, null); // 老板没开页面，提醒留在库里
    const tabA: unknown[] = [];
    const tabB: unknown[] = [];
    env.hub.register(BOSS, (event, data) => event === 'notification' && tabA.push(data));
    env.hub.register(BOSS, (event, data) => event === 'notification' && tabB.push(data));
    env.hub.flush(env.db, BOSS); // 第一次打开：投递给一个连接
    env.hub.flush(env.db, BOSS); // 再刷新：不再重复
    expect(tabA.length + tabB.length).toBe(1);
    const row = env.db.prepare("SELECT delivered_at FROM notifications WHERE type = 'reminder' AND user_id = ?").get(BOSS) as { delivered_at: string | null };
    expect(row.delivered_at).not.toBeNull();
  });
});
