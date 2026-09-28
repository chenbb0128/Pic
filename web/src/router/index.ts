import { createRouter, createWebHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/workspace' },
    { path: '/workspace', component: () => import('../pages/WorkspacePage.vue') },
    { path: '/help', component: () => import('../pages/HelpPage.vue') },
  ],
})
