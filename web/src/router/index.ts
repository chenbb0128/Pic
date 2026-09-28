import { createMemoryHistory, createRouter, createWebHistory, type RouterHistory } from 'vue-router'

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: '/', redirect: '/workspace' },
      { path: '/workspace', component: () => import('../pages/WorkspacePage.vue') },
      { path: '/pricing', name: 'pricing', component: () => import('../pages/PricingPage.vue') },
      { path: '/help', component: () => import('../pages/HelpPage.vue') },
    ],
  })
}

export const router = createAppRouter(typeof window === 'undefined' ? createMemoryHistory() : createWebHistory())
