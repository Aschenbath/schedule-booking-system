import type { LlmClient, ExtractInput, Extraction, ReplyFacts, ChatTurn } from './types';
import { parseChineseTime, normalizeTimeText } from '../time/parse';
import { normalizeQuery } from '../agent/people';
import { renderReply } from '../agent/reply';
import type { Category } from '../agent/schema';

const CATEGORY_KEYWORDS: Array<[Category, RegExp]> = [
  ['meeting', /开会|会议|例会|评审|讨论|汇报|复盘|碰头|研讨|沟通会|培训|面谈|开个会|开场会/],
  ['reception', /接待|来访|来公司|来参观|参观|到访|拜访我们|来考察|来看看|来看|来我们/],
  ['dinner', /饭局|吃饭|午饭|晚饭|午餐|晚餐|宴请|请客|聚餐|吃个饭|喝茶|喝酒|宵夜|吃顿/],
  ['other', /^其他$|^其它$|其他事项|其它事项|别的事|其他事/],
];
const CATEGORY_ANSWER: Array<[Category, RegExp]> = [
  ['meeting', /^(是)?会议$/],
  ['reception', /^(是)?接待$/],
  ['dinner', /^(是)?饭局$/],
  ['other', /^(是)?其他$|^(是)?其它$/],
];

const STOP = /[，,。；;！!？?\n]/;
const cut = (s: string | undefined) => (s ?? '').split(STOP)[0].trim();

