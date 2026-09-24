<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { api, apiStream, fmtTime } from '../api';
import { store } from '../store';

interface Card {
  type: 'people_confirm' | 'analysis' | 'summary' | 'submitted';
  [k: string]: any;
}
interface Msg {
  id: number | string;
  role: 'user' | 'assistant';
  content: string;
  cards: Card[];
  streaming?: boolean;
}

const conversations = ref<any[]>([]);
const activeId = ref<string>('');
const messages = ref<Msg[]>([]);
const draft = ref<any>(null);
const input = ref('');
const sending = ref(false);
const error = ref('');
const requests = ref<any[]>([]);
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);
const lastSent = ref('');
const busy = ref(false);
const selected = ref<Record<string, boolean>>({});
// 预约对话只给员工用：员工向老板申请时间，语气是“想约/想请”，不是给别人下指令
const bossTitle = computed(() => {
  const b = store.users.find((u) => u.role === 'boss');
  return b ? `${b.name.slice(0, 1)}总` : '老板';
});
const examples = computed(() => [
  `想约${bossTitle.value}明天下午3点在公司开个会，汇报海珠别墅的设计方案，设计部同事一起参加`,
  `周五上午10点碧桂园的王总来公司拜访谈合作，想请${bossTitle.value}一起接待，对方大概4个人`,
  `想请${bossTitle.value}下周一晚上7点和万科李总吃饭，地点天河正佳`,
]);
const placeholder = computed(() => `说说想约${bossTitle.value}做什么，例如：想约${bossTitle.value}明天下午3点在公司开会，汇报海珠别墅方案`);
const activeConv = computed(() => conversations.value.find((c) => c.id === activeId.value));

async function loadConversations(selectFirst = true) {
  conversations.value = await api('/conversations');
  if (selectFirst && !activeId.value && conversations.value.length) await openConversation(conversations.value[0].id);
}
async function loadRequests() {
  requests.value = await api('/requests?scope=mine');
}
async function openConversation(id: string) {
  if (sending.value) return;
  activeId.value = id;
  error.value = '';
  const conv = await api(`/conversations/${id}`);
  messages.value = conv.messages;
  draft.value = conv.draft;
  syncSelected();
  scrollDown();
  focusInput();
}
async function newConversation() {
  if (sending.value) return;
  const conv = await api('/conversations', { body: {} });
  await loadConversations(false);
  await openConversation(conv.id);
  messages.value = [
    { id: 'hello', role: 'assistant', content: `你好${store.user?.name ? '，' + store.user.name : ''}！我是预约小助手，帮你约${bossTitle.value}的时间。想找${bossTitle.value}做什么、什么时候、在哪、有谁参加，直接说就行；我会帮你查${bossTitle.value}的日程冲突和路上车程，整理好后提交给${bossTitle.value}批准。`, cards: [] },
  ];
}
function autoGrow() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}
function focusInput() {
  nextTick(() => {
    inputEl.value?.focus();
    autoGrow();
  });
}
watch(input, () => nextTick(autoGrow));
function scrollDown() {
  nextTick(() => {
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  });
}
function syncSelected() {
  const ids: string[] = draft.value?.attendees?.ids ?? [];
  const m: Record<string, boolean> = {};
  for (const id of ids) m[id] = true;
  selected.value = m;
}

async function send(textOverride?: string) {
  const text = (textOverride ?? input.value).trim();
  if (!text || sending.value) return;
  if (!activeId.value) await newConversation();
  input.value = '';
  lastSent.value = text;
  error.value = '';
  sending.value = true;
  messages.value = messages.value.filter((m) => m.id !== 'hello');
  messages.value.push({ id: `u-${Date.now()}`, role: 'user', content: text, cards: [] });
  const reply: Msg = { id: `a-${Date.now()}`, role: 'assistant', content: '', cards: [], streaming: true };
  messages.value.push(reply);
  scrollDown();
  try {
    await apiStream(`/conversations/${activeId.value}/messages`, { text }, (event, data) => {
      if (event === 'delta') {
        reply.content += data.text;
        scrollDown();
      } else if (event === 'state') {
        if (typeof data.content === 'string' && data.content) reply.content = data.content; // 以服务端落库的为准（流中断时会整条替换）
        reply.cards = data.cards;
        reply.id = data.messageId;
        draft.value = data.draft;
        syncSelected();
      } else if (event === 'error') {
        error.value = data.message;
      }
    });
  } catch (e: any) {
    error.value = e.message ?? String(e);
  } finally {
    reply.streaming = false;
    sending.value = false;
    if (!reply.content && !reply.cards.length) messages.value = messages.value.filter((m) => m !== reply);
    scrollDown();
    focusInput();
    loadConversations(false);
    loadRequests();
  }
}

