<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api, fmtTime } from '../api';
import { store } from '../store';
import MiniMap from '../components/MiniMap.vue';

const items = ref<any[]>([]);
const busy = ref(false);
// 展开了小地图的通知 id
const mapOpen = ref<Record<string, boolean>>({});

async function load() {
  items.value = await api('/notifications');
  store.unread = 0;
  await api('/notifications/read-all', { body: {} }).catch(() => {});
}
async function reply(n: any, status: 'accepted' | 'declined') {
  busy.value = true;
  try {
    await api(`/notifications/${n.id}/rsvp`, { body: { status } });
    n.rsvp = status;
  } finally {
    busy.value = false;
  }
}
async function tick() {
  await api('/admin/tick-reminders', { body: {} });
  await load();
}
const typeLabel: Record<string, string> = { reminder: '日程提醒', invite: '会议通知', request_result: '审批结果', request_new: '新预约请求', request_withdrawn: '预约撤回' };
const typeClass: Record<string, string> = { reminder: 'warn', invite: 'ok', request_result: 'primary', request_new: 'primary', request_withdrawn: '' };

watch(() => store.refreshTick, load);
onMounted(load);
</script>

<template>
  <div>
    <div class="row" style="margin-bottom: 12px">
      <h2 class="grow" style="margin: 0">提醒中心</h2>
      <button v-if="store.isBoss" class="btn sm" title="演示用：立即检查是否有到点的提醒" @click="tick">立即检查提醒</button>
      <button class="btn sm" @click="load">刷新</button>
    </div>
    <div class="small muted" style="margin-bottom: 10px">
      {{ store.isBoss ? '日程开始前会在这里和右上角弹窗提醒；页面关着时错过的提醒，下次打开只弹一次。' : '老板同意后你会在这里收到会议通知，可以回复参会或不参会。' }}
      <span v-if="store.streamState !== 'open'" class="badge warn">实时连接中…</span>
    </div>
    <div v-if="!items.length" class="card empty">暂无通知</div>

    <div v-for="n in items" :key="n.id" class="card" style="margin-bottom: 10px">
      <div class="row">
        <span class="badge" :class="typeClass[n.type]">{{ typeLabel[n.type] ?? n.type }}</span>
        <strong class="grow">{{ n.title }}</strong>
        <span class="small muted">{{ fmtTime(n.created_at) }}</span>
      </div>
      <div v-if="n.type === 'reminder' || n.type === 'invite'" class="with-map" :class="{ open: mapOpen[n.id] }" style="margin-top: 6px">
      <div class="kv small">
        <span class="k">类别</span><span>{{ n.payload.category }}</span>
        <span class="k">主题</span><span>{{ n.payload.subject }}</span>
        <span class="k">时间</span><span>{{ n.payload.time }}</span>
        <span class="k">地点</span><span><a v-if="n.payload.navUrl" class="nav-link" :href="n.payload.navUrl" target="_blank" rel="noopener" title="一点打开高德导航">📍 {{ n.payload.location }}</a><template v-else>{{ n.payload.location }}</template><button type="button" class="map-toggle" :class="{ on: mapOpen[n.id] }" @click="mapOpen[n.id] = !mapOpen[n.id]">{{ mapOpen[n.id] ? '收起地图' : '🗺 看地图' }}</button></span>
        <span class="k">参与人</span><span>{{ n.payload.attendees?.length ? n.payload.attendees.join('、') : '无' }}</span>
        <template v-if="n.payload.note"><span class="k">备注</span><span>{{ n.payload.note }}</span></template>
      </div>
      <MiniMap v-if="mapOpen[n.id]" :q="n.payload.address || n.payload.location" :nav-url="n.payload.navUrl" />
      </div>
      <div v-else-if="n.type === 'request_new'" class="small muted" style="margin-top: 4px">
        {{ n.payload.requester }} 发起 · {{ n.payload.category }} · {{ n.payload.time }} · {{ n.payload.location }}
        <span v-if="n.payload.travelStatus === 'unverified'" class="badge danger">车程未核实</span>
        <router-link to="/approvals" style="margin-left: 8px">去审批</router-link>
      </div>
      <div v-else-if="n.type === 'request_withdrawn'" class="small muted" style="margin-top: 4px">
        {{ n.payload.requester }} 撤回了这条预约 · {{ n.payload.category }} · {{ n.payload.time }}<span v-if="n.payload.location"> · {{ n.payload.location }}</span>
      </div>
      <div v-else-if="n.type === 'request_result'" class="small muted" style="margin-top: 4px">
        {{ n.payload.time }}<span v-if="n.payload.location"> · {{ n.payload.location }}</span>
        <span v-if="n.payload.reason"> · 原因：{{ n.payload.reason }}</span>
        <span v-if="n.payload.result === 'approved'"> · {{ n.payload.notified ? `已通知 ${n.payload.notified} 位参会人` : '没有需要通知的参会人' }}</span>
      </div>
      <div v-if="n.type === 'invite'" class="row" style="margin-top: 8px">
        <template v-if="n.rsvp">
          <span class="badge" :class="n.rsvp === 'accepted' ? 'ok' : 'danger'">{{ n.rsvp === 'accepted' ? '已回复：参会' : '已回复：不参会' }}</span>
          <button class="btn sm" :disabled="busy" @click="reply(n, n.rsvp === 'accepted' ? 'declined' : 'accepted')">改为{{ n.rsvp === 'accepted' ? '不参会' : '参会' }}</button>
        </template>
        <template v-else>
          <button class="btn sm ok" :disabled="busy" @click="reply(n, 'accepted')">参会</button>
          <button class="btn sm danger" :disabled="busy" @click="reply(n, 'declined')">不参会</button>
        </template>
      </div>
    </div>
  </div>
</template>
