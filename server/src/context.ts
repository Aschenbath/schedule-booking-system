import type { DB } from './db';
import type { MapService } from './map';
import type { LlmClient } from './llm';

/** 运行时上下文：数据库、地图、大模型（都可在测试里替换） */
export interface AppContext {
  db: DB;
  map: MapService;
  llm: LlmClient;
}
