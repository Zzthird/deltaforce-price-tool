/**
 * 人工「物品属性」标注 —— 读取、校验、合并。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这里装三个官方数据**不提供**、只能人工标注的属性
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  ① `availability` 可获得性 —— 能不能在局内摸到
 *       · 可摸（默认）/ 不可摸（只能兑换·制造·任务奖励）/ 已失效（活动结束）
 *
 *  ② `listable` 能不能上架交易行
 *       · 默认可以。为 false 的例子：**旧赛季子弹** —— 交易行上能看到价格，
 *         但那个价格你拿不到，只能卖军需处。
 *       · ⚠️ 这是"**物品类型本身**能不能上架"（类型级），
 *         不是"从交易行买来的实例被标记为绑定"（实例级）——
 *         后者对摸金没影响，因为从地上摸到的东西从来不是绑定的。
 *
 *  ③ `unitsPerSlot` 一个格子放几个定价单位
 *       · 普通物品 1；**子弹 = 每组发数（60 或 90）**
 *       · ⚠️ 因弹而异，同一口径都可能不同（实测 `6.8x51mm Hybrid` 是 60、
 *         `6.8*51mm PLY-III` 是 90），所以只能一个一个标。
 *       · 不标就是**未知** → 单格价值算不出来（宁可显示"待补"，
 *         也不要给一个错得很像对的数字）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 设计上与之前一致
 * ═══════════════════════════════════════════════════════════════════════
 *   · 键可以是物品名或官方 objectID，ID 优先
 *   · `load*` 碰文件系统，`apply*` 是纯函数（好测、便于将来搬到网页端）
 *   · 容错优先：格式错误只跳过那一条，绝不让服务挂掉
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ItemAvailability, SeasonalMark } from '@deltaforce/shared'
import { AMMO_CATEGORY_CODE, DEFAULT_AVAILABILITY, DEFAULT_UNITS_PER_SLOT, SEASONAL_CN } from '../constants'
import type { SourceItem } from '../sources/types'
import type { OverrideProblem } from './types'

/* ══════════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════════ */

/** 一条人工标注。所有字段都可选 —— 你只标注你知道的那部分。 */
export interface ItemAttributeEntry {
  availability?: ItemAvailability
  listable?: boolean
  /** 一个格子放几个定价单位（子弹 = 每组发数） */
  unitsPerSlot?: number
  /**
   * 赛季限定标记。
   * ⚠️ 设置了它之后，`availability` 与 `listable` 会**自动推导** ——
   * 除非你同时显式写了那两个字段（显式优先，用于处理例外）。
   */
  seasonal?: SeasonalMark
  /** 标注理由，可选。写下来以后自己看得懂。 */
  note?: string | null
}

export interface ItemAttributesOverrides {
  entries: Map<string, ItemAttributeEntry>
  rawKeyCount: number
}

export interface ItemAttributesLoadResult {
  overrides: ItemAttributesOverrides
  missing: boolean
  problems: OverrideProblem[]
}

/** 某个物品合并后的属性 */
export interface AppliedItemAttributes {
  availability: ItemAvailability
  listable: boolean
  /** null = 未知（主要出现在没标每组发数的弹药上） */
  unitsPerSlot: number | null
  /** 赛季限定标记；null = 不是赛季限定 */
  seasonal: SeasonalMark | null
  note: string | null
  /** 是否有任何人工标注 */
  manual: boolean
}

export interface ApplyAttributesStats {
  totalItems: number
  overrideCount: number
  applied: number
  matchedById: number
  matchedByName: number
  lootable: number
  unobtainable: number
  expired: number
  /** 不可上架交易行的数量 */
  notListable: number
  /** 单格价值算不出来的数量（主要是没标每组发数的弹药） */
  unitsUnknown: number
  /** 标为「本季」的数量 */
  seasonalCurrent: number
  /** 标为「往季」的数量 */
  seasonalPast: number
  unmatchedKeys: string[]
}

