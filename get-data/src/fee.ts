/**
 * 交易行手续费公式的**逆向分析** —— 纯函数，全项目唯一实现处。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要这个东西
 * ═══════════════════════════════════════════════════════════════════════
 * 「最高利润」这个需求依赖手续费公式 `fee(P)`。但公开资料互相矛盾
 * （10% / 15% / 10–15% 浮动，保证金的退还规则两个来源直接冲突），
 * **且明确找不到官方费率表**（见 docs/source-recon.md）。
 *
 * 而这里有个逻辑硬伤：**固定比例手续费不可能产生"利润最高点"** ——
 * `利润 = P×(1−r) − 成本` 对 P 的导数恒为 `1−r > 0`，单调上升。
 * 所以要么费率是阶梯/累进的，要么那个"最高点"来自卖不掉导致保证金损失。
 *
 * 猜公式的代价是"算出一个看着合理但其实错的数字"，所以宁可去实测。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 实测方式（这个模块只负责分析，录入在 scripts/fee-probe.ts）
 * ═══════════════════════════════════════════════════════════════════════
 * 在游戏交易行挂单时能看到「预计到手」，于是：
 *
 *     fee = 挂价 − 到手          ← 实际被抽走多少
 *     r   = fee / 挂价           ← 抽走的比例
 *
 * 拿同一个物品挂几次不同价格，就能看出 r 是常数还是随价格变。
 * 如果变，再二分逼近档位边界（`suggestNextProbes` 会算出来）。
 */

/** 一次挂单实测 */
export interface FeeSample {
  /** 物品名（用户录入时敲的）*/
  item: string
  /** 挂价（哈夫币）*/
  price: number
  /** 交易行显示的「预计到手」*/
  net: number
  /** 实测时间（ISO 8601）*/
  at: string
  /** 若能在本地快照里找到该物品，带回它的品质与大类 —— 用于判断费率是否与它们有关 */
  grade?: number
  category?: string
}

/** 实际被抽走的钱 */
export function feeOf(s: FeeSample): number {
  return s.price - s.net
}

/** 抽走比例（0~1）*/
export function rateOf(s: FeeSample): number {
  return s.price === 0 ? 0 : (s.price - s.net) / s.price
}

/* ══════════════════════════════════════════════════════════════════════
 * 模型
 * ══════════════════════════════════════════════════════════════════════ */

/** 一个档位：`upTo === null` 表示"到无穷" */
export interface FeeTier {
  /** 挂价 ≤ upTo 的落在这一档 */
  upTo: number | null
  /** 这一档的费率（如 0.1 = 10%）*/
  rate: number
}

export type FeeModelKind =
  /** 所有样本比例一致 —— 固定比例 */
  | 'flat'
  /** 分档：比例按价格区间跳变 */
  | 'tiered'
  /** 比例随价格连续变化（不是跳变）—— 需要拟合公式 */
  | 'continuous'
  /** 样本太少（少于 2 个），下不了结论 */
  | 'insufficient'
  /**
   * ⭐ **样本自相矛盾** —— 同样的挂价出现了不同的手续费。
   *
   * 这不是一种"模型"，而是数据有问题的信号。必须单独报出来，
   * 否则会被误判成"比例随价格连续变化"✗（写测试时真踩到了：
   * 同样挂 10,000，一个到手 9,000、一个 9,500，工具却说"连续变化"）。
   *
   * 两个可能原因，都得让用户看到：
   *   · 敲错了（`fix` / `del` 改掉）
   *   · 费率还取决于**别的变量**（比如寄售时长 12 小时 / 24 小时）
   */
  | 'inconsistent'

export interface FeeAnalysis {
  kind: FeeModelKind
  /** 拟出的模型（flat / tiered 时有值）*/
  tiers: FeeTier[]
  /** 用该模型预测每个样本，吻合几个 */
  fitCount: number
  sampleCount: number
  /** 不吻合的样本（模型错在哪，一眼能看到）*/
  mismatches: Array<{ sample: FeeSample; predictedFee: number; actualFee: number }>
  /** 还缺哪些价格的样本才能收敛（二分出来的探测点）*/
  nextProbes: number[]
  /** 给人看的结论 */
  summary: string
}

