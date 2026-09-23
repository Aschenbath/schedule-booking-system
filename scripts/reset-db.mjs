#!/usr/bin/env node
// 删除本地 SQLite 数据库（含 WAL/SHM），下次启动会重新灌入种子数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = path.resolve(root, 'server', process.env.DB_PATH ?? './data/app.db');
let removed = 0;
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const f = dbPath + suffix;
  if (fs.existsSync(f)) {
    fs.rmSync(f);
    removed++;
    console.log('removed', path.relative(root, f));
  }
}
console.log(removed ? '数据库已清空，重新启动服务即可重新灌入种子数据。' : '没有找到数据库文件，无需清理。');