export interface ApplyAttributesResult {
  byItemId: Map<string, AppliedItemAttributes>
  stats: ApplyAttributesStats
}

/* ══════════════════════════════════════════════════════════════════════
 * 各字段的宽容解析（也供 CSV 导入用）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 可获得性的等价写法。宽容接受 —— 你在 Excel 里怎么写都能认出来。
 *
 * ⚠️ 重点在这两组要分清：
 *   「限时下架」= 曾经能拾，现在不能，**可能返场**（旧赛季子弹）
 *   「非战利品」= 机制上不产出，**不随赛季变化**（只能兑换的道具）
 * 旧叫法（已失效 / 不可摸）仍然认，但它们没表达“会不会回来”，不推荐再用。
 */
const AVAILABILITY_ALIASES: Readonly<Record<string, ItemAvailability>> = {
  // ── 可摸（默认）────────────────────────────────
  可摸: 'lootable',
  正常: 'lootable',
  能摸: 'lootable',
  能摸到: 'lootable',
  ok: 'lootable',
  lootable: 'lootable',
  '0': 'lootable',

  // ── 限时下架：可能返场（赛季/活动结束）────────
  限时下架: 'expired',
  下架: 'expired',
  赛季结束: 'expired',
  赛季限定: 'expired',
  活动限定: 'expired',
  活动结束: 'expired',
  // 旧叫法（仍认，但不推荐 —— 没表达“可能返场”）
  已失效: 'expired',
  失效: 'expired',
  已下架: 'expired',
  expired: 'expired',
  '2': 'expired',

  // ── 非战利品：机制上不产出，不随赛季变化 ──────
  非战利品: 'unobtainable',
  不可拾取: 'unobtainable',
  不是战利品: 'unobtainable',
  只能兑换: 'unobtainable',
  兑换: 'unobtainable',
  制造: 'unobtainable',
  任务奖励: 'unobtainable',
  // 旧叫法（仍认，但不推荐）
  不可摸: 'unobtainable',
  摸不到: 'unobtainable',
  不能摸: 'unobtainable',
  unobtainable: 'unobtainable',
  '1': 'unobtainable',
}

/** @returns 认不出来时返回 null（调用方据此报警告并跳过，而不是猜） */
export function parseAvailability(raw: string): ItemAvailability | null {
  const v = raw.trim()
  if (v === '') return null
  return AVAILABILITY_ALIASES[v] ?? AVAILABILITY_ALIASES[v.toLowerCase()] ?? null
}

/**
 * 解析“能不能上架交易行”。
 *
 * ⚠️ 先判断**否定**，因为「不可上架」同时包含「不」和「可」——
 *    顺序反了就会把“不可上架”当成“可上架”。
 *    （这个 bug 是真实发生的：用户填了 278 行「不可上架」，全被忽略）
 *
 * @returns `null` 表示**没填**（沿用默认值“可上架”）
 */
export function parseListable(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return null

  // 先看否定
  if (v === '0' || v === 'x' || v === 'no' || v === 'false') return false
  if (/不|否|no|false/.test(v)) return false

  // 再看肯定
  if (v === '1' || v === 'y' || v === 'yes' || v === 'true') return true
  if (/可|能|是|yes|true/.test(v)) return true

  return null
}

/** 解析“每组发数”。非正整数一律当作没填。 */
export function parseUnitsPerSlot(raw: string): number | null {
  const v = raw.trim()
  if (v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.trunc(n)
}

/**
 * 解析“赛季限定”列。
 *
 * ⚠️ 它**适用于任何物品**（不只是子弹）—— 赛季弹药、赛季限定战利品、
 *    活动限定收集品…… 都可以用它。
 *
 * @returns `null` 表示**不是赛季限定**（留空）或认不出来
 */
export function parseSeasonal(raw: string): SeasonalMark | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  if (['本季', '本赛季', '当前赛季', '本季限定', '本季弹', 'current', 'now', '1'].includes(v)) {
    return 'current'
  }
  if (['往季', '上季', '旧赛季', '往季限定', '往季弹', '过去', 'past', 'old', '0'].includes(v)) {
    return 'past'
  }
  return null
}

