/**
 * 物品的展示派生 —— 从 `Item` 算出"该显示成什么"。
 *
 * ⚠️ 为什么抽成纯函数而不是写在模板里：
 * 模板里的三元套三元既难读、也**测不到**。而"出产地该显示成三态"
 * 这种规则恰恰是最需要钉住的 —— 三态的边界（通用 / 特产 / 待补）
 * 一旦弄错，用户会看到"每张图都出"被显示成"没数据"，
 * 而那两句话的下一步行动完全不同。
 */

import type { Item } from '@deltaforce/shared'

/** 出产地一列的三种状态 */
export type ProvenanceKind =
  /** 通用物资：每张图都能刷到（实测 1564 条里有 1297 条是这种）*/
  | 'universal'
  /** 特产：只知道它出在几张图上 */
  | 'maps'
  /** 待补：没有任何出产地数据 */
  | 'missing'

export interface ProvenanceDisplay {
  kind: ProvenanceKind
  /** 单元格里显示的短文本 */
  text: string
  /** 悬浮提示里的完整文本 */
  full: string
}

/**
 * 出产地一列该怎么显示。
 *
 * ⭐ 三态的来源与理由：
 *
 * | 状态 | 数据 | 显示 | 为什么 |
 * |---|---|---|---|
 * | universal | `provenanceUniversal === true` | 淡灰「通用」| **不能显示成 6 个图名** —— 1297 条通用物资会把这一列填满同样的字串，等于没信息 |
 * | maps | 有明确地图列表 | 地图名 | 只有**特产**才显示地图，这样一眼能扫出"这张图特有的东西" |
 * | missing | `provenanceMaps === null` | 淡灰「待补」| **必须与「通用」区分**：前者是"我们不知道"，后者是"每张图都出" |
 *
 * 这正是用户的要求：「在表格中默认不显示"全地图"字样，只有地图特产显示地图」。
 */
export function describeProvenance(item: Item): ProvenanceDisplay {
  if (item.provenanceUniversal) {
    return { kind: 'universal', text: '通用', full: '通用物资 —— 每张地图都可能刷出' }
  }

  const maps = item.provenanceMaps
  if (maps === null || maps.length === 0) {
    return { kind: 'missing', text: '待补', full: '还没有出产地数据（没有标注，不代表不会出）' }
  }

  /**
   * 只列 2 张图，其余用"等 N 张"。
   * 列宽只有 ~170px，铺开 6 个图名会把这列撑爆，也会让相邻行的地图名
   * 看起来一样（前两个总是相同）—— 反而更难扫。
   * 完整列表放悬浮提示里。
   */
  const brief = maps.length <= 2 ? maps.join('、') : `${maps.slice(0, 2).join('、')} 等 ${maps.length} 张`
  return { kind: 'maps', text: brief, full: maps.join('、') }
}

/**
 * 今日涨幅的显示。
 *
 * ⚠️ 颜色约定用**中国习惯：红涨绿跌**（与 A 股一致），不是国际的绿涨红跌。
 * 返回色值而不是类名，是因为色值来自后端的品质调色板体系，
 * 这里用两个固定的语义色就够（不参与品质色）。
 */
export interface ChangeDisplay {
  text: string
  /** 正负号对应的语义，组件据此选颜色 */
  tone: 'up' | 'down' | 'flat' | 'none'
}

export function describeChange(pct: number | null): ChangeDisplay {
  if (pct === null || !Number.isFinite(pct)) return { text: '—', tone: 'none' }
  if (pct > 0) return { text: `+${pct.toFixed(1)}%`, tone: 'up' }
  if (pct < 0) return { text: `${pct.toFixed(1)}%`, tone: 'down' }
  return { text: '0.0%', tone: 'flat' }
}
