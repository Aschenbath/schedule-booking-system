/** 类别、必填项、默认时长、提问话术（代码层的“规则”，不交给模型判断） */
export type Category = 'meeting' | 'reception' | 'dinner' | 'other';
export const CATEGORIES: Category[] = ['meeting', 'reception', 'dinner', 'other'];
export const CATEGORY_LABEL: Record<Category, string> = { meeting: '会议', reception: '接待', dinner: '饭局', other: '其他' };
export const DEFAULT_DURATION_MIN: Record<Category, number> = { meeting: 60, reception: 60, dinner: 120, other: 60 };

export type FieldKey = 'subject' | 'time' | 'location' | 'attendees' | 'visitor' | 'headcount' | 'counterpart';
export const FIELD_LABEL: Record<FieldKey, string> = {
  subject: '主题',
  time: '时间段',
  location: '地点',
  attendees: '参会人或部门',
  visitor: '来访方',
  headcount: '人数',
  counterpart: '对方',
};
export const REQUIRED_FIELDS: Record<Category, FieldKey[]> = {
  meeting: ['subject', 'time', 'location', 'attendees'],
  reception: ['visitor', 'headcount', 'time', 'location'],
  dinner: ['counterpart', 'time', 'location', 'headcount'],
  other: ['subject', 'time', 'location'],
};
export const FIELD_QUESTION: Record<FieldKey, string> = {
  subject: '这次的主题是什么？',
  time: '具体是什么时间？（例如：明天下午3点到4点）',
  location: '地点在哪里？',
  attendees: '需要哪些人或部门参加？',
  visitor: '来访的是哪一方？',
  headcount: '大概几个人？',
  counterpart: '对方是谁？',
};

export interface ExpansionSummary {
  query: string;
  kind: 'dept' | 'tag' | 'name' | 'unknown';
  normalized: string;
  names: string[];
  ids: string[];
}

export interface Draft {
  category: Category | null;
  categoryAsked?: boolean;
  subject?: string;
  start?: string; // ISO
  end?: string; // ISO
  timeText?: string;
  timeNeedsClock?: boolean; // 只有“上午/下午”没有具体时刻
  durationDefaulted?: boolean;
  location?: string;
  visitor?: string;
  counterpart?: string;
  headcount?: number;
  note?: string;
  peopleQueries: string[];
  attendees: { ids: string[]; names: string[]; confirmed: boolean; expansions: ExpansionSummary[] };
  /** 上一轮追问了哪些字段（用户简短回答时归位） */
  pendingFields?: FieldKey[];
  analysis?: import('./schedule').Analysis;
  submittedRequestId?: string;
}

export const emptyDraft = (): Draft => ({ category: null, peopleQueries: [], attendees: { ids: [], names: [], confirmed: false, expansions: [] } });

/** 计算缺失的必填项（顺序即追问顺序） */
export function missingFields(d: Draft): FieldKey[] {
  if (!d.category) return [];
  const out: FieldKey[] = [];
  for (const f of REQUIRED_FIELDS[d.category]) {
    switch (f) {
      case 'subject':
        if (!d.subject) out.push(f);
        break;
      case 'time':
        if (!d.start || d.timeNeedsClock) out.push(f);
        break;
      case 'location':
        if (!d.location) out.push(f);
        break;
      case 'attendees':
        if (d.attendees.ids.length === 0) out.push(f);
        break;
      case 'visitor':
        if (!d.visitor) out.push(f);
        break;
      case 'counterpart':
        if (!d.counterpart) out.push(f);
        break;
      case 'headcount':
        if (!d.headcount) out.push(f);
        break;
    }
  }
  return out;
}

/** 提交给老板前的“事由”标题 */
export function draftTitle(d: Draft): string {
  if (d.subject) return d.subject;
  if (d.category === 'reception' && d.visitor) return `接待${d.visitor}`;
  if (d.category === 'dinner' && d.counterpart) return `与${d.counterpart}的饭局`;
  return d.category ? CATEGORY_LABEL[d.category] : '预约';
}