/**
 * 从赛季限定标记推导出“可获得性”与“能不能上架”。
 *
 * ⭐ **这就是“换季自动更新”的全部逻辑** —— 只在这里实现一次。
 * 换季时只需跑 `npm run season:rollover` 把本季改成往季，
 * 这两个属性就会自动跟着变。
 *
 * @returns 不是赛季限定时返回 `null`（由默认值决定）
 */
export function deriveFromSeasonal(
  seasonal: SeasonalMark | null,
): { availability: ItemAvailability; listable: boolean } | null {
  if (seasonal === 'current') return { availability: 'lootable', listable: true }
  if (seasonal === 'past') return { availability: 'expired', listable: false }
  return null
}

/** 提供给控制台的可填写值提示 */
export function attributeHints(): string {
  return (
    '可获得性：可摸（留空）/ 限时下架（可能返场）/ 非战利品（机制上不产出）　·　' +
    '上架：留空 = 可上架，写「否」= 不可上架'
  )
}

/**
 * 每格单位数的默认规则 —— **只在这里实现一次**。
 *
 *   · 人工标注了就用它
 *   · 非弹药 → 1（一个格子放一个物品，永远成立）
 *   · 弹药 → **null（未知）**，没标注就算不出来
 *
 * 单独导出是因为 normalize 在“根本没有标注记录”时也要用同一套规则。
 */
export function resolveUnitsPerSlot(
  categoryCode: string,
  /** 接受两种形状：原始标注条目、或已合并的属性（后者 unitsPerSlot 可能是 null） */
  entry: { unitsPerSlot?: number | null } | undefined,
): number | null {
  const declared = entry?.unitsPerSlot
  if (typeof declared === 'number') return declared
  return categoryCode === AMMO_CATEGORY_CODE ? null : DEFAULT_UNITS_PER_SLOT
}

/* ══════════════════════════════════════════════════════════════════════
 * 读取 + 校验
 * ══════════════════════════════════════════════════════════════════════ */

const FullFormSchema = z.object({
  availability: z.enum(['lootable', 'unobtainable', 'expired']).optional(),
  listable: z.boolean().optional(),
  unitsPerSlot: z.number().int().positive().optional(),
  seasonal: z.enum(['current', 'past']).optional(),
  note: z.string().nullish(),
})

