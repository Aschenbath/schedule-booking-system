import { describe, it, expect } from 'vitest';
import { parseChineseTime, mergeTime } from '../src/time/parse';
import { parseInTz } from '../src/clock';

const now = parseInTz('2026-09-23T09:00:00'); // 周三

const fmt = (d?: { format: (f: string) => string }) => d?.format('YYYY-MM-DD HH:mm');

describe('中文相对时间解析', () => {
  it('明天下午3点', () => {
    const p = parseChineseTime('明天下午3点', now)!;
    expect(fmt(p.start)).toBe('2026-09-24 15:00');
    expect(p.hasDate && p.hasClock).toBe(true);
  });
  it('下周二上午（无具体时刻）', () => {
    const p = parseChineseTime('下周二上午', now)!;
    expect(fmt(p.start)).toBe('2026-09-29 09:00');
    expect(p.hasClock).toBe(false);
  });
  it('这周五 / 周五 / 周一（已过则顺延到下周）', () => {
    expect(fmt(parseChineseTime('这周五下午2点', now)!.start)).toBe('2026-09-25 14:00');
    expect(fmt(parseChineseTime('周五下午2点', now)!.start)).toBe('2026-09-25 14:00');
    expect(fmt(parseChineseTime('周一上午10点', now)!.start)).toBe('2026-09-28 10:00');
  });
  it('时间段 下午2点到4点 / 10点半-11点 / 上午10点到下午1点', () => {
    const a = parseChineseTime('后天下午2点到4点', now)!;
    expect(fmt(a.start)).toBe('2026-09-25 14:00');
    expect(fmt(a.end)).toBe('2026-09-25 16:00');
    const b = parseChineseTime('明天10点半-11点', now)!;
    expect(fmt(b.start)).toBe('2026-09-24 10:30');
    expect(fmt(b.end)).toBe('2026-09-24 11:00');
    const c = parseChineseTime('明天上午10点到下午1点', now)!;
    expect(fmt(c.end)).toBe('2026-09-24 13:00');
  });
  it('中文数字、时长、日期', () => {
    const a = parseChineseTime('明天下午三点半开一个小时', now)!;
    expect(fmt(a.start)).toBe('2026-09-24 15:30');
    expect(fmt(a.end)).toBe('2026-09-24 16:30');
    expect(fmt(parseChineseTime('10月8号上午9点', now)!.start)).toBe('2026-10-08 09:00');
    expect(fmt(parseChineseTime('28号晚上7点', now)!.start)).toBe('2026-09-28 19:00');
    expect(fmt(parseChineseTime('2026-10-01 14:00', now)!.start)).toBe('2026-10-01 14:00');
    expect(parseChineseTime('明晚6点半吃饭', now)!.start.format('HH:mm')).toBe('18:30');
  });
  it('没有日期且时刻已过 -> 顺延到明天', () => {
    expect(fmt(parseChineseTime('8点', now)!.start)).toBe('2026-09-24 08:00');
  });
  it('无时间信息返回 null', () => {
    expect(parseChineseTime('我们聊聊项目', now)).toBeNull();
  });
  it('改口合并：只换日期 / 只换时刻', () => {
    const base = parseChineseTime('明天下午3点到4点', now)!;
    const d = mergeTime(base.start, base.end, parseChineseTime('算了改成后天', now)!);
    expect(fmt(d.start)).toBe('2026-09-25 15:00');
    expect(fmt(d.end)).toBe('2026-09-25 16:00');
    const c = mergeTime(base.start, base.end, parseChineseTime('改到5点吧', now)!);
    expect(fmt(c.start)).toBe('2026-09-24 17:00');
    expect(fmt(c.end)).toBe('2026-09-24 18:00');
  });
});
