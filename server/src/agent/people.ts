import type { DB, Contact } from '../db';
import { allContacts } from '../db';

export type ExpansionKind = 'dept' | 'tag' | 'name' | 'unknown';
export interface Expansion {
  query: string; // 原始说法，如“人工智能部”“所有设计师”“刘洋”
  normalized: string;
  kind: ExpansionKind;
  people: Contact[];
}

const NOISE = /^(请|麻烦|帮我|通知|叫上|叫|邀请|拉上|带上|加上|还有|和|跟|以及|把)+|(的?(所有|全部|全体)?(同事|成员|人员|人|们))+$|(部门|的)$/g;

export function normalizeQuery(q: string): string {
  let s = q.trim().replace(/[，,、。；;！!？?\s]+/g, '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(NOISE, '').replace(/^(所有|全部|全体|整个|各位|每位)/, '');
  }
  return s;
}

/** 部门名匹配：允许省略“部”字，例如“人工智能”→“人工智能部” */
function matchDept(db: DB, q: string): string | undefined {
  const depts = (db.prepare('SELECT name FROM departments').all() as { name: string }[]).map((r) => r.name);
  const exact = depts.find((d) => d === q || d === q + '部' || d.replace(/部$/, '') === q.replace(/部$/, ''));
  if (exact) return exact;
  // “设计”→“设计部”、“工程”→“工程部”
  const bare = q.replace(/部$/, '');
  if (bare.length >= 2) {
    const hit = depts.filter((d) => d.replace(/部$/, '') === bare || (d.startsWith(bare) && d.length - bare.length <= 1));
    if (hit.length === 1) return hit[0];
  }
  return undefined;
}

/** 岗位标签匹配：“设计师”匹配 title 含“设计师”的人（含“软装设计师”） */
function matchTag(contacts: Contact[], q: string): Contact[] {
  if (q.length < 2) return [];
  return contacts.filter((c) => c.title.includes(q) || (q.endsWith('们') && c.title.includes(q.slice(0, -1))));
}

/**
 * 把“通知人工智能部”“所有设计师”“刘洋”展开成具体的人。
 * 老板本人不算被通知对象（这是老板的日程）。
 */
export function expandPeople(db: DB, query: string): Expansion {
  const normalized = normalizeQuery(query);
  const contacts = allContacts(db).filter((c) => c.role !== 'boss');
  if (!normalized) return { query, normalized, kind: 'unknown', people: [] };

  const dept = matchDept(db, normalized);
  if (dept) return { query, normalized: dept, kind: 'dept', people: contacts.filter((c) => c.dept === dept) };

  const byTag = matchTag(contacts, normalized);
  if (byTag.length) return { query, normalized, kind: 'tag', people: byTag };

  const byName = contacts.filter((c) => c.name === normalized || (normalized.length >= 2 && c.name.includes(normalized)));
  if (byName.length) return { query, normalized, kind: 'name', people: byName };

  return { query, normalized, kind: 'unknown', people: [] };
}

export function expandMany(db: DB, queries: string[]): Expansion[] {
  const seen = new Set<string>();
  const out: Expansion[] = [];
  for (const q of queries) {
    const n = normalizeQuery(q);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(expandPeople(db, q));
  }
  return out;
}

export function uniqueContacts(expansions: Expansion[]): Contact[] {
  const map = new Map<string, Contact>();
  for (const e of expansions) for (const p of e.people) map.set(p.id, p);
  return [...map.values()];
}
