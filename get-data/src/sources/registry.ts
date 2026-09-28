/**
 * 物品主数据源注册表。
 *
 * ⭐ 加一个新物品源的完整步骤就两步：
 *   1. 写一个实现 `ItemSource` 接口的文件（照抄 official.ts 的结构）
 *   2. 在这个对象里加一行
 *
 * 前端、API、存储、指标计算 —— 全部零改动。
 */

import type { ItemSourceId } from '@deltaforce/shared'
import { officialItemSource } from './official'
import type { ItemSource } from './types'

const REGISTRY: Record<ItemSourceId, ItemSource> = {
  official: officialItemSource,
}

/** 按 id 取适配器；id 非法时给出明确的可读错误 */
export function getItemSource(id: ItemSourceId): ItemSource {
  const source = REGISTRY[id]
  if (!source) {
    throw new Error(
      `未知的物品主数据源："${id}"。可用：${Object.keys(REGISTRY).join(' / ')}`,
    )
  }
  return source
}

export function listItemSources(): ItemSource[] {
  return Object.values(REGISTRY)
}