/** 用模型算某个挂价下该抽多少（四舍五入到整数哈夫币）*/
export function predictFee(price: number, tiers: readonly FeeTier[]): number {
  for (const t of tiers) {
    if (t.upTo === null || price <= t.upTo) return Math.round(price * t.rate)
  }
  // 所有档位都有上界却没命中 → 用最后一档
  const last = tiers[tiers.length - 1]
  return last ? Math.round(price * last.rate) : 0
}

/* ══════════════════════════════════════════════════════════════════════
 * 分析
 * ══════════════════════════════════════════════════════════════════════ */

/** 比例比较的容差：0.3 个百分点。低于它就算"同一档" */
const RATE_EPSILON = 0.003

/**
 * 把比例"吸附"到好看的值（整百分点，或 0.5 个百分点）。
 *
 * 为什么要吸附：手续费几乎一定是 5% / 10% / 15% 这种整数比例，
 * 而实测出来的 `fee/price` 会因为四舍五入变成 10.03% 这种数。
 * 报告里写「10%」比写「10.03%」有用得多。
 *
 * 但如果吸附后**拟合变差**（超过容差），就不吸附、保留原值 ——
 * 宁可报一个不好看的准确值，也不要报一个好看但不准的值。
 */
function snapRate(rate: number, samples: readonly FeeSample[]): number {
  for (const candidate of candidateRates(rate)) {
    // 只吸附到 1% 或 0.5% 的整数倍
    if (candidate <= 0 || candidate > 1) continue
    const tiers: FeeTier[] = [{ upTo: null, rate: candidate }]
    if (samples.every((s) => Math.abs(predictFee(s.price, tiers) - feeOf(s)) <= 1)) {
      return candidate
    }
  }
  return rate
}

function candidateRates(rate: number): number[] {
  // 从近到远试：整百分点 → 0.5 个百分点 → 0.1 个百分点
  const out: number[] = []
  const pct = rate * 100
  for (const step of [1, 0.5, 0.1]) {
    const snapped = Math.round(pct / step) * step
    if (!out.includes(snapped / 100)) out.push(snapped / 100)
  }
  return out
}

/**
 * 分析所有样本，拟出一个手续费模型。
 *
 * ⚠️ 分档与"连续变化"的区别很重要：
 *   · 分档 → 最优点在**档位边界**，可以直接枚举算出来 ✓
 *   · 连续 → 需要拟合公式，且最优点要解方程
 * 所以这里必须把两者分开报告，不能都当"阶梯"处理。
 */