export async function loadItemAttributesOverrides(
  path: string,
): Promise<ItemAttributesLoadResult> {
  const problems: OverrideProblem[] = []
  const empty: ItemAttributesOverrides = { entries: new Map(), rawKeyCount: 0 }

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { overrides: empty, missing: true, problems: [] }
    }
    return {
      overrides: empty,
      missing: false,
      problems: [{ key: null, message: `读取物品属性文件失败：${(err as Error).message}` }],
    }
  }

  if (text.trim() === '') return { overrides: empty, missing: false, problems: [] }

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    return {
      overrides: empty,
      missing: false,
      problems: [
        {
          key: null,
          message:
            `物品属性文件 JSON 语法错误（已跳过全部标注，全部按默认值处理）：` +
            `${(err as Error).message}`,
        },
      ],
    }
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      overrides: empty,
      missing: false,
      problems: [{ key: null, message: '物品属性文件的顶层必须是一个对象，已跳过全部标注' }],
    }
  }

  const record = json as Record<string, unknown>
  const entries = new Map<string, ItemAttributeEntry>()
  const rawKeys = Object.keys(record)

  for (const key of rawKeys) {
    const value = record[key]

    // 简写：直接给状态字符串（只标可获得性时用）
    if (typeof value === 'string') {
      const availability = parseAvailability(value)
      if (!availability) {
        problems.push({
          key,
          message: `认不出状态 "${value}"（可用：可摸 / 不可摸 / 已失效），已跳过这一条`,
        })
        continue
      }
      entries.set(key, { availability })
      continue
    }

    const parsed = FullFormSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      problems.push({
        key,
        message:
          `格式不对（应为状态字符串，或 {availability, listable, unitsPerSlot, note} 对象）：` +
          `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}。已跳过这一条`,
      })
      continue
    }

    const entry: ItemAttributeEntry = {}
    if (parsed.data.availability !== undefined) entry.availability = parsed.data.availability
    if (parsed.data.listable !== undefined) entry.listable = parsed.data.listable
    if (parsed.data.unitsPerSlot !== undefined) entry.unitsPerSlot = parsed.data.unitsPerSlot
    if (parsed.data.seasonal !== undefined) entry.seasonal = parsed.data.seasonal
    if (parsed.data.note !== undefined) entry.note = parsed.data.note ?? null

    if (
      entry.availability === undefined &&
      entry.listable === undefined &&
      entry.unitsPerSlot === undefined &&
      entry.seasonal === undefined &&
      entry.note === undefined
    ) {
      problems.push({ key, message: '这一条什么属性都没标，已跳过' })
      continue
    }

    entries.set(key, entry)
  }

  return { overrides: { entries, rawKeyCount: rawKeys.length }, missing: false, problems }
}

/* ══════════════════════════════════════════════════════════════════════
 * 合并（纯函数）
 * ══════════════════════════════════════════════════════════════════════ */

