import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import type { Hub } from '../services/notifications';
import { allContacts, getContact, getBoss, type RequestRow } from '../db';
import { now, toIso, fromIso, fmtRange } from '../clock';
import { parseChineseTime, mergeTime, parseDurationChange, parseUntil } from '../time/parse';
import { expandMany, uniqueContacts, type Expansion } from './people';
import { analyzeSlot, type Analysis } from './schedule';
import { CATEGORY_LABEL, DEFAULT_DURATION_MIN, FIELD_QUESTION, emptyDraft, missingFields, draftTitle, type Draft, type FieldKey, type ExpansionSummary } from './schema';
import { renderReply, existingText } from './reply';
import { RulesLlm } from '../llm/rules';
import type { Extraction, ReplyFacts, ChatTurn, Directory } from '../llm/types';
import { submitRequest, withdrawRequest, getRequest, RequestError } from '../services/requests';

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
    return { departments, tags, names: contacts.map((c) => c.name), boss: getBoss(this.ctx.db).name };
  }

  // ---------- 一轮对话 ----------
  async *handleMessage(convId: string, text: string): AsyncGenerator<TurnEvent> {
    const conv = this.getConversationRow(convId);
    if (!conv) throw new RequestError('会话不存在', 404);
    const user = getContact(this.ctx.db, conv.user_id);
    let draft = this.loadDraft(conv);
    // 这句话之前信息是否已经齐了（员工看过完整摘要）——提交必须建立在这之上
    const readyBefore = !!draft.category && !!draft.start && !draft.timeNeedsClock && missingFields(draft).length === 0;
    const history = this.history(convId);
    this.addMessage(convId, 'user', text);
    const nowT = now();
    const notes: string[] = [];
    const facts: ReplyFacts = {
      self: conv.user_id === getBoss(this.ctx.db).id,
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

    // 0) 这条对话提交过的请求老板已经同意、写进日程：对话里不能再改或取消，如实说明，草稿不动
    const lockedReply = (r: RequestRow) => {
      facts.existing = existingInfo(r);
      return this.finish(convId, draft, facts, history, []);
    };
    const linkedId = draft.submittedRequestId ?? draft.replacesRequestId;
    let sent = linkedId ? getRequest(this.ctx, linkedId) : undefined;
    if (sent?.status === 'approved') {
      yield* lockedReply(sent);
      return;
    }

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
    // 抽取要几秒，老板可能正好在这期间批了：后面一律按请求的最新状态判断
    if (sent) sent = getRequest(this.ctx, sent.id);
    if (sent?.status === 'approved') {
      yield* lockedReply(sent);
      return;
    }

    // 2) 意图：取消 / 重来
    // 模型把“算了，后天吧”标成取消、却同时给了新时间/地点：按改口处理，不清空草稿
    if (ex.intent === 'cancel' && (ex.time_text || ex.start || ex.location || ex.duration_min || ex.extend_min)) ex.intent = null;
    if (ex.intent === 'cancel' || ex.intent === 'restart') {
      // 已经提交、老板还没处理：撤回，老板那边不会再看到；撤回的瞬间老板刚好批了，就如实说已写进日程
      if (sent?.status === 'pending') {
        const r = this.withdraw(sent.id, conv.user_id);
        if (r.status === 'approved') {
          yield* lockedReply(r);
          return;
        }
        if (r.status === 'withdrawn') facts.withdrawn = { requestId: r.id };
      }
      draft = emptyDraft();
      if (ex.intent === 'cancel') facts.cancelled = true;
      else facts.restarted = true;
      yield* this.finish(convId, draft, facts, history, []);
      return;
    }

    // 3) 类别（判不准就问，不猜）
    if (ex.category === 'unsure') draft.category ??= null; // 已经定了的类别不被后面一句含糊话清掉
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
    let durationSet = false; // 这句话里的时间已经带了结束/时长
    // 开始已定、这句只说“留到/开到X点”“X点结束”：只改结束时间，不当成新的开始时间
    const untilSrc = ex.time_text ?? text;
    const untilEnd = draft.start && !draft.timeNeedsClock && !/今天|明天|后天|周|星期|礼拜|月|号/.test(untilSrc) ? parseUntil(untilSrc, fromIso(draft.start)) : null;
    if (untilEnd) {
      draft.end = toIso(untilEnd);
      draft.durationDefaulted = false;
      durationSet = true;
      timeChanged = true;
      timeEdited = true;
    } else if (ex.time_text) {
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
        durationSet = !!(parsed.end || parsed.durationMin);
        timeChanged = true;
        timeEdited = true;
      } else if (ex.start) {
        const s = fromIso(ex.start);
        if (s.isValid()) {
          draft.start = toIso(s);
          const e = ex.end ? fromIso(ex.end) : null;
          draft.end = e && e.isValid() && e.isAfter(s) ? toIso(e) : undefined;
          durationSet = !!draft.end;
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
    if (draft.start && !draft.end && draft.pendingDurationMin && !draft.timeNeedsClock) {
      draft.end = toIso(fromIso(draft.start).add(draft.pendingDurationMin, 'minute'));
      draft.pendingDurationMin = undefined;
      durationSet = true;
      timeChanged = true;
    }
    let defaultNote = -1; // 本轮补了默认时长的提示在 notes 里的位置
    let askedDuration = false; // 本轮已经问了“要多久”，算一个问题
    if (draft.start && !draft.end && draft.category && !draft.timeNeedsClock) {
      const mins = DEFAULT_DURATION_MIN[draft.category];
      draft.end = toIso(fromIso(draft.start).add(mins, 'minute'));
      if (!draft.durationDefaulted) defaultNote = notes.push(`结束时间没说，先按${CATEGORY_LABEL[draft.category]}默认 ${mins} 分钟安排（${fmtRange(draft.start, draft.end)}），需要更长可以告诉我。`) - 1;
      draft.durationDefaulted = true;
      timeChanged = true;
    }
    // 只改时长（“要两个半小时”“再加半小时”）：开始不变，只挪结束时间；只说“要更久”就问多久
    if (!durationSet) {
      const dc = parseDurationChange(ex.time_text ?? text) ?? (ex.time_text ? parseDurationChange(text) : null);
      const total = ex.duration_min ?? dc?.totalMin;
      const extend = ex.extend_min ?? dc?.extendMin;
      if (draft.start && !draft.timeNeedsClock && (total || extend)) {
        const s = fromIso(draft.start);
        const base = draft.end ? fromIso(draft.end) : s;
        draft.end = toIso(total ? s.add(total, 'minute') : base.add(extend!, 'minute'));
        draft.durationDefaulted = false;
        timeChanged = true;
        timeEdited = true;
      } else if (total || extend) {
        notes.push(`记下了，时长${total ? `约 ${total} 分钟` : `延长 ${extend} 分钟`}；等开始时间定了我按这个算结束时间。`);
        if (total) draft.pendingDurationMin = total;
      } else if (dc?.vague && draft.start && draft.end && !draft.timeNeedsClock) {
        // 时刻还没定时不问时长（时间那个问题已经覆盖）；同一轮刚补的默认时长提示换成这句，避免自相矛盾
        if (defaultNote >= 0) notes.splice(defaultNote, 1);
        askedDuration = true;
        notes.push(`现在按 ${fmtRange(draft.start, draft.end)} 安排。要留多长时间？告诉我时长（如“两个小时”）或结束时间（如“到5点半”），我来调整。`);
      }
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
    // 老板本人是被预约的对象，不当作“要通知的人”去展开（否则会报“张总没有找到成员”）
    const boss = getBoss(this.ctx.db);
    const bossAlias = new Set([boss.name, `${boss.name.slice(0, 1)}总`, '老板', '老总', boss.title, `${boss.name.slice(0, 1)}${boss.title}`]);
    if (ex.people_queries?.length) ex.people_queries = ex.people_queries.filter((q) => !bossAlias.has(q.replace(/^(和|跟|与|叫上|通知|请)/, '').trim()));
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
    // 提交有副作用，不能只凭模型的一个标签：之前没看过完整摘要、或者这句话还在改内容/加人，就先不提交，给员工看摘要确认
    if (ex.intent === 'submit' && (!readyBefore || timeChanged || locationChanged || !!ex.subject || !!ex.people_queries?.length || !!ex.remove_people?.length)) ex.intent = null;
    if ((ex.intent === 'confirm_people' || ex.intent === 'submit') && draft.attendees.ids.length) draft.attendees.confirmed = true; // “没问题，提交”= 名单也没问题

    // 提交过之后的这句话：内容变了 → 原请求先留着，等员工确认后撤回重交；没变 → 后面如实说原请求的状态
    let unchangedSince: RequestRow | undefined;
    if (sent) {
      const same = sameContent(draft, sent);
      if (sent.status === 'pending') {
        draft.submittedRequestId = same ? sent.id : undefined;
        draft.replacesRequestId = same ? undefined : sent.id;
        if (same) unchangedSince = sent;
      } else if (sent.status === 'rejected' && same && draft.submittedRequestId) {
        unchangedSince = sent;
      } else {
        // 被拒后改了内容 / 已撤回：这份草稿就是一份新的预约，可以重新提交
        draft.submittedRequestId = undefined;
        draft.replacesRequestId = undefined;
      }
    }

    // 7) 冲突 + 车程（代码做；地图失败标 unverified）
    const timeComplete = !!draft.start && !!draft.end && !draft.timeNeedsClock;
    if (timeComplete && (timeChanged || locationChanged || !draft.analysis)) {
      draft.analysis = await analyzeSlot(this.ctx, draft.start!, draft.end!, draft.location ?? '');
      facts.analysis = draft.analysis;
    } else if (!timeComplete) draft.analysis = undefined;

    // 8) 缺什么问什么，一轮最多两项
    const missing = draft.category ? missingFields(draft) : [];
    const ask = facts.askCategory ? [] : missing.slice(0, askedDuration ? 1 : 2); // 问了时长就只再问一项
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
        const r = this.submitDraft(convId, conv.user_id, draft);
        if (r.locked) facts.existing = existingInfo(r.request);
        else {
          facts.submitted = { requestId: r.request.id, duplicate: !r.created, replaced: r.replaced };
          facts.self = r.request.requester_id === getBoss(this.ctx.db).id;
        }
      } else if (needsConfirm) notes.push('提交前请先确认参会名单。');
      else if (missing.length) notes.push('还差一些信息，补齐后就可以提交。');
    }
    // 提交过的那条这句话没改：如实说它现在的状态，不再请员工确认提交
    if (!facts.submitted && !facts.existing && unchangedSince) facts.existing = existingInfo(unchangedSince);
    if (!facts.submitted && !facts.existing && draft.replacesRequestId)
      notes.push(`这条预约之前已经提交（请求号 ${draft.replacesRequestId.slice(0, 8)}），刚才的修改还没发给老板；确认无误后点按钮或回复“提交”，我会撤回原请求、按新内容重新提交。`);

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
    // 已提交的请求原样没动：只挂它的状态，不再出“提交”按钮
    if (facts.existing) return facts.existing.status === 'pending' ? [{ type: 'submitted', requestId: facts.existing.requestId }] : [];
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
      // 流到一半断了：丢掉半句，整条换成模板回复（前端以 state.content 为准覆盖）
      const fallback = renderReply(facts);
      if (!content.trim()) yield { type: 'delta', text: fallback };
      content = fallback;
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
    const isBoss = conv.user_id === getBoss(this.ctx.db).id;
    const cards: Card[] = [{ type: 'people_confirm', expansions: draft.attendees.expansions, selectedIds: valid, confirmed: true }];
    let content = valid.length ? `名单已确认（${valid.length} 人）：${draft.attendees.names.join('、')}。` : '名单已清空，这次不通知其他人。';
    if (ready) {
      content += `\n信息齐了，请确认：\n${items.map((i) => `${i.label}：${i.value}`).join('\n')}\n${isBoss ? '没问题的话点“加入日程”，或回复“提交”。' : '没问题的话点“提交给老板批准”，或回复“提交”。'}`;
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
    const { request, created, replaced, locked } = this.submitDraft(convId, conv.user_id, draft);
    const self = request.requester_id === getBoss(this.ctx.db).id;
    const no = (id: string) => id.slice(0, 8);
    const cards: Card[] = locked ? [] : [{ type: 'submitted', requestId: request.id }];
    const content = locked
      ? existingText(existingInfo(request), self)
      : !created
        ? `这条请求之前已经提交过了（请求号 ${no(request.id)}），没有重复创建。`
        : self
          ? `已加入您的日程（${fmtRange(request.start, request.end)}），参与人已收到通知。`
          : replaced
            ? `已撤回原请求（请求号 ${no(replaced)}），并按新内容重新提交给老板批准（请求号 ${no(request.id)}）。老板同意后才会写入日程并通知相关的人。`
            : `已提交给老板批准（请求号 ${no(request.id)}）。老板同意后才会写入日程并通知相关的人。`;
    const messageId = this.addMessage(convId, 'assistant', content, cards);
    this.saveDraft(convId, draft);
    return { request, created, messageId, content, cards, draft };
  }

  /** 撤回这条对话里还在待批准的请求；老板恰好先处理了，就返回它的最新状态 */
  private withdraw(id: string, userId: string): RequestRow {
    try {
      return withdrawRequest(this.ctx, this.hub, id, userId);
    } catch (e) {
      if (e instanceof RequestError && e.status === 409) return getRequest(this.ctx, id)!;
      throw e;
    }
  }

  /** 提交草稿：提交后改过内容的，先撤回原来那条待批准的再交新的；原来那条老板已经批了，就不交新的，如实返回它 */
  private submitDraft(convId: string, userId: string, draft: Draft): { request: RequestRow; created: boolean; replaced?: string; locked?: boolean } {
    let replaced: string | undefined;
    if (draft.replacesRequestId) {
      const old = getRequest(this.ctx, draft.replacesRequestId);
      const r = old?.status === 'pending' ? this.withdraw(old.id, userId) : old;
      if (r?.status === 'approved') {
        draft.submittedRequestId = r.id;
        draft.replacesRequestId = undefined;
        return { request: r, created: false, locked: true };
      }
      if (old?.status === 'pending' && r?.status === 'withdrawn') replaced = r.id;
      draft.replacesRequestId = undefined;
    }
    const { request, created } = submitRequest(this.ctx, this.hub, convId, userId, draft);
    draft.submittedRequestId = request.id;
    return { request, created, replaced };
  }
}

/** 草稿和已提交的请求内容是否一致：决定这句话算不算“改了已提交的预约” */
function sameContent(d: Draft, r: RequestRow): boolean {
  const ids = (a: string[]) => JSON.stringify([...a].sort());
  return (
    d.category === r.category &&
    draftTitle(d) === (r.subject ?? '') &&
    d.start === r.start &&
    d.end === r.end &&
    (d.location ?? '') === (r.location ?? '') &&
    ids(d.attendees.ids) === ids(JSON.parse(r.attendees) as string[]) &&
    (d.headcount ?? null) === r.headcount &&
    (d.visitor ?? null) === r.visitor &&
    (d.counterpart ?? null) === r.counterpart &&
    (d.note ?? null) === r.note
  );
}

/** 已提交请求的现状（给回复用）；老板改过时间的按改后的时间说 */
function existingInfo(r: RequestRow): NonNullable<ReplyFacts['existing']> {
  return {
    requestId: r.id,
    status: r.status as 'pending' | 'approved' | 'rejected',
    time: fmtRange(r.final_start ?? r.start, r.final_end ?? r.end),
    reason: r.status === 'rejected' ? r.decision_note ?? undefined : undefined,
  };
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