function retry() {
  const last = [...messages.value].reverse().find((m) => m.role === 'user');
  if (last) messages.value = messages.value.filter((m) => m !== last);
  send(lastSent.value);
}
async function confirmPeople(card: Card) {
  if (busy.value) return;
  const ids = Object.entries(selected.value)
    .filter(([, v]) => v)
    .map(([k]) => k);
  busy.value = true;
  error.value = '';
  try {
    const r = await api(`/conversations/${activeId.value}/people/confirm`, { body: { ids } });
    card.confirmed = true;
    messages.value.push({ id: r.messageId, role: 'assistant', content: r.content, cards: r.cards });
    draft.value = r.draft;
    scrollDown();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
    focusInput();
  }
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const r = await api(`/conversations/${activeId.value}/submit`, { body: {} });
    messages.value.push({ id: r.messageId, role: 'assistant', content: r.content, cards: r.cards });
    draft.value = r.draft;
    scrollDown();
    loadRequests();
    loadConversations(false);
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function pickSuggestion(label: string) {
  send(`改到${label.replace(/（.*?）/g, '')}`);
}
function peopleOf(card: Card) {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string; query: string }> = [];
  for (const e of card.expansions) for (let i = 0; i < e.ids.length; i++) if (!seen.has(e.ids[i])) (seen.add(e.ids[i]), out.push({ id: e.ids[i], name: e.names[i], query: e.query }));
  return out;
}
const isLast = (m: Msg) => messages.value[messages.value.length - 1] === m;
const statusLabel: Record<string, string> = { pending: '待批准', approved: '已同意', rejected: '已拒绝', withdrawn: '已撤回' };
const statusClass: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'danger', withdrawn: '' };
// 对话里的“已提交”卡片跟着请求的最新状态走：老板批了、拒了，或者员工撤回了，旧卡片也不会一直显示“等待批准”
const requestById = computed(() => new Map(requests.value.map((r) => [r.id, r])));
const reqStatus = (id: string): string => requestById.value.get(id)?.status ?? 'pending';
const travelLabel: Record<string, string> = { ok: '车程已核实', tight: '车程赶不上', unverified: '车程未核实', none: '' };

function onKey(e: KeyboardEvent) {
  // 中文输入法选词时的回车不发送（keyCode 229 兼容旧版 Safari）
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'ArrowUp' && !input.value && lastSent.value) {
    e.preventDefault();
    input.value = lastSent.value;
    nextTick(() => inputEl.value?.setSelectionRange(input.value.length, input.value.length));
  } else if (e.key === 'Escape' && input.value) {
    input.value = '';
  }
}

watch(
  () => store.refreshTick,
  () => loadRequests(),
);
onMounted(async () => {
  await Promise.all([loadConversations(), loadRequests()]);
  if (!conversations.value.length) await newConversation();
  focusInput();
});
</script>

