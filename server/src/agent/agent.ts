import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { Hub } from '../services/notifications';
import { allContacts, getContact } from '../db';
import { now, toIso, fromIso, fmtRange } from '../clock';
import { parseChineseTime, mergeTime } from '../time/parse';
import { expandMany, uniqueContacts, type Expansion } from './people';
import { analyzeSlot, type Analysis } from './schedule';
import { CATEGORY_LABEL, DEFAULT_DURATION_MIN, FIELD_QUESTION, emptyDraft, missingFields, draftTitle, type Draft, type FieldKey, type ExpansionSummary } from './schema';
import { renderReply } from './reply';
import { RulesLlm } from '../llm/rules';
import type { Extraction, ReplyFacts, ChatTurn, Directory } from '../llm/types';
import { submitRequest, RequestError } from '../services/requests';

export type Card =
  | { type: 'people_confirm'; expansions: ExpansionSummary[]; selectedIds: string[]; confirmed: boolean }
  | { type: 'analysis'; analysis: Analysis }
  | { type: 'summary'; items: Array<{ label: string; value: string }>; canSubmit: boolean }
  | { type: 'submitted'; requestId: string };

export type TurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'state'; draft: Draft; cards: Card[]; messageId: number; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface ConversationRow {
  id: string;
  user_id: string;
  draft: string;
  status: string;
  created_at: string;
  updated_at: string;
}
export interface MessageRow {
  id: number;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  cards: string | null;
  created_at: string;
}

