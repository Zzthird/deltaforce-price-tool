/**
 * 元数据的状态 —— 筛选器选项 + 标签调色板。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么中文标签和颜色**从后端来**，而不是前端写死
 * ═══════════════════════════════════════════════════════════════════════
 * 因为 `shared` 包只能放类型（AGENTS.md §5），运行时常量放不进去 ——
 * 而"金"这个品质是 `#e8a64e` 还是别的颜色，是**实测自数据源**的事实，
 * 不该在前端再抄一份。抄两份的后果很具体：
 *
 *   后端改了品质色值 → 前端没跟上 → 网页上"金"的边框和"金"的文字
 *   变成两种颜色，而且没人会发现。
 *
 * 所以后端是唯一定义处，这里只是接住它。
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  LabelPalette,
  MetaOption,
  SourceStatus,
} from '@deltaforce/shared'
import { ApiError, api } from '@/api/client'

export const useMetaStore = defineStore('meta', () => {
  const categories = ref<MetaOption[]>([])
  const subcategories = ref<MetaOption[]>([])
  const thirdClasses = ref<MetaOption[]>([])
  const grades = ref<MetaOption[]>([])
  const maps = ref<MetaOption[]>([])
  const sources = ref<SourceStatus[]>([])
  const priceBasis = ref<string | null>(null)
  const matchRate = ref<number | null>(null)
  const warnings = ref<string[]>([])

  const labels = ref<LabelPalette | null>(null)

  const loading = ref(false)
  const error = ref<string | null>(null)
  const loaded = ref(false)

  /* ---------------- 派生 ---------------- */

  /**
   * 品质色值表：`"5"` → `"#e8a64e"`。
   *
   * 表格里每个品质都要查一次颜色，所以把它拍平成一层的 Map 更省事
   * （不用每次 `labels.grade[String(grade)].color`）。
   */
  const gradeColors = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [value, style] of Object.entries(labels.value?.grade ?? {})) {
      out[value] = style.color
    }
    return out
  })

  const gradeTones = computed<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [value, style] of Object.entries(labels.value?.grade ?? {})) {
      out[value] = style.tone
    }
    return out
  })

  /* ---------------- 动作 ---------------- */

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await api.meta()
      categories.value = res.categories
      subcategories.value = res.subcategories
      thirdClasses.value = res.thirdClasses
      grades.value = res.grades
      maps.value = res.maps
      sources.value = res.sources
      priceBasis.value = res.priceBasis
      matchRate.value = res.matchRate
      labels.value = res.labels
      loaded.value = true

      // 告警在另一个接口里，顺手拿一下（拿不到不影响主流程）
      try {
        const src = await api.sources()
        warnings.value = src.warnings
      } catch {
        warnings.value = []
      }
    } catch (err) {
      error.value = err instanceof ApiError ? err.friendly : `未知错误：${String(err)}`
    } finally {
      loading.value = false
    }
  }

  return {
    categories,
    subcategories,
    thirdClasses,
    grades,
    maps,
    sources,
    priceBasis,
    matchRate,
    warnings,
    labels,
    loading,
    error,
    loaded,
    gradeColors,
    gradeTones,
    load,
  }
})