export function applyItemAttributesOverrides(
  items: readonly SourceItem[],
  overrides: ItemAttributesOverrides,
): ApplyAttributesResult {
  const byItemId = new Map<string, AppliedItemAttributes>()
  const unmatched = new Set(overrides.entries.keys())

  let applied = 0
  let matchedById = 0
  let matchedByName = 0
  let unobtainable = 0
  let expired = 0
  let notListable = 0
  let unitsUnknown = 0
  let seasonalCurrent = 0
  let seasonalPast = 0

  for (const item of items) {
    let entry: ItemAttributeEntry | undefined
    let matchedBy: 'id' | 'name' | null = null

    const byId = overrides.entries.get(item.sourceItemId)
    if (byId) {
      entry = byId
      matchedBy = 'id'
    } else {
      const byName = overrides.entries.get(item.name)
      if (byName) {
        entry = byName
        matchedBy = 'name'
      }
    }

    if (entry) {
      applied += 1
      unmatched.delete(matchedBy === 'id' ? item.sourceItemId : item.name)
      if (matchedBy === 'id') matchedById += 1
      else matchedByName += 1
    }

    const seasonal: SeasonalMark | null = entry?.seasonal ?? null

    /**
     * ⭐ **显式标注 > 赛季推导 > 默认值**
     *
     * 推导这一步就是“换季自动更新”的全部逻辑：
     * 本季 → 可摸 + 可上架；往季 → 限时下架 + 不可上架。
     * 所以换季时只需把当前赛季那批 seasonal 从 current 改成 past。
     */
    const derived = deriveFromSeasonal(seasonal)
    const availability = entry?.availability ?? derived?.availability ?? DEFAULT_AVAILABILITY
    const listable = entry?.listable ?? derived?.listable ?? true

    /**
     * ⭐ 每格单位数：非弹药默认 1；弹药无标注则为 null（未知）。
     * 规则只在 `resolveUnitsPerSlot` 里实现一次。
     */
    const unitsPerSlot = resolveUnitsPerSlot(item.categoryCode, entry)

    if (availability === 'unobtainable') unobtainable += 1
    if (availability === 'expired') expired += 1
    if (!listable) notListable += 1
    if (unitsPerSlot === null) unitsUnknown += 1
    if (seasonal === 'current') seasonalCurrent += 1
    if (seasonal === 'past') seasonalPast += 1

    byItemId.set(item.sourceItemId, {
      availability,
      listable,
      unitsPerSlot,
      seasonal,
      note: entry?.note ?? null,
      manual: entry !== undefined,
    })
  }

  const lootable = items.length - unobtainable - expired

  return {
    byItemId,
    stats: {
      totalItems: items.length,
      overrideCount: overrides.entries.size,
      applied,
      matchedById,
      matchedByName,
      lootable,
      unobtainable,
      expired,
      notListable,
      unitsUnknown,
      seasonalCurrent,
      seasonalPast,
      unmatchedKeys: [...unmatched],
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 一致性检查
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 检查“赛季限定标记”与“显式写的 availability / listable”是否矛盾。
 *
 * ⭐ 这个检查的意义：防止你**改了一列忘了改另一列**。
 * 例：你把一颗往季改成 `listable: true`（因为它返场了），
 * 却忘了把 seasonal 从 `past` 改成 `current` —— 下一季 rollover 时
 * 它又会被推回“不可上架”，你会很困惑为什么。
 *
 * ⚠️ 只报告、不阻拦 —— 显式写法有合法用途（处理例外）。
 *
 * ⭐ **写了备注就不提醒**：备注本来就是“标注理由”字段，
 *    有理由 = 你解释过了 = 有意为之。
 *    没有这一条的话，一个合理的例外会被每次抓取都提醒一遍，很快就变成噪声。
 */
export function checkAttributeConflicts(
  overrides: ItemAttributesOverrides,
): OverrideProblem[] {
  const problems: OverrideProblem[] = []

  for (const [key, entry] of overrides.entries) {
    if (!entry.seasonal) continue
    // 你已经在备注里解释过了 —— 不再打扰
    if (entry.note) continue

    const derived = deriveFromSeasonal(entry.seasonal)
    if (!derived) continue
    const label = SEASONAL_CN[entry.seasonal] ?? entry.seasonal

    if (entry.listable !== undefined && entry.listable !== derived.listable) {
      problems.push({
        key,
        message:
          `标了「${label}」（按规则应${derived.listable ? '可' : '不可'}上架交易行），` +
          `但又显式写了 listable=${entry.listable} —— 以**显式写的**为准。` +
          `如果这是有意为之，在备注里写一句原因即可不再提醒；否则请把两处改成一致`,
      })
    }
    if (entry.availability !== undefined && entry.availability !== derived.availability) {
      problems.push({
        key,
        message:
          `标了「${label}」（按规则应${derived.availability === 'lootable' ? '可摸' : '不可摸'}），` +
          `但又显式写了 availability="${entry.availability}" —— 以**显式写的**为准。` +
          `如果这是有意为之，在备注里写一句原因即可不再提醒；否则请把两处改成一致`,
      })
    }
  }

  return problems
}

/* ══════════════════════════════════════════════════════════════════════
 * 序列化（给 CSV 回写脚本用）
 * ══════════════════════════════════════════════════════════════════════ */

export function serializeItemAttributesOverrides(overrides: ItemAttributesOverrides): string {
  const out: Record<string, ItemAttributeEntry> = {}
  const keys = [...overrides.entries.keys()].sort((a, b) => a.localeCompare(b, 'zh'))
  for (const key of keys) {
    const entry = overrides.entries.get(key)
    if (!entry) continue
    const clean: ItemAttributeEntry = {}
    if (entry.availability !== undefined) clean.availability = entry.availability
    if (entry.listable !== undefined) clean.listable = entry.listable
    if (entry.unitsPerSlot !== undefined) clean.unitsPerSlot = entry.unitsPerSlot
    if (entry.seasonal !== undefined) clean.seasonal = entry.seasonal
    if (entry.note) clean.note = entry.note
    out[key] = clean
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
