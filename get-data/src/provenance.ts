/**
 * 出产地解析与展开。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么只保留地图名（不保留点位）
 * ═══════════════════════════════════════════════════════════════════════
 * 官方原始值形如 `"长弓溪谷-钻石皇后酒店,航天基地-核心区"`。
 * 但实测下来**点位信息不可靠**：
 *
 *   · 很多全图都能刷的物资，官方只标了某几个"核心区"
 *   · 还有脏数据：`"-AZ3"`（前置横线，地图名编码坏了）
 *
 * 显示一个不可靠的精确信息，比不显示更糟 —— 你会按它跑去水泥厂找一个
 * 其实刷在别处的东西。所以这里把点位截断掉，**只保留地图名**。
 *
 * 原始串仍然完整保留在 `Item.propsDetail.propsSource` 里，将来想恢复
 * 细粒度随时可以。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么这段逻辑只有一份实现
 * ═══════════════════════════════════════════════════════════════════════
 * 因为要处理脏数据。如果让前端也去解析原始串，容错规则就会有两份，
 * 改一处忘一处。所以切分、清洗、展开全部在后端做完，
 * 下发给网页的是已经**可以直接 `includes()` 判断**的干净数组。
 */

import { PROVENANCE_ALL_MAPS } from './constants'

/** 去掉首尾的分隔符与空白（半角/全角横线、颅号、竖线、分号、斜线） */
function trimDashesAndSpace(s: string): string {
  return s.replace(/^[\s\u3000\-—－、|;；/／]+|[\s\u3000\-—－、|;；/／]+$/g, '').trim()
}

/** 按横线找分隔位置（半角 - / 全角 — / － 都算） */
function findDashIndex(s: string): number {
  return s.search(/[-—－]/)
}

function dedupeSorted(names: readonly string[]): string[] {
  const set = new Set(names.filter((n) => n.length > 0))
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
}

/**
 * 把官方的原始出产地字符串解析成**地图名数组**。
 *
 * 解析规则（顺序很重要）：
 *   1. 按逗号切成多段
 *   2. 每段**先去掉首尾的 `-` 和空白** ← 这一步修掉 `"-AZ3"` 这种脏值
 *   3. 去完还有横线 → 横线前就是地图名（后面的点位**丢弃**）
 *      去完没横线   → 整段就是地图名（例："全地图"、"AZ3"）
 *   4. 去重 + 按拼音排序
 *
 * @returns 解析不出任何有效地图时返回 `null`（而不是空数组）。
 *          因为 `null` 的语义是"没有数据"，空数组会让人误以为"确认过没有"。
 */
export function parseProvenanceMaps(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null

  const maps: string[] = []
  for (const chunk of raw.split(',')) {
    const cleaned = trimDashesAndSpace(chunk)
    if (cleaned.length === 0) continue

    const dash = findDashIndex(cleaned)
    if (dash > 0) {
      // 有横线：横线前是地图名，后面的点位丢弃
      maps.push(trimDashesAndSpace(cleaned.slice(0, dash)))
    } else {
      // 没横线：整段就是地图名（可能是 "全地图" 这个特殊值）
      maps.push(cleaned)
    }
  }

  const result = dedupeSorted(maps)
  return result.length > 0 ? result : null
}

/**
 * 展开特殊值 `全地图`。
 *
 * 把 `["全地图"]` 变成 `["巴克什", "潮汐监狱", ...]`（即所有已知地图）。
 * 这样网页只需要 `maps.includes(选中的地图)`，不必知道特殊值的存在 ——
 * 地图筛选的规则就只有一份实现（就是这一行 includes）。
 *
 * @param allMapNames 数据里出现过的所有具体地图名（不含特殊值本身）
 */
export function expandAllMaps(
  maps: readonly string[] | null,
  allMapNames: readonly string[],
): string[] | null {
  if (maps === null) return null

  const concrete = maps.filter((m) => m !== PROVENANCE_ALL_MAPS)
  const hasAllMaps = maps.length !== concrete.length

  if (!hasAllMaps) {
    const result = dedupeSorted(concrete)
    return result.length > 0 ? result : null
  }

  const expanded = dedupeSorted([...concrete, ...allMapNames])
  // 兜底：如果整个数据集里都没有任何具体地图名，就没法展开
  // （理论上不可能发生：官方有 323 条带具体地图的数据）
  return expanded.length > 0 ? expanded : null
}

/**
 * 收集一批物品里出现过的**所有具体地图名**（不含特殊值）。
 * 这是 `/api/meta` 的 `maps` 选项的数据来源，也是 `expandAllMaps` 的输入。
 */
export function collectMapNames(
  items: readonly { rawProvenance: string | null }[],
): string[] {
  const set = new Set<string>()
  for (const item of items) {
    const maps = parseProvenanceMaps(item.rawProvenance)
    if (!maps) continue
    for (const m of maps) {
      if (m !== PROVENANCE_ALL_MAPS) set.add(m)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
}

/**
 * 判断某物资是否**已确认**会在指定地图刷出。
 *
 * 注意：这个函数是给测试与后端内部用的说明性实现；
 * 由于 `expandAllMaps` 已经把特殊值展开，网页端只需一句
 * `maps?.includes(mapName) ?? false` 即可，语义完全一致。
 */
export function isConfirmedOnMap(
  maps: readonly string[] | null,
  mapName: string,
): boolean {
  if (maps === null) return false
  return maps.includes(mapName) || maps.includes(PROVENANCE_ALL_MAPS)
}
