#!/usr/bin/env node
// 自动录制演示视频（Playwright recordVideo → .webm），同时截关键步骤的图。
// 走完整流程：员工约老板 → 确认名单 → 改时长 → 改时间 → 改地点 → 提交 → 老板看地图、批准 → 到点提醒 → 日程 → 参会人回复 → 员工看到结果。
//
// 不碰开发用的数据库：另起一个服务实例（独立端口 + 临时数据库 + 固定 NOW），录完就关。
// 大模型沿用 .env 里的配置（LLM_*），也可以在命令行临时覆盖。视频只保存在本地，不上传。
//
// 用法：
//   npm run record                          # 输出到 recordings/
//   HEADED=1 npm run record                 # 同时弹出浏览器窗口看着它走
//   RECORD_PORT=3100 RECORD_NOW=2026-09-23T09:41:00 npm run record
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.RECORD_PORT ?? 3100);
// 周三 09:43:20 开录：种子里当天 10:00 有「周经营例会」，提前 15 分钟提醒 → 09:45 到点，大约落在老板看后台设置的时候
const NOW = process.env.RECORD_NOW ?? '2026-09-23T09:43:20';
const OUT_DIR = path.resolve(root, process.env.RECORD_OUT ?? 'recordings');
const SHOT_DIR = path.resolve(root, process.env.RECORD_SHOTS ?? 'docs/screenshots');
const BASE = `http://localhost:${PORT}`;
const SIZE = { width: 1440, height: 900 };

const EMPLOYEE = { id: 'u004', name: '刘洋' };
const BOSS = { id: 'u001', name: '张伟' };
const ATTENDEE = { name: '郭涛' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[record ${new Date().toLocaleTimeString()}]`, ...a);

// ---------- 1. 构建前端 + 启动独立的服务实例 ----------
if (!process.env.SKIP_BUILD) {
  log('构建前端 …');
  execSync('npm run build -w web', { cwd: root, stdio: 'inherit' });
}
const tmpDb = path.join(os.tmpdir(), `schedule-record-${process.pid}.db`);
log(`启动录制用服务：${BASE}  NOW=${NOW}  数据库=${tmpDb}`);
const server = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/index.ts'], {
  cwd: path.join(root, 'server'),
  env: { ...process.env, PORT: String(PORT), DB_PATH: tmpDb, NOW, NOW_MODE: 'offset' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function cleanup() {
  if (server.exitCode === null) {
    server.kill();
    await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
  }
  for (const s of ['', '-wal', '-shm'])
    try {
      fs.rmSync(tmpDb + s, { force: true });
    } catch {}
}
process.on('exit', () => server.exitCode === null && server.kill());
process.on('SIGINT', () => process.exit(130));

async function waitServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/meta`);
      if (r.ok) return r.json();
    } catch {}
    if (server.exitCode !== null) throw new Error(`服务启动失败：\n${serverLog}`);
    await sleep(500);
  }
  throw new Error(`服务 60 秒内没起来：\n${serverLog}`);
}
const meta = await waitServer();
log(`服务就绪：llm=${meta.llm} model=${meta.llmModel ?? '-'} map=${meta.map} now=${meta.now}`);
if (meta.llm !== 'openai') log('⚠ 当前是离线规则模式（没有配置大模型），录出来的是规则版对话');

// ---------- 2. 浏览器 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const videoTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-video-'));
const browser = await chromium.launch({ headless: !process.env.HEADED });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoTmp, size: SIZE }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
const page = await context.newPage();
page.setDefaultTimeout(30_000);

