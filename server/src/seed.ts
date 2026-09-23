import { DB, transaction, setSetting } from './db';
import { now, toIso } from './clock';

/** 通讯录：30 人，老板属于总经办 */
export const CONTACTS: Array<{ id: string; name: string; dept: string; title: string; role?: 'boss' }> = [
  { id: 'u001', name: '张伟', dept: '总经办', title: '总经理', role: 'boss' },
  { id: 'u002', name: '李娜', dept: '总经办', title: '总经理助理' },
  { id: 'u003', name: '王芳', dept: '设计部', title: '设计总监' },
  { id: 'u004', name: '刘洋', dept: '设计部', title: '设计师' },
  { id: 'u005', name: '陈静', dept: '设计部', title: '设计师' },
  { id: 'u006', name: '杨帆', dept: '设计部', title: '设计师' },
  { id: 'u007', name: '赵敏', dept: '设计部', title: '设计师' },
  { id: 'u008', name: '吴倩', dept: '设计部', title: '软装设计师' },
  { id: 'u009', name: '郑强', dept: '工程部', title: '工程总监' },
  { id: 'u010', name: '孙磊', dept: '工程部', title: '项目经理' },
  { id: 'u011', name: '马超', dept: '工程部', title: '项目经理' },
  { id: 'u012', name: '朱婷', dept: '工程部', title: '项目经理' },
  { id: 'u013', name: '胡军', dept: '工程部', title: '项目经理' },
  { id: 'u014', name: '林峰', dept: '工程部', title: '施工监理' },
  { id: 'u015', name: '何伟', dept: '工程部', title: '施工监理' },
  { id: 'u016', name: '郭涛', dept: '预结算部', title: '预结算员' },
  { id: 'u017', name: '高丽', dept: '预结算部', title: '预结算员' },
  { id: 'u018', name: '罗刚', dept: '预结算部', title: '预结算员' },
  { id: 'u019', name: '梁静', dept: '市场部', title: '市场总监' },
  { id: 'u020', name: '宋佳', dept: '市场部', title: '销售顾问' },
  { id: 'u021', name: '唐宇', dept: '市场部', title: '销售顾问' },
  { id: 'u022', name: '许晴', dept: '市场部', title: '销售顾问' },
  { id: 'u023', name: '韩雪', dept: '人工智能部', title: '算法工程师' },
  { id: 'u024', name: '冯远', dept: '人工智能部', title: '算法工程师' },
  { id: 'u025', name: '曹阳', dept: '人工智能部', title: '产品经理' },
  { id: 'u026', name: '邓丽', dept: '财务部', title: '财务经理' },
  { id: 'u027', name: '彭飞', dept: '财务部', title: '会计' },
  { id: 'u028', name: '曾敏', dept: '人事行政部', title: '人事专员' },
  { id: 'u029', name: '谢东', dept: '人事行政部', title: '行政专员' },
  { id: 'u030', name: '董浩', dept: '采购部', title: '采购专员' },
];

/** 部门表：包含一个暂时没有人的“法务部”（用于验证空名单场景） */
export const DEPARTMENTS = ['总经办', '设计部', '工程部', '预结算部', '市场部', '人工智能部', '财务部', '人事行政部', '采购部', '法务部'];

/** 已知地点（广州），用于模拟地图服务 */
export const PLACES: Array<{ name: string; address: string; lng: number; lat: number }> = [
  { name: '公司', address: '广州市天河区珠江新城华穗路406号', lng: 113.3236, lat: 23.1206 },
  { name: '家', address: '广州市海珠区滨江东路500号', lng: 113.305, lat: 23.1 },
  { name: '番禺万博样板间', address: '广州市番禺区汉溪大道东380号万博中心', lng: 113.334, lat: 23.009 },
  { name: '黄埔科学城工地', address: '广州市黄埔区科学大道182号', lng: 113.446, lat: 23.165 },
  { name: '陶陶居北京路店', address: '广州市越秀区北京路', lng: 113.27, lat: 23.125 },
  { name: '广州塔', address: '广州市海珠区阅江西路222号', lng: 113.319, lat: 23.106 },
  { name: '白云国际会议中心', address: '广州市白云区白云大道南1039号', lng: 113.283, lat: 23.19 },
  { name: '佛山南海工厂', address: '佛山市南海区桂澜路', lng: 113.144, lat: 23.032 },
  { name: '天环广场', address: '广州市天河区天河路218号', lng: 113.318, lat: 23.136 },
  { name: '琶洲展馆', address: '广州市海珠区阅江中路380号', lng: 113.365, lat: 23.103 },
  { name: '南沙工地', address: '广州市南沙区进港大道', lng: 113.525, lat: 22.8 },
];

export const DEFAULT_SETTINGS: Record<string, string> = {
  company_address: '广州市天河区珠江新城华穗路406号',
  home_address: '广州市海珠区滨江东路500号',
  reminder_lead_minutes: '15',
  work_start: '09:00',
  work_end: '18:00',
  map_simulate_failure: '0',
};

