import { reactive, watch } from 'vue';

export interface User {
  id: string;
  name: string;
  dept: string;
  title: string;
  role: 'boss' | 'employee';
}
export interface Meta {
  now: string;
  nowOverridden: boolean;
  /** NOW_MODE=frozen：时间停在 NOW 不走 */
  nowFrozen?: boolean;
  tz: string;
  llm: string;
  llmModel: string | null;
  map: string;
  mapSimulateFailure: boolean;
}
export interface ToastItem {
  id: string;
  title: string;
  type: string;
  payload: any;
  createdAt: number;
}

const savedUser = (() => {
  try {
    return localStorage.getItem('userId') ?? '';
  } catch {
    return '';
  }
})();

export const store = reactive({
  userId: savedUser,
  users: [] as User[],
  meta: null as Meta | null,
  unread: 0,
  /** 任何列表数据需要刷新时 +1（SSE refresh 事件驱动） */
  refreshTick: 0,
  toasts: [] as ToastItem[],
  streamState: 'idle' as 'idle' | 'open' | 'error',
  get user(): User | undefined {
    return this.users.find((u) => u.id === this.userId);
  },
  get isBoss(): boolean {
    return this.user?.role === 'boss';
  },
});

watch(
  () => store.userId,
  (id) => {
    try {
      localStorage.setItem('userId', id);
    } catch {
      /* ignore */
    }
    store.toasts = []; // 弹窗属于上一个用户，换人就清掉
    connectStream();
  },
);

let es: EventSource | null = null;
export function connectStream() {
  es?.close();
  es = null;
  store.streamState = 'idle';
  if (!store.userId) return;
  const src = new EventSource(`/api/stream?user=${encodeURIComponent(store.userId)}`);
  es = src;
  src.addEventListener('hello', () => {
    store.streamState = 'open';
  });
  src.addEventListener('notification', (e) => {
    const n = JSON.parse((e as MessageEvent).data);
    store.toasts.unshift({ id: n.id, title: n.title, type: n.type, payload: n.body, createdAt: Date.now() });
    if (store.toasts.length > 5) store.toasts.length = 5;
    store.unread += 1;
    store.refreshTick += 1;
  });
  src.addEventListener('refresh', () => {
    store.refreshTick += 1;
  });
  src.onerror = () => {
    store.streamState = 'error'; // EventSource 会自动重连
  };
}

export function dismissToast(id: string) {
  store.toasts = store.toasts.filter((t) => t.id !== id);
}

export async function loadBootstrap() {
  const [users, meta] = await Promise.all([fetch('/api/users').then((r) => r.json()), fetch('/api/meta').then((r) => r.json())]);
  store.users = users;
  store.meta = meta;
  if (!store.userId || !store.users.some((u) => u.id === store.userId)) {
    store.userId = store.users.find((u) => u.role !== 'boss')?.id ?? store.users[0]?.id ?? '';
  } else {
    connectStream();
  }
}
