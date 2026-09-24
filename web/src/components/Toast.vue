<script setup lang="ts">
import { ref } from 'vue';
import { store, dismissToast } from '../store';
import MiniMap from './MiniMap.vue';

function lines(t: { type: string; payload: any }): string[] {
  const p = t.payload ?? {};
  if (t.type === 'reminder' || t.type === 'invite') {
    return [
      `${p.category ?? ''} · ${p.time ?? ''}`,
      p.location ? `地点：${p.location}` : '',
      p.attendees?.length ? `参与：${p.attendees.join('、')}` : '',
      p.note ? `备注：${p.note}` : '',
    ].filter(Boolean);
  }
  if (t.type === 'request_new') return [`${p.requester ?? ''} 发起 · ${p.category ?? ''} · ${p.time ?? ''}`, p.location ? `地点：${p.location}` : '', p.travelStatus === 'unverified' ? '⚠ 车程未核实' : ''].filter(Boolean);
  if (t.type === 'request_result') return [p.time ? `${p.time}` : '', p.reason ? `原因：${p.reason}` : ''].filter(Boolean);
  if (t.type === 'request_withdrawn') return [`${p.requester ?? ''} 撤回了预约 · ${p.category ?? ''} · ${p.time ?? ''}`];
  return [];
}
const mapOpen = ref<Record<string, boolean>>({});
</script>

<template>
  <div class="toasts">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">
      <div class="row">
        <strong class="grow">{{ t.title }}</strong>
        <button class="btn sm" @click="dismissToast(t.id)">关闭</button>
      </div>
      <div v-for="(l, i) in lines(t)" :key="i" class="small">{{ l }}</div>
      <div v-if="t.payload?.location && t.type !== 'request_withdrawn'" class="small" style="margin-top: 6px">
        <a v-if="t.payload.navUrl" class="nav-link" :href="t.payload.navUrl" target="_blank" rel="noopener">📍 导航去{{ t.payload.location }}</a>
        <button type="button" class="map-toggle" :class="{ on: mapOpen[t.id] }" @click="mapOpen[t.id] = !mapOpen[t.id]">{{ mapOpen[t.id] ? '收起地图' : '🗺 看地图' }}</button>
      </div>
      <MiniMap v-if="mapOpen[t.id] && t.payload?.location" style="margin-top: 6px" :q="t.payload.address || t.payload.location" :nav-url="t.payload.navUrl" :height="160" />
      <div class="small muted" style="margin-top: 4px"><router-link to="/notifications">去提醒中心查看</router-link></div>
    </div>
  </div>
</template>
