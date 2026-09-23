import { Dayjs, dayjs, TZ } from '../clock';

/**
 * 中文相对时间解析（确定性、可测试）。
 * 支持：今天/明天/后天/大后天、(下/这/本)周X、X月X日、X号、YYYY-MM-DD、
 *      上午/下午/晚上、X点(半/X分)、X:MM、A到B 时间段、持续时长（一个小时/半小时/90分钟）。
 */
export interface ParsedTime {
  start: Dayjs;
  end?: Dayjs;
  durationMin?: number;
  hasDate: boolean;
  hasClock: boolean;
  period?: Period;
  text: string;
}
export type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'dawn';

const CN_NUM: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnToInt(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    const v = CN_NUM[ch];
    if (v === undefined) return NaN;
    if (v === 10) {
      total += (cur || 1) * 10;
      cur = 0;
    } else cur = v;
  }
  return total + cur;
}

export function normalizeTimeText(text: string): string {
  let t = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[～〜]/g, '~');
  // 中文数字 -> 阿拉伯数字（仅在时间/数量语境：点/时/号/日/月/小时/分钟/人 前）
  t = t.replace(/([零一二两三四五六七八九十]+)(?=(点|时|号|日|月|个半?小时|小时|个钟头|分钟|分|人|位|刻))/g, (m) => {
    const n = cnToInt(m);
    return Number.isNaN(n) ? m : String(n);
  });
  t = t.replace(/半个?小时/g, '30分钟').replace(/(\d+)个半小时/g, (_, n) => `${Number(n) * 60 + 30}分钟`);
  return t;
}

const PERIOD_RE = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间|今晚|明晚|夜里|晚)/;
function periodOf(word: string | undefined): Period | undefined {
  if (!word) return undefined;
  if (/凌晨/.test(word)) return 'dawn';
  if (/早|上午/.test(word)) return 'morning';
  if (/中午/.test(word)) return 'noon';
  if (/下午|傍晚/.test(word)) return 'afternoon';
  if (/晚|夜/.test(word)) return 'evening';
  return undefined;
}
const PERIOD_DEFAULT_HOUR: Record<Period, number> = { dawn: 6, morning: 9, noon: 12, afternoon: 14, evening: 18 };

function applyPeriod(hour: number, period?: Period): number {
  if (period === undefined) return hour;
  if ((period === 'afternoon' || period === 'evening') && hour < 12) return hour + 12;
  if (period === 'noon' && hour < 6) return hour + 12; // 中午1点 -> 13
  return hour;
}

const WD: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 6 };

interface DatePart {
  date: Dayjs; // 当天 00:00
  hasDate: boolean;
}

function parseDate(t: string, now: Dayjs): DatePart {
  const today = now.startOf('day');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?/))) {
    return { date: dayjs.tz(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, 'YYYY-MM-DD', TZ), hasDate: true };
  }
  if (/大后天/.test(t)) return { date: today.add(3, 'day'), hasDate: true };
  if (/后天/.test(t)) return { date: today.add(2, 'day'), hasDate: true };
  if (/明天|明日|明早|明晚/.test(t)) return { date: today.add(1, 'day'), hasDate: true };
  if (/今天|今日|今晚|今早/.test(t)) return { date: today, hasDate: true };
  if ((m = t.match(/(下下|下|这|本|上)?(周|星期|礼拜)([一二三四五六日天末])/))) {
    const wd = WD[m[3]];
    const isoToday = now.isoWeekday(); // 1..7
    let base = today.add(wd - isoToday, 'day'); // 本周对应的那天
    const prefix = m[1];
    if (prefix === '下') base = base.add(7, 'day');
    else if (prefix === '下下') base = base.add(14, 'day');
    else if (prefix === '上') base = base.subtract(7, 'day');
    else if (prefix === '这' || prefix === '本') {
      /* 本周 */
    } else if (base.isBefore(today)) base = base.add(7, 'day'); // 无前缀：最近的将来一个
    return { date: base, hasDate: true };
  }
  if ((m = t.match(/(\d{1,2})月(\d{1,2})[日号]/))) {
    let d = dayjs.tz(`${now.year()}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`, 'YYYY-MM-DD', TZ);
    if (d.isBefore(today)) d = d.add(1, 'year');
    return { date: d, hasDate: true };
  }
  if ((m = t.match(/(?<!\d)(\d{1,2})[号日](?!期)/))) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      let d = today.date(day);
      if (d.isBefore(today)) d = d.add(1, 'month');
      return { date: d, hasDate: true };
    }
  }
  return { date: today, hasDate: false };
}

interface ClockPart {
  hour: number;
  minute: number;
  text: string;
  index: number;
}
const CLOCK_RE = /(\d{1,2})\s*(?:[点时]\s*(半|1刻|3刻|\d{1,2})?\s*分?|:(\d{2}))/g;
function parseClocks(t: string): ClockPart[] {
  const out: ClockPart[] = [];
  for (const m of t.matchAll(CLOCK_RE)) {
    const hour = Number(m[1]);
    if (hour > 24) continue;
    let minute = 0;
    const frac = m[2];
    if (frac === '半') minute = 30;
    else if (frac === '1刻') minute = 15;
    else if (frac === '3刻') minute = 45;
    else if (frac) minute = Number(frac);
    else if (m[3]) minute = Number(m[3]);
    if (minute > 59) continue;
    out.push({ hour, minute, text: m[0], index: m.index ?? 0 });
  }
  return out;
}

