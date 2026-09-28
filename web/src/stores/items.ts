/**
 * 物品数据的状态。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这里做的事情，本质上是"把后端的一次响应变成一个全局变量"
 * ═══════════════════════════════════════════════════════════════════════
 * 页面里很多地方都需要这批数据：状态栏要显示"3 分钟前更新"，
 * 表格要显示物品，筛选器要显示数量，阈值滑块要显示"命中 87 条"。
 *
 * 如果每个组件各自 fetch 一次，会有 4 个问题：
 *   · 发 4 次请求（而且 /api/items 可能触发抓取，重复触发很糟）
 *   · 4 份数据可能不一致（有的组件拿到了新的，有的是旧的）
 *   · 各自的 loading / 错误状态互相打架
 *   · 点一次"刷新"要通知 4 个组件
 *
 * 所以：**取数据只有这一个地方**，其它组件都从 store 读。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 关于写法：为什么是"函数里 return 一个对象"
 * ═══════════════════════════════════════════════════════════════════════
 * Pinia 有两种写法，这里用的是"setup 风格"：
 *
 *   export const useItemsStore = defineStore('items', () => {
 *     const items = ref([])
 *     return { items }          // ← 返回什么，外面就能用什么
 *   })
 *
 * 它和 Vue 组件里的 `<script setup>` 写法一模一样。好处是：
 *   · 就是普通函数 + 闭包，没有 `this`，不用理解 Options API 那套
 *   · `ref` / `computed` 在组件和 store 里用法完全一致
 *
 * Python 类比：像一个模块级单例 —— 函数体内的局部变量对模块外是私有的，
 * 只有 `return` 出来的才是"公开接口"。`ref` 是响应式的（谁读它谁被追踪），
 * `computed` 相当于"带缓存的属性"（依赖不变就不会重算）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Item } from '@deltaforce/shared'
import { ApiError, api } from '@/api/client'

export const useItemsStore = defineStore('items', () => {
  /* ---------------- 数据 ---------------- */

  const items = ref<Item[]>([])

  /**
   * 数据在服务端有多旧（秒）。**这个值不是本地钟算的** ——
   * 它来自后端响应里的 `ageSeconds`。
   *
   * 为什么不本地算：本地钟可能和服务器不一样，而且"数据多旧"
   * 只有后端知道（它记录着抓取时刻）。
   */
  const ageSeconds = ref<number | null>(null)
  const lastFetchAt = ref<string | null>(null)
  const snapshotStale = ref(false)

  /** 后端是否正在后台抓取（前端据此轮询，并在界面上说"正在获取最新价格…"）*/
  const refreshing = ref(false)

  /** 前端自己的请求是否在进行中（和后端的 `refreshing` 不是一回事）*/
  const loading = ref(false)

  /** 出错时的**中文说明**（已经过多一层转译，可以直接显示）*/
  const error = ref<string | null>(null)

  /* ---------------- 派生 ---------------- */

  const count = computed(() => items.value.length)

  /**
   * ⭐ **可参与排序**的物品 —— 排行榜只能用它。
   *
   * 后端故意把所有物品都返回（包括不可上架、不可摸的），
   * 因为那些信息本身就是价值（“这条能摸到但卖不掉”是有用的结论）。
   * 但排序时必须排掉两类：
   *
   *   ① `listable === false`    挂不上交易行 → 价格无意义
   *   ② `availability !== 'lootable'`  压根摸不到（限时下架 / 非战利品）
   *
   * 为什么这个判定放前端：阈值与判定都是“看你想要什么”的事，
   * 后端只负责如实提供数据。见 PLAN.md §12.3。
   */
  const ranked = computed(() =>
    items.value.filter((it) => it.listable && it.availability === 'lootable'),
  )

  /** 被排掉的数量 —— 显示出来，否则用户会好奇“为什么总数对不上” */
  const excludedCounts = computed(() => ({
    notListable: items.value.filter((it) => !it.listable).length,
    notLootable: items.value.filter((it) => it.availability !== 'lootable').length,
    noPrice: items.value.filter((it) => it.price === null).length,
  }))

  /**
   * 按单格价值降序排。`null`（算不出来）排最后。
   *
   * `computed` 会缓存 —— 只要 `items` 没变，多次读它不会重复排序。
   * 这在这里很重要：表格重渲染一次会读它好几次。
   */
  const sortedByValue = computed(() =>
    [...ranked.value].sort((a, b) => {
      const va = a.pricePerSlot
      const vb = b.pricePerSlot
      if (va === null && vb === null) return 0
      if (va === null) return 1
      if (vb === null) return -1
      return vb - va
    }),
  )

  /* ---------------- 动作 ---------------- */

  /**
   * 拉取物品列表。
   *
   * ⚠️ 这个请求可能很慢（后端在数据过期时会阻塞等一轮抓取，约 13 秒），
   *    所以一定要有 loading 提示，不能让用户对着一个空白页面等。
   */
  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await api.items()
      items.value = res.items
      ageSeconds.value = res.ageSeconds
      lastFetchAt.value = res.lastFetchAt
      snapshotStale.value = res.snapshotStale
      refreshing.value = res.refreshing
    } catch (err) {
      // ApiError 有专门给用户看的说法；其它异常老实说是未知错误
      error.value = err instanceof ApiError ? err.friendly : `未知错误：${String(err)}`
    } finally {
      loading.value = false
    }
  }

  /**
   * 手动刷新。
   *
   * 注意 409 / 429 **不是故障**，而是后端的锁在正常工作：
   *   · 409 = 已经有人在抓了（多标签页同时点就是这种情况）
   *   · 429 = 刚抓过，别这么频繁（对数据源的礼貌约束）
   * 所以这两种情况不该显示成红色报错，而是提示"稍等"。
   */
  async function manualRefresh(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await api.refresh()
      // 后台开始抓了 —— 稍后重新拉一次就能拿到新数据
      setTimeout(() => void load(), 3000)
      return { ok: true, message: res.message }
    } catch (err) {
      if (err instanceof ApiError) {
        const waitable = err.code === 'refresh_in_progress' || err.code === 'refresh_too_soon'
        return { ok: waitable, message: err.friendly }
      }
      return { ok: false, message: `未知错误：${String(err)}` }
    }
  }

  return {
    items,
    ageSeconds,
    lastFetchAt,
    snapshotStale,
    refreshing,
    loading,
    error,
    count,
    ranked,
    excludedCounts,
    sortedByValue,
    load,
    manualRefresh,
  }
})
