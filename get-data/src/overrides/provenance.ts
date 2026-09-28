/**
 * 人工出产地覆盖 —— 读取、校验、合并。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ═══════════════════════════════════════════════════════════════════════
 * 官方 `propsSource` 实测只覆盖 323/586 = **55%** 的收集品，而且
 * **钥匙类 80 条一条都没有** —— 而钥匙恰好是单格价值最高的那批。
 * 所以「按地图看」这个功能能不能用，取决于你能不能手工补数据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要拆成「读文件」与「合并」两个函数
 * ═══════════════════════════════════════════════════════════════════════
 *   ① 好测 —— `applyProvenanceOverrides` 是纯函数，单测不用 mock 文件系统
 *   ② 为将来的网页端编辑留门 —— 那时只需再加一个写文件的接口，
 *      **合并逻辑一行不用改**
 *   ③ 符合项目总原则：读写与计算分离
 *
 * Python 类比：`load_*` 相当于读 JSON 文件 + pydantic 校验；
 *              `apply_*` 相当于一个 pandas 的 map 操作，无副作用。
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ProvenanceSource } from '@deltaforce/shared'
import { PROVENANCE_ALL_MAPS } from '../constants'
import { parseProvenanceMaps } from '../provenance'
import type { SourceItem } from '../sources/types'
import type { OverrideProblem } from './types'

/* ══════════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════════ */

export type OverrideMode = 'replace' | 'append'

export interface ProvenanceOverrideEntry {
  mode: OverrideMode
  /** 地图名数组。可以包含特殊值「全地图」。 */
  sources: string[]
}

export interface ProvenanceOverrides {
  /** 键（物品名或官方 objectID）→ 覆盖规则 */
  entries: Map<string, ProvenanceOverrideEntry>
  /** 覆盖文件里原本有多少个键（含校验失败的） */
  rawKeyCount: number
}

/** 某个物品合并后的出产地结果 */
export interface AppliedProvenance {
  /** 合并后的地图名数组；`null` 表示没有数据或已被显式删除 */
  maps: string[] | null
  source: ProvenanceSource | null
}

/** @deprecated 用 `OverrideProblem` 代替（两个覆盖模块共用同一个形状） */
export type ProvenanceProblem = OverrideProblem

export interface LoadResult {
  overrides: ProvenanceOverrides
  /** 文件不存在（首次运行时就是这个状态，不算错误） */
  missing: boolean
  problems: ProvenanceProblem[]
}

export interface ApplyStats {
  totalItems: number
  /** 覆盖文件里的条目数 */
  overrideCount: number
  /** 实际命中了物品的覆盖条目数 */
  applied: number
  /** 其中用 objectID 命中的 */
  matchedById: number
  /** 其中用物品名命中的 */
  matchedByName: number
  /** 沿用官方值的物品数 */
  keptOfficial: number
  /** 补充后从"无数据"变成"有数据"的物品数 ⭐ 这是补数据的直接成果 */
  newlyFilled: number
  /** 被显式删除出产地的物品数 */
  explicitlyCleared: number
  /** 覆盖文件里没匹配上任何物品的键 */
  unmatchedKeys: string[]
  problems: ProvenanceProblem[]
}

export interface ApplyResult {
  /** sourceItemId → 合并后的出产地 */
  byItemId: Map<string, AppliedProvenance>
  stats: ApplyStats
}

/* ══════════════════════════════════════════════════════════════════════
 * 读取 + 校验
 * ══════════════════════════════════════════════════════════════════════ */

const FullFormSchema = z.object({
  mode: z.enum(['replace', 'append']),
  sources: z.array(z.string()),
})

/**
 * 读取并校验覆盖文件。
 *
 * **容错原则：覆盖文件是手写产物，一定要假设它会写错，而写错时绝不能让服务挂掉。**
 *   · 文件不存在       → 静默跳过（首次运行就是这个状态）
 *   · JSON 语法错误    → 明确报错，但**跳过全部覆盖**，用官方值继续跑
 *   · 单个键格式不对   → 只跳过那一条，其余照常生效
 */
