import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers';
import { expandPeople, normalizeQuery } from '../src/agent/people';

describe('名单展开', () => {
  const { db } = makeEnv();
  it('部门 → 具体的人（老板本人不算）', () => {
    const e = expandPeople(db, '通知人工智能部');
    expect(e.kind).toBe('dept');
    expect(e.people.map((p) => p.name)).toEqual(['韩雪', '冯远', '曹阳']);
    expect(expandPeople(db, '总经办').people.map((p) => p.name)).toEqual(['李娜']);
  });
  it('岗位标签 → 所有该岗位的人', () => {
    const e = expandPeople(db, '所有设计师');
    expect(e.kind).toBe('tag');
    expect(e.people.map((p) => p.name)).toEqual(['刘洋', '陈静', '杨帆', '赵敏', '吴倩']);
    expect(expandPeople(db, '项目经理们').people).toHaveLength(4);
  });
  it('姓名 / 省略“部”字 / 未知', () => {
    expect(expandPeople(db, '刘洋').people.map((p) => p.id)).toEqual(['u004']);
    expect(expandPeople(db, '人工智能').people).toHaveLength(3);
    expect(expandPeople(db, '法务部')).toMatchObject({ kind: 'dept', people: [] });
    expect(expandPeople(db, '外星人事务部')).toMatchObject({ kind: 'unknown', people: [] });
  });
  it('查询归一化', () => {
    expect(normalizeQuery('通知所有设计师们')).toBe('设计师');
    expect(normalizeQuery('叫上人工智能部的同事')).toBe('人工智能部');
  });
});