function cnNumber(s: string): number | null {
  const n = normalizeTimeText(s + '人').replace(/人$/, '');
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 离线规则抽取器：正则 + 通讯录字典。
 * 用于自动化测试和没有可用大模型时的兜底；能力有限，但结果确定、可复现。
 */
export class RulesLlm implements LlmClient {
  readonly mode = 'rules' as const;
  constructor(private readonly opts: { chunkDelayMs?: number } = {}) {}

  async extract(input: ExtractInput): Promise<Extraction> {
    const raw = input.text.trim();
    const t = normalizeTimeText(raw);
    const out: Extraction = {};
    const pending = input.pendingFields;

    // ---- 意图 ----
    if (/^(算了|取消|不约了|不用了|先不约|取消预约)/.test(raw) && !/改成|改到|换成|挪到/.test(raw)) {
      out.intent = 'cancel';
      return out;
    }
    if (/重新来|重来|重新开始|从头来/.test(raw)) {
      out.intent = 'restart';
      return out;
    }
    if (/^(名单没问题|确认名单|名单确认|就这些人|人没问题|名单ok|名单可以|名单对|人员没问题)/i.test(raw)) {
      out.intent = 'confirm_people';
      return out;
    }
    if (/^(提交|确认提交|没问题|可以|就这样|好的|ok|行|发给老板|交给老板|提交吧|确认)[，,。！!\s]*(提交|吧|了)?$/i.test(raw)) {
      out.intent = 'submit';
      return out;
    }

    // ---- 类别 ----
    const answered = CATEGORY_ANSWER.find(([, re]) => re.test(raw));
    if (answered) out.category = answered[0];
    else {
      const hits = CATEGORY_KEYWORDS.filter(([, re]) => re.test(raw)).map(([c]) => c);
      if (hits.length === 1) out.category = hits[0];
      else if (hits.length > 1) out.category = hits.includes('dinner') && hits.includes('meeting') ? 'unsure' : hits[0];
    }

    // ---- 时间 ----
    const parsed = parseChineseTime(t, input.now);
    if (parsed) out.time_text = raw;

    // ---- 人数 ----
    const hc = t.match(/(\d+)\s*(个人|人|位)(?!员|工|事|力)/);
    if (hc) out.headcount = Number(hc[1]);
    else if (pending.includes('headcount')) {
      const n = cnNumber(raw.replace(/[个人位左右大概约]/g, ''));
      if (n) out.headcount = n;
    }

    // ---- 地点 ----
    let loc: string | undefined;
    let m = raw.match(/(?:地点(?:在|是|：|:)|地址(?:在|是|：|:))([^，,。；;！!？?\s]{2,30})/);
    if (m) loc = m[1];
    if (!loc) {
      m = raw.match(/(?:^|[，,。；;\s]|就|约|定|安排)?(?:在|去|到(?!\d))([^，,。；;！!？?\s\d]{1}[^，,。；;！!？?\s]{1,25}?)(?=开会|开个会|开|吃饭|吃个饭|吃|见面|碰头|接待|会面|进行|举行|聊|谈|讨论|评审|汇报|参观|考察|集合|等|一起|，|,|。|；|;|！|!|？|\?|$)/);
      if (m && !/^(公司|家)(的)?(人|同事)/.test(m[1]) && !/^(明|后|今|下|这|本|周|星期|礼拜|上午|下午|晚上|中午)/.test(m[1])) loc = m[1];
    }
    if (!loc && pending.includes('location') && !parsed && raw.length <= 30 && !/通知|叫上|邀请/.test(raw)) loc = cut(raw);
    if (loc) out.location = loc.replace(/^(在|去|到)/, '').replace(/(那里|那边|这边|这里)$/, '') || undefined;

    // ---- 主题 ----
    let subject: string | undefined;
    m = raw.match(/(?:主题(?:是|为|：|:)?|议题(?:是|为|：|:)?|事由(?:是|为|：|:)?)([^，,。；;！!？?\n]{2,40})/);
    if (m) subject = m[1].trim();
    if (!subject) {
      m = raw.match(/(?:讨论一下|讨论|聊聊|聊一下|汇报一下|汇报|评审一下|评审|开个|关于|同步一下|同步)([^，,。；;！!？?\n]{2,30}?)(的会议|的会|会议|的事|方案|进展|问题|情况|，|,|。|；|;|$)/);
      if (m) subject = (m[1] + (['方案', '进展', '问题', '情况'].includes(m[2]) ? m[2] : '')).trim();
    }
    if (!subject) {
      m = raw.match(/([^，,。；;！!？?\n在去到]{2,30}?)(评审会|评审|复盘会|复盘|例会|汇报会|研讨会|沟通会|培训|启动会|总结会|讨论会|碰头会)/);
      if (m && !/^(开|约|想|要|明天|后天|今天|下周|这周|周|上午|下午|晚上)/.test(m[1])) subject = (m[1] + m[2]).trim();
    }
    if (!subject && pending.includes('subject') && !parsed && !loc && raw.length <= 40 && !/通知|叫上|邀请|人参加/.test(raw)) subject = cut(raw);
    if (subject) out.subject = subject;

    // ---- 来访方 / 对方 ----
    m = raw.match(/(?:接待|来访(?:的是|方是|方：|方:)?)([^，,。；;！!？?\s]{2,20}?)(?=来访|来公司|来参观|来看|一行|等|\d|，|,|。|；|;|$)/);
    if (m && !/^(一下|的)/.test(m[1])) out.visitor = m[1];
    if (!out.visitor && pending.includes('visitor') && !parsed && !loc && raw.length <= 30) out.visitor = cut(raw);

    m = raw.match(/(?:和|跟|与|请|宴请|陪)([^，,。；;！!？?\s]{2,20}?)(?=吃饭|吃个饭|吃|喝|聚餐|饭局|一起|吃顿)/);
    if (m && !/^(老板|张总)/.test(m[1])) out.counterpart = m[1];
    if (!out.counterpart && pending.includes('counterpart') && !parsed && !loc && raw.length <= 30) out.counterpart = cut(raw);

    // ---- 备注 ----
    m = raw.match(/(?:备注|注意|另外|补充)[：:，,]?(.+)$/);
    if (m) out.note = m[1].trim();

    // ---- 通知对象：字典扫描 ----
    const queries: string[] = [];
    const dir = input.directory;
    for (const d of dir.departments) if (raw.includes(d) || raw.includes(d.replace(/部$/, '') + '部门')) queries.push(d);
    for (const tag of dir.tags) {
      const re = new RegExp(`(所有|全部|全体|各位|每位)?${tag}(们|同事)?`);
      if (re.test(raw)) queries.push(raw.match(re)![0]);
    }
    for (const n of dir.names) if (raw.includes(n)) queries.push(n);
    if (queries.length === 0 && pending.includes('attendees') && !parsed && !loc) {
      for (const tok of raw.split(/[、，,和跟及与\s]+|以及|还有/)) {
        const q = normalizeQuery(tok);
        if (q.length >= 2) queries.push(q);
      }
    }
    // “通知XX部”这种没在字典里的说法也要保留，让代码展开成 0 人并如实告知
    m = raw.match(/(?:通知|叫上|邀请|拉上)([^，,。；;！!？?\s]{2,12}?)(?:一起|参加|参会|来|，|,|。|$)/);
    if (m) {
      const q = normalizeQuery(m[1]);
      if (q && !queries.some((x) => x.includes(q) || q.includes(x))) queries.push(q);
    }
    if (queries.length) out.people_queries = [...new Set(queries)];

    return out;
  }

  async *streamReply(facts: ReplyFacts, _history: ChatTurn[]): AsyncIterable<string> {
    const text = renderReply(facts);
    // 模拟流式：按小块输出
    for (let i = 0; i < text.length; i += 6) {
      yield text.slice(i, i + 6);
      const d = this.opts.chunkDelayMs ?? 8;
      if (d > 0) await new Promise((r) => setTimeout(r, d));
    }
  }
}
