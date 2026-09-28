/**
 * 轻量健康校验 —— 只在**标签页可见时**轮询。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要有这个，以及为什么不能更简单
 * ═══════════════════════════════════════════════════════════════════════
 * 后端刻意没有定时器（没人用就不抓数据）。所以"数据变新了"这件事
 * 需要前端来发现 —— 比如你在另一个标签页点了刷新，这个标签页该跟上。
 *
 * 但有两种偷懒的写法都是错的：
 *
 *   ❌ **每 60 秒重新拉一次 /api/items**
 *      → 那是 2MB 的响应，白白传 60 次/小时
 *      → 而且 `/api/items` 会**触发抓取**，多个标签页就是多重抓取
 *
 *   ❌ **不管标签页可见性，一直轮询**
 *      → 你把网页切到后台放一整天，它就空转一整天
 *      → 和"没人在用就不该抓数据"的初衷正好相反
 *
 * 所以这里的做法是：
 *   ✅ 只在**可见**时轮询（`document.visibilityState`）
 *   ✅ 而轮询的是 `/api/health` —— 这个接口刻意**不触发抓取**，
 *      响应只有 230 字节，可以放心频繁打
 *   ✅ 而且**只在数据真的变了才重新拉 items** —— 比对 `lastFetchAt`
 *
 * 这样最坏情况是每小时 60 次 230 字节的健康检查（十几 KB），
 * 并且一次多余的抓取都不会发生。
 */

import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { api } from '@/api/client'
import { useItemsStore } from '@/stores/items'

export interface HealthPollingState {
  /** 当前标签页是否可见 */
  visible: Ref<boolean>
  /** 最近一次校验的时刻 */
  lastCheckAt: Ref<Date | null>
  /** 最近一次校验发现后端数据变新了 */
  lastChangeAt: Ref<Date | null>
  /** 校验过程中出错了（不影响页面使用，只是提示） */
  error: Ref<string | null>
}

export interface UseHealthPollingOptions {
  /** 轮询间隔（毫秒），默认 60 秒 */
  intervalMs?: number
}

export function useHealthPolling(options: UseHealthPollingOptions = {}): HealthPollingState {
  const intervalMs = options.intervalMs ?? 60_000
  const itemsStore = useItemsStore()

  const visible = ref(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
  const lastCheckAt = ref<Date | null>(null)
  const lastChangeAt = ref<Date | null>(null)
  const error = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * 做一次校验。
   *
   * `lastFetchAt` 是**后端快照的抓取时刻**。它变了 = 后端确实拿到新数据了。
   * 拿它做比对而不是比时间戳差，是因为：
   *   · 本地钟可能不准
   *   · 后端可能因为失败而**没有**更新（这时 lastFetchAt 不变，
   *     我们就不该白拉一次 items）
   */
  async function check(): Promise<void> {
    // 不可见时直接跳过（双保险：即使定时器没被清掉也不会真的发请求）
    if (document.visibilityState !== 'visible') return

    try {
      const health = await api.health()
      lastCheckAt.value = new Date()
      error.value = null

      if (health.lastFetchAt !== null && health.lastFetchAt !== itemsStore.lastFetchAt) {
        lastChangeAt.value = new Date()
        // 后端有更新的数据 → 这次才真的重新拉列表
        await itemsStore.load()
      } else {
        // 数据没变，但"数据有多旧"会一直涨，所以只更新这个数字
        itemsStore.ageSeconds = health.ageSeconds
        itemsStore.snapshotStale = health.snapshotStale
        itemsStore.refreshing = health.refreshing
      }
    } catch (err) {
      // 校验失败不该打扰用户（页面上的数据还能用），只在状态栏留个记号
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  function start(): void {
    if (timer !== null) return
    timer = setInterval(() => void check(), intervalMs)
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /**
   * 标签页可见性变化。
   *
   * 两个关键点：
   *   ① 切回可见时**立刻校验一次** —— 你切走了 10 分钟再回来，
   *      应该马上看到新数据，而不是再等 60 秒
   *   ② 切到后台时**停掉定时器** —— 不是"留着但让回调早退"，
   *      是真的不跑。这样即使回调里有 bug 也不会偷偷发请求
   */
  function onVisibilityChange(): void {
    visible.value = document.visibilityState === 'visible'
    if (visible.value) {
      void check()
      start()
    } else {
      stop()
    }
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (visible.value) start()
  })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    // 组件卸载必须清掉定时器，否则热更新时会累积出好几个并行的定时器
    stop()
  })

  return { visible, lastCheckAt, lastChangeAt, error }
}