export async function loadProvenanceOverrides(path: string): Promise<LoadResult> {
  const problems: ProvenanceProblem[] = []
  const empty: ProvenanceOverrides = { entries: new Map(), rawKeyCount: 0 }

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return { overrides: empty, missing: true, problems: [] }
    }
    return {
      overrides: empty,
      missing: false,
      problems: [{ key: null, message: `读取覆盖文件失败：${(err as Error).message}` }],
    }
  }

  if (text.trim() === '') {
    return { overrides: empty, missing: false, problems: [] }
  }

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
            `覆盖文件 JSON 语法错误（已跳过全部覆盖，官方数据照常使用）：` +
            `${(err as Error).message}`,
        },
      ],
    }
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      overrides: empty,
      missing: false,
      problems: [
        { key: null, message: '覆盖文件的顶层必须是一个对象（JSON Object），已跳过全部覆盖' },
      ],
    }
  }

  const record = json as Record<string, unknown>
  const entries = new Map<string, ProvenanceOverrideEntry>()
  const rawKeys = Object.keys(record)

  for (const key of rawKeys) {
    const value = record[key]

    // 简写：直接给数组 → 等价于 replace
    if (Array.isArray(value)) {
      if (!value.every((v) => typeof v === 'string')) {
        problems.push({ key, message: '简写形式的数组里必须全是字符串，已跳过这一条' })
        continue
      }
      entries.set(key, { mode: 'replace', sources: value as string[] })
      continue
    }

    // 完整形式：{ mode, sources }
    const parsed = FullFormSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      problems.push({
        key,
        message:
          `格式不对（应为 数组 或 {mode:"replace"|"append", sources:[...]}）：` +
          `${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}。已跳过这一条`,
      })
      continue
    }
    entries.set(key, { mode: parsed.data.mode, sources: parsed.data.sources })
  }

  return {
    overrides: { entries, rawKeyCount: rawKeys.length },
    missing: false,
    problems,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 合并（纯函数）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把人工覆盖合并到物品上。
 *
 * 合并规则：
 *
 *   | 情况                  | 结果                  | source     |
 *   |-----------------------|-----------------------|------------|
 *   | 无覆盖                | 官方值                | official   |
 *   | 覆盖 mode=replace     | 人工值                | manual     |
 *   | 覆盖 mode=append      | 官方 ∪ 人工（去重）    | merged     |
 *   | 覆盖且 sources 为空   | null（显式删除）      | manual     |
 *   | 无覆盖且官方也无数据  | null                  | null       |
 *
 * **这个函数是纯函数** —— 不碰文件、不读环境变量、不写日志、不改入参。
 * 所以单测可以直接喂数据断言输出，不需要任何 mock。
 *
 * 注意：人工写的 sources 也会走一遍 `parseProvenanceMaps`，
 * 所以你就算按习惯写了 `"长弓溪谷-水泥厂"`，点位也会被自动截断掉 ——
 * 解析规则只有一份实现。
 */
export function applyProvenanceOverrides(
  items: readonly SourceItem[],
  overrides: ProvenanceOverrides,
): ApplyResult {
  const byItemId = new Map<string, AppliedProvenance>()
  const unmatched = new Set(overrides.entries.keys())
  let applied = 0
  let matchedById = 0
  let matchedByName = 0
  let keptOfficial = 0
  let newlyFilled = 0
  let explicitlyCleared = 0

  for (const item of items) {
    const officialMaps = parseProvenanceMaps(item.rawProvenance)

    // 查找顺序：objectID 优先，其次物品名
    // （objectID 不怕官方改名，可以作为"钉子"）
    let entry: ProvenanceOverrideEntry | undefined
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

    if (!entry) {
      // 没有覆盖：沿用官方值
      if (officialMaps) keptOfficial += 1
      byItemId.set(item.sourceItemId, {
        maps: officialMaps,
        source: officialMaps ? 'official' : null,
      })
      continue
    }

    applied += 1
    unmatched.delete(matchedBy === 'id' ? item.sourceItemId : item.name)
    if (matchedBy === 'id') matchedById += 1
    else matchedByName += 1

    // 人工值也走一遍解析（容忍写了点位、全角横线等）
    const manualMaps = entry.sources.length > 0
      ? parseProvenanceMaps(entry.sources.join(','))
      : null

    if (manualMaps === null) {
      // 显式删除
      explicitlyCleared += 1
      byItemId.set(item.sourceItemId, { maps: null, source: 'manual' })
      continue
    }

    if (entry.mode === 'replace') {
      if (officialMaps === null) newlyFilled += 1
      byItemId.set(item.sourceItemId, { maps: manualMaps, source: 'manual' })
    } else {
      // append：官方 ∪ 人工
      const merged = [...new Set([...(officialMaps ?? []), ...manualMaps])]
        .sort((a, b) => a.localeCompare(b, 'zh'))
      if (officialMaps === null) newlyFilled += 1
      byItemId.set(item.sourceItemId, {
        maps: merged,
        source: officialMaps === null ? 'manual' : 'merged',
      })
    }
  }

  return {
    byItemId,
    stats: {
      totalItems: items.length,
      overrideCount: overrides.entries.size,
      applied,
      matchedById,
      matchedByName,
      keptOfficial,
      newlyFilled,
      explicitlyCleared,
      unmatchedKeys: [...unmatched],
      problems: [],
    },
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 地图名软校验（只警告、不阻拦）
 * ══════════════════════════════════════════════════════════════════════ */

/** 软校验的结果：一个地图名 + 用了它的那些键 */
export interface UnknownMapNameReport {
  mapName: string
  /** 用了这个地图名的覆盖键（最多列 10 个） */
  keys: string[]
  /** 总共多少条覆盖用了它 */
  usedBy: number
}

/**
 * 检查你写的的地图名是否在**官方数据**里出现过。
 *
 * ⭐ 为什么要做这个：地图名是**手打的**，打错很常见
 * （比如把「长弓溪谷」打成「长弓溪」）。而打错之后的表现是
 * “选了这张图，结果漏掉了你标的那批物资” —— 非常难查。
 *
 * ⚠️ **只警告、不阻拦**。因为：
 *   · 将来游戏出新地图，你标上去时它确实“从未出现过”
 *   · 后端不知道游戏里到底有哪些地图，强行校验会拦住合法输入
 *
 * @param officialMapNames **只来自官方数据**的地图名集合。
 *        刻意不包含覆盖文件里自己的名字 —— 否则你写什么它都认为“见过”。
 */
export function validateMapNames(
  overrides: ProvenanceOverrides,
  officialMapNames: readonly string[],
): UnknownMapNameReport[] {
  const known = new Set(officialMapNames)
  const unknown = new Map<string, string[]>()

  for (const [key, entry] of overrides.entries) {
    const names = parseProvenanceMaps(entry.sources.join(',')) ?? []
    for (const name of names) {
      if (name === PROVENANCE_ALL_MAPS) continue
      if (known.has(name)) continue
      const keys = unknown.get(name)
      if (keys) keys.push(key)
      else unknown.set(name, [key])
    }
  }

  return [...unknown.entries()]
    .map(([mapName, keys]) => ({ mapName, keys: keys.slice(0, 10), usedBy: keys.length }))
    .sort((a, b) => b.usedBy - a.usedBy)
}

/* ══════════════════════════════════════════════════════════════════════
 * 序列化（给「CSV 回写」脚本用）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把覆盖对象写成 JSON 文本。
 *
 * 排序让 diff 好看：键按拼音排序，地图名也按拼音排序。
 * **不写简写形式** —— 统一用完整形式，避免以后改 mode 时忘记改写法。
 */
export function serializeProvenanceOverrides(overrides: ProvenanceOverrides): string {
  const out: Record<string, { mode: OverrideMode; sources: string[] }> = {}
  const keys = [...overrides.entries.keys()].sort((a, b) => a.localeCompare(b, 'zh'))
  for (const key of keys) {
    const entry = overrides.entries.get(key)
    if (!entry) continue
    out[key] = {
      mode: entry.mode,
      sources: [...entry.sources].sort((a, b) => a.localeCompare(b, 'zh')),
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
