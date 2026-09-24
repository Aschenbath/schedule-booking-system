<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue';
import { api, fmtTime, sh } from '../api';
import { store } from '../store';
import MiniMap from '../components/MiniMap.vue';

const pending = ref<any[]>([]);
const history = ref<any[]>([]);
const showHistory = ref(false);
const error = ref('');
const editing = ref<Record<string, { start: string; end: string }>>({});
const rejecting = ref<Record<string, string>>({});
const busyId = ref('');
const mapOpen = ref<Record<string, boolean>>({});
const toast = ref('');
let toastTimer: any;
function flash(t: string) {
  toast.value = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 2500);
}

function toLocalInput(iso: string) {
  const d = sh(iso); // 输入框里显示北京时间
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toIso(local: string) {
  // datetime-local 没有时区，里面填的就是北京时间
  return `${local.slice(0, 16)}:00+08:00`;
}

async function load() {
  error.value = '';
  pending.value = await api('/requests?scope=pending');
  if (showHistory.value) history.value = (await api('/requests?scope=all')).filter((r: any) => r.status !== 'pending');
}
async function approve(r: any, reschedule = false) {
  if (busyId.value) return;
  error.value = '';
  busyId.value = r.id;
  try {
    const body: any = {};
    if (reschedule) {
      const e = editing.value[r.id];
      if (!e.start || !e.end || new Date(toIso(e.end)) <= new Date(toIso(e.start))) throw new Error('结束时间必须晚于开始时间');
      body.start = toIso(e.start);
      body.end = toIso(e.end);
    }
    await api(`/requests/${r.id}/approve`, { body });
    delete editing.value[r.id];
    flash(`已同意「${r.subject}」，已通知发起人${r.attendees?.length ? '和参与人' : '（没有其他参与人）'}`);
    await load();
  } catch (e: any) {
    if (e.status === 409) await load().catch(() => {}); // 员工刚撤回 / 已经处理过：先刷掉过期的卡片
    error.value = e.message;
  } finally {
    busyId.value = '';
  }
}
async function reject(r: any) {
  if (busyId.value) return;
  error.value = '';
  busyId.value = r.id;
  try {
    await api(`/requests/${r.id}/reject`, { body: { reason: rejecting.value[r.id]?.trim() || undefined } });
    delete rejecting.value[r.id];
    flash(`已拒绝「${r.subject}」，已通知发起人`);
    await load();
  } catch (e: any) {
    if (e.status === 409) await load().catch(() => {});
    error.value = e.message;
  } finally {
    busyId.value = '';
  }
}
function startEdit(r: any) {
  delete rejecting.value[r.id];
  editing.value[r.id] = { start: toLocalInput(r.start), end: toLocalInput(r.end) };
}
function startReject(r: any) {
  delete editing.value[r.id];
  rejecting.value[r.id] = '';
  nextTick(() => (document.getElementById(`reject-${r.id}`) as HTMLInputElement | null)?.focus());
}
/** 改开始时间时保持原时长，结束时间跟着走 */
function onStartChange(r: any) {
  const e = editing.value[r.id];
  const dur = new Date(r.end).getTime() - new Date(r.start).getTime();
  if (e?.start) e.end = toLocalInput(new Date(new Date(toIso(e.start)).getTime() + dur).toISOString());
}
const travelBadge = (s: string) => ({ ok: ['ok', '车程已核实'], tight: ['warn', '车程赶不上'], unverified: ['danger', '车程未核实'], none: ['', '前后无需赶路'] })[s] ?? ['', ''];
const statusLabel: Record<string, string> = { approved: '已同意', rejected: '已拒绝', withdrawn: '已撤回' };
const statusClass: Record<string, string> = { approved: 'ok', rejected: 'danger', withdrawn: '' };

watch(() => store.refreshTick, load);
watch(showHistory, load);
onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 12px">
      <h2 class="grow" style="margin: 0">待批准（{{ pending.length }}）</h2>
      <label class="small"><input type="checkbox" v-model="showHistory" /> 显示已处理</label>
      <button class="btn sm" @click="load">刷新</button>
    </div>
    <div v-if="!store.isBoss" class="alert warn" style="margin-bottom: 12px">当前用户不是老板，只能查看，不能审批。请在右上角切换到张伟（老板）。</div>
    <div v-if="error" class="alert danger" style="margin-bottom: 12px">{{ error }}</div>
    <div v-if="toast" class="alert ok" style="margin-bottom: 12px">{{ toast }}</div>
    <div v-if="!pending.length" class="card empty">暂时没有待批准的请求</div>

    <div v-for="r in pending" :key="r.id" class="card" style="margin-bottom: 12px">
      <div class="row">
        <span class="badge primary">{{ r.categoryLabel }}</span>
        <strong class="grow" style="font-size: 16px">{{ r.subject }}</strong>
        <span v-if="r.analysis?.conflicts?.length" class="badge danger">时间冲突</span>
        <span v-else-if="r.analysis?.travelStatus" class="badge" :class="travelBadge(r.analysis.travelStatus)[0]">{{ travelBadge(r.analysis.travelStatus)[1] }}</span>
      </div>
      <div class="with-map" :class="{ open: mapOpen[r.id] && r.location }" style="margin-top: 8px">
      <div class="kv">
        <span class="k">发起人</span><span>{{ r.requester?.name }}（{{ r.requester?.dept }}）</span>
        <span class="k">时间</span><span>{{ r.timeLabel }}</span>
        <span class="k">地点</span><span>{{ r.location || '（未填）' }}<button v-if="r.location" type="button" class="map-toggle" :class="{ on: mapOpen[r.id] }" @click="mapOpen[r.id] = !mapOpen[r.id]">{{ mapOpen[r.id] ? '收起地图' : '🗺 看地图' }}</button></span>
        <template v-if="r.visitor"><span class="k">来访方</span><span>{{ r.visitor }}</span></template>
        <template v-if="r.counterpart"><span class="k">对方</span><span>{{ r.counterpart }}</span></template>
        <template v-if="r.headcount"><span class="k">人数</span><span>{{ r.headcount }} 人</span></template>
        <span class="k">参与人</span><span>{{ r.attendees.length ? r.attendees.map((a: any) => a.name + '(' + a.dept + ')').join('、') : '无' }}</span>
        <template v-if="r.note"><span class="k">备注</span><span>{{ r.note }}</span></template>
      </div>
      <MiniMap v-if="mapOpen[r.id] && r.location" :q="r.location" />
      </div>

      <div v-if="r.analysis" style="margin-top: 8px">
        <div v-if="r.analysis.conflicts.length" class="alert danger small" style="margin-bottom: 6px">
          与已有日程重叠：<span v-for="c in r.analysis.conflicts" :key="c.id">「{{ c.subject }}」{{ fmtTime(c.start) }}–{{ fmtTime(c.end).slice(-5) }} @{{ c.location }}；</span>
        </div>
        <template v-for="nb in [r.analysis.before, r.analysis.after].filter(Boolean)" :key="nb.eventId">
          <div v-if="nb.travel.status === 'unverified'" class="alert danger small" style="margin-bottom: 6px">⚠ 车程未核实：与「{{ nb.subject }}」（{{ nb.location }}）之间的驾车时长未能获取，请自行判断是否赶得上。</div>
          <div v-else-if="nb.enough === false" class="alert warn small" style="margin-bottom: 6px">车程赶不上：「{{ nb.subject }}」在 {{ nb.location }}，驾车约 {{ nb.travel.minutes }} 分钟，间隔只有 {{ nb.gapMin }} 分钟{{ nb.suggestStart ? (nb.side === 'after' ? '，建议提前到 ' + fmtTime(nb.suggestStart) + ' 或更早' : '，建议改到 ' + fmtTime(nb.suggestStart) + ' 或之后') : '' }}</div>
          <div v-else-if="nb.travel.status === 'ok'" class="small muted" style="margin-bottom: 6px">与「{{ nb.subject }}」之间驾车约 {{ nb.travel.minutes }} 分钟，间隔 {{ nb.gapMin }} 分钟，够用。</div>
        </template>
      </div>

      <div v-if="editing[r.id]" class="row" style="margin-top: 10px">
        <input type="datetime-local" class="input" style="width: auto" v-model="editing[r.id].start" @change="onStartChange(r)" />
        <span>至</span>
        <input type="datetime-local" class="input" style="width: auto" v-model="editing[r.id].end" />
        <button class="btn ok" :disabled="!store.isBoss || busyId === r.id" @click="approve(r, true)">{{ busyId === r.id ? '处理中…' : '按新时间同意' }}</button>
        <button class="btn" @click="delete editing[r.id]">取消</button>
      </div>
      <div v-else-if="rejecting[r.id] !== undefined" class="reject-box">
        <input :id="`reject-${r.id}`" class="input grow" v-model="rejecting[r.id]" placeholder="拒绝原因（可选，会告诉发起人）" @keydown.enter="!$event.isComposing && reject(r)" @keydown.esc="delete rejecting[r.id]" />
        <button class="btn danger" :disabled="busyId === r.id" @click="reject(r)">{{ busyId === r.id ? '处理中…' : '确认拒绝' }}</button>
        <button class="btn" @click="delete rejecting[r.id]">取消</button>
      </div>
      <div v-else class="row" style="margin-top: 10px">
        <button class="btn ok" :disabled="!store.isBoss || busyId === r.id" @click="approve(r)">{{ busyId === r.id ? '处理中…' : '同意' }}</button>
        <button class="btn" :disabled="!store.isBoss" @click="startEdit(r)">改时间后同意</button>
        <button class="btn danger" :disabled="!store.isBoss" @click="startReject(r)">拒绝</button>
        <span class="small muted">提交于 {{ fmtTime(r.created_at) }}</span>
      </div>
    </div>

    <template v-if="showHistory">
      <h3 style="margin-top: 20px">已处理</h3>
      <div v-if="!history.length" class="card empty">暂无</div>
      <div v-for="r in history" :key="r.id" class="card" style="margin-bottom: 8px">
        <div class="row">
          <span class="badge" :class="statusClass[r.status]">{{ statusLabel[r.status] ?? r.status }}</span>
          <strong class="grow">{{ r.subject }}</strong>
          <span class="small muted">{{ r.requester?.name }} · {{ r.timeLabel }}</span>
        </div>
        <div v-if="r.decision_note" class="small muted">{{ r.decision_note }}</div>
        <div v-if="r.status === 'approved' && r.final_start !== r.start" class="small" style="color: var(--warn)">已改为 {{ fmtTime(r.final_start) }}</div>
      </div>
    </template>
  </div>
</template>
