/**
 * 运行时常量。
 *
 * ⚠️ 为什么这些不放 `shared`：
 * 因为它们是**运行时值**（对象、字符串）。`shared` 包被两端用 `import type`
 * 引入，而 `import type` 会在编译期被完全擦除 —— 一旦 `shared` 里出现运行时值，
 * 前端就必须写普通 `import`，运行时就会真的去加载那个 `.ts` 文件，直接崩。
 *
 * 所以：品质调色板、分类中文名这类运行时常量放这里，
 * 通过 `GET /api/meta` 下发给网页。
 */

import type { Grade, GradeTone } from '@deltaforce/shared'

/**
 * 品质等级 → 中文名。
 * 映射关系实测自 dergame 的 CSS 变量 `--color-grade-N`，不是猜的。
 * （若按它前端筛选器的中文选项去猜，7 个色值对 8 个选项，映射必然错位。）
 */
export const GRADE_CN: Readonly<Record<Grade, string>> = {
  0: '灰',
  1: '白',
  2: '绿',
  3: '蓝',
  4: '紫',
  5: '金',
  6: '红',
}

/** 品质 → 色系名（网页用来选样式类） */
export const GRADE_TONE: Readonly<Record<Grade, GradeTone>> = {
  0: 'gray',
  1: 'white',
  2: 'green',
  3: 'blue',
  4: 'purple',
  5: 'gold',
  6: 'red',
}

/** 品质 → 十六进制色值（实测自 dergame CSS 变量） */
export const GRADE_COLOR: Readonly<Record<Grade, string>> = {
  0: '#949595',
  1: '#cdd5d5',
  2: '#188d14',
  3: '#658bce',
  4: '#9b61c8',
  5: '#e8a64e',
  6: '#cb464a',
}

/**
 * 大类代码 → 中文名。
 *
 * 注意：官方的 `secondClassCN` 存的是**子类**中文名（收集品/钥匙/头盔），
 * 不是大类中文名。所以大类中文名必须我们自己在后端维护一份。
 */
export const CATEGORY_CN: Readonly<Record<string, string>> = {
  props: '道具',
  acc: '配件',
  ammo: '弹药',
  protect: '防护',
  gun: '枪械',
  vehicle: '载具',
  skin: '皮肤',
}

/**
 * ⛔ 硬性排除的大类。
 *
 * 只有载具。理由（实测）：
 *   16 条载具全部 `length=0`、`width=0`、`weight=""`、`avgPrice=0`。
 *   如果不过滤，`单格价值 = 价格 ÷ (0 × 0) = Infinity`，排行榜直接毁掉。
 *   而且载具本来就搬不出战场，不属于"战利品"。
 *
 * 皮肤（10 条：图灵砖/喷漆/头像/军牌）也是 0 格 0 价。
 *
 * ⚠️ 它**曾经**靠 `carryable`（占格 > 0）+ 网页上的“排除不可携带”开关处理，
 * 后来用户明确要求“不要显示出来”，所以改成这里硬排除。
 * 代价：它们**根本不会进数据集**（API 里也没有），
 * 好处：载荷小了、列表干净了。
 * 想找回来：把这个数组改回 `['vehicle']` 即可。
 *
 * 想调整可摸范围，改这个数组即可。
 */
export const HARD_EXCLUDED_CATEGORY_CODES: readonly string[] = ['vehicle', 'skin']

/**
 * 单条物品级的硬排除 —— **用官方ID，不是名字**。
 *
 * 为什么不能用名字：实测官方有 6 组同名物品（13 条），
 * 最坑的是 `.300BLK`（3 条不同品质的子弹共用一个名字）。
 * 按名字排除会一次性误伤好几条。
 *
 * 为什么放代码里而不是配置文件：这两条是**用户明确确认不需要**的个别物品，
 * 不是会随使用习惯变化的东西。写在这里一眼看得到，也容易撤。
 */
export const HARD_EXCLUDED_ITEM_IDS: readonly string[] = [
  '13020000590', // M249H.A.V.K链锯套件（moligod 全量里没有，源覆盖缺口）
  '13020000595', // HVK格斗套件（同上）
]

/**
 * 官方接口的大类清单（实测共 7 类，1592 条）。
 * 顺序即抓取顺序，最后一个虽然会被过滤掉，但仍要抓 —— 否则统计数字对不上。
 */
export const OFFICIAL_CATEGORY_CODES: readonly string[] = [
  'props',
  'acc',
  'ammo',
  'protect',
  'gun',
  'skin',
  'vehicle',
]

/**
 * 物品源侧最后更新时间超过这个小时数，就把该条标记为 `stale`。
 * 实测官方有 2026-09-04 的数据（24 天前），需要能区分出来。
 */
export const ITEM_STALE_AFTER_HOURS = 24

/** 名称匹配率低于这个值时，在状态栏警告"价格源与主数据对不上" */
export const MIN_ACCEPTABLE_MATCH_RATE = 0.9