export function analyzeFee(samples: readonly FeeSample[]): FeeAnalysis {
  const sorted = [...samples].sort((a, b) => a.price - b.price)

  if (sorted.length < 2) {
    return {
      kind: 'insufficient',
      tiers: [],
      fitCount: 0,
      sampleCount: sorted.length,
      mismatches: [],
      nextProbes: sorted.length === 1 ? [Math.round((sorted[0]?.price ?? 1000) * 10)] : [1000],
      summary: '样本太少（至少 2 个才能判断比例是否恒定）。先多挂几单。',
    }
  }

  /* ---------- ⓪ 先查样本自相矛盾 ---------- */
  /**
   * ⚠️ 这一步必须在所有模型判断**之前**。
   *
   * 同样的挂价给出不同的手续费，说明这些数里至少有一个是错的
   * （或者费率还取决于别的变量）。此时任何"拟合"都是没有意义的 ——
   * 而且会给出误导性的结论（比如误判成"连续变化"）。
   */
  const byPrice = new Map<number, FeeSample[]>()
  for (const s of sorted) {
    const list = byPrice.get(s.price)
    if (list) list.push(s)
    else byPrice.set(s.price, [s])
  }
  const conflicts: Array<{ price: number; fees: number[]; items: string[] }> = []
  for (const [price, list] of byPrice) {
    if (list.length < 2) continue
    const fees = [...new Set(list.map((x) => feeOf(x)))]
    if (fees.length > 1) {
      conflicts.push({ price, fees, items: [...new Set(list.map((x) => x.item))] })
    }
  }
  if (conflicts.length > 0) {
    const lines = conflicts.map(
      (c) =>
        `    ${c.price.toLocaleString('zh-CN')} 这个挂价出现了 ${c.fees.length} 种手续费：` +
        `${c.fees.map((f) => f.toLocaleString('zh-CN')).join(' / ')}` +
        `（来自 ${c.items.join('、')}）`,
    )
    return {
      kind: 'inconsistent',
      tiers: [],
      fitCount: 0,
      sampleCount: sorted.length,
      mismatches: [],
      nextProbes: [],
      summary: [
        '⚠️ **样本里有矛盾** —— 同样的挂价却得到不同的手续费：',
        ...lines,
        '  同样价格不该有两种手续费。可能原因：',
        '    ① 其中一条敲错了 → 用 `list` 看编号，再用 `fix 挂价 到手` 或 `del 编号` 改掉',
        '    ② 费率还取决于**别的因素**（比如寄售时长 12 小时 / 24 小时不同）→ 请分开记录',
        '  在查清之前，任何拟合都不靠谱，所以这里不给结论。',
      ].join('\n'),
    }
  }

  /* ---------- ① 先试"固定比例" ---------- */
  const rates = sorted.map(rateOf)
  const sortedRates = [...rates].sort((a, b) => a - b)
  const medianRate = sortedRates[Math.floor(sortedRates.length / 2)] ?? 0
  const flatRate = snapRate(medianRate, sorted)
  const flatTiers: FeeTier[] = [{ upTo: null, rate: flatRate }]
  const flatFit = countFit(sorted, flatTiers)

  if (flatFit === sorted.length) {
    return {
      kind: 'flat',
      tiers: flatTiers,
      fitCount: flatFit,
      sampleCount: sorted.length,
      mismatches: [],
      nextProbes: [],
      summary:
        `固定比例 ${fmtRate(flatRate)}（${sorted.length} 个样本全部吻合）。\n` +
        `  ⚠️ 固定比例下不存在"利润最高点"—— 利润随挂价单调上升。\n` +
        `     所以你说的"利润不增反降"应该来自别的原因（比如挂太高卖不掉、保证金损失）。`,
    }
  }

  /* ---------- ② 试"分档" ---------- */
  /**
   * 按比例聚类：相邻样本比例相差超过容差就切一档。
   *
   * ⚠️ 必须先按**价格**排序再聚类（已经排了）—— 因为我们要的是
   * "价格升高 → 比例变化"的**阶梯**。如果比例是随机波动的，
   * 聚类结果会碎成很多单点档，那种情况下面会归到 `continuous`。
   */
  const clusters: Array<{ rate: number; samples: FeeSample[] }> = []
  for (const s of sorted) {
    const r = rateOf(s)
    const last = clusters[clusters.length - 1]
    if (last && Math.abs(r - last.rate) <= RATE_EPSILON) {
      last.samples.push(s)
      // 用这一档的平均值（越多样本越准）
      last.rate = last.samples.reduce((a, x) => a + rateOf(x), 0) / last.samples.length
    } else {
      clusters.push({ rate: r, samples: [s] })
    }
  }

  /**
   * 判断是"真的分档"还是"比例连续变化"：
   *
   * 分档的特征是**同一档内有很多样本**（因为你会在一个区间里挂好几次），
   * 而连续变化的特征是每个簇基本只有一个样本。
   * 阈值取"平均每档 ≥ 1.5 个样本" —— 低于它更可能是连续变化。
   */
  const avgPerCluster = sorted.length / clusters.length
  if (clusters.length > 1 && avgPerCluster < 1.5) {
    const pts = sorted.map((s) => `${s.price}→${fmtRate(rateOf(s))}`).join('  ')
    return {
      kind: 'continuous',
      tiers: [],
      fitCount: 0,
      sampleCount: sorted.length,
      mismatches: [],
      nextProbes: [],
      summary:
        `比例似乎**随价格连续变化**（不是跳变），每个价格点的比例都不同：\n  ${pts}\n` +
        `  这需要拟合公式，而不是枚举档位。请把更多样本发我，我再分析。`,
    }
  }

  /** 档位边界：第 k 档的上界 = 第 k 档最大价格（保守取上界，实测再二分收窄）*/
  const tiers: FeeTier[] = clusters.map((c, i) => {
    const last = i === clusters.length - 1
    const maxPrice = Math.max(...c.samples.map((s) => s.price))
    return { upTo: last ? null : maxPrice, rate: snapRate(c.rate, c.samples) }
  })

  const fit = countFit(sorted, tiers)
  const mismatches: FeeAnalysis['mismatches'] = []
  for (const s of sorted) {
    const predicted = predictFee(s.price, tiers)
    const actual = feeOf(s)
    if (Math.abs(predicted - actual) > 1) {
      mismatches.push({ sample: s, predictedFee: predicted, actualFee: actual })
    }
  }

  /**
   * 下一步该测哪些价格（二分逼近每个档位边界）。
   *
   * 边界目前只知道"落在 [第 k 档最高价, 第 k+1 档最低价] 之间"，
   * 所以最有价值的探测点是这两个数的**中点** —— 每测一次就把区间减半。
   */
  const nextProbes: number[] = []
  for (let i = 0; i < clusters.length - 1; i += 1) {
    const hiOfLower = Math.max(...(clusters[i]?.samples ?? []).map((s) => s.price))
    const loOfUpper = Math.min(...(clusters[i + 1]?.samples ?? []).map((s) => s.price))
    if (hiOfUpperGap(hiOfLower, loOfUpper)) {
      nextProbes.push(Math.round((hiOfLower + loOfUpper) / 2))
    }
  }

  const tierLines = tiers
    .map((t, i) => {
      const from = i === 0 ? 0 : (tiers[i - 1]?.upTo ?? 0) + 1
      const to = t.upTo === null ? '∞' : String(t.upTo)
      return `    ${String(from).padStart(9)} ~ ${to.padStart(9)}  →  ${fmtRate(t.rate)}`
    })
    .join('\n')

  const nextLine =
    nextProbes.length > 0
      ? `\n  建议下一个样本（二分逼近档位边界）：${nextProbes.map((n) => n.toLocaleString('zh-CN')).join(' 或 ')}`
      : ''

  return {
    kind: 'tiered',
    tiers,
    fitCount: fit,
    sampleCount: sorted.length,
    mismatches,
    nextProbes,
    summary:
      `阶梯比例（${sorted.length} 个样本，${fit} 个吻合）：\n` +
      `    挂价区间              费率\n${tierLines}\n` +
      `  ⚠️ 边界只是"落在两个已测价格之间"，还不是准确值。${nextLine}`,
  }
}

