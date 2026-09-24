<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { api, sh, shIso } from '../api';
import { store } from '../store';
import MiniMap from '../components/MiniMap.vue';

const mode = ref<'day' | 'week'>('day');
const anchor = ref(sh(store.meta?.now ?? Date.now())); // 以下日期运算都在北京时间墙上时钟上做
const events = ref<any[]>([]);
const travel = ref<any[]>([]);
const loading = ref(false);
const mapOpen = ref<Record<string, boolean>>({});

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const p = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
const hm = (iso: string) => {
  const d = sh(iso);
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // 周一为起点
  s.setDate(s.getDate() - dow);
  return s;
};
const range = computed(() => {
  const from = mode.value === 'day' ? startOfDay(anchor.value) : startOfWeek(anchor.value);
  const to = new Date(from);
  to.setDate(to.getDate() + (mode.value === 'day' ? 1 : 7));
  return { from, to };
});
const days = computed(() => {
  const out: Date[] = [];
  for (let d = new Date(range.value.from); d < range.value.to; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
});
const todayKey = computed(() => dayKey(sh(store.meta?.now ?? Date.now())));
const title = computed(() => {
  const f = range.value.from;
  if (mode.value === 'day') return `${f.getMonth() + 1}月${f.getDate()}日 周${WD[f.getDay()]}`;
  const t = new Date(range.value.to);
  t.setDate(t.getDate() - 1);
  return `${f.getMonth() + 1}月${f.getDate()}日 – ${t.getMonth() + 1}月${t.getDate()}日`;
});

async function load() {
  loading.value = true;
  try {
    const q = `from=${encodeURIComponent(shIso(range.value.from))}&to=${encodeURIComponent(shIso(range.value.to))}`;
    const r = await api(`/events?${q}`);
    events.value = r.events;
    travel.value = r.travel;
  } finally {
    loading.value = false;
  }
}
function shift(n: number) {
  const d = new Date(anchor.value);
  d.setDate(d.getDate() + n * (mode.value === 'day' ? 1 : 7));
  anchor.value = d;
}
function goToday() {
  anchor.value = sh(store.meta?.now ?? Date.now());
}
const eventsOf = (d: Date) => events.value.filter((e) => dayKey(sh(e.start)) === dayKey(d));
const travelAfter = (id: string) => travel.value.find((t) => t.fromId === id);
const travelText = (t: any) => {
  if (!t) return '';
  if (t.travel.status === 'same_place') return '同一地点';
  if (t.travel.status === 'unverified') return `车程未核实（${t.travel.reason ?? '地图接口失败'}）`;
  return `驾车约 ${t.travel.minutes} 分钟 · 间隔 ${t.gapMin} 分钟${t.enough ? '' : ' · 赶不上！'}`;
};
const travelClass = (t: any) => (!t ? '' : t.travel.status === 'unverified' ? 'unverified' : t.enough === false ? 'tight' : '');
const navUrl = (loc: string) => `https://uri.amap.com/search?keyword=${encodeURIComponent(loc)}`;

watch([mode, anchor], load);
watch(() => store.refreshTick, load);
onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 12px">
      <h2 style="margin: 0">日程</h2>
      <div class="row" style="margin-left: 8px">
        <button class="btn sm" :class="{ primary: mode === 'day' }" @click="mode = 'day'">日</button>
        <button class="btn sm" :class="{ primary: mode === 'week' }" @click="mode = 'week'">周</button>
      </div>
      <div class="grow"></div>
      <button class="btn sm" @click="shift(-1)">‹</button>
      <strong>{{ title }}</strong>
      <button class="btn sm" @click="shift(1)">›</button>
      <button class="btn sm" @click="goToday">今天</button>
    </div>
    <div class="small muted" style="margin-bottom: 10px">相邻两场之间标出驾车时长；地图接口失败时显示“车程未核实”，不会假装算过。</div>

    <div v-if="mode === 'day'" class="card timeline">
      <div v-if="!eventsOf(days[0]).length" class="empty">这一天没有日程</div>
      <template v-for="e in eventsOf(days[0])" :key="e.id">
        <div class="event with-map" :class="[e.category, { open: mapOpen[e.id] }]">
          <div>
          <div class="row">
            <strong>{{ hm(e.start) }}–{{ hm(e.end) }}</strong>
            <span class="badge primary">{{ e.categoryLabel }}</span>
            <strong class="grow">{{ e.subject }}</strong>
            <span v-if="e.source === 'request'" class="badge ok">预约</span>
          </div>
          <div class="small">📍 {{ e.location }}<button type="button" class="map-toggle" :class="{ on: mapOpen[e.id] }" @click="mapOpen[e.id] = !mapOpen[e.id]">{{ mapOpen[e.id] ? '收起地图' : '🗺 看地图' }}</button></div>
          <div v-if="e.attendees.length" class="small muted">参与：{{ e.attendees.join('、') }}</div>
          <div v-if="e.note" class="small muted">备注：{{ e.note }}</div>
          </div>
          <MiniMap v-if="mapOpen[e.id]" :q="e.location" :nav-url="navUrl(e.location)" :height="180" />
        </div>
        <div v-if="travelAfter(e.id)" class="travel" :class="travelClass(travelAfter(e.id))">🚗 {{ travelText(travelAfter(e.id)) }}</div>
      </template>
    </div>

    <div v-else class="week-grid">
      <div v-for="d in days" :key="dayKey(d)" class="day-col" :class="{ today: dayKey(d) === todayKey }">
        <div class="day-head">{{ d.getMonth() + 1 }}/{{ d.getDate() }} 周{{ WD[d.getDay()] }}</div>
        <div v-if="!eventsOf(d).length" class="small muted">无</div>
        <template v-for="e in eventsOf(d)" :key="e.id">
          <div class="event" :class="e.category">
            <div><strong>{{ hm(e.start) }}–{{ hm(e.end) }}</strong> <span class="badge">{{ e.categoryLabel }}</span></div>
            <div>{{ e.subject }}</div>
            <div class="muted">📍 {{ e.location }}</div>
          </div>
          <div v-if="travelAfter(e.id)" class="travel" :class="travelClass(travelAfter(e.id))">🚗 {{ travelText(travelAfter(e.id)) }}</div>
        </template>
      </div>
    </div>
  </div>
</template>
