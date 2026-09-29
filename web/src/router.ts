/**
 * 极简哈希路由。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么不用 vue-router
 * ═══════════════════════════════════════════════════════════════════════
 * 只有**两个**页面（首页 / 价值榜），而且没有嵌套路由、没有路由守卫、
 * 没有参数解析 —— 引一个路由库是为了一个 `ref` 再加 30KB 依赖 ✗。
 *
 * 用 hash（`#/home`）而不是 history API 的原因：
 *   页面是纯静态的（Vite 产物可以直接丢给任何静态服务器），
 *   而 history 模式需要服务端把所有路径都回退到 index.html ✗ ——
 *   那会给"以后部署"添一个不必要的配置项。
 *
 * Python 类比：这相当于一个只有两个分支的 `if __name__` ——
 * 没必要为此装一个框架。
 */

import { ref } from 'vue'

export type ViewId = 'home' | 'rank'

export interface NavItem {
  id: ViewId
  label: string
  /** 侧边栏上的小图标（用 emoji，不引图标库）*/
  icon: string
  hint: string
}

export const NAV: readonly NavItem[] = [
  { id: 'home', label: '一图流首页', icon: '🏠', hint: '每日密码 · 集市物品 · 特勤处' },
  { id: 'rank', label: '物资价值榜', icon: '📊', hint: '按每格价值排序，看这趟该摸什么' },
]

const VIEW_IDS: readonly ViewId[] = NAV.map((n) => n.id)

/** 当前页面。默认首页（用户的命名是「一图流首页」）*/
const current = ref<ViewId>(parseHash())

function parseHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, '').trim()
  return VIEW_IDS.includes(raw as ViewId) ? (raw as ViewId) : 'home'
}

/** 只装一次监听（模块级，重复调用不会叠加）*/
let installed = false
function install(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('hashchange', () => {
    current.value = parseHash()
  })
}

install()

export function useRouter(): {
  view: typeof current
  go: (id: ViewId) => void
} {
  install()
  return {
    view: current,
    /** 切页面。同时写 hash —— 这样浏览器前进/后退、刷新都能停在原页面 */
    go: (id: ViewId) => {
      current.value = id
      const next = `#/${id}`
      if (window.location.hash !== next) window.location.hash = next
    },
  }
}
