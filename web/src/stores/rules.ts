/**
 * 摸金判定规则 —— 阈值与"必摸 / 可摸 / 跳过"的判定。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么判定放在前端
 * ═══════════════════════════════════════════════════════════════════════
 * 三个原因，都很实际：
 *
 *   ① **判定规则是用户的偏好，不是数据的属性。** "单格 2 万算必摸"这句话里
 *      没有一丝一毫关于物品本身的事实，它是你的取舍。后端没有理由知道它。
 *
 *   ② **拖滑块不该发网络请求。** 拖一下就打一次后端、或者要重启服务，
 *      那就没法愉快地试不同阈值了 —— 而"试着调一下看看"恰恰是这个功能
 *      最主要的使用方式。
 *
 *   ③ **后端写死之后就没法快速试了。** 每次改阈值都要改配置、重启、
 *      再刷新页面，试三组阈值就烦了。
 *
 * 所以：规则存在浏览器 localStorage 里，**后端完全不感知**。
 * 契约里 `LootRules` 的注释也是这么写的。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 两个阈值而不是一个
 * ═══════════════════════════════════════════════════════════════════════
 * 单阈值只能分出"值得 / 不值得"，但实际决策有三档：
 *
 *   ≥ mustThreshold   **必摸** —— 不捡就是亏
 *   中间               **可摸** —— 看背包和路线
 *   < skipThreshold   **跳过** —— 占格子不值
 *
 * 中间那一档是真实存在的需求：一局里格子有限，"值 8000 的要不要占我一格"
 * 取决于我当时空着几格。所以留一段可调区间，比一个硬边界有用。
 */

import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Item, LootMode, LootRules, LootVerdict } from '@deltaforce/shared'

/** localStorage 的键。带版本号 —— 将来规则结构变了可以换键，不会读到旧数据 */
const STORAGE_KEY = 'deltaforce.lootRules.v1'

/**
 * 默认阈值。
 *
 * 为什么是 20000 / 5000：实测消耗品的单格价值跨度达 350 倍，
 * 这个组合能把常见的"该捡 / 不该捡"分开。（这是可推翻的默认值，
 * 拖两次滑块就会变成你自己的数。）
 */
const DEFAULT_RULES: LootRules = {
  mode: 'pricePerSlot',
  mustThreshold: 20_000,
  skipThreshold: 5_000,
}

/**
 * 从 localStorage 读。
 *
 * ⚠️ **不能信里面的内容** —— 它可能是上一个版本写的、可能被手改过、
 * 也可能是别的网站同源留下的垃圾。所以逐字段校验类型和范围，
 * 任何一项不对就退回默认值。
 *
 * 这是"外部输入"的典型场景：localStorage 和网络响应一样不可信。
 */
function loadRules(): LootRules {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_RULES }

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_RULES }
    const obj = parsed as Partial<LootRules>

    const mode: LootMode = obj.mode === 'price' ? 'price' : 'pricePerSlot'
    const must = typeof obj.mustThreshold === 'number' && Number.isFinite(obj.mustThreshold)
      ? Math.max(0, obj.mustThreshold)
      : DEFAULT_RULES.mustThreshold
    const skip = typeof obj.skipThreshold === 'number' && Number.isFinite(obj.skipThreshold)
      ? Math.max(0, obj.skipThreshold)
      : DEFAULT_RULES.skipThreshold

    /**
     * ⚠️ 两个阈值必须满足 `skip ≤ must`。
     *
     * 如果存进来的是反的（比如手改过、或者将来加了别的入口写坏），
     * 判定会变成"既不是必摸也不是跳过"的诡异状态 —— 中间那档会消失。
     * 所以这里直接把反的那一侧夹回来，而不是等到界面上显示怪结果。
     */
    return { mode, mustThreshold: Math.max(must, skip), skipThreshold: Math.min(must, skip) }
  } catch {
    // localStorage 在某些隐私模式下会直接抛异常，不该让整个页面崩掉
    return { ...DEFAULT_RULES }
  }
}