<template>
  <div class="chat-layout">
    <aside class="card chat-side">
      <div class="row" style="margin-bottom: 8px">
        <strong class="grow">我的对话</strong>
        <button class="btn sm primary" @click="newConversation">新建预约</button>
      </div>
      <div v-for="c in conversations" :key="c.id" class="item" :class="{ active: c.id === activeId }" @click="openConversation(c.id)">
        <div class="t">{{ c.title }}</div>
        <div class="p">{{ c.preview || '（还没开始）' }}</div>
      </div>
    </aside>

    <section class="card chat-main">
      <div ref="listEl" class="messages">
        <div v-for="m in messages" :key="m.id" class="msg" :class="m.role">
          <div class="who">{{ m.role === 'user' ? store.user?.name ?? '我' : '预约小助手' }}</div>
          <div v-if="m.streaming && !m.content" class="bubble typing"><i /><i /><i /></div>
          <div v-else class="bubble" :class="{ cursor: m.streaming }">{{ m.content }}</div>
          <div v-if="m.cards?.length" class="cards">
            <template v-for="(card, ci) in m.cards" :key="ci">
              <div v-if="card.type === 'people_confirm'" class="subcard">
                <h4>通知名单（{{ card.confirmed ? '已确认' : '请核对' }}）</h4>
                <div v-for="e in card.expansions" :key="e.query" class="small muted">「{{ e.query }}」→ {{ e.names.length ? e.names.length + ' 人' : '没有找到任何人' }}</div>
                <div class="people-list" style="margin-top: 6px">
                  <label v-for="p in peopleOf(card)" :key="p.id">
                    <input type="checkbox" v-model="selected[p.id]" :disabled="card.confirmed || !isLast(m)" /> {{ p.name }}
                  </label>
                </div>
                <div v-if="!card.confirmed && isLast(m) && peopleOf(card).length" style="margin-top: 8px">
                  <button class="btn sm primary" :disabled="busy" @click="confirmPeople(card)">{{ busy ? '确认中…' : `确认名单（${Object.values(selected).filter(Boolean).length} 人）` }}</button>
                </div>
              </div>

              <div v-else-if="card.type === 'analysis'" class="subcard">
                <h4>冲突与车程</h4>
                <div v-if="card.analysis.conflicts.length" class="alert danger" style="margin-bottom: 6px">
                  与已有日程重叠：<span v-for="c in card.analysis.conflicts" :key="c.id">「{{ c.subject }}」{{ fmtTime(c.start) }}–{{ fmtTime(c.end).slice(-5) }} @{{ c.location }}；</span>
                </div>
                <template v-for="nb in [card.analysis.before, card.analysis.after].filter(Boolean)" :key="nb.eventId">
                  <div v-if="nb.travel.status === 'unverified'" class="alert danger small" style="margin-bottom: 6px">⚠ 车程未核实：与「{{ nb.subject }}」（{{ nb.location }}）之间的驾车时长未能获取（{{ nb.travel.reason }}）</div>
                  <div v-else-if="nb.enough === false" class="alert warn small" style="margin-bottom: 6px">时间上不冲突，但车程赶不上：「{{ nb.subject }}」在 {{ nb.location }}，驾车约 {{ nb.travel.minutes }} 分钟，间隔只有 {{ nb.gapMin }} 分钟</div>
                  <div v-else-if="nb.travel.status === 'ok'" class="alert ok small" style="margin-bottom: 6px">与「{{ nb.subject }}」之间驾车约 {{ nb.travel.minutes }} 分钟，时间够用</div>
                </template>
                <div v-if="card.analysis.suggestions.length">
                  <div class="small muted" style="margin-bottom: 4px">可用空档（点击直接改时间）：</div>
                  <div class="chips">
                    <button v-for="s in card.analysis.suggestions" :key="s.start" class="chip" :disabled="sending || !isLast(m)" @click="pickSuggestion(s.label)">{{ s.label }}</button>
                  </div>
                </div>
              </div>

              <div v-else-if="card.type === 'summary'" class="subcard">
                <h4>预约信息</h4>
                <div class="kv">
                  <template v-for="it in card.items" :key="it.label">
                    <span class="k">{{ it.label }}</span><span>{{ it.value }}</span>
                  </template>
                </div>
                <div v-if="card.canSubmit && isLast(m) && !draft?.submittedRequestId" style="margin-top: 8px">
                  <button class="btn sm primary" :disabled="sending || busy" @click="submit">{{ busy ? '提交中…' : draft?.replacesRequestId ? '撤回原请求并重新提交' : `提交给${bossTitle}批准` }}</button>
                </div>
              </div>

              <div v-else-if="card.type === 'submitted'" class="subcard">
                <span class="badge" :class="statusClass[reqStatus(card.requestId)]">{{ reqStatus(card.requestId) === 'pending' ? `已提交，等待${bossTitle}批准` : statusLabel[reqStatus(card.requestId)] }}</span> <span class="small muted">请求号 {{ card.requestId.slice(0, 8) }}</span>
              </div>
            </template>
          </div>
        </div>
        <div v-if="!sending && messages.length <= 1" class="examples">
          <div class="small muted">试试这样说：</div>
          <button v-for="ex in examples" :key="ex" class="chip" @click="send(ex)">{{ ex }}</button>
        </div>
      </div>
      <div v-if="error" class="alert danger small row">
        <span class="grow">{{ error }}</span>
        <button v-if="lastSent" class="btn sm" :disabled="sending" @click="retry">重试</button>
        <button class="btn sm" @click="error = ''">关闭</button>
      </div>
      <div class="composer">
        <textarea ref="inputEl" v-model="input" class="input" rows="1" :placeholder="placeholder" :readonly="sending" @keydown="onKey" />
        <button class="btn primary" :disabled="sending || !input.trim()" @click="send()">{{ sending ? '回复中…' : '发送' }}</button>
      </div>
      <div class="composer-hint small muted">Enter 发送 · Shift+Enter 换行 · ↑ 调出上一句 · Esc 清空</div>
    </section>

    <aside class="card chat-side req-list">
      <strong>我的请求</strong>
      <div v-if="!requests.length" class="empty small">还没有提交过请求</div>
      <div v-for="r in requests" :key="r.id" class="req">
        <div class="row">
          <span class="badge" :class="statusClass[r.status]">{{ statusLabel[r.status] }}</span>
          <strong class="grow">{{ r.subject }}</strong>
        </div>
        <div class="small muted">{{ r.categoryLabel }} · {{ r.timeLabel }}</div>
        <div class="small muted">{{ r.location }}<span v-if="r.analysis?.travelStatus && travelLabel[r.analysis.travelStatus]"> · {{ travelLabel[r.analysis.travelStatus] }}</span></div>
        <div v-if="r.status === 'approved' && r.final_start !== r.start" class="small" style="color: var(--warn)">{{ bossTitle }}改为 {{ fmtTime(r.final_start) }}</div>
        <div v-if="r.status === 'rejected' && r.decision_note" class="small muted">原因：{{ r.decision_note }}</div>
      </div>
    </aside>
  </div>
</template>
