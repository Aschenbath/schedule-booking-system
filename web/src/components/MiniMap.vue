<script lang="ts">
// 地点 → 坐标 的结果在页面内共享，同一个地点只请求一次
const cache = new Map<string, Promise<Geo>>();
interface Geo {
  ok: boolean;
  address?: string;
  lng?: number;
  lat?: number;
  approximate?: boolean;
  reason?: string;
}
</script>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api';

/** 页面内小地图：高德瓦片（无需 key）+ 标记点，可拖动、缩放；不跳出当前页面。 */
const props = withDefaults(defineProps<{ q: string; navUrl?: string; height?: number }>(), { height: 220 });

const TILE = 256;
const geo = ref<Geo | null>(null);
const zoom = ref(15);
const width = ref(320);
const box = ref<HTMLElement | null>(null);
// 地图中心相对标记点的像素偏移（拖动产生）
const offset = ref({ x: 0, y: 0 });

function load() {
  const q = props.q?.trim();
  if (!q) return (geo.value = { ok: false, reason: '没有地点' });
  if (!cache.has(q)) cache.set(q, api(`/geocode?q=${encodeURIComponent(q)}`).catch((e: any) => ({ ok: false, reason: e.message })));
  geo.value = null;
  cache.get(q)!.then((g) => {
    if (!g.ok) cache.delete(q); // 失败不缓存，下次打开重试
    geo.value = g;
  });
}
watch(() => props.q, load);
onMounted(() => {
  load();
  if (box.value) width.value = box.value.clientWidth || 320;
});

function project(lng: number, lat: number, z: number) {
  const n = TILE * 2 ** z;
  const r = (lat * Math.PI) / 180;
  return { x: ((lng + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
const marker = computed(() => (geo.value?.ok ? project(geo.value.lng!, geo.value.lat!, zoom.value) : null));
// 视口左上角的世界像素坐标
const origin = computed(() => (marker.value ? { x: marker.value.x + offset.value.x - width.value / 2, y: marker.value.y + offset.value.y - props.height / 2 } : null));
const tiles = computed(() => {
  const o = origin.value;
  if (!o) return [];
  const max = 2 ** zoom.value;
  const out: Array<{ key: string; src: string; left: number; top: number }> = [];
  for (let tx = Math.floor(o.x / TILE); tx <= Math.floor((o.x + width.value) / TILE); tx++)
    for (let ty = Math.floor(o.y / TILE); ty <= Math.floor((o.y + props.height) / TILE); ty++) {
      if (ty < 0 || ty >= max) continue;
      const x = ((tx % max) + max) % max;
      const s = ((x + ty) % 4) + 1;
      out.push({ key: `${zoom.value}/${tx}/${ty}`, src: `https://webrd0${s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${ty}&z=${zoom.value}`, left: tx * TILE - o.x, top: ty * TILE - o.y });
    }
  return out;
});
const pin = computed(() => (marker.value && origin.value ? { left: marker.value.x - origin.value.x, top: marker.value.y - origin.value.y } : null));

function setZoom(z: number) {
  z = Math.max(4, Math.min(18, z));
  const k = 2 ** (z - zoom.value);
  offset.value = { x: offset.value.x * k, y: offset.value.y * k };
  zoom.value = z;
}
function recenter() {
  offset.value = { x: 0, y: 0 };
}

let drag: { x: number; y: number; ox: number; oy: number } | null = null;
function onDown(e: PointerEvent) {
  drag = { x: e.clientX, y: e.clientY, ox: offset.value.x, oy: offset.value.y };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onMove(e: PointerEvent) {
  if (!drag) return;
  offset.value = { x: drag.ox - (e.clientX - drag.x), y: drag.oy - (e.clientY - drag.y) };
}
function onUp() {
  drag = null;
}
function onWheel(e: WheelEvent) {
  setZoom(zoom.value + (e.deltaY < 0 ? 1 : -1));
}
</script>

<template>
  <div class="minimap">
    <div ref="box" class="minimap-view" :style="{ height: height + 'px' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel.prevent="onWheel">
      <template v-if="geo?.ok">
        <img v-for="t in tiles" :key="t.key" class="minimap-tile" :src="t.src" :style="{ left: t.left + 'px', top: t.top + 'px' }" draggable="false" alt="" />
        <div v-if="pin" class="minimap-pin" :style="{ left: pin.left + 'px', top: pin.top + 'px' }" :title="geo.address"></div>
        <div class="minimap-ctrl" @pointerdown.stop>
          <button type="button" title="放大" @click="setZoom(zoom + 1)">+</button>
          <button type="button" title="缩小" @click="setZoom(zoom - 1)">−</button>
          <button type="button" title="回到地点" @click="recenter">◎</button>
        </div>
      </template>
      <div v-else-if="geo" class="minimap-msg small muted">地图暂时定位不到这个地点（{{ geo.reason }}）</div>
      <div v-else class="minimap-msg small muted">地图加载中…</div>
    </div>
    <div class="minimap-foot small muted">
      <span class="grow">{{ geo?.address || q }}<template v-if="geo?.ok && geo.approximate"> · 模拟坐标，仅示意</template></span>
      <a v-if="navUrl" :href="navUrl" target="_blank" rel="noopener">高德导航 ↗</a>
    </div>
  </div>
</template>
