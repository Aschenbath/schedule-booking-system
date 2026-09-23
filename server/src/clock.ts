import dayjs, { Dayjs } from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);

export const TZ = 'Asia/Shanghai';
dayjs.tz.setDefault(TZ);

/**
 * 时钟：`NOW` 环境变量可覆盖当前时间。
 *  - offset 模式（默认）：进程启动时锚定在 NOW，之后正常前进（便于演示到点提醒）
 *  - frozen 模式：时间冻结在 NOW
 */
class Clock {
  private anchor: number | null = null; // NOW 对应的毫秒
  private bootReal = Date.now();
  private mode: 'offset' | 'frozen' = 'offset';

  configure(nowStr: string | undefined, mode: 'offset' | 'frozen' = 'offset') {
    this.bootReal = Date.now();
    this.mode = mode;
    if (!nowStr) {
      this.anchor = null;
      return;
    }
    const parsed = parseInTz(nowStr);
    if (!parsed.isValid()) throw new Error(`NOW 无法解析: ${nowStr}`);
    this.anchor = parsed.valueOf();
  }

  now(): Dayjs {
    if (this.anchor === null) return dayjs().tz(TZ);
    const ms = this.mode === 'frozen' ? this.anchor : this.anchor + (Date.now() - this.bootReal);
    return dayjs(ms).tz(TZ);
  }

  isOverridden() {
    return this.anchor !== null;
  }
}

export const clock = new Clock();
export const now = () => clock.now();

/** 把字符串按 Asia/Shanghai 解析（无时区信息时按上海本地时间） */
export function parseInTz(s: string): Dayjs {
  const trimmed = s.trim();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) return dayjs(trimmed).tz(TZ);
  const formats = ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'];
  for (const f of formats) {
    const d = dayjs.tz(trimmed, f, TZ);
    if (d.isValid()) return d;
  }
  return dayjs.tz(trimmed, TZ);
}

export const toIso = (d: Dayjs) => d.tz(TZ).format('YYYY-MM-DDTHH:mm:ssZ');
export const fromIso = (s: string) => dayjs(s).tz(TZ);

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export function fmtDateTime(d: Dayjs) {
  d = d.tz(TZ);
  return `${d.format('M月D日')}(周${WEEKDAYS[d.day()]}) ${d.format('HH:mm')}`;
}
export function fmtRange(start: string, end: string) {
  const s = fromIso(start);
  const e = fromIso(end);
  if (s.isSame(e, 'day')) return `${fmtDateTime(s)}–${e.format('HH:mm')}`;
  return `${fmtDateTime(s)} – ${fmtDateTime(e)}`;
}
export { dayjs };
export type { Dayjs };