let shotNo = 0;
async function shot(name) {
  shotNo++;
  const file = path.join(SHOT_DIR, `demo-${String(shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log('截图', path.relative(root, file));
}

// 画面底部的字幕条：让看录屏的人知道这一步在演示什么
async function caption(text) {
  log('▶', text);
  await page.evaluate((t) => {
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText =
        'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;max-width:80%;padding:10px 18px;border-radius:10px;background:rgba(17,24,39,.88);color:#fff;font:600 16px/1.5 system-ui,"Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await sleep(1500);
}

async function switchUser(name) {
  await page.locator('.up-trigger').click();
  await page.locator('.up-search input').fill(name);
  await sleep(400);
  await page.locator('.up-opt', { hasText: name }).first().click();
  await sleep(1200);
}

async function nav(label) {
  await page.locator('nav.nav a', { hasText: label }).first().click();
  await sleep(1200);
}

// 员工在输入框里打字、发送，等流式回复结束
async function say(text) {
  const box = page.locator('textarea.input');
  await box.click();
  await page.keyboard.type(text, { delay: 45 });
  await sleep(300);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('回复中…'), null, { timeout: 120_000 });
  await sleep(2500);
}

const t0 = Date.now();
try {
  // ---------- 员工：发起预约 ----------
  // 在页面脚本跑之前就写好当前用户（只写第一次，之后切换用户不受影响），避免和前端“默认选第一个员工”抢
  await context.addInitScript((id) => {
    if (!sessionStorage.getItem('__demo_init')) {
      localStorage.setItem('userId', id);
      sessionStorage.setItem('__demo_init', '1');
    }
  }, EMPLOYEE.id);
  await page.goto(`${BASE}/chat`);
  await page.waitForSelector('textarea.input');
  await caption(`① 员工「${EMPLOYEE.name}」打开预约对话（不用登录，右上角下拉切换用户）`);

  await caption('一句话说清：时间、地点、主题、要叫上的人');
  await say('想约张总明天下午4点在公司开个会，汇报海珠别墅的设计方案，叫上郭涛和人工智能部');
  await caption('小助手把「人工智能部」展开成具体的人让员工确认，并提示车程赶不上');
  await shot('employee-first-turn');

  const confirmBtn = page.locator('button', { hasText: /^确认名单（/ }).last();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    await page.waitForFunction(() => !document.body.innerText.includes('确认中…'));
    await sleep(2000);
    await caption('② 员工确认参会名单');
  }

  await caption('③ 中途改时长：只改结束时间，其它信息不丢');
  await say('内容比较多，大概要一个半小时');
  await shot('employee-duration');

  await caption('④ 改口换时间：只换时刻，主题、地点、名单都保留');
  await say('那改到5点吧');

  await caption('⑤ 改地点');
  await say('地点改到天河正佳');
  await shot('employee-ready');

  const submitBtn = page.locator('button', { hasText: /^提交给.*批准$/ }).last();
  await submitBtn.click();
  await page.waitForFunction(() => !document.body.innerText.includes('提交中…'));
  await sleep(2500);
  await caption('⑥ 提交：先生成「待批准」请求，老板同意后才写进日程');
  await shot('employee-submitted');

  // ---------- 老板：批准 ----------
  await caption(`⑦ 切换到老板「${BOSS.name}」`);
  await switchUser(BOSS.name);
  await nav('待批准');
  const card = page.locator('.card', { hasText: '海珠别墅' }).first();
  await card.waitFor();
  await card.scrollIntoViewIfNeeded();
  await caption('待批准卡片：发起人、时间、地点、参与人、车程核实结果');
  const mapBtn = card.locator('button.map-toggle').first();
  if (await mapBtn.isVisible().catch(() => false)) {
    await mapBtn.click();
    await caption('⑧ 地点旁边直接展开小地图，不用跳出去');
    await sleep(2500);
    await shot('boss-approval-map');
  }
  await card.getByRole('button', { name: '同意', exact: true }).click();
  await sleep(2500);
  await caption('⑨ 老板点「同意」：写入日程并通知参会人');
  await shot('boss-approved');

  // 新请求的弹窗演示过了，关掉，画面干净些
  for (const b of await page.locator('.toast button', { hasText: '关闭' }).all()) await b.click().catch(() => {});

  await nav('日程');
  await caption('⑩ 日程：日视图 / 周视图，相邻两场之间标出车程');
  await page.getByRole('button', { name: '›', exact: true }).click(); // 看明天：刚批准的那场
  await sleep(2500);
  await shot('boss-schedule-day');
  await page.getByRole('button', { name: '周', exact: true }).click();
  await sleep(2500);
  await shot('boss-schedule-week');

  // ---------- 到点提醒 ----------
  // 种子日程今天 10:00「周经营例会」，提前 15 分钟 → 09:45 到点。老板上线前就到点的话，会作为“错过的提醒”在上线时补弹一次
  await nav('后台设置');
  await caption('⑪ 后台设置：常用地址（公司、家）、提前多少分钟提醒');
  await shot('boss-settings');
  await caption('⑫ 到点提醒：老板开着页面时实时弹出');
  const toast = page.locator('.toast', { hasText: '周经营例会' }).first();
  try {
    await toast.waitFor({ timeout: 240_000 });
  } catch {
    log('⚠ 4 分钟内没有等到提醒弹窗，跳过这一步');
  }
  if (await toast.isVisible().catch(() => false)) {
    await caption('提醒里有类别、主题、起止时间、地点、参与人、备注');
    const tMap = toast.locator('button.map-toggle');
    if (await tMap.isVisible().catch(() => false)) {
      await tMap.click();
      await caption('地点一点就能展开地图，也可以跳高德导航');
      await sleep(1500);
    }
    await shot('boss-reminder-toast');
  }

  // 弹窗看完就关掉，免得挡住后面的操作
  for (const b of await page.locator('.toast button', { hasText: '关闭' }).all()) await b.click().catch(() => {});

  // ---------- 参会人：收到通知并回复 ----------
  await caption(`⑬ 切换到参会人「${ATTENDEE.name}」：提醒中心收到会议通知`);
  await switchUser(ATTENDEE.name);
  await nav('提醒中心');
  const notice = page.locator('.card', { hasText: '海珠别墅' }).first();
  await notice.waitFor();
  await notice.scrollIntoViewIfNeeded();
  await sleep(1500);
  await notice.getByRole('button', { name: '参会', exact: true }).click();
  await sleep(2000);
  await caption('回复「参会」');
  await shot('attendee-rsvp');

  // ---------- 员工：看到结果 ----------
  await caption(`⑭ 回到员工「${EMPLOYEE.name}」：请求状态变为已同意`);
  await switchUser(EMPLOYEE.name);
  await nav('预约对话');
  await sleep(2500); // 让“老板已同意”的弹窗先出现一会儿
  await shot('employee-result-toast');
  for (const b of await page.locator('.toast button', { hasText: '关闭' }).all()) await b.click().catch(() => {});
  await sleep(1500);
  await caption('右侧「我的请求」：状态已同意');
  await shot('employee-result');
  await caption('演示结束');
  await sleep(2000);
} catch (e) {
  console.error('录制中断：', e.message);
  await shot('error').catch(() => {});
  process.exitCode = 1;
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  if (video) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const dest = path.join(OUT_DIR, `demo-${stamp}.webm`);
    fs.copyFileSync(await video.path(), dest);
    fs.rmSync(videoTmp, { recursive: true, force: true });
    log(`视频：${path.relative(root, dest)}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
  }
  const warns = serverLog.split(/\r?\n/).filter((l) => /\[(llm|agent)\]/.test(l));
  log(warns.length ? `模型相关告警 ${warns.length} 条（这些回合走了备用渠道或离线兜底）：\n  ${warns.map((l) => l.slice(0, 160)).join('\n  ')}` : '全程模型调用正常，没有走离线兜底');
  await cleanup();
}
