<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { store } from '../store';

const open = ref(false);
const q = ref('');
const active = ref(0);
const root = ref<HTMLElement>();
const searchEl = ref<HTMLInputElement>();
const listEl = ref<HTMLElement>();

const current = computed(() => store.users.find((u: any) => u.id === store.userId));

const filtered = computed(() => {
  const k = q.value.trim().toLowerCase();
  return store.users.filter((u: any) => !k || `${u.name}${u.dept}${u.title}`.toLowerCase().includes(k));
});

// 按部门分组，老板所在部门置顶
const groups = computed(() => {
  const map = new Map<string, any[]>();
  for (const u of filtered.value) {
    if (!map.has(u.dept)) map.set(u.dept, []);
    map.get(u.dept)!.push(u);
  }
  return [...map.entries()].map(([dept, users]) => ({ dept, users }));
});
const flat = computed(() => groups.value.flatMap((g) => g.users));

function toggle() {
  open.value ? close() : show();
}
async function show() {
  open.value = true;
  q.value = '';
  active.value = Math.max(0, flat.value.findIndex((u: any) => u.id === store.userId));
  await nextTick();
  searchEl.value?.focus();
  scrollActive();
}
function close() {
  open.value = false;
}
function pick(u: any) {
  store.userId = u.id;
  close();
}
function scrollActive() {
  listEl.value?.querySelector('.up-opt.hl')?.scrollIntoView({ block: 'nearest' });
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = flat.value.length;
    if (!n) return;
    active.value = (active.value + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    nextTick(scrollActive);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const u = flat.value[active.value];
    if (u) pick(u);
  } else if (e.key === 'Escape') {
    close();
  }
}
watch(q, () => (active.value = 0));

function initial(name: string) {
  return name?.slice(0, 1) ?? '?';
}
function onDoc(e: MouseEvent) {
  if (open.value && root.value && !root.value.contains(e.target as Node)) close();
}
onMounted(() => document.addEventListener('mousedown', onDoc));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDoc));
</script>

<template>
  <div ref="root" class="up" :class="{ open }">
    <button type="button" class="up-trigger" title="切换当前用户（不做登录）" aria-haspopup="listbox" :aria-expanded="open" @click="toggle">
      <span class="up-avatar" :class="{ boss: current?.role === 'boss' }">{{ initial(current?.name) }}</span>
      <span class="up-who">
        <span class="up-name">{{ current?.name ?? '选择用户' }}<em v-if="current?.role === 'boss'">老板</em></span>
        <span class="up-role">{{ current ? `${current.dept} · ${current.title}` : '' }}</span>
      </span>
      <svg class="up-caret" width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
    </button>

    <transition name="up-pop">
      <div v-if="open" class="up-panel" @keydown="onKey">
        <div class="up-search">
          <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.5" /></svg>
          <input ref="searchEl" v-model="q" placeholder="搜索姓名 / 部门 / 岗位" />
          <kbd>ESC</kbd>
        </div>
        <div ref="listEl" class="up-list" role="listbox">
          <div v-for="g in groups" :key="g.dept" class="up-group">
            <div class="up-dept"><span>{{ g.dept }}</span><i>{{ g.users.length }}</i></div>
            <button
              v-for="u in g.users"
              :key="u.id"
              type="button"
              role="option"
              class="up-opt"
              :class="{ sel: u.id === store.userId, hl: flat[active]?.id === u.id }"
              :aria-selected="u.id === store.userId"
              @mouseenter="active = flat.indexOf(u)"
              @click="pick(u)"
            >
              <span class="up-avatar sm" :class="{ boss: u.role === 'boss' }">{{ initial(u.name) }}</span>
              <span class="up-opt-name">{{ u.name }}</span>
              <span class="up-opt-title">{{ u.title }}</span>
              <em v-if="u.role === 'boss'" class="up-tag">老板</em>
              <svg v-if="u.id === store.userId" class="up-check" width="12" height="10" viewBox="0 0 12 10"><path d="M1 5l3.5 3.5L11 1" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
            </button>
          </div>
          <div v-if="!flat.length" class="up-none">没有匹配的人</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.up {
  position: relative;
}
.up-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 210px;
  padding: 5px 12px 5px 5px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card-hi);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.up-trigger:hover,
.up.open .up-trigger {
  border-color: var(--ink-2);
  box-shadow: 0 6px 16px -10px rgba(40, 25, 5, 0.5);
}
.up-trigger:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.up-avatar {
  flex: none;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--ink);
  color: #f3eee3;
  font-family: var(--serif);
  font-weight: 700;
  font-size: 14px;
}
.up-avatar.boss {
  background: var(--primary);
  box-shadow: 0 0 0 2px var(--card-hi), 0 0 0 3px var(--primary);
}
.up-avatar.sm {
  width: 24px;
  height: 24px;
  font-size: 12px;
  background: var(--bg-deep);
  color: var(--ink-2);
}
.up-avatar.sm.boss {
  background: var(--primary);
  color: #fff;
  box-shadow: none;
}
.up-who {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
  flex: 1;
  min-width: 0;
}
.up-name {
  font-weight: 600;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.up-name em,
.up-tag {
  font-style: normal;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--primary);
  border: 1px solid var(--primary);
  border-radius: 2px;
  padding: 0 4px;
  line-height: 15px;
}
.up-role {
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.up-caret {
  color: var(--muted);
  transition: transform 0.3s var(--ease);
}
.up.open .up-caret {
  transform: rotate(180deg);
}

.up-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 8px);
  width: 300px;
  background: var(--card-hi);
  border: 1px solid var(--line);
  border-top: 3px solid var(--ink);
  border-radius: 4px;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  z-index: 60;
  transform-origin: top right;
}
.up-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-soft);
  color: var(--muted);
}
.up-search input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 13px;
  color: var(--text);
}
.up-search input::placeholder {
  color: #b0a795;
}
kbd {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-bottom-width: 2px;
  border-radius: 3px;
}
.up-list {
  max-height: min(420px, 60vh);
  overflow: auto;
  /* 顶部不留 padding：sticky 的部门标题贴着滚动区上沿，避免与搜索栏之间露缝 */
  padding: 0 0 8px;
  scrollbar-width: thin;
  scrollbar-color: var(--line) transparent;
}
.up-dept {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 4px;
  background: var(--card-hi);
  font-family: var(--serif);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: var(--ink-2);
}
.up-group:first-child .up-dept {
  padding-top: 12px;
}
.up-dept::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--line-soft);
  order: 1;
}
.up-dept i {
  order: 2;
  font-style: normal;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0;
  color: var(--muted);
}
.up-opt {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.up-opt::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--primary);
  transform: scaleY(0);
  transition: transform 0.2s var(--ease);
}
.up-opt.hl {
  background: var(--bg);
}
.up-opt.hl::before,
.up-opt.sel::before {
  transform: scaleY(1);
}
.up-opt-name {
  font-weight: 600;
}
.up-opt-title {
  flex: 1;
  color: var(--muted);
  font-size: 12px;
}
.up-opt.sel .up-opt-name {
  color: var(--primary);
}
.up-check {
  color: var(--primary);
}
.up-none {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}

.up-pop-enter-active,
.up-pop-leave-active {
  transition: opacity 0.18s, transform 0.22s var(--ease);
}
.up-pop-enter-from,
.up-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
}

@media (max-width: 900px) {
  .up-trigger {
    min-width: 0;
  }
  .up-role {
    display: none;
  }
  .up-panel {
    width: min(300px, calc(100vw - 24px));
  }
}
</style>
