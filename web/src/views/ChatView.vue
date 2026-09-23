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
const selected = ref<Record<string, boolean>>({});

const activeConv = computed(() => conversations.value.find((c) => c.id === activeId.value));

async function loadConversations(selectFirst = true) {
  conversations.value = await api('/conversations');
  if (selectFirst && !activeId.value && conversations.value.length) await openConversation(conversations.value[0].id);
}
async function loadRequests() {
  requests.value = await api('/requests?scope=mine');
}
async function openConversation(id: string) {
  activeId.value = id;
  const conv = await api(`/conversations/${id}`);
  messages.value = conv.messages;
  draft.value = conv.draft;
  syncSelected();
  scrollDown();
}
async function newConversation() {
  const conv = await api('/conversations', { body: {} });
  await loadConversations(false);
  await openConversation(conv.id);
  messages.value = [
    { id: 'hello', role: 'assistant', content: `你好${store.user?.name ? '，' + store.user.name : ''}！我是预约小助手。想约老板做什么？直接说，比如“明天下午3点在公司开会，讨论海珠别墅方案，叫上设计部”。`, cards: [] },
  ];
}
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
    scrollDown();
    loadConversations(false);
    loadRequests();
  }
}

async function confirmPeople(card: Card) {
  const ids = Object.entries(selected.value)
    .filter(([, v]) => v)
    .map(([k]) => k);
  const r = await api(`/conversations/${activeId.value}/people/confirm`, { body: { ids } });
  card.confirmed = true;
  messages.value.push({ id: r.messageId, role: 'assistant', content: r.content, cards: r.cards });
  draft.value = r.draft;
  scrollDown();
}
async function submit() {
  try {
    const r = await api(`/conversations/${activeId.value}/submit`, { body: {} });
    messages.value.push({ id: r.messageId, role: 'assistant', content: r.content, cards: r.cards });
    draft.value = r.draft;
    scrollDown();
    loadRequests();
    loadConversations(false);
  } catch (e: any) {
    error.value = e.message;
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
const statusLabel: Record<string, string> = { pending: '待批准', approved: '已同意', rejected: '已拒绝' };
const statusClass: Record<string, string> = { pending: 'warn', approved: 'ok', rejected: 'danger' };
const travelLabel: Record<string, string> = { ok: '车程已核实', tight: '车程赶不上', unverified: '车程未核实', none: '' };

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

watch(
  () => store.refreshTick,
  () => loadRequests(),
);
onMounted(async () => {
  await Promise.all([loadConversations(), loadRequests()]);
  if (!conversations.value.length) await newConversation();
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
          <div class="bubble" :class="{ cursor: m.streaming }">{{ m.content }}</div>
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
                  <button class="btn sm primary" @click="confirmPeople(card)">确认名单</button>
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
                  <button class="btn sm primary" :disabled="sending" @click="submit">提交给老板批准</button>
                </div>
              </div>

              <div v-else-if="card.type === 'submitted'" class="subcard">
                <span class="badge warn">已提交，等待老板批准</span> <span class="small muted">请求号 {{ card.requestId.slice(0, 8) }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
      <div v-if="error" class="alert danger small">{{ error }}</div>
      <div class="composer">
        <textarea v-model="input" class="input" rows="1" placeholder="例如：明天下午3点在公司开会，讨论海珠别墅方案，叫上设计部" :disabled="sending" @keydown="onKey" />
        <button class="btn primary" :disabled="sending || !input.trim()" @click="send()">{{ sending ? '回复中…' : '发送' }}</button>
      </div>
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
        <div v-if="r.status === 'approved' && r.final_start !== r.start" class="small" style="color: var(--warn)">老板改为 {{ fmtTime(r.final_start) }}</div>
        <div v-if="r.status === 'rejected' && r.decision_note" class="small muted">原因：{{ r.decision_note }}</div>
      </div>
    </aside>
  </div>
</template>