function parseDuration(t: string): number | undefined {
  let m: RegExpMatchArray | null;
  if ((m = t.match(/(\d+)\s*分钟/))) return Number(m[1]);
  if ((m = t.match(/(\d+)\s*个?(小时|钟头)/))) return Number(m[1]) * 60;
  return undefined;
}

export function parseChineseTime(text: string, now: Dayjs): ParsedTime | null {
  const t = normalizeTimeText(text);
  const datePart = parseDate(t, now);
  const clocks = parseClocks(t);
  const durationMin = parseDuration(t);

  // 时段词：取时钟前面最近的时段词
  const periodBefore = (idx: number): Period | undefined => {
    const seg = t.slice(Math.max(0, idx - 6), idx);
    let last: string | undefined;
    for (const m of seg.matchAll(new RegExp(PERIOD_RE.source, 'g'))) last = m[1];
    return periodOf(last);
  };
  const globalPeriod = periodOf(t.match(PERIOD_RE)?.[1]);

  if (!datePart.hasDate && clocks.length === 0 && !globalPeriod) return null;

  let start: Dayjs;
  let end: Dayjs | undefined;
  let hasClock = false;

  if (clocks.length > 0) {
    hasClock = true;
    const c0 = clocks[0];
    const p0 = periodBefore(c0.index) ?? globalPeriod;
    const h0 = applyPeriod(c0.hour, p0);
    start = datePart.date.hour(h0).minute(c0.minute);
    // 时间段：A 到 B
    if (clocks.length > 1) {
      const c1 = clocks[1];
      const between = t.slice(c0.index + c0.text.length, c1.index);
      if (between.length <= 6 && /^[\s至到~\-—–]+(?:凌晨|早上|上午|中午|下午|傍晚|晚上|晚)?$/.test(between)) {
        const ownPeriod = periodBefore(c1.index);
        const p1 = ownPeriod ?? p0 ?? globalPeriod;
        let h1 = applyPeriod(c1.hour, p1);
        if (h1 <= h0 && !ownPeriod && h1 + 12 < 24) h1 += 12; // 10点到2点 -> 14
        end = datePart.date.hour(h1).minute(c1.minute);
        if (!end.isAfter(start)) end = end.add(1, 'day');
      }
    }
  } else {
    // 只有时段（如“下周二上午”），给默认时刻，标记 hasClock=false
    const p = globalPeriod ?? 'morning';
    start = datePart.date.hour(PERIOD_DEFAULT_HOUR[p]).minute(0);
  }

  if (!datePart.hasDate && hasClock && start.isBefore(now)) {
    start = start.add(1, 'day');
    if (end) end = end.add(1, 'day');
  }
  if (end === undefined && durationMin) end = start.add(durationMin, 'minute');

  return { start, end, durationMin, hasDate: datePart.hasDate, hasClock, period: globalPeriod, text };
}

/**
 * 用户改口时合并时间：
 *  - 只说了日期（“改成后天”）→ 保留原时刻，只换日期
 *  - 只说了时刻（“改到4点”）→ 保留原日期，只换时刻
 */
export function mergeTime(prevStart: Dayjs | undefined, prevEnd: Dayjs | undefined, parsed: ParsedTime): { start: Dayjs; end?: Dayjs } {
  if (!prevStart) return { start: parsed.start, end: parsed.end };
  const prevDur = prevEnd ? prevEnd.diff(prevStart, 'minute') : undefined;
  const withDur = (s: Dayjs) => (prevDur ? s.add(prevDur, 'minute') : undefined);
  if (parsed.hasDate && !parsed.hasClock && !parsed.period) {
    const start = parsed.start.hour(prevStart.hour()).minute(prevStart.minute());
    return { start, end: withDur(start) };
  }
  if (!parsed.hasDate && parsed.hasClock) {
    let hour = parsed.start.hour();
    // “改到5点”没说上午/下午：沿用原时间的上下午
    if (!parsed.period && hour < 12 && prevStart.hour() >= 12) hour += 12;
    const start = prevStart.hour(hour).minute(parsed.start.minute());
    let end = parsed.end ? prevStart.hour(parsed.end.hour()).minute(parsed.end.minute()) : withDur(start);
    if (end && !end.isAfter(start)) end = end.add(1, 'day');
    return { start, end };
  }
  if (parsed.hasDate && !parsed.hasClock && parsed.period) {
    // “改成明天下午”：换日期，时刻用时段默认值
    return { start: parsed.start, end: withDur(parsed.start) };
  }
  return { start: parsed.start, end: parsed.end ?? withDur(parsed.start) };
}
