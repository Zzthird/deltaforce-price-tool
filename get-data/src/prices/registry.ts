/**
 * 价格源注册表。
 *
 * ⭐ 这就是"保留从付费数据帝 API 取数的可能"落地的地方。
 * 将来接数据帝，只需要：
 *   1. 写 `shujudi.ts`，实现 `PriceSource` 接口（拿到 API key，把返回的 JSON
 *      翻译成 `Map<物品名, PriceQuote>`）
 *   2. 在下面 REGISTRY 里加一行
 *   3. `.env` 里改 `PRICE_SOURCE=shujudi`
 *
 * 从 join 到网页渲染，一行都不用改。
 */

import type { PriceSourceId } from '@deltaforce/shared'
import { moligodPriceSource } from './moligod'
import type { PriceSource } from './types'

/**
 * 已实现的价格源。
 *
 * v1 只实现 moligod。预留但尚未实现：
 *   · dergame  —— v1.5 应急备份。明文 JSON，但一轮要约 320 次请求
 *                 （100 条上限可用 type × grade × name 三维拆分绕过，
 *                  实测覆盖官方有价物品 91.3%、摸金核心 99.8%）
 *   · shujudi  —— v2 占位。付费 API，宣称"与游戏内市场同步"
 *
 * `none` 不在这里 —— 它表示"不取价格"，由 getPriceSource 返回 null 表达。
 */
const REGISTRY: Partial<Record<PriceSourceId, PriceSource>> = {
  moligod: moligodPriceSource,
}

/**
 * 按 id 取价格源。
 * `'none'` 或未实现的 id 返回 null —— 调用方据此走"没有价格"的降级路径，
 * 而不是抛错（因为物品主数据仍然可用，不该因为价格源缺失就整体失败）。
 */
export function getPriceSource(id: PriceSourceId): PriceSource | null {
  if (id === 'none') return null
  return REGISTRY[id] ?? null
}

/** 已实现的价格源清单（用于启动时校验配置） */
export function listPriceSources(): PriceSource[] {
  return Object.values(REGISTRY).filter((s): s is PriceSource => s !== undefined)
}

/** 配置里写的价格源是否可用 */
export function isPriceSourceAvailable(id: PriceSourceId): boolean {
  return id === 'none' || REGISTRY[id] !== undefined
}
