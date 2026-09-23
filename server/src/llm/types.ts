import type { Dayjs } from '../clock';
import type { Draft, Category, ExpansionSummary, FieldKey } from '../agent/schema';
import type { Analysis } from '../agent/schedule';

export interface Directory {
  departments: string[];
  tags: string[];
  names: string[];
}
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ExtractInput {
  now: Dayjs;
  draft: Draft;
  pendingFields: FieldKey[];
  history: ChatTurn[];
  text: string;
  directory: Directory;
}

/** 模型（或规则）从一句话里抽取出来的“增量信息”，没提到的字段为 null/undefined */
export interface Extraction {
  category?: Category | 'unsure' | null;
  subject?: string | null;
  time_text?: string | null;
  start?: string | null;
  end?: string | null;
  location?: string | null;
  visitor?: string | null;
  counterpart?: string | null;
  headcount?: number | null;
  note?: string | null;
  people_queries?: string[] | null;
  remove_people?: string[] | null;
  intent?: 'submit' | 'cancel' | 'restart' | 'confirm_people' | null;
}

/** 代码算好的“事实”，交给模型只做措辞（或交给模板渲染） */
export interface ReplyFacts {
  userName: string;
  category: Category | null;
  categoryLabel: string | null;
  askCategory: boolean;
  collected: Array<{ label: string; value: string }>;
  questions: string[];
  people: {
    expansions: ExpansionSummary[];
    needsConfirm: boolean;
    emptyQueries: string[];
    confirmedNames: string[];
  };
  analysis?: Analysis | null;
  notes: string[];
  changed?: string[]; // 本轮改口后被替换的信息（时间/地点），回复要先复述
  ready: boolean;
  submitted?: { requestId: string; duplicate?: boolean } | null;
  cancelled?: boolean;
  restarted?: boolean;
}

export interface LlmClient {
  readonly mode: 'rules' | 'openai';
  extract(input: ExtractInput): Promise<Extraction>;
  streamReply(facts: ReplyFacts, history: ChatTurn[]): AsyncIterable<string>;
}
