// 提交之后员工又改口 / 取消 / 老板先处理了：对话里说的要和老板那边看到的一致（离线规则模型 + 模拟地图，不联网）
import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, chat, card, type TestEnv } from './helpers';
import { fromIso } from '../src/clock';
import { getBoss } from '../src/db';
import { approveRequest, rejectRequest, withdrawRequest, getRequest } from '../src/services/requests';

const fmt = (iso?: string) => (iso ? fromIso(iso).format('YYYY-MM-DD HH:mm') : undefined);
const MA_JUN = 'u019';
const LIU_YANG = 'u004';
// 一句话说全的饭局：周五 19:00 起，默认 120 分钟
const DINNER = '周五晚上7点跟建材供应商吃饭，在陶陶居北京路店，一共6个人';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

const status = (id: string) => getRequest(env.ctx, id)?.status;
const requestsOf = (convId: string) => env.db.prepare('SELECT id, status FROM requests WHERE conversation_id = ? ORDER BY created_at').all(convId) as Array<{ id: string; status: string }>;
const bossPending = () => (env.db.prepare("SELECT id FROM requests WHERE status = 'pending'").all() as Array<{ id: string }>).map((r) => r.id);
const bossNotices = () => (env.db.prepare('SELECT type FROM notifications WHERE user_id = ? ORDER BY created_at').all(getBoss(env.db).id) as Array<{ type: string }>).map((n) => n.type);

async function submitted() {
  const conv = env.agent.createConversation(MA_JUN);
  await chat(env.agent, conv.id, DINNER);
  const t = await chat(env.agent, conv.id, '提交');
  const id = t.draft.submittedRequestId!;
  expect(status(id)).toBe('pending');
  return { convId: conv.id, id };
}

