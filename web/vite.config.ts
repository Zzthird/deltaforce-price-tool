/**
 * Vite 配置。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * Vite 是什么
 * ═══════════════════════════════════════════════════════════════════════
 * 它同时是两样东西：
 *   · **开发服务器**（`npm run dev`）—— 起在 5173 端口，改文件立刻生效
 *   · **打包器**（`npm run build`）—— 把整个前端压成几个静态文件
 *
 * 为什么不用 Webpack（更老的方案）：Vite 在开发时**不打完整的包** ——
 * 它把源码按原样发给浏览器，让浏览器用原生 ES 模块自己按需加载。
 * 所以冷启动是"毫秒级起服务器"，而不是"等 30 秒打完包"。
 * 浏览器请求到某个文件时才现场编译它（esbuild，Go 写的，很快）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 关键的一块：/api 代理
 * ═══════════════════════════════════════════════════════════════════════
 * 浏览器有个安全规则叫**同源策略**：`localhost:5173` 上的页面
 * 不能随便去读 `localhost:3000` 的响应（端口不同就算"不同源"）。
 *
 * 两种解法：
 *   ① 让后端加 CORS 响应头          → 要改后端代码，还要处理预检请求
 *   ② 让前端开发服务器**转发**过去   → 页面只跟自己人说话，不涉及跨源
 *
 * 选 ②。配置就是下面 5 行：凡是 `/api` 开头的请求，Vite 都替浏览器
 * 转给 3000 端口。对浏览器来说，它请求的一直是 `localhost:5173/api/...`，
 * 完全没跨源。
 *
 * Python 类比：相当于给 requests 配了个代理，请求发到 5173 就被转发到 3000 ——
 * 只不过这一层由 Vite 的服务器来做。
 */

import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const API_ORIGIN = 'http://127.0.0.1:3000'

export default defineConfig({
  plugins: [
    /**
     * 让 Vite 认识 `.vue` 文件（单文件组件）。
     * 没有它，`import App from './App.vue'` 会报"不认识这个后缀"。
     */
    vue(),
  ],

  resolve: {
    alias: {
      /**
       * `@` 指向 `src/`，这样 import 不用写一长串 `../../`。
       *
       * Python 类比：相当于把项目根加进 `sys.path`，于是可以
       * `from utils.format import x` 而不是 `from ..utils.format import x`。
       */
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    // 端口被占时直接失败，不要悄悄换一个 —— 否则你会对着旧服务调试
    strictPort: true,

    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: true,
        /**
         * ⚠️ 代理层**不做请求超时**（默认不限制）。
         *
         * 因为后端 `/api/items` 在数据过期时会**阻塞等一轮抓取**（约 13 秒），
         * 冷启动时甚至更久。要是这里设个 5 秒超时，第一次打开网页就必失败 ——
         * 而那时候数据正在正常抓取路上。
         */
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },

  build: {
    // 打包产物放这里（`npm run build` 之后可以直接丢给任何静态服务器）
    outDir: 'dist',
    // 本地工具：不做压缩体积的极致优化，构建快一点更有用
    sourcemap: true,
  },
})