/** 区间里还有缝隙才值得二分 */
function hiOfUpperGap(lo: number, hi: number): boolean {
  return hi - lo > 1
}

function countFit(samples: readonly FeeSample[], tiers: readonly FeeTier[]): number {
  let n = 0
  for (const s of samples) {
    // 允许 ±1 的误差 —— 游戏大概率是把手续费四舍五入成整数哈夫币
    if (Math.abs(predictFee(s.price, tiers) - feeOf(s)) <= 1) n += 1
  }
  return n
}

export function fmtRate(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%`
}

/**
 * 跨物品对比：费率是否与物品本身有关。
 *
 * 为什么需要：搜索结果里有一条说费率"按物品**参考价区间**浮动" ——
 * 那意味着费率可能取决于**物品**而不是挂价。如果两个不同物品
 * 在同一个挂价下费率不同，就说明模型里还缺一个变量。
 */
export function compareAcrossItems(samples: readonly FeeSample[]): string {
  const byItem = new Map<string, FeeSample[]>()
  for (const s of samples) {
    const list = byItem.get(s.item)
    if (list) list.push(s)
    else byItem.set(s.item, [s])
  }

  const lines: string[] = []
  for (const [item, list] of byItem) {
    const rs = list.map(rateOf)
    const lo = Math.min(...rs)
    const hi = Math.max(...rs)
    const same = hi - lo <= RATE_EPSILON
    lines.push(
      `  ${item.padEnd(20)} ${String(list.length).padStart(2)} 个样本  费率 ${
        same ? `恒为 ${fmtRate(lo)}` : `${fmtRate(lo)} ~ ${fmtRate(hi)}`
      }`,
    )
  }

  /**
   * 挑出"挂价接近但费率不同"的跨物品样本对 —— 那是模型缺变量的铁证。
   */
  const suspicious: string[] = []
  const all = [...samples].sort((a, b) => a.price - b.price)
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i]!
      const b = all[j]!
      if (a.item === b.item) continue
      // 价格相差 10% 以内，费率却差 0.5 个百分点以上
      const priceClose = Math.abs(a.price - b.price) / Math.max(a.price, b.price) < 0.1
      const rateDiff = Math.abs(rateOf(a) - rateOf(b)) > 0.005
      if (priceClose && rateDiff) {
        suspicious.push(
          `    ⚠️ ${a.item} @ ${a.price.toLocaleString('zh-CN')} = ${fmtRate(rateOf(a))}` +
            `  vs  ${b.item} @ ${b.price.toLocaleString('zh-CN')} = ${fmtRate(rateOf(b))}` +
            `  ← 挂价接近但费率不同，说明费率可能还取决于物品本身`,
        )
      }
    }
  }

  return (
    `═══ 跨物品对比 ═══\n${lines.join('\n')}` +
    (suspicious.length > 0 ? `\n${suspicious.slice(0, 8).join('\n')}` : '')
  )
}


/* ══════════════════════════════════════════════════════════════════════
 * 录入解析
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * `1,000` / `10000` / `100万` / `1.5亿` → 数字。
 *
 * 为什么要支持中文单位与千分位：你是在**看着交易行界面**敲数字，
 * 上面写的是「1,000,000」，而「100万」是脑子里换算后的说法 ——
 * 两种都该能用，不该逼你逐字删逗号再数零。
 */
export function parseAmount(raw: string): number | null {
  const s = raw.replace(/,/g, '').trim()
  const m = /^([\d.]+)\s*(亿|万)?$/.exec(s)
  if (!m) return null
  const base = Number(m[1])
  if (!Number.isFinite(base)) return null
  const unit = m[2]
  const mul = unit === '亿' ? 1e8 : unit === '万' ? 1e4 : 1
  return Math.round(base * mul)
}

/**
 * 解析一行录入。三种写法都支持，因为交易行界面显示什么由游戏决定：
 *
 *   `海洋之泪 1000 900`      → fee = 价格 − 到手
 *   `海洋之泪 1000 fee=100`  → 直接给手续费
 *   `海洋之泪 1000 r=10%`    → 直接给比例
 *
 * ⚠️ 物品名可能含空格（如「D6 战术头盔」），所以**从后往前**取两个数值字段，
 *    剩下来的整段才是物品名。反过来解析的话名字会被切碎。
 */
export function parseSampleLine(line: string, now: Date = new Date()): FeeSample | null {
  const t = line.trim()
  if (t === '') return null

  const rest = t.split(/\s+/)
  if (rest.length < 3) return null

  const third = rest.pop()!
  const second = rest.pop()!
  const item = rest.join(' ').trim()
  if (item === '') return null

  const price = parseAmount(second)
  if (price === null) return null

  let net: number | null = null
  let feeOverride: number | null = null

  if (/^fee=/i.test(third)) {
    feeOverride = parseAmount(third.slice(4))
  } else if (/^r=/i.test(third)) {
    const pct = Number(third.slice(2).replace('%', ''))
    if (Number.isFinite(pct)) feeOverride = Math.round((price * pct) / 100)
  } else {
    net = parseAmount(third)
  }

  if (net === null && feeOverride === null) return null
  if (net === null) net = price - feeOverride!

  return { item, price, net, at: now.toISOString() }
}


/* ══════════════════════════════════════════════════════════════════════
 * 交互录入（带"当前物品"）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 为什么需要"当前物品"这个概念：
 * 挂单时你是在**反复改同一个物品的价格**（1000 → 10000 → 100000），
 * 每行都重打物品名很累。所以：
 *
 *   第一行：`海洋之泪 1000 900`   ← 带名字，顺便把"当前物品"设成它
 *   之后：  `10000 9000`          ← 只敲两个数字 ✓
 *   换物品：`item D6 战术头盔`     ← 显式切换（不记录样本）
 *
 * 判断规则很简单：**两个字段用当前物品，三个以上字段的第一个是物品名**。
 */
export type ParsedEntry =
  | { kind: 'sample'; sample: FeeSample }
  | { kind: 'switch'; item: string }
  | { kind: 'error'; message: string }

/** 切换当前物品的两种写法：`item 名字` 或 `@名字` */
export function parseItemSwitch(line: string): string | null {
  const t = line.trim()
  const m = /^(?:item|@)\s*(.+)$/i.exec(t)
  return m && m[1] ? m[1].trim() : null
}

/**
 * 解析一行录入。`currentItem` 是"当前物品"（可空）。
 *
 * ⚠️ 返回的是**判别联合**而不是 `FeeSample | null`：
 *    "切换物品"和"输入有错"是两件完全不同的事，
 *    都压成 `null` 的话，界面就没法给出有用的提示了。
 */
export function parseEntry(
  line: string,
  currentItem: string | null,
  now: Date = new Date(),
): ParsedEntry {
  const t = line.trim()
  if (t === '') return { kind: 'error', message: '空行' }

  const switched = parseItemSwitch(t)
  if (switched !== null) return { kind: 'switch', item: switched }

  const fields = t.split(/\s+/)

  // 两个字段 → 沿用当前物品
  if (fields.length === 2) {
    if (currentItem === null) {
      return {
        kind: 'error',
        message: '还不知道是哪个物品 —— 第一行请带上物品名，例如：海洋之泪 1000 900',
      }
    }
    const s = parseSampleLine(`${currentItem} ${fields[0]} ${fields[1]}`, now)
    return s === null
      ? { kind: 'error', message: `看不懂数字：${fields.join(' ')}` }
      : { kind: 'sample', sample: s }
  }

  if (fields.length < 2) return { kind: 'error', message: '太短了' }

  // 三个以上字段 → 第一个（可能含空格）是物品名
  const s = parseSampleLine(t, now)
  if (s === null) return { kind: 'error', message: `看不懂这一行：${t}` }

  // 防一个常见手误：把两个数字敲成三列，于是"物品名"变成了数字
  if (parseAmount(s.item) !== null) {
    return {
      kind: 'error',
      message: `物品名看起来是个数字（${s.item}）—— 是不是多敲了一列？`,
    }
  }
  return { kind: 'sample', sample: s }
}


/* ══════════════════════════════════════════════════════════════════════
 * 物品名匹配（为了查参考价）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 实测踩到：用户手填的是「海盗铜币」，而游戏数据里叫「**锈迹斑斑的**海盗铜币」
 * —— 差三个字，于是查不到参考价 ✗，而"费率是否取决于参考价"正是要验证的东西。
 *
 * 所以匹配分三步，从严到松：
 *   ① 完全相等
 *   ② 去掉标点/空白后相等（「.300BLK」vs「.300 BLK」）
 *   ③ 一方包含另一方（「海盗铜币」⊂「锈迹斑斑的海盗铜币」）
 *
 * ⚠️ 第 ③ 步**必须挑最短的那个候选**：输入「铜币」时，
 *    「锈迹斑斑的海盗铜币」和「古怪的海盗银币」都可能包含它，
 *    挑最短（= 描述词最少）的那个最可能是用户想说的。
 *    如果候选有多个且长度相同 → 返回 null，**不猜**。
 */
export function findClosestItem(
  input: string,
  candidates: readonly string[],
): { matched: string | null; how: 'exact' | 'normalized' | 'contained' | 'none' } {
  const raw = input.trim()
  if (raw === '') return { matched: null, how: 'none' }

  for (const c of candidates) {
    if (c === raw) return { matched: c, how: 'exact' }
  }

  const norm = (s: string) => s.replace(/[\s.·、，,（）()【】\[\]]/g, '').toLowerCase()
  const n = norm(raw)
  for (const c of candidates) {
    if (norm(c) === n) return { matched: c, how: 'normalized' }
  }

  const hits = candidates.filter((c) => c.includes(raw) || raw.includes(c))
  if (hits.length === 0) return { matched: null, how: 'none' }
  hits.sort((a, b) => a.length - b.length)
  const best = hits[0]!
  // 最短的有并列 → 说明分不清，不猜
  if (hits.length > 1 && hits[1]!.length === best.length) return { matched: null, how: 'none' }
  return { matched: best, how: 'contained' }
}
