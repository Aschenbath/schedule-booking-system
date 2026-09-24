// 需求逐条核对（审计）后补的回归测试：每条对应一个审计发现的问题，离线规则模型 + 模拟地图，不联网
import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, chat, type TestEnv } from './helpers';
import { fromIso } from '../src/clock';
import { createApp } from '../src/http/app';
import { analyzeSlot } from '../src/agent/schedule';

const LIU_YANG = 'u004';
const BOSS = 'u001';
let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

describe('审计回归', () => {
  it('A1 后一场卡住时，建议的是“提前到 X 或更早”，而且按建议时间真的赶得上', async () => {
    // 种子：明天 14:00–15:30 在番禺万博样板间陪客户；在公司 13:00–14:00 开会 → 后一场赶不上
    const a = await analyzeSlot(env.ctx, '2026-09-24T13:00:00+08:00', '2026-09-24T14:00:00+08:00', '公司');
    const nb = a.after!;
    expect(nb.enough).toBe(false);
    expect(nb.side).toBe('after');
    const s = fromIso(nb.suggestStart!);
    // 按建议开始 + 会议时长 + 车程，不晚于下一场开始
    expect(s.add(60 + nb.travel.minutes!, 'minute').isAfter(fromIso(nb.start))).toBe(false);

    const conv = env.agent.createConversation(LIU_YANG);
    const t = await chat(env.agent, conv.id, '明天下午1点在公司开会，主题材料下单确认，叫上郭涛');
    expect(t.content).toContain('时间上不冲突，但车程赶不上');
    expect(t.content).toContain('提前到');
  });

  it('A2 换一个会话把同样的事再提交一遍，不会多出第二条待批准', async () => {
    const say = '周五晚上7点跟建材供应商吃饭，在陶陶居北京路店，一共6个人';
    const c1 = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, c1.id, say);
    const r1 = env.agent.submit(c1.id);
    const c2 = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, c2.id, say);
    const r2 = env.agent.submit(c2.id);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.request.id).toBe(r1.request.id);
    expect(env.db.prepare("SELECT COUNT(*) c FROM requests WHERE status = 'pending'").get()).toEqual({ c: 1 });
  });

  it('A3 后台设置改了公司地址：旧坐标和坐标缓存作废，车程按新地址重算', async () => {
    const before = await analyzeSlot(env.ctx, '2026-09-24T16:00:00+08:00', '2026-09-24T17:00:00+08:00', '公司');
    const app = createApp(env.ctx, env.hub, env.agent);
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': BOSS },
      body: JSON.stringify({ company_address: '广州市番禺区万博商务区' }),
    });
    expect(res.status).toBe(200);
    const place = env.db.prepare("SELECT address, lng, lat FROM places WHERE name = '公司'").get() as { address: string; lng: number | null };
    expect(place.address).toBe('广州市番禺区万博商务区');
    expect(place.lng).toBeNull();
    const after = await analyzeSlot(env.ctx, '2026-09-24T16:00:00+08:00', '2026-09-24T17:00:00+08:00', '公司');
    // 公司搬到番禺后，从番禺样板间过来的车程明显变短
    expect(after.before!.travel.minutes!).toBeLessThan(before.before!.travel.minutes!);
  });

  it('A5 一句话同时像两类（客户来公司开会）就问类别，不猜；已定的类别不会被后面的含糊话清掉', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t1 = await chat(env.agent, conv.id, '万科的客户明天下午来公司开会');
    expect(t1.draft.category).toBeNull();
    expect(t1.content).toMatch(/会议|接待|饭局/);
    const t2 = await chat(env.agent, conv.id, '会议');
    expect(t2.draft.category).toBe('meeting');
    const t3 = await chat(env.agent, conv.id, '开会之后顺便一起吃饭'); // 同时像会议和饭局 → unsure，但类别已经定了
    expect(t3.draft.category).toBe('meeting');
  });

  it('A6 说“需要更长时间”时总共不超过两个问题，也不会出现“14:00–14:00”这种零长度时间', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    const t = await chat(env.agent, conv.id, '后天下午在公司开会，需要更长时间');
    expect(t.content).not.toMatch(/(\d{2}:\d{2})–\1/);
    const durationAsked = t.content.includes('要留多长时间') ? 1 : 0;
    expect((t.draft.pendingFields ?? []).length + durationAsked).toBeLessThanOrEqual(2);

    const c2 = env.agent.createConversation(LIU_YANG);
    const t2 = await chat(env.agent, c2.id, '后天下午3点在公司开会，需要更长时间');
    expect((t2.draft.pendingFields ?? []).length + (t2.content.includes('要留多长时间') ? 1 : 0)).toBeLessThanOrEqual(2);
    expect(t2.content).not.toContain('需要更长可以告诉我'); // 不会一边说“默认 60 分钟、要更长告诉我”一边问多久
  });

  it('A8 模型把一句新需求误标成“提交”也不会直接提交：必须先让员工看过完整摘要', async () => {
    const rules = env.ctx.llm;
    // 模拟模型抽取出错：每句话都标 intent=submit
    env.ctx.llm = { mode: 'openai', extract: async (i) => ({ ...(await rules.extract(i)), intent: 'submit' }), streamReply: (f, h) => rules.streamReply(f, h) };
    const conv = env.agent.createConversation(LIU_YANG);
    const t1 = await chat(env.agent, conv.id, '周五晚上7点跟建材供应商吃饭，在陶陶居北京路店，一共6个人');
    expect(t1.draft.submittedRequestId).toBeUndefined();
    expect(env.db.prepare('SELECT COUNT(*) c FROM requests').get()).toEqual({ c: 0 });
    // 看过摘要后再说“提交”才提交
    const t2 = await chat(env.agent, conv.id, '提交');
    expect(t2.draft.submittedRequestId).toBeTruthy();
  });

  it('A7 “算了，后天吧”是改口不是取消：之前收集的信息都在，只换日期', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, conv.id, '明天下午3点在公司开会，主题周会，叫上郭涛');
    const t = await chat(env.agent, conv.id, '算了，后天吧');
    expect(t.draft.category).toBe('meeting');
    expect(t.draft.subject).toBe('周会');
    expect(t.draft.location).toBe('公司');
    expect(fromIso(t.draft.start!).format('YYYY-MM-DD HH:mm')).toBe('2026-09-25 15:00');
    expect(t.content).not.toContain('已取消');
  });

  it('A9 “现在怎么样了”里的“在”不是地点；“在公司吧”的地点是“公司”，不带语气词', async () => {
    const conv = env.agent.createConversation(LIU_YANG);
    await chat(env.agent, conv.id, '明天下午3点开会，主题周会，在陶陶居北京路店');
    const t1 = await chat(env.agent, conv.id, '现在怎么样了');
    expect(t1.draft.location).toBe('陶陶居北京路店');
    const t2 = await chat(env.agent, conv.id, '还是在公司吧');
    expect(t2.draft.location).toBe('公司');
  });
});
