import path from 'node:path';
import { serve } from '@hono/node-server';
import { config, ENV_FILE } from './config';
import { clock, now, toIso } from './clock';
import { openDb } from './db';
import { seedIfEmpty } from './seed';
import { createMapService } from './map';
import { createLlm } from './llm';
import { Agent } from './agent/agent';
import { Hub } from './services/notifications';
import { startReminderScheduler } from './services/reminders';
import { createApp } from './http/app';
import type { AppContext } from './context';

const serverRoot = path.resolve(import.meta.dirname, '..');

clock.configure(config.now || undefined, config.nowMode);
const dbPath = config.dbPath === ':memory:' ? ':memory:' : path.resolve(serverRoot, config.dbPath);
const db = openDb(dbPath);
const seeded = seedIfEmpty(db);

const ctx: AppContext = { db, map: createMapService(db, config.map.provider, config.map.amapKey), llm: createLlm() };
const hub = new Hub();
const agent = new Agent(ctx, hub);
const staticDir = path.resolve(serverRoot, '..', 'web', 'dist');
const app = createApp(ctx, hub, agent, { staticDir });

serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`
  日程预约系统 server
  ────────────────────────────────────────
  地址      : http://localhost:${info.port}   (前端开发模式请开 http://localhost:5173)
  当前时间  : ${toIso(now())}  ${clock.isOverridden() ? `(NOW 覆盖, ${config.nowMode} 模式)` : '(真实时间)'}
  大模型    : ${ctx.llm.mode}${ctx.llm.mode === 'openai' ? ` / ${config.llm.model} @ ${config.llm.baseUrl}` : '（离线规则模式，未配置 LLM_API_KEY）'}
  地图      : ${ctx.map.name}
  数据库    : ${dbPath}${seeded ? '  (已写入种子数据)' : ''}
  .env      : ${ENV_FILE ?? '未找到（使用默认值）'}
  `);
});

const stop = startReminderScheduler(ctx, hub, 5000);
process.on('SIGINT', () => {
  stop();
  db.close();
  process.exit(0);
});
