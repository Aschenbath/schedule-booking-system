import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, chat, card, type TestEnv } from './helpers';
import { FailingMapService } from '../src/map';
import { fromIso } from '../src/clock';
import { approveRequest } from '../src/services/requests';
import type { RequestRow } from '../src/db';

const fmt = (iso?: string) => (iso ? fromIso(iso).format('YYYY-MM-DD HH:mm') : undefined);
const LIU_YANG = 'u004'; // 设计部 设计师
const GUO_TAO = 'u016'; // 预结算部

let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

describe('对话场景（离线规则模型 + 模拟地图，不联网）', () => {
  it('S1 会议完整流程：追问缺项（一轮最多两项）→ 展开名单 → 确认 → 提交待批准', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t1 = await chat(env.agent, conv.id, '我想约老板后天上午10点开个会');
    expect(t1.draft.category).toBe('meeting');
    expect(fmt(t1.draft.start)).toBe('2026-09-25 10:00');
    expect(fmt(t1.draft.end)).toBe('2026-09-25 11:00'); // 会议默认 60 分钟
    expect(t1.content).toContain('默认 60 分钟');
    expect(t1.draft.pendingFields).toEqual(['subject', 'location']); // 缺三项，只问两项
    expect(t1.draft.pendingFields!.length).toBeLessThanOrEqual(2);

    const t2 = await chat(env.agent, conv.id, '主题是海珠别墅项目方案评审，地点在公司3楼会议室');
    expect(t2.draft.subject).toBe('海珠别墅项目方案评审');
    expect(t2.draft.location).toBe('公司3楼会议室');
    expect(t2.draft.pendingFields).toEqual(['attendees']);
    expect(t2.content).toContain('哪些人或部门');

    const t3 = await chat(env.agent, conv.id, '叫上设计部和孙磊');
    const pc = card(t3.cards, 'people_confirm')!;
    expect(pc).toBeTruthy();
    expect(pc.expansions.map((e) => e.query)).toEqual(['设计部', '孙磊']);
    expect(pc.expansions[0].names.length).toBe(6);
    expect(pc.confirmed).toBe(false);
    expect(t3.content).toContain('展开为 6 人');
    expect(card(t3.cards, 'summary')).toBeUndefined(); // 未确认名单不能提交

    const c = env.agent.confirmPeople(conv.id, pc.selectedIds);
    expect(c.draft.attendees.confirmed).toBe(true);
    expect(card(c.cards, 'summary')?.canSubmit).toBe(true);

    const t4 = await chat(env.agent, conv.id, '提交');
    const sub = card(t4.cards, 'submitted')!;
    expect(sub).toBeTruthy();
    const req = env.db.prepare('SELECT * FROM requests WHERE id = ?').get(sub.requestId) as unknown as RequestRow;
    expect(req.status).toBe('pending');
    expect(JSON.parse(req.attendees)).toContain('u010'); // 孙磊
    expect(req.subject).toBe('海珠别墅项目方案评审');
    // 老板收到“新请求”通知；此时还没有任何日程写入
    expect(env.db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 'u001' AND type = 'request_new'").get()).toEqual({ c: 1 });
    expect(env.db.prepare("SELECT COUNT(*) c FROM events WHERE source = 'request'").get()).toEqual({ c: 0 });
  });

  it('S2 刷新页面后对话不丢：消息与草稿都在数据库里', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, conv.id, '明天下午3点开会');
    await chat(env.agent, conv.id, '主题是周会');
    const reloaded = env.agent.getConversation(conv.id);
    expect(reloaded.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(reloaded.draft.subject).toBe('周会');
    expect(fmt(reloaded.draft.start)).toBe('2026-09-24 15:00');
  });

  it('S3 时间重叠：指出冲突并给出可用空档', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t = await chat(env.agent, conv.id, '明天下午2点半和老板开会讨论工地进度，在公司');
    const a = t.draft.analysis!;
    expect(a.conflicts.map((c) => c.subject)).toEqual(['陪客户看样板间']);
    expect(a.suggestions.length).toBeGreaterThan(0);
    expect(t.content).toContain('重叠');
    expect(t.content).toContain('空档');
    expect(card(t.cards, 'analysis')).toBeTruthy();
    expect(t.draft.subject).toBe('工地进度');
  });

  it('S4 时间不冲突但车程赶不上：明确说明并建议时间', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    // 前一场 14:00-15:30 在番禺万博，16:00 在公司只隔 30 分钟
    const t = await chat(env.agent, conv.id, '明天下午4点在公司开会，主题预算复核');
    const a = t.draft.analysis!;
    expect(a.conflicts).toHaveLength(0);
    expect(a.travelStatus).toBe('tight');
    expect(a.before?.subject).toBe('陪客户看样板间');
    expect(a.before?.enough).toBe(false);
    expect(a.before!.travel.minutes!).toBeGreaterThan(30);
    expect(fmt(a.before?.suggestStart)).toBe('2026-09-24 16:15');
    expect(t.content).toContain('时间上不冲突，但车程赶不上');
    expect(t.content).toContain('建议挪到');
  });

  it('S5 [失败路径] 地图接口失败：标明“车程未核实”，提交后审批卡片也带标记', async () => {
    env = makeEnv({ map: new FailingMapService() });
    const conv = env.agent.createConversation(GUO_TAO);
    const t = await chat(env.agent, conv.id, '明天下午4点在公司开会，主题预算复核');
    expect(t.draft.analysis?.travelStatus).toBe('unverified');
    expect(t.content).toContain('车程未核实');
    expect(t.content).not.toContain('车程赶不上');
    // 不能把失败当作已核实：geocache 里不应有任何缓存
    expect(env.db.prepare('SELECT COUNT(*) c FROM geocache').get()).toEqual({ c: 0 });

    const t2 = await chat(env.agent, conv.id, '叫上高丽');
    env.agent.confirmPeople(conv.id, card(t2.cards, 'people_confirm')!.selectedIds);
    const sub = env.agent.submit(conv.id);
    const req = env.db.prepare('SELECT analysis FROM requests WHERE id = ?').get(sub.request.id) as { analysis: string };
    expect(JSON.parse(req.analysis).travelStatus).toBe('unverified');
  });

  it('S6 [失败路径] 部门展开为空：如实告知，不说“已通知”，继续追问参会人', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t = await chat(env.agent, conv.id, '下周一上午10点在公司开会讨论合同风险，通知法务部');
    const pc = card(t.cards, 'people_confirm')!;
    expect(pc.expansions[0]).toMatchObject({ query: '法务部', kind: 'dept', names: [] });
    expect(t.content).toContain('没有找到任何成员');
    expect(t.content).not.toContain('已通知');
    expect(t.draft.attendees.ids).toEqual([]);
    expect(t.draft.pendingFields).toContain('attendees');
    expect(card(t.cards, 'summary')).toBeUndefined();

    const t2 = await chat(env.agent, conv.id, '那叫上李娜');
    expect(t2.draft.attendees.names).toEqual(['李娜']);
  });

  it('S7 [失败路径] 用户中途改口：“算了改成后天”只换日期，其它信息不丢；“改到5点”只换时刻', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t1 = await chat(env.agent, conv.id, '明天下午3点到4点在公司开会，主题是季度复盘，叫上财务部');
    expect(fmt(t1.draft.start)).toBe('2026-09-24 15:00');
    expect(t1.draft.attendees.names).toEqual(['邓丽', '彭飞']);

    const t2 = await chat(env.agent, conv.id, '算了改成后天');
    expect(fmt(t2.draft.start)).toBe('2026-09-25 15:00');
    expect(fmt(t2.draft.end)).toBe('2026-09-25 16:00');
    expect(t2.draft.subject).toBe('季度复盘');
    expect(t2.draft.location).toBe('公司');
    expect(t2.draft.attendees.names).toEqual(['邓丽', '彭飞']);
    expect(t2.draft.category).toBe('meeting');

    const t3 = await chat(env.agent, conv.id, '改到5点吧');
    expect(fmt(t3.draft.start)).toBe('2026-09-25 17:00');
    expect(fmt(t3.draft.end)).toBe('2026-09-25 18:00');
    expect(t3.draft.subject).toBe('季度复盘');
  });

  it('S8 类别判不准就问一句，不猜；回答后继续追问具体时刻', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t1 = await chat(env.agent, conv.id, '想约老板明天下午聊聊');
    expect(t1.draft.category).toBeNull();
    expect(t1.content).toContain('会议、接待、饭局');
    expect(t1.draft.pendingFields).toEqual([]);

    const t2 = await chat(env.agent, conv.id, '会议');
    expect(t2.draft.category).toBe('meeting');
    expect(fmt(t2.draft.start)).toBe('2026-09-24 14:00');
    expect(t2.draft.timeNeedsClock).toBe(true);
    expect(t2.content).toContain('具体几点');
  });

  it('S9 接待 + 相对时间“下周二上午”：识别来访方和人数，追问时刻与地点', async () => {
    const conv = env.agent.createConversation('u020');
    const t = await chat(env.agent, conv.id, '下周二上午接待万科的客户来参观样板间，5个人');
    expect(t.draft.category).toBe('reception');
    expect(t.draft.visitor).toBe('万科的客户');
    expect(t.draft.headcount).toBe(5);
    expect(fmt(t.draft.start)).toBe('2026-09-29 09:00');
    expect(t.draft.pendingFields).toEqual(['time', 'location']);

    const t2 = await chat(env.agent, conv.id, '10点到11点，在番禺万博样板间');
    expect(fmt(t2.draft.start)).toBe('2026-09-29 10:00');
    expect(fmt(t2.draft.end)).toBe('2026-09-29 11:00');
    expect(t2.draft.location).toBe('番禺万博样板间');
    expect(card(t2.cards, 'summary')?.canSubmit).toBe(true);
  });

  it('S10 饭局：对方/人数/地点一次说全，默认 2 小时，直接可提交；老板同意后写入日程', async () => {
    const conv = env.agent.createConversation('u019');
    const t = await chat(env.agent, conv.id, '周五晚上7点跟建材供应商吃饭，在陶陶居北京路店，一共6个人');
    expect(t.draft.category).toBe('dinner');
    expect(t.draft.counterpart).toBe('建材供应商');
    expect(t.draft.location).toBe('陶陶居北京路店');
    expect(t.draft.headcount).toBe(6);
    expect(fmt(t.draft.start)).toBe('2026-09-25 19:00');
    expect(fmt(t.draft.end)).toBe('2026-09-25 21:00');
    expect(t.draft.analysis?.travelStatus).toBe('ok'); // 17:00 公司结束，车程够
    expect(card(t.cards, 'summary')?.canSubmit).toBe(true);

    const t2 = await chat(env.agent, conv.id, '没问题，提交');
    const reqId = card(t2.cards, 'submitted')!.requestId;
    const { event, created } = approveRequest(env.ctx, env.hub, reqId);
    expect(created).toBe(true);
    expect(event.category).toBe('dinner');
    expect(event.subject).toBe('与建材供应商的饭局');
    expect(fmt(event.start)).toBe('2026-09-25 19:00');
  });

  it('S11 同一请求重复提交、重复批准，都不会建出两条', async () => {
    const conv = env.agent.createConversation('u019');
    await chat(env.agent, conv.id, '周五晚上7点跟建材供应商吃饭，在陶陶居北京路店，一共6个人');
    const first = env.agent.submit(conv.id);
    const second = env.agent.submit(conv.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    const viaChat = await chat(env.agent, conv.id, '提交');
    expect(viaChat.content).toContain('已经提交过');
    expect(env.db.prepare("SELECT COUNT(*) c FROM requests WHERE conversation_id = ?").get(conv.id)).toEqual({ c: 1 });

    const a1 = approveRequest(env.ctx, env.hub, first.request.id);
    const a2 = approveRequest(env.ctx, env.hub, first.request.id);
    expect(a1.created).toBe(true);
    expect(a2.created).toBe(false);
    expect(a2.event.id).toBe(a1.event.id);
    expect(env.db.prepare('SELECT COUNT(*) c FROM events WHERE request_id = ?').get(first.request.id)).toEqual({ c: 1 });
  });

  it('S12 取消与重新开始：取消清空草稿；“算了改成…”不算取消', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, conv.id, '明天下午3点开会，主题周会，在公司');
    const t = await chat(env.agent, conv.id, '算了，不约了');
    expect(t.draft.category).toBeNull();
    expect(t.draft.subject).toBeUndefined();
    expect(t.content).toContain('取消');
  });
});
