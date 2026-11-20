import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Tauri 期望前端构建产物在 ../dist，dev 走固定端口供 tauri.conf 引用
export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
  },
})