const PERIOD_LABEL: Record<string, string> = { morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', dawn: '凌晨' };

export class Agent {
  private rules = new RulesLlm();
  constructor(private readonly ctx: AppContext, private readonly hub: Hub | null = null) {}

  // ---------- 会话存取 ----------
  createConversation(userId: string): ConversationRow {
    const id = randomUUID();
    const t = toIso(now());
    this.ctx.db.prepare("INSERT INTO conversations(id, user_id, draft, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").run(id, userId, JSON.stringify(emptyDraft()), t, t);
    return this.getConversationRow(id)!;
  }

  listConversations(userId: string) {
    const rows = this.ctx.db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20').all(userId) as unknown as ConversationRow[];
    return rows.map((r) => {
      const d = JSON.parse(r.draft) as Draft;
      const last = this.ctx.db.prepare('SELECT content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(r.id) as { content: string } | undefined;
      return { id: r.id, updated_at: r.updated_at, title: d.category ? draftTitle(d) : '新的预约', preview: last?.content?.slice(0, 40) ?? '', submittedRequestId: d.submittedRequestId ?? null };
    });
  }

  getConversationRow(id: string): ConversationRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as ConversationRow | undefined;
  }

  getConversation(id: string) {
    const conv = this.getConversationRow(id);
    if (!conv) throw new RequestError('会话不存在', 404);
    const messages = (this.ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id) as unknown as MessageRow[]).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      cards: m.cards ? (JSON.parse(m.cards) as Card[]) : [],
      created_at: m.created_at,
    }));
    return { id: conv.id, userId: conv.user_id, draft: JSON.parse(conv.draft) as Draft, messages };
  }

  private loadDraft(conv: ConversationRow): Draft {
    const d = { ...emptyDraft(), ...(JSON.parse(conv.draft) as Partial<Draft>) } as Draft;
    d.peopleQueries ??= [];
    d.attendees ??= { ids: [], names: [], confirmed: false, expansions: [] };
    return d;
  }
  private saveDraft(convId: string, draft: Draft) {
    this.ctx.db.prepare('UPDATE conversations SET draft = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(draft), toIso(now()), convId);
  }
  private addMessage(convId: string, role: 'user' | 'assistant', content: string, cards?: Card[]): number {
    const r = this.ctx.db.prepare('INSERT INTO messages(conversation_id, role, content, cards, created_at) VALUES (?, ?, ?, ?, ?)').run(convId, role, content, cards?.length ? JSON.stringify(cards) : null, toIso(now()));
    return Number(r.lastInsertRowid);
  }
  private history(convId: string, limit = 10): ChatTurn[] {
    const rows = this.ctx.db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(convId, limit) as unknown as ChatTurn[];
    return rows.reverse();
  }

  directory(): Directory {
    const contacts = allContacts(this.ctx.db);
    const departments = (this.ctx.db.prepare('SELECT name FROM departments').all() as { name: string }[]).map((r) => r.name);
    const tags = [...new Set(contacts.map((c) => c.title))];
    return { departments, tags, names: contacts.map((c) => c.name) };
  }

  // ---------- 一轮对话 ----------
  async *handleMessage(convId: string, text: string): AsyncGenerator<TurnEvent> {
    const conv = this.getConversationRow(convId);
    if (!conv) throw new RequestError('会话不存在', 404);
    const user = getContact(this.ctx.db, conv.user_id);
    let draft = this.loadDraft(conv);
    const history = this.history(convId);
    this.addMessage(convId, 'user', text);
    const nowT = now();
    const notes: string[] = [];

    // 1) 听懂：模型（或规则）抽取增量信息
    const input = { now: nowT, draft, pendingFields: draft.pendingFields ?? [], history, text, directory: this.directory() };
    let ex: Extraction;
    try {
      ex = await this.ctx.llm.extract(input);
    } catch (e) {
      console.warn('[agent] llm.extract failed, fallback to rules:', (e as Error).message);
      ex = await this.rules.extract(input);
      notes.push('（模型暂时不可用，这句话按离线规则理解，如有偏差请直接纠正我）');
    }

    const facts: ReplyFacts = {
      userName: user?.name ?? conv.user_id,
      category: null,
      categoryLabel: null,
      askCategory: false,
      collected: [],
      questions: [],
      people: { expansions: [], needsConfirm: false, emptyQueries: [], confirmedNames: [] },
      analysis: null,
      notes,
      ready: false,
    };

    // 2) 意图：取消 / 重来
    if (ex.intent === 'cancel' || ex.intent === 'restart') {
      draft = emptyDraft();
      if (ex.intent === 'cancel') facts.cancelled = true;
      else facts.restarted = true;
      yield* this.finish(convId, draft, facts, history, []);
      return;
    }

    // 3) 类别（判不准就问，不猜）
    if (ex.category === 'unsure') draft.category = null;
    else if (ex.category) draft.category = ex.category;
    facts.askCategory = !draft.category;
    if (facts.askCategory) draft.categoryAsked = true;

    // 4) 简单字段合并（改口只覆盖提到的字段，其它保留）
    let locationChanged = false;
    const hadLocation = !!draft.location;
    const hadTime = !!draft.start && !draft.timeNeedsClock;
    if (ex.subject) draft.subject = ex.subject;
    if (ex.location && ex.location !== draft.location) {
      draft.location = ex.location;
      locationChanged = true;
    }
    if (ex.visitor) draft.visitor = ex.visitor;
    if (ex.counterpart) draft.counterpart = ex.counterpart;
    if (ex.headcount) draft.headcount = ex.headcount;
    if (ex.note) draft.note = draft.note ? `${draft.note}；${ex.note}` : ex.note;

    // 5) 时间：代码解析相对时间（NOW 可覆盖），改口只换说到的部分
    let timeChanged = false;
    let timeEdited = false; // 用户这句话里真的改/给了时间（区别于程序补默认时长）
    if (ex.time_text) {
      const parsed = parseChineseTime(ex.time_text, nowT) ?? (ex.time_text !== text ? parseChineseTime(text, nowT) : null);
      if (parsed) {
        const prevStart = draft.start ? fromIso(draft.start) : undefined;
        const prevEnd = draft.end ? fromIso(draft.end) : undefined;
        const prevHadClock = !!draft.start && !draft.timeNeedsClock;
        const merged = mergeTime(prevStart, prevEnd, parsed);
        draft.start = toIso(merged.start);
        draft.end = merged.end ? toIso(merged.end) : undefined;
        draft.timeNeedsClock = parsed.hasClock ? false : parsed.hasDate && !parsed.period && prevHadClock ? false : true;
        draft.timeText = ex.time_text;
        if (parsed.end || parsed.durationMin) draft.durationDefaulted = false;
        timeChanged = true;
        timeEdited = true;
      } else if (ex.start) {
        const s = fromIso(ex.start);
        if (s.isValid()) {
          draft.start = toIso(s);
          const e = ex.end ? fromIso(ex.end) : null;
          draft.end = e && e.isValid() && e.isAfter(s) ? toIso(e) : undefined;
          draft.timeNeedsClock = false;
          draft.timeText = ex.time_text;
          timeChanged = true;
          timeEdited = true;
        }
      }
    } else if (ex.start && !draft.start) {
      const s = fromIso(ex.start);
      if (s.isValid()) {
        draft.start = toIso(s);
        draft.timeNeedsClock = false;
        timeChanged = true;
        timeEdited = true;
      }
    }
    if (draft.start && !draft.end && draft.category && !draft.timeNeedsClock) {
      const mins = DEFAULT_DURATION_MIN[draft.category];
      draft.end = toIso(fromIso(draft.start).add(mins, 'minute'));
      if (!draft.durationDefaulted) notes.push(`结束时间没说，先按${CATEGORY_LABEL[draft.category]}默认 ${mins} 分钟安排（${fmtRange(draft.start, draft.end)}），需要更长可以告诉我。`);
      draft.durationDefaulted = true;
      timeChanged = true;
    }
    // 改口时明确复述改成了什么，其它信息不动
    if (timeEdited && hadTime && draft.start && draft.end && !draft.timeNeedsClock) (facts.changed ??= []).push(`好，时间改为 ${fmtRange(draft.start, draft.end)}，其它信息不变。`);
    if (locationChanged && hadLocation) (facts.changed ??= []).push(`地点改为${draft.location}。`);

    // 6) 人：部门/岗位/姓名展开成具体的人（代码做，0 人如实说）
    if (ex.remove_people?.length) {
      const rm = new Set(ex.remove_people);
      draft.attendees.expansions = draft.attendees.expansions.filter((e) => !rm.has(e.query) && !rm.has(e.normalized));
      draft.peopleQueries = draft.peopleQueries.filter((q) => !rm.has(q));
      const keep = new Set(draft.attendees.expansions.flatMap((e) => e.ids));
      draft.attendees.ids = draft.attendees.ids.filter((id) => keep.has(id) && !rm.has(getContact(this.ctx.db, id)?.name ?? ''));
      draft.attendees.names = draft.attendees.ids.map((id) => getContact(this.ctx.db, id)?.name ?? id);
    }
    if (ex.people_queries?.length) {
      const fresh = ex.people_queries.filter((q) => !draft.peopleQueries.includes(q));
      if (fresh.length) {
        const expansions = expandMany(this.ctx.db, fresh);
        const summaries = expansions.map(toSummary);
        draft.peopleQueries.push(...fresh);
        draft.attendees.expansions.push(...summaries);
        const ids = new Set(draft.attendees.ids);
        for (const c of uniqueContacts(expansions)) ids.add(c.id);
        draft.attendees.ids = [...ids];
        draft.attendees.names = draft.attendees.ids.map((id) => getContact(this.ctx.db, id)?.name ?? id);
        if (summaries.some((s) => s.ids.length > 0)) draft.attendees.confirmed = false;
        facts.people.expansions = summaries;
        facts.people.emptyQueries = summaries.filter((s) => s.ids.length === 0).map((s) => s.query);
      }
    }
    if ((ex.intent === 'confirm_people' || ex.intent === 'submit') && draft.attendees.ids.length) draft.attendees.confirmed = true; // “没问题，提交”= 名单也没问题

    // 7) 冲突 + 车程（代码做；地图失败标 unverified）
    const timeComplete = !!draft.start && !!draft.end && !draft.timeNeedsClock;
    if (timeComplete && (timeChanged || locationChanged || !draft.analysis)) {
      draft.analysis = await analyzeSlot(this.ctx, draft.start!, draft.end!, draft.location ?? '');
      facts.analysis = draft.analysis;
    } else if (!timeComplete) draft.analysis = undefined;

    // 8) 缺什么问什么，一轮最多两项
    const missing = draft.category ? missingFields(draft) : [];
    const ask = facts.askCategory ? [] : missing.slice(0, 2);
    facts.questions = ask.map((f) => this.question(f, draft));
    draft.pendingFields = ask;
    const needsConfirm = draft.attendees.ids.length > 0 && !draft.attendees.confirmed;
    facts.people.needsConfirm = needsConfirm && !facts.askCategory;
    facts.people.confirmedNames = draft.attendees.confirmed ? draft.attendees.names : [];
    const ready = !!draft.category && missing.length === 0 && !needsConfirm;
    facts.ready = ready;
    facts.category = draft.category;
    facts.categoryLabel = draft.category ? CATEGORY_LABEL[draft.category] : null;
    facts.collected = summarize(draft);
    if (!facts.askCategory && !facts.questions.length && needsConfirm && !facts.people.expansions.length && ex.intent !== 'submit') notes.push('参会名单还没确认，请在名单卡里核对后点“确认名单”，或回复“名单没问题”。');

    // 9) 提交意图
    if (ex.intent === 'submit') {
      if (ready) {
        const { request, created } = submitRequest(this.ctx, this.hub, convId, conv.user_id, draft);
        draft.submittedRequestId = request.id;
        facts.submitted = { requestId: request.id, duplicate: !created };
      } else if (needsConfirm) notes.push('提交前请先确认参会名单。');
      else if (missing.length) notes.push('还差一些信息，补齐后就可以提交。');
    }

    yield* this.finish(convId, draft, facts, history, this.buildCards(draft, facts));
  }

  private question(f: FieldKey, d: Draft): string {
    if (f === 'time' && d.start && d.timeNeedsClock) {
      const p = parseChineseTime(d.timeText ?? '', now())?.period;
      return `${fromIso(d.start).format('M月D日')}${p ? PERIOD_LABEL[p] : ''}具体几点到几点？`;
    }
    if (f === 'attendees' && d.attendees.expansions.length && d.attendees.ids.length === 0) return '上面的说法没有找到任何人，需要哪些人或部门参加？';
    return FIELD_QUESTION[f];
  }

  private buildCards(draft: Draft, facts: ReplyFacts): Card[] {
    const cards: Card[] = [];
    if (draft.attendees.expansions.length) cards.push({ type: 'people_confirm', expansions: draft.attendees.expansions, selectedIds: draft.attendees.ids, confirmed: draft.attendees.confirmed });
    const a = facts.analysis ?? (facts.ready ? draft.analysis : null);
    if (a && (a.conflicts.length || a.travelStatus !== 'none')) cards.push({ type: 'analysis', analysis: a });
    if (facts.submitted) cards.push({ type: 'submitted', requestId: facts.submitted.requestId });
    else if (facts.ready && !facts.askCategory) cards.push({ type: 'summary', items: facts.collected, canSubmit: true });
    return cards;
  }

  /** 生成回复（流式）、落库、返回状态 */
  private async *finish(convId: string, draft: Draft, facts: ReplyFacts, history: ChatTurn[], cards: Card[]): AsyncGenerator<TurnEvent> {
    let content = '';
    try {
      for await (const chunk of this.ctx.llm.streamReply(facts, history)) {
        content += chunk;
        yield { type: 'delta', text: chunk };
      }
      if (!content.trim()) throw new Error('empty reply');
    } catch (e) {
      console.warn('[agent] llm.streamReply failed, fallback to template:', (e as Error).message);
      const fallback = renderReply(facts);
      const add = content.trim() ? `\n${fallback}` : fallback;
      content += add;
      yield { type: 'delta', text: add };
    }
    const messageId = this.addMessage(convId, 'assistant', content, cards);
    this.saveDraft(convId, draft);
    yield { type: 'state', draft, cards, messageId, content };
    yield { type: 'done' };
  }

  // ---------- 界面动作 ----------
  confirmPeople(convId: string, ids: string[]) {
    const conv = this.getConversationRow(convId);
    if (!conv) throw new RequestError('会话不存在', 404);
    const draft = this.loadDraft(conv);
    const valid = ids.filter((id) => getContact(this.ctx.db, id));
    draft.attendees.ids = valid;
    draft.attendees.names = valid.map((id) => getContact(this.ctx.db, id)!.name);
    draft.attendees.confirmed = true;
    const missing = draft.category ? missingFields(draft) : [];
    const ready = !!draft.category && missing.length === 0;
    const items = summarize(draft);
    const cards: Card[] = [{ type: 'people_confirm', expansions: draft.attendees.expansions, selectedIds: valid, confirmed: true }];
    let content = valid.length ? `名单已确认（${valid.length} 人）：${draft.attendees.names.join('、')}。` : '名单已清空，这次不通知其他人。';
    if (ready) {
      content += `\n信息齐了，请确认：\n${items.map((i) => `${i.label}：${i.value}`).join('\n')}\n没问题的话点“提交给老板批准”，或回复“提交”。`;
      cards.push({ type: 'summary', items, canSubmit: true });
    } else if (missing.length) {
      const ask = missing.slice(0, 2);
      draft.pendingFields = ask;
      content += '\n' + ask.map((f) => this.question(f, draft)).join('\n');
    }
    const messageId = this.addMessage(convId, 'assistant', content, cards);
    this.saveDraft(convId, draft);
    return { messageId, content, cards, draft };
  }

  submit(convId: string) {
    const conv = this.getConversationRow(convId);
    if (!conv) throw new RequestError('会话不存在', 404);
    const draft = this.loadDraft(conv);
    const missing = draft.category ? missingFields(draft) : [];
    if (!draft.category || missing.length) throw new RequestError('信息还不完整，不能提交');
    if (draft.attendees.ids.length && !draft.attendees.confirmed) throw new RequestError('请先确认参会名单');
    const { request, created } = submitRequest(this.ctx, this.hub, convId, conv.user_id, draft);
    draft.submittedRequestId = request.id;
    const cards: Card[] = [{ type: 'submitted', requestId: request.id }];
    const content = created ? `已提交给老板批准（请求号 ${request.id.slice(0, 8)}）。老板同意后才会写入日程并通知相关的人。` : `这条请求之前已经提交过了（请求号 ${request.id.slice(0, 8)}），没有重复创建。`;
    const messageId = this.addMessage(convId, 'assistant', content, cards);
    this.saveDraft(convId, draft);
    return { request, created, messageId, content, cards, draft };
  }
}

