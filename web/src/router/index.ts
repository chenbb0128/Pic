import { createMemoryHistory, createRouter, createWebHistory, type RouterHistory } from 'vue-router'

export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({
    history,
    routes: [
      { path: '/', redirect: '/workspace' },
      { path: '/workspace', component: () => import('../pages/StudioWorkspacePage.vue') },
      { path: '/classic', component: () => import('../pages/WorkspacePage.vue') },
      { path: '/cutout', component: () => import('../pages/CutoutPage.vue') },
      { path: '/tools/:kind(recolor|polka|frame|name|text)', component: () => import('../pages/CreativeToolsPage.vue') },
      { path: '/tools/resize', component: () => import('../pages/ImageSizeConverterPage.vue') },
      { path: '/pricing', name: 'pricing', component: () => import('../pages/PricingPage.vue') },
      { path: '/help', component: () => import('../pages/HelpPage.vue') },
    ],
  })
}

export const router = createAppRouter(typeof window === 'undefined' ? createMemoryHistory() : createWebHistory())
