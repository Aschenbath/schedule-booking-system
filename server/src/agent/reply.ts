import type { ReplyFacts } from '../llm/types';
import { fmtRange, fmtDateTime, fromIso } from '../clock';

/** 代码模板渲染回复：规则模式直接用；模型模式在模型不可用时兜底 */
export function renderReply(f: ReplyFacts): string {
  const lines: string[] = [];
  const wd = f.withdrawn ? f.withdrawn.requestId.slice(0, 8) : '';
  if (f.cancelled) return wd ? `好的，已撤回请求（请求号 ${wd}），老板那边不会再看到它，这次预约已取消。需要的时候随时再找我。` : '好的，这次预约已取消。需要的时候随时再找我。';
  if (f.restarted) return `${wd ? `好的，已撤回之前提交的请求（请求号 ${wd}），我们重新开始。` : '好的，我们重新开始。'}请告诉我：这次是会议、接待、饭局还是其他？大概什么时间、在哪里？`;
  if (f.existing) return existingText(f.existing, f.self);
  if (f.submitted) {
    const no = f.submitted.requestId.slice(0, 8);
    if (f.self && !f.submitted.duplicate) lines.push('已加入您的日程，参与人已收到通知，可以在“日程”页查看。');
    else if (f.submitted.duplicate) lines.push(`这条请求之前已经提交过了（请求号 ${no}），没有重复创建，老板那边只会看到一条。`);
    else if (f.submitted.replaced) lines.push(`已撤回原请求（请求号 ${f.submitted.replaced.slice(0, 8)}），并按新内容重新提交给老板批准（请求号 ${no}）。老板同意后才会写进日程并通知相关的人。`);
    else lines.push(`已提交给老板批准（请求号 ${no}）。老板同意后会正式写入日程并通知相关的人，你可以在“我的请求”里查看进度。`);
    return lines.join('\n');
  }

  if (f.askCategory) {
    lines.push('收到。先确认一下：这次是会议、接待、饭局，还是其他事项？');
  }

  for (const c of f.changed ?? []) lines.push(c);

  const peopleLines: string[] = [];
  for (const e of f.people.expansions) {
    if (e.names.length === 0) peopleLines.push(`「${e.query}」没有找到任何成员，没法通知到任何人，请换个说法或指定具体的人。`);
    else peopleLines.push(`「${e.query}」展开为 ${e.names.length} 人：${e.names.join('、')}`);
  }
  if (peopleLines.length) {
    lines.push(...peopleLines);
    if (f.people.needsConfirm) lines.push('请在下方核对名单并点击“确认名单”，也可以直接告诉我增减。');
  }

  const a = f.analysis;
  if (a) {
    if (a.conflicts.length) {
      const c = a.conflicts.map((x) => `「${x.subject}」(${fmtRange(x.start, x.end)}，${x.location})`).join('、');
      lines.push(`这个时间和老板已有的日程重叠：${c}。`);
    }
    for (const nb of [a.before, a.after]) {
      if (!nb || nb.travel.status === 'same_place') continue;
      if (nb.travel.status === 'unverified') {
        lines.push(`前后有一场「${nb.subject}」在${nb.location}，但地图接口调用失败，车程未核实，提交后会在老板的审批卡片上标明“车程未核实”。`);
      } else if (nb.enough === false) {
        const at = nb.suggestStart ? fmtDateTime(fromIso(nb.suggestStart)) : '';
        const sug = !at ? '建议换个时间' : nb.side === 'after' ? `建议提前到 ${at} 或更早开始` : `建议挪到 ${at} 或之后开始`;
        lines.push(`时间上不冲突，但车程赶不上：「${nb.subject}」在${nb.location}，驾车约 ${nb.travel.minutes} 分钟，而中间只有 ${nb.gapMin} 分钟。${sug}。`);
      } else if (nb.enough === true) {
        lines.push(`和「${nb.subject}」之间驾车约 ${nb.travel.minutes} 分钟，时间够用。`);
      }
    }
    if (a.suggestions.length) lines.push(`可用的空档：${a.suggestions.map((s) => s.label).join('；')}。你可以直接回复想改到哪个时间。`);
  }

  for (const n of f.notes) lines.push(n);

  if (f.questions.length) {
    lines.push(f.questions.length === 1 ? f.questions[0] : f.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'));
  } else if (f.ready) {
    const summary = f.collected.map((c) => `${c.label}：${c.value}`).join('\n');
    lines.push(`信息齐了，请确认：\n${summary}\n没问题的话点“${f.self ? '加入日程' : '提交给老板批准'}”，或回复“提交”。`);
  } else if (!f.askCategory && lines.length === 0) {
    lines.push('收到，请继续补充信息。');
  }
  return lines.join('\n');
}

/** 已提交请求的现状：待批准 / 已写进日程（对话里不能再改）/ 被拒 */
export function existingText(e: NonNullable<ReplyFacts['existing']>, self?: boolean): string {
  if (e.status === 'approved')
    return self
      ? `这条已经加入您的日程（${e.time}），不能在对话里修改或取消；要安排新的事，请点“新建预约”。`
      : `这条预约老板已经同意，已写进日程（${e.time}）。已同意的日程不能在对话里修改或取消，需要调整请直接联系老板；要约新的事，可以点“新建预约”。`;
  if (e.status === 'rejected') return `这条预约老板没有同意${e.reason ? `（原因：${e.reason}）` : ''}。想再约的话，告诉我要改的时间或内容，改好后可以重新提交。`;
  return `这条预约已经提交（请求号 ${e.requestId.slice(0, 8)}，${e.time}），正在等老板批准。要改时间、地点或参加的人直接告诉我；不约了就说“取消”，我帮你撤回。`;
}