function toSummary(e: Expansion): ExpansionSummary {
  return { query: e.query, kind: e.kind, normalized: e.normalized, names: e.people.map((p) => p.name), ids: e.people.map((p) => p.id) };
}

export function summarize(d: Draft): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [];
  if (d.category) items.push({ label: '类别', value: CATEGORY_LABEL[d.category] });
  if (d.subject) items.push({ label: '主题', value: d.subject });
  if (d.visitor) items.push({ label: '来访方', value: d.visitor });
  if (d.counterpart) items.push({ label: '对方', value: d.counterpart });
  if (d.start && d.end) items.push({ label: '时间', value: fmtRange(d.start, d.end) + (d.durationDefaulted ? '（默认时长）' : '') });
  if (d.location) items.push({ label: '地点', value: d.location });
  if (d.headcount) items.push({ label: '人数', value: `${d.headcount} 人` });
  if (d.attendees.names.length) items.push({ label: '参与人', value: d.attendees.names.join('、') });
  if (d.note) items.push({ label: '备注', value: d.note });
  if (d.analysis) {
    const s = d.analysis.travelStatus;
    const label = s === 'ok' ? '前后车程已核实，时间够用' : s === 'tight' ? '车程赶不上（老板会看到提示）' : s === 'unverified' ? '车程未核实（地图接口失败）' : '前后无需赶路';
    items.push({ label: '车程', value: label });
    if (d.analysis.conflicts.length) items.push({ label: '冲突', value: `与 ${d.analysis.conflicts.length} 条已有日程重叠` });
  }
  return items;
}
