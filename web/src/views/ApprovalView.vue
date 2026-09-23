<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import { store } from '../store';

const pending = ref<any[]>([]);
const history = ref<any[]>([]);
const showHistory = ref(false);
const error = ref('');
const editing = ref<Record<string, { start: string; end: string }>>({});

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toIso(local: string) {
  // datetime-local 无时区，按浏览器本地时间转 ISO；时区统一为 Asia/Shanghai
  const d = new Date(local);
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

async function load() {
  error.value = '';
  pending.value = await api('/requests?scope=pending');
  if (showHistory.value) history.value = (await api('/requests?scope=all')).filter((r: any) => r.status !== 'pending');
}
async function approve(r: any, reschedule = false) {
  try {
    const body: any = {};
    if (reschedule) {
      const e = editing.value[r.id];
      body.start = toIso(e.start);
      body.end = toIso(e.end);
    }
    await api(`/requests/${r.id}/approve`, { body });
    delete editing.value[r.id];
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function reject(r: any) {
  const reason = window.prompt('拒绝原因（可选）：', '') ?? undefined;
  if (reason === undefined) return;
  try {
    await api(`/requests/${r.id}/reject`, { body: { reason } });
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
function startEdit(r: any) {
  editing.value[r.id] = { start: toLocalInput(r.start), end: toLocalInput(r.end) };
}
const travelBadge = (s: string) => ({ ok: ['ok', '车程已核实'], tight: ['warn', '车程赶不上'], unverified: ['danger', '车程未核实'], none: ['', '前后无需赶路'] })[s] ?? ['', ''];
const statusLabel: Record<string, string> = { approved: '已同意', rejected: '已拒绝' };

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
    <div v-if="!pending.length" class="card empty">暂时没有待批准的请求</div>

    <div v-for="r in pending" :key="r.id" class="card" style="margin-bottom: 12px">
      <div class="row">
        <span class="badge primary">{{ r.categoryLabel }}</span>
        <strong class="grow" style="font-size: 16px">{{ r.subject }}</strong>
        <span v-if="r.analysis?.travelStatus" class="badge" :class="travelBadge(r.analysis.travelStatus)[0]">{{ travelBadge(r.analysis.travelStatus)[1] }}</span>
      </div>
      <div class="kv" style="margin-top: 8px">
        <span class="k">发起人</span><span>{{ r.requester?.name }}（{{ r.requester?.dept }}）</span>
        <span class="k">时间</span><span>{{ r.timeLabel }}</span>
        <span class="k">地点</span><span>{{ r.location || '（未填）' }}</span>
        <template v-if="r.visitor"><span class="k">来访方</span><span>{{ r.visitor }}</span></template>
        <template v-if="r.counterpart"><span class="k">对方</span><span>{{ r.counterpart }}</span></template>
        <template v-if="r.headcount"><span class="k">人数</span><span>{{ r.headcount }} 人</span></template>
        <span class="k">参与人</span><span>{{ r.attendees.length ? r.attendees.map((a: any) => a.name + '(' + a.dept + ')').join('、') : '无' }}</span>
        <template v-if="r.note"><span class="k">备注</span><span>{{ r.note }}</span></template>
      </div>

      <div v-if="r.analysis" style="margin-top: 8px">
        <div v-if="r.analysis.conflicts.length" class="alert danger small" style="margin-bottom: 6px">
          与已有日程重叠：<span v-for="c in r.analysis.conflicts" :key="c.id">「{{ c.subject }}」{{ fmtTime(c.start) }}–{{ fmtTime(c.end).slice(-5) }} @{{ c.location }}；</span>
        </div>
        <template v-for="nb in [r.analysis.before, r.analysis.after].filter(Boolean)" :key="nb.eventId">
          <div v-if="nb.travel.status === 'unverified'" class="alert danger small" style="margin-bottom: 6px">⚠ 车程未核实：与「{{ nb.subject }}」（{{ nb.location }}）之间的驾车时长未能获取，请自行判断是否赶得上。</div>
          <div v-else-if="nb.enough === false" class="alert warn small" style="margin-bottom: 6px">车程赶不上：「{{ nb.subject }}」在 {{ nb.location }}，驾车约 {{ nb.travel.minutes }} 分钟，间隔只有 {{ nb.gapMin }} 分钟{{ nb.suggestStart ? '，建议改到 ' + fmtTime(nb.suggestStart) : '' }}</div>
          <div v-else-if="nb.travel.status === 'ok'" class="small muted" style="margin-bottom: 6px">与「{{ nb.subject }}」之间驾车约 {{ nb.travel.minutes }} 分钟，间隔 {{ nb.gapMin }} 分钟，够用。</div>
        </template>
      </div>

      <div v-if="editing[r.id]" class="row" style="margin-top: 10px">
        <input type="datetime-local" class="input" style="width: auto" v-model="editing[r.id].start" />
        <span>至</span>
        <input type="datetime-local" class="input" style="width: auto" v-model="editing[r.id].end" />
        <button class="btn ok" :disabled="!store.isBoss" @click="approve(r, true)">按新时间同意</button>
        <button class="btn" @click="delete editing[r.id]">取消</button>
      </div>
      <div v-else class="row" style="margin-top: 10px">
        <button class="btn ok" :disabled="!store.isBoss" @click="approve(r)">同意</button>
        <button class="btn" :disabled="!store.isBoss" @click="startEdit(r)">改时间后同意</button>
        <button class="btn danger" :disabled="!store.isBoss" @click="reject(r)">拒绝</button>
        <span class="small muted">提交于 {{ fmtTime(r.created_at) }}</span>
      </div>
    </div>

    <template v-if="showHistory">
      <h3 style="margin-top: 20px">已处理</h3>
      <div v-if="!history.length" class="card empty">暂无</div>
      <div v-for="r in history" :key="r.id" class="card" style="margin-bottom: 8px">
        <div class="row">
          <span class="badge" :class="r.status === 'approved' ? 'ok' : 'danger'">{{ statusLabel[r.status] }}</span>
          <strong class="grow">{{ r.subject }}</strong>
          <span class="small muted">{{ r.requester?.name }} · {{ r.timeLabel }}</span>
        </div>
        <div v-if="r.decision_note" class="small muted">{{ r.decision_note }}</div>
        <div v-if="r.status === 'approved' && r.final_start !== r.start" class="small" style="color: var(--warn)">已改为 {{ fmtTime(r.final_start) }}</div>
      </div>
    </template>
  </div>
</template>