describe('提交之后（对话与审批保持一致）', () => {
  it('P1 提交后改时间：原请求先原样保留，说明“还没发给老板”；员工回复“提交”才撤回原请求、按新内容重交', async () => {
    const { convId, id } = await submitted();
    const t1 = await chat(env.agent, convId, '改到周六晚上6点');
    expect(fmt(t1.draft.start)).toBe('2026-09-26 18:00');
    expect(t1.draft.submittedRequestId).toBeUndefined();
    expect(t1.draft.replacesRequestId).toBe(id);
    expect(t1.content).toContain('还没发给老板');
    expect(card(t1.cards, 'summary')?.canSubmit).toBe(true);
    expect(status(id)).toBe('pending'); // 员工确认之前，老板那边还是原来那条

    const t2 = await chat(env.agent, convId, '提交');
    const next = t2.draft.submittedRequestId!;
    expect(next).toBeTruthy();
    expect(next).not.toBe(id);
    expect(t2.content).toContain('已撤回原请求');
    expect(card(t2.cards, 'submitted')?.requestId).toBe(next);
    expect(status(id)).toBe('withdrawn');
    expect(bossPending()).toEqual([next]); // 老板的待批准只剩新的一条
    expect(fmt(getRequest(env.ctx, next)!.start)).toBe('2026-09-26 18:00');
    expect(bossNotices()).toEqual(['request_new', 'request_withdrawn', 'request_new']);
  });

  it('P2 提交后改了内容，点按钮重交也是先撤回再新建；再点一次不会多出第三条', async () => {
    const { convId, id } = await submitted();
    await chat(env.agent, convId, '改到周六晚上6点');
    const r = env.agent.submit(convId);
    expect(r.created).toBe(true);
    expect(r.content).toContain(`已撤回原请求（请求号 ${id.slice(0, 8)}）`);
    expect(status(id)).toBe('withdrawn');
    const again = env.agent.submit(convId);
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(r.request.id);
    expect(requestsOf(convId).map((x) => x.status)).toEqual(['withdrawn', 'pending']);
  });

  it('P3 提交后说“不约了”：撤回请求，老板的待批准里不再有它，并收到撤回通知', async () => {
    const { convId, id } = await submitted();
    const t = await chat(env.agent, convId, '算了不约了');
    expect(t.content).toContain('已撤回');
    expect(t.draft.category).toBeNull();
    expect(status(id)).toBe('withdrawn');
    expect(bossPending()).toEqual([]);
    expect(bossNotices()).toEqual(['request_new', 'request_withdrawn']);
    // 撤回的请求老板不能再批
    expect(() => approveRequest(env.ctx, env.hub, id)).toThrow(/被发起人撤回/);
  });

  it('P4 老板已经同意（改了时间）：再改、再取消都如实说“已写进日程、对话里不能改”，日程和草稿都不动', async () => {
    const { convId, id } = await submitted();
    approveRequest(env.ctx, env.hub, id, { start: '2026-09-25T20:00:00+08:00' });
    const t1 = await chat(env.agent, convId, '改到周六晚上6点');
    expect(t1.content).toContain('已写进日程');
    expect(t1.content).toContain('20:00–22:00'); // 按老板改后的时间说
    expect(t1.cards).toEqual([]); // 不出提交按钮
    expect(fmt(t1.draft.start)).toBe('2026-09-25 19:00');
    const t2 = await chat(env.agent, convId, '算了不约了');
    expect(t2.content).toContain('不能在对话里修改或取消');
    expect(status(id)).toBe('approved');
    expect(requestsOf(convId)).toHaveLength(1);
    expect(env.db.prepare('SELECT COUNT(*) c FROM events WHERE request_id = ?').get(id)).toEqual({ c: 1 });
  });

  it('P5 被拒后：没改内容就如实说没同意和原因；改了时间可以重新提交，是一条新请求', async () => {
    const { convId, id } = await submitted();
    rejectRequest(env.ctx, env.hub, id, '那天要出差');
    const t1 = await chat(env.agent, convId, '现在怎么样了');
    expect(t1.content).toContain('没有同意');
    expect(t1.content).toContain('那天要出差');
    expect(t1.cards).toEqual([]);
    const t2 = await chat(env.agent, convId, '改到周六晚上6点');
    expect(t2.draft.submittedRequestId).toBeUndefined();
    expect(card(t2.cards, 'summary')?.canSubmit).toBe(true);
    const t3 = await chat(env.agent, convId, '提交');
    const next = t3.draft.submittedRequestId!;
    expect(next).not.toBe(id);
    expect(status(next)).toBe('pending');
    expect(status(id)).toBe('rejected');
  });

  it('P6 改了内容还没重交，老板先批了原请求：再提交不建新请求，如实说原请求已写进日程', async () => {
    const { convId, id } = await submitted();
    await chat(env.agent, convId, '改到周六晚上6点');
    approveRequest(env.ctx, env.hub, id);
    const r = env.agent.submit(convId);
    expect(r.created).toBe(false);
    expect(r.cards).toEqual([]);
    expect(r.content).toContain('已写进日程');
    expect(r.draft.submittedRequestId).toBe(id);
    expect(r.draft.replacesRequestId).toBeUndefined();
    expect(requestsOf(convId)).toHaveLength(1);
    // 同样的情况走对话“提交”也一样
    const t = await chat(env.agent, convId, '提交');
    expect(t.content).toContain('已写进日程');
    expect(requestsOf(convId)).toHaveLength(1);
  });

  it('P7 改完又改回原样：不算修改，原请求照旧待批准，不用重交', async () => {
    const { convId, id } = await submitted();
    const t1 = await chat(env.agent, convId, '改到周六晚上6点');
    expect(t1.draft.replacesRequestId).toBe(id);
    const t2 = await chat(env.agent, convId, '还是周五晚上7点吧');
    expect(fmt(t2.draft.start)).toBe('2026-09-25 19:00');
    expect(t2.draft.submittedRequestId).toBe(id);
    expect(t2.draft.replacesRequestId).toBeUndefined();
    expect(t2.content).toContain('正在等老板批准');
    expect(card(t2.cards, 'submitted')?.requestId).toBe(id);
    expect(requestsOf(convId)).toHaveLength(1);
  });

  it('P8 撤回只能由发起人、只能撤待批准的；老板已处理的撤不了', async () => {
    const { id } = await submitted();
    expect(() => withdrawRequest(env.ctx, env.hub, id, LIU_YANG)).toThrow(/不存在/);
    approveRequest(env.ctx, env.hub, id);
    expect(() => withdrawRequest(env.ctx, env.hub, id, MA_JUN)).toThrow(/被老板同意/);
    expect(status(id)).toBe('approved');
  });
});
