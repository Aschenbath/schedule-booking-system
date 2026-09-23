<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { store, loadBootstrap } from './store';
import Toast from './components/Toast.vue';

onMounted(loadBootstrap);

const tabs = computed(() => {
  const boss = store.isBoss;
  return [
    { to: '/chat', label: '预约对话', show: true },
    { to: '/approvals', label: '待批准', show: boss },
    { to: '/schedule', label: '日程', show: true },
    { to: '/notifications', label: '提醒中心', show: true, badge: store.unread },
    { to: '/settings', label: '后台设置', show: boss },
  ].filter((t) => t.show);
});

const nowLabel = computed(() => {
  const m = store.meta;
  if (!m) return '';
  const d = new Date(m.now);
  const s = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${m.nowOverridden ? 'NOW 覆盖 ' : ''}${s} · 模型 ${m.llm === 'openai' ? m.llmModel : '离线规则'} · 地图 ${m.map}${m.mapSimulateFailure ? '(模拟故障)' : ''}`;
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">日程预约系统</div>
        <nav class="nav">
          <router-link v-for="t in tabs" :key="t.to" :to="t.to">
            {{ t.label }}
            <span v-if="t.badge" class="dot">{{ t.badge }}</span>
          </router-link>
        </nav>
        <div class="userbox">
          <span class="meta">{{ nowLabel }}</span>
          <select v-model="store.userId" title="切换当前用户（不做登录）">
            <option v-for="u in store.users" :key="u.id" :value="u.id">{{ u.name }} · {{ u.dept }} · {{ u.title }}{{ u.role === 'boss' ? '（老板）' : '' }}</option>
          </select>
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