/**
 * ⭐ 地图名的特殊值：表示"所有地图都会出"。
 *
 * 官方数据里真实出现过（某条物品的 propsSource 就是整整一个 `全地图`）；
 * 人工覆盖文件里也可以写。
 *
 * 它会在后端被 `expandAllMaps()` **展开成明确的地图名列表**，
 * 所以网页拿到 `provenanceMaps` 时不需要知道它存在。
 *
 * 注：这个常量刻意放这里而不是 `shared` —— 因为 `shared` 只允许有类型，
 *     加一个 `const` 会破坏那里“铁律一”（见 shared/src/index.ts 头部注释）。
 */
export const PROVENANCE_ALL_MAPS = '全地图'

/**
 * 默认的“一个格子放几个定价单位”。
 * 普通物品就是一个格子放一个；**弹药是例外**（一个格 60 发，部分 90 发）。
 */
export const DEFAULT_UNITS_PER_SLOT = 1

/** 弹药的大类代码 —— 它的 `unitsPerSlot` 必须人工标注，否则单格价值算不出来 */
export const AMMO_CATEGORY_CODE = 'ammo'

/**
 * 可获得性 → 中文标签（用于 CSV 与网页展示）。
 *
 * ⚠️ 命名的关键：要能一眼看出“**会不会回来**”。
 * 旧的叫法（已失效 / 不可摸）两个都只说了“现在摸不到”，
 * 没表达“可能返场 vs 确定没有”的区别 —— 那正是掳金决策最需要的那个信息。
 */
export const AVAILABILITY_CN: Readonly<Record<string, string>> = {
  lootable: '可摸',
  /** 曾经能拾，现在下架 —— 赛季/活动结束就是这一类，**可能返场** */
  expired: '限时下架',
  /** 机制上不作为战利品产出 —— **不会随赛季变化** */
  unobtainable: '非战利品',
}

/**
 * 赛季限定标记 → 中文标签。
 */
export const SEASONAL_CN: Readonly<Record<string, string>> = {
  current: '本季',
  past: '往季',
}

/**
 * 可获得性的详细说明，用于网页上的 tooltip。
 * 把“会不会回来”写清楚，避免只看标签产生误解。
 */
export const AVAILABILITY_DESC: Readonly<Record<string, string>> = {
  lootable: '局内可以拾到',
  expired: '曾经能拾到，现在已下架（赛季结束/活动结束）—— **有可能返场**',
  unobtainable: '机制上不作为战利品产出（只能兑换 / 制造 / 任务奖励）—— 不随赛季变化',
}

/**
 * 可获得性的默认值。
 * 之所以默认“可摸”，是因为官方数据里绝大多数物品确实可摸，
 * 只有少数需要人工排除 —— 默认值应该让“不做事”的代价最小。
 */
export const DEFAULT_AVAILABILITY = 'lootable' as const

/* ═══════════════════════════════════════════════════════════════════════
 * 护甲 / 头盔的耐久度分档
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 为什么需要这套东西 —— 一个实测出来的陷阱：
 *
 * moligod 对每件护甲给了 **4 个条目**：
 *
 *   `H70 精英头盔`          → 2,163,983   ← ❌ 没有 yesterdayAvg、没有 updateTime
 *   `H70 精英头盔（全新）`     → 4,003,281   ← ✅ 有实时行情
 *   `H70 精英头盔（几乎全新）` → 1,017,434   ← ✅
 *   `H70 精英头盔（破损）`     →   707,547   ← ✅
 *
 * 那个“裸名”条目**不是行情，是基础参考价**（`current_price === base_price`）。
 *
 * 铁证：拿官方 `avgPrice` 跟这四档比，**72/85 件（85%）与裸名吻合**
 * （H09 防暴头盔差 1%、HA-2 防弹装甲差 8%）。
 *
 * 也就是说：按名称精确匹配时，护甲拿到的恰好是我们**明令禁止使用**的那种
 * “仅供参考、非实盘”的价。实测涉及 51 件护甲。
 *
 * 差距有多大：H70 精英头盔 全新/破损 = **5.7 倍**。选错一档，
 * 护甲在整个价值榜上的位置会系统性地偏移。
 */

/**
 * 耐久度档位，**按从新到旧排序**。
 *
 * 这个顺序同时也是 moligod 名称后缀的识别顺序，以及网页上的显示顺序。
 */
export const CONDITION_TIERS = ['全新', '几乎全新', '破损'] as const

/** 耐久度档位名 */
export type ConditionTier = (typeof CONDITION_TIERS)[number]

/**
 * ⭐ **排序 / 判定护甲时用哪一档 —— 想换就改这一行。**
 *
 * 为什么默认选“破损”（最低档）：
 *   价值榜的作用是回答“这趟该不该捡”。用最低档保证
 *   **标了“必摸”就真的值得摸** —— 高估的代价是白跑一趟。
 *   三档的价会**同时显示在网页上**，所以并没有隐藏信息。
 *
 * 备选值：`'全新'`（上限）、`'几乎全新'`（中间档）。
 */
export const ARMOR_PRICE_TIER: ConditionTier = '破损'

/**
 * 从物品名里拆出耐久度后缀的正则。
 *
 * 实测 moligod 用的就是全角括号 + 这三个词，没有其它写法
 * （全量 1718 条扫过：159 条带后缀，去后缀后 53/53 都能在官方找到）。
 */
export const CONDITION_SUFFIX_RE = /（(全新|几乎全新|破损)）$/