export const useRulesStore = defineStore('rules', () => {
  const initial = loadRules()

  const mode = ref<LootMode>(initial.mode)
  const mustThreshold = ref(initial.mustThreshold)
  const skipThreshold = ref(initial.skipThreshold)

  /** 规则整体（对外只读的一个组合）*/
  const rules = computed<LootRules>(() => ({
    mode: mode.value,
    mustThreshold: mustThreshold.value,
    skipThreshold: skipThreshold.value,
  }))

  /** 当前用哪个指标排序/判定 —— 界面要显示它的单位说明 */
  const metricLabel = computed(() =>
    mode.value === 'pricePerSlot' ? '单格价值' : '单价',
  )

  /**
   * 取一个物品的"指标值" —— 排序和判定都用它。
   *
   * 为什么排序键和判定依据要**同步切换**：
   * 如果按单价排序、按单格价值判定，你会在列表上看到"排在前面的被判跳过"
   * 这种自相矛盾的东西。两者必须指向同一个数。
   */
  function metricOf(item: Item): number | null {
    return mode.value === 'pricePerSlot' ? item.pricePerSlot : item.price
  }

  /**
   * 判定一个物品。
   *
   * 返回 `unknown` 的三种情况：
   *   · **不可上架** —— 挂不上交易行，价格没有意义
   *   · **不可摸**（限时下架 / 非战利品）—— 摸不到，值多少都与你无关
   *   · **没有价格** —— 算不出来
   *
   * 前两种必须在这里挡住，而不是指望调用方先过滤。因为界面允许
   * "显示不可上架与不可摸的物品"（那些信息本身也有价值 ——
   * "能摸到但卖不掉"是个有用的结论），此时如果按价格判它"必摸"，
   * 就会给出一个错误建议。
   */
  function verdictOf(item: Item): LootVerdict {
    if (!item.listable) return 'unknown'
    if (item.availability !== 'lootable') return 'unknown'

    const value = metricOf(item)
    if (value === null) return 'unknown'
    if (value >= mustThreshold.value) return 'must'
    if (value < skipThreshold.value) return 'skip'
    return 'maybe'
  }

  /** 恢复默认（界面上的"重置"按钮） */
  function reset(): void {
    mode.value = DEFAULT_RULES.mode
    mustThreshold.value = DEFAULT_RULES.mustThreshold
    skipThreshold.value = DEFAULT_RULES.skipThreshold
  }

  /**
   * 存盘。`deep: true` 是因为 `rules` 是个对象 ——
   * 但这里 watch 的是三个 ref，所以用不到 deep ✓
   *
   * 为什么 watch 三个 ref 而不是 watch `rules`：
   * 直接 watch 一个 computed 也能触发，但 `immediate: true` 会把
   * 刚读出来的值再写回去一次（无意义的写）。分开 watch 更清楚。
   */
  watch([mode, mustThreshold, skipThreshold], () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rules.value))
    } catch {
      // 存不下（隐私模式/配额满）不该让界面崩 —— 只是刷新后丢设置而已
    }
  })

  return {
    mode,
    mustThreshold,
    skipThreshold,
    rules,
    metricLabel,
    metricOf,
    verdictOf,
    reset,
  }
})

/* ══════════════════════════════════════════════════════════════════════
 * 判定结果的中文文案
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 为什么不放在 `shared` 里：那里只能放**类型**（AGENTS.md §5），
 * 而这是运行时常量。也不能从后端下发 —— 因为它描述的是**前端自己算出来的**
 * 结论，后端压根不知道 `verdict` 这个字段的存在。
 *
 * 所以：它是前端自己的文案，就放在前端。
 */
export const VERDICT_LABEL: Readonly<Record<LootVerdict, string>> = {
  must: '必摸',
  maybe: '可摸',
  skip: '跳过',
  unknown: '未知',
}

/** 判定 → Element Plus 的 tag 类型 */
export const VERDICT_TAG_TYPE: Readonly<Record<LootVerdict, 'danger' | 'warning' | 'info'>> = {
  must: 'danger',
  maybe: 'warning',
  skip: 'info',
  unknown: 'info',
}
