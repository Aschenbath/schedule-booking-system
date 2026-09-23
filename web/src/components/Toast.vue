<script setup lang="ts">
import { store, dismissToast } from '../store';

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
  return [];
}
</script>

<template>
  <div class="toasts">
    <div v-for="t in store.toasts" :key="t.id" class="toast" :class="t.type">
      <div class="row">
        <strong class="grow">{{ t.title }}</strong>
        <button class="btn sm" @click="dismissToast(t.id)">关闭</button>
      </div>
      <div v-for="(l, i) in lines(t)" :key="i" class="small">{{ l }}</div>
      <div v-if="t.payload?.navUrl" class="small" style="margin-top: 6px">
        <a :href="t.payload.navUrl" target="_blank" rel="noopener">📍 打开地图导航</a>
      </div>
      <div class="small muted" style="margin-top: 4px"><router-link to="/notifications">去提醒中心查看</router-link></div>
    </div>
  </div>
</template>
