import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 由 src/pwa.ts 自己注册并处理更新
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '升级·找朋友',
        short_name: '找朋友',
        description: '三副牌、5 或 6 人的升级找朋友，和朋友联机打牌',
        lang: 'zh-CN',
        start_url: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#152b24',
        theme_color: '#152b24',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 只缓存静态资源，WebSocket 与接口不走 service worker
        globPatterns: ['**/*.{js,css,html,svg,png,jpg,mp3,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/ws/, /^\/healthz/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
