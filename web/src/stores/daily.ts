/**
 * 每日地图密码。
 *
 * ⚠️ 它和 `items` / `meta` 那两个 store 是**不同性质的数据**：
 *   · 每天变一次（不是 5 分钟）
 *   · 不进快照、不进历史、不参与任何判定
 * 所以单独一个 store，也不跟着 `useHealthPolling` 一起轮询 ——
 * 它挂在首页上，打开首页时拉一次就够（后端还有半小时缓存）。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ApiError, api } from '@/api/client'

export interface DailySecret {
  mapId: number | null
  mapName: string
  secret: string
}

export const useDailyStore = defineStore('daily', () => {
  const secrets = ref<DailySecret[]>([])
  const fetchedAt = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  /**
   * 数据有多旧（秒）。本地算的 —— 后端给的是抓取时刻，
   * 而"多久以前"要拿现在去比。
   */
  const ageSeconds = computed<number | null>(() => {
    if (fetchedAt.value === null) return null
    const t = Date.parse(fetchedAt.value)
    if (!Number.isFinite(t)) return null
    return Math.max(0, Math.round((Date.now() - t) / 1000))
  })

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await api.daily()
      secrets.value = res.secrets
      fetchedAt.value = res.fetchedAt
      loaded.value = true
    } catch (err) {
      error.value =
        err instanceof ApiError
          ? err.friendly
          : `取每日密码失败：${err instanceof Error ? err.message : String(err)}`
    } finally {
      loading.value = false
    }
  }

  return { secrets, fetchedAt, loading, error, loaded, ageSeconds, load }
})