interface SeedEvent {
  day: number;
  from: string;
  to: string;
  category: 'meeting' | 'reception' | 'dinner' | 'other';
  subject: string;
  location: string;
  attendees: string[]; // 姓名
  note?: string;
}

/** 老板未来两周已有日程（约 15 条，相对于 NOW 生成） */
const SEED_EVENTS: SeedEvent[] = [
  { day: 0, from: '10:00', to: '11:00', category: 'meeting', subject: '周经营例会', location: '公司', attendees: ['王芳', '郑强', '梁静', '邓丽'] },
  { day: 0, from: '15:00', to: '16:00', category: 'reception', subject: '建材供应商来访（3人）', location: '公司', attendees: ['董浩'], note: '看新款瓷砖样品' },
  { day: 1, from: '09:30', to: '10:30', category: 'meeting', subject: '设计方案评审：海珠别墅项目', location: '公司', attendees: ['王芳', '刘洋', '孙磊'] },
  { day: 1, from: '14:00', to: '15:30', category: 'reception', subject: '陪客户看样板间', location: '番禺万博样板间', attendees: ['宋佳'], note: '客户：周先生一家' },
  { day: 2, from: '12:00', to: '13:30', category: 'dinner', subject: '与银行客户经理午餐', location: '陶陶居北京路店', attendees: ['邓丽'], note: '4人' },
  { day: 2, from: '16:00', to: '17:00', category: 'meeting', subject: '预结算复核会', location: '公司', attendees: ['郭涛', '高丽', '罗刚'] },
  { day: 3, from: '09:00', to: '11:30', category: 'other', subject: '工地巡查', location: '黄埔科学城工地', attendees: ['郑强', '林峰'] },
  { day: 3, from: '14:30', to: '15:30', category: 'meeting', subject: '智能报价系统进展汇报', location: '公司', attendees: ['韩雪', '冯远', '曹阳'] },
  { day: 4, from: '10:00', to: '11:00', category: 'meeting', subject: '采购谈判：定制柜体', location: '公司', attendees: ['董浩', '郑强'] },
  { day: 4, from: '18:30', to: '20:30', category: 'dinner', subject: '老客户答谢晚宴', location: '广州塔', attendees: ['梁静', '李娜'], note: '8人，已订包间' },
  { day: 6, from: '09:00', to: '10:00', category: 'meeting', subject: '市场部月度复盘', location: '公司', attendees: ['梁静', '宋佳', '唐宇', '许晴'] },
  { day: 7, from: '14:00', to: '16:00', category: 'reception', subject: '设计院来访交流', location: '公司', attendees: ['王芳', '陈静'], note: '约6人' },
  { day: 8, from: '10:00', to: '12:00', category: 'other', subject: '行业协会论坛', location: '白云国际会议中心', attendees: ['李娜'] },
  { day: 10, from: '15:00', to: '16:00', category: 'meeting', subject: '财务季度分析', location: '公司', attendees: ['邓丽', '彭飞'] },
  { day: 12, from: '09:30', to: '11:30', category: 'other', subject: '佛山工厂考察', location: '佛山南海工厂', attendees: ['董浩', '马超'] },
];

export function seedIfEmpty(db: DB): boolean {
  const cnt = (db.prepare('SELECT COUNT(*) AS c FROM contacts').get() as { c: number }).c;
  if (cnt > 0) return false;
  const base = now();
  transaction(db, () => {
    const insC = db.prepare('INSERT INTO contacts(id, name, dept, title, role) VALUES (?, ?, ?, ?, ?)');
    for (const c of CONTACTS) insC.run(c.id, c.name, c.dept, c.title, c.role ?? 'employee');
    const insD = db.prepare('INSERT INTO departments(name) VALUES (?)');
    for (const d of DEPARTMENTS) insD.run(d);
    const insP = db.prepare('INSERT INTO places(name, address, lng, lat) VALUES (?, ?, ?, ?)');
    for (const p of PLACES) insP.run(p.name, p.address, p.lng, p.lat);
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setSetting(db, k, v);

    const boss = CONTACTS.find((c) => c.role === 'boss')!;
    const nameToId = new Map(CONTACTS.map((c) => [c.name, c.id]));
    const insE = db.prepare(
      'INSERT INTO events(id, request_id, category, subject, start, end, location, attendees, note, created_by, source, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    SEED_EVENTS.forEach((e, i) => {
      const day = base.startOf('day').add(e.day, 'day');
      const [sh, sm] = e.from.split(':').map(Number);
      const [eh, em] = e.to.split(':').map(Number);
      const start = day.hour(sh).minute(sm);
      const end = day.hour(eh).minute(em);
      const ids = e.attendees.map((n) => nameToId.get(n)).filter(Boolean);
      insE.run(`evt_seed_${String(i + 1).padStart(2, '0')}`, e.category, e.subject, toIso(start), toIso(end), e.location, JSON.stringify(ids), e.note ?? null, boss.id, 'seed', toIso(base));
    });
  });
  return true;
}
