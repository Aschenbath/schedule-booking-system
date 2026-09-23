import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', component: () => import('./views/ChatView.vue'), meta: { title: '预约对话' } },
    { path: '/approvals', component: () => import('./views/ApprovalView.vue'), meta: { title: '待批准' } },
    { path: '/schedule', component: () => import('./views/ScheduleView.vue'), meta: { title: '日程' } },
    { path: '/notifications', component: () => import('./views/NotificationsView.vue'), meta: { title: '提醒中心' } },
    { path: '/settings', component: () => import('./views/SettingsView.vue'), meta: { title: '后台设置' } },
  ],
});
