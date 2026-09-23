import { openDb, getSetting, type DB } from '../src/db';
import { seedIfEmpty } from '../src/seed';
import { clock } from '../src/clock';
import { MockMapService, type MapService } from '../src/map';
import { RulesLlm } from '../src/llm/rules';
import { Agent, type Card } from '../src/agent/agent';
import { Hub } from '../src/services/notifications';
import type { AppContext } from '../src/context';
import type { Draft } from '../src/agent/schema';

export const NOW = '2026-09-23T09:00:00'; // 周三

export interface TestEnv {
  ctx: AppContext;
  db: DB;
  hub: Hub;
  agent: Agent;
}

/** 内存数据库 + 种子数据 + 离线规则模型 + 模拟地图；不联网 */
export function makeEnv(opts: { map?: MapService; now?: string } = {}): TestEnv {
  clock.configure(opts.now ?? NOW, 'frozen');
  const db = openDb(':memory:');
  seedIfEmpty(db);
  const map =
    opts.map ??
    new MockMapService({
      places: () => db.prepare('SELECT name, address, lng, lat FROM places').all() as any,
      shouldFail: () => getSetting(db, 'map_simulate_failure', '0') === '1',
    });
  const ctx: AppContext = { db, map, llm: new RulesLlm({ chunkDelayMs: 0 }) };
  const hub = new Hub();
  const agent = new Agent(ctx, hub);
  return { ctx, db, hub, agent };
}

export interface TurnResult {
  content: string;
  draft: Draft;
  cards: Card[];
}

/** 发一句话，收齐流式输出与最终状态 */
export async function chat(agent: Agent, convId: string, text: string): Promise<TurnResult> {
  let content = '';
  let draft: Draft | undefined;
  let cards: Card[] = [];
  for await (const ev of agent.handleMessage(convId, text)) {
    if (ev.type === 'delta') content += ev.text;
    if (ev.type === 'state') {
      draft = ev.draft;
      cards = ev.cards;
      if (ev.content !== content) throw new Error('流式内容与落库内容不一致');
    }
  }
  if (!draft) throw new Error('没有收到 state 事件');
  return { content, draft, cards };
}

export const card = <T extends Card['type']>(cards: Card[], type: T) => cards.find((c) => c.type === type) as Extract<Card, { type: T }> | undefined;
