/**
 * 前端入口 —— 浏览器加载的第一段 JS。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件只做三件事
 * ═══════════════════════════════════════════════════════════════════════
 *   1. 装上 Pinia（全局状态）和 Element Plus（控件库）
 *   2. 把根组件 App.vue 挂到 index.html 里那个 `<div id="app">` 上
 *   3. 收尾
 *
 * Python 类比：有点像 `if __name__ == '__main__':` 那个块 ——
 * 前面都是定义，这里才是"开始跑"的地方。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 一个必须保持的习惯：从 `@deltaforce/shared` 导入只能用 `import type`
 * ═══════════════════════════════════════════════════════════════════════
 * 因为这个包**没有构建产物**（没有 `dist/`，就是一堆 `.ts` 源码）。
 * 它能工作的全部前提是：`import type` 在编译期被**整行擦除**，
 * 于是运行时根本不会去加载它。
 *
 * 一旦写成普通 `import { SOMETHING } from '@deltaforce/shared'`，
 * 浏览器就会真的去请求那个 `.ts` 文件 → 直接崩。
 *
 * 所以：**`shared` 里绝对不能出现 `const` / `function`**。
 * 这类运行时常量（品质色值、中文标签）由后端通过 `/api/meta` 下发 ——
 * 前端从 `useMetaStore()` 里拿。详见 AGENTS.md §5。
 */

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'

import App from './App.vue'
import './styles.css'

const app = createApp(App)

/**
 * Pinia —— 全局状态。
 *
 * 为什么需要它：物品列表、筛选条件、阈值滑块分散在好几个组件里，
 * 但它们要读同一份数据。没有它的话就得"父组件传给子组件、子组件再传下去"
 * （叫 prop drilling），层级一深就没法维护。
 *
 * Pinia 相当于一个**模块级单例**（Python 里 `config = {...}` 那种），
 * 任何组件 import 它就拿到同一个对象；而且它是响应式的 ——
 * 谁改了它，用到它的组件自动重画。
 */
app.use(createPinia())

/**
 * Element Plus —— 控件库（表格/滑块/下拉框/徽章…）。
 *
 * 这里用**完整引入**：一行导入全部组件 + 全部样式。
 * 代价是打包体积大一些（本地自用工具，不在意）。
 * 想按需引入要装 `unplugin-vue-components`，那是给"上线给很多人用"的场景准备的。
 *
 * `locale={zhCn}` 是必要的 —— 不然分页器、表格的"无数据"提示、
 * 日期选择器都会显示英文。
 */
app.use(ElementPlus, { locale: zhCn })

/**
 * 挂载。`'#app'` 对应 index.html 里那个 `<div id="app">`。
 * 这一行之后，整个界面才开始渲染。
 */
app.mount('#app')
