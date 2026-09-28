/**
 * 数字与时间的显示格式化。
 *
 * ⚠️ 单独一个文件的原因：这些格式一旦不统一，界面上会出现
 * "34275453" 和 "3427.5万" 混着显示的怪现象。集中在一处才好改。
 */

/**
 * 哈夫币金额 —— 按中文习惯用"万 / 亿"缩写。
 *
 * 为什么不用 `toLocaleString` 直接给千分位：
 * 单格价值动辄上千万（海洋之泪 34,275,453），一屏全是长数字根本没法扫读。
 * 缩写之后 "3427.5万" 一眼就能比大小。
 *
 * 想看清确切数字时用 `formatExact`（放在 tooltip 里）。
 */
export function formatMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return n.toLocaleString('zh-CN')
}

/** 精确数字（千分位），用于 tooltip 和展开详情 */
export function formatExact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN')
}

/**
 * "数据有多旧" → 人话。
 *
 * ⚠️ 全部用"以前"而不是"以后"的说法：数据只能来自过去。
 *    而且一定要显示这个 —— 价格 5 分钟就变，不显示就是让用户
 *    拿一个不知道哪来的数字做决策。
 */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '未知'
  if (seconds < 10) return '刚刚'
  if (seconds < 60) return `${Math.round(seconds)} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} 小时前`
  return `${(seconds / 86400).toFixed(1)} 天前`
}

/**
 * 涨幅百分比 → 带符号的字符串。
 *
 * `null` 显示 `—` 并在界面上标注"历史积累中" ——
 * 因为 v1 的历史数据是自己一轮一轮攒的，刚装上时还没有昨日数据。
 */
export function formatChangePct(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '—'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

/** 万 / 亿 的阈值，供界面做"这个数字该用什么颜色"的判断 */
export const MONEY_HUGE = 1e8
export const MONEY_LARGE = 1e4
