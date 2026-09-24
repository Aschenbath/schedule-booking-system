<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { store, loadBootstrap } from './store';
import { sh } from './api';
import Toast from './components/Toast.vue';
import UserPicker from './components/UserPicker.vue';

onMounted(loadBootstrap);

// 按需求文档分角色：预约对话只给员工；待批准、日程、后台设置只给老板；提醒中心两边都有
const BOSS_ONLY = ['/approvals', '/schedule', '/settings'];
const route = useRoute();
const router = useRouter();
const home = computed(() => (store.isBoss ? '/approvals' : '/chat'));
watch(
  () => [store.user?.role, route.path] as const,
  ([role, path]) => {
    if (!role) return;
    const allowed = role === 'boss' ? path !== '/chat' : !BOSS_ONLY.includes(path);
    if (!allowed) router.replace(home.value);
  },
  { immediate: true },
);

const tabs = computed(() => {
  const boss = store.isBoss;
  return [
    { to: '/chat', label: '预约对话', show: !boss },
    { to: '/approvals', label: '待批准', show: boss },
    { to: '/schedule', label: '日程', show: boss },
    { to: '/notifications', label: '提醒中心', show: true, badge: store.unread },
    { to: '/settings', label: '后台设置', show: boss },
  ].filter((t) => t.show);
});

// 顶栏时钟跟着走：服务端时间 + 拿到它之后过去的时长（NOW_MODE=frozen 时不走）
const tick = ref(Date.now());
let metaAt = Date.now();
watch(
  () => store.meta,
  () => (metaAt = Date.now()),
);
const timer = setInterval(() => (tick.value = Date.now()), 10_000);
onBeforeUnmount(() => clearInterval(timer));
const nowLabel = computed(() => {
  const m = store.meta;
  if (!m) return '';
  const d = sh(new Date(m.now).getTime() + (m.nowFrozen ? 0 : Math.max(0, tick.value - metaAt)));
  const s = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${m.nowOverridden ? 'NOW 覆盖 ' : ''}${s} · 模型 ${m.llm === 'openai' ? m.llmModel : '离线规则'} · 地图 ${m.map}${m.mapSimulateFailure ? '(模拟故障)' : ''}`;
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <router-link :to="home" class="brand">
          <span class="seal">日<br />程</span>
          <span class="brand-text"><span class="brand-name">日程预约</span><span class="brand-sub">Executive Agenda</span></span>
        </router-link>
        <nav class="nav">
          <router-link v-for="t in tabs" :key="t.to" :to="t.to">
            {{ t.label }}
            <span v-if="t.badge" class="dot">{{ t.badge }}</span>
          </router-link>
        </nav>
        <div class="userbox">
          <span class="meta">{{ nowLabel }}</span>
          <UserPicker />
        </div>
      </div>
    </header>
    <main class="main">
      <router-view v-if="store.userId" :key="store.userId" />
      <div v-else class="empty">正在加载…</div>
    </main>
    <Toast />
  </div>
</template>
