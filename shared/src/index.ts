/**
 * @deltaforce/shared —— 取数服务（get-data）与网页（web）之间的**唯一数据契约**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 铁律一：本包只允许放类型（type / interface），绝不能出现 const / function。
 * ═══════════════════════════════════════════════════════════════════════
 * 原因：两端都用 `import type` 引入本包。`import type` 在编译期被完全擦除，
 * 编译产物里那一行直接消失 —— 所以 Vite 和 tsx 在运行时**根本不会加载这个文件**。
 *
 * 由此带来三个好处：
 *   1. 不需要构建步骤（不需要 tsc 编译出 dist/）
 *   2. 不需要配置 exports 指向编译产物
 *   3. 避开了"打包器加载工作区 TS 包"的一系列经典坑
 *      （server.fs.allow / optimizeDeps.exclude / tsconfig paths）
 *
 * 一旦这里出现运行时值，前端就必须写普通 import 才能用它，
 * 于是运行时真的会去加载这个 .ts 文件 —— 浏览器和 Node 都不认识 .ts，直接崩。
 * 所以需要运行时共享的常量（比如品质调色板）放在 get-data/src/constants.ts，
 * 通过 GET /api/meta 下发给网页。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 铁律二：这里只放「数据形状」，不放「实现接口」。
 * ═══════════════════════════════════════════════════════════════════════
 * 适配器接口（ItemSource / PriceSource / FetchContext）**不在这里**，
 * 它们在 `get-data/src/sources/types.ts` 与 `get-data/src/prices/types.ts`。
 *
 * 两个原因：
 *   1. 架构上：前端完全不需要知道"适配器长什么样"，它只消费数据。
 *      共享的应该是数据形状，不是后端实现。
 *   2. 技术上：本包的 tsconfig 是 `lib: ["ES2023"]`，既没有 DOM 也没有
 *      @types/node。而适配器接口要用到 `AbortSignal`、`Response` 这类类型，
 *      放进来会强迫本包引入 DOM lib 或 node 类型，破坏"纯数据契约"的定位。
 */

/* ══════════════════════════════════════════════════════════════════════
 * 1. 数据源标识
 * ══════════════════════════════════════════════════════════════════════
 *
 * 本项目把数据源拆成两类（详见 PLAN.md §6.6）：
 *
 *   ItemSource  —— 物品主数据源：产出名称/官方ID/占格/品质/三级分类/出产地
 *                  它**不提供价格**（官方只给"近期平均交易价"，实测误差大）
 *   PriceSource —— 价格源：只产出「物品名 → 现价」的查找表
 *
 * 两类源在管道里 join（按名称匹配，实测匹配率 98.4%）后才形成最终的 Item。
 * 这样换价格源 = 写 1 个文件 + 注册表加 1 行，前端与 API 一行不改。
 */

/** 物品主数据源。新增源时在这里加一个联合成员。 */
export type ItemSourceId = 'official'

/**
 * 价格源。`none` 表示不取价格（只显示物品主数据）。
 * 新增源（例如将来接付费的"数据帝" API）时在这里加一个成员。
 */
export type PriceSourceId = 'moligod' | 'dergame' | 'shujudi' | 'none'

/** 数据源的种类，用于 /api/sources 区分展示。 */
export type SourceKind = 'item' | 'price'

/* ══════════════════════════════════════════════════════════════════════
 * 2. 数据源能力声明与运行状态
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 数据源能力声明。
 *
 * ⭐ 这是"无痛换源"的关键：不同源的字段齐全程度不同。
 * 网页据此**自动隐藏或降级**对应列，而不是显示 undefined。
 * 例：某个价格源没有昨日均价 → hasYesterdayAvg=false → 网页隐藏"今日涨幅"列。
 */
export interface SourceCapabilities {
  /** 有价格字段 */
  hasPrice: boolean
  /** 有占格数据（width/length）—— 没有它"单格价值"功能就不成立 */
  hasSlots: boolean
  /** 有昨日均价 —— 有它才能算"今日涨幅" */
  hasYesterdayAvg: boolean
  /** 有昨日价格区间（低/高） */
  hasYesterdayRange: boolean
  /** 有更长时间的价格区间（如 7 日高低） */
  hasRange: boolean
  /** 有别名（游戏内俗称） */
  hasAlias: boolean
  /** 有子分类 */
  hasSubcategory: boolean
  /** ⭐ 有出产地（哪张图的哪个点位会刷出该物资） */
  hasProvenance: boolean
  /** 按耐久度区分条目（同一头盔的"全新/几乎全新/破损"是不同条目） */
  hasDurabilityVariants: boolean
}

/** 单个数据源的运行时状态，由 GET /api/sources 下发。 */
export interface SourceStatus {
  kind: SourceKind
  id: string
  /** 显示名，如"腾讯官方接口"、"moligod" */
  label: string
  /** 站点首页，用于网页做来源标注与外链 */
  homepage: string
  capabilities: SourceCapabilities
  /** 是否在配置中启用 */
  enabled: boolean
  /** 是否是当前生效的源（数据实际来自它） */
  active: boolean
  /** 最近一次抓取成功的时刻（ISO 8601）；从未成功则为 null */
  lastOkAt: string | null
  /** 最近一次尝试抓取的时刻（ISO 8601） */
  lastAttemptAt: string | null
  /** 最近一次成功抓到的条目数 */
  itemCount: number | null
  /** 最近一次耗时（毫秒） */
  lastDurationMs: number | null
  /** 最近一次失败原因；成功则为 null */
  lastError: string | null
  /** 连续失败次数（达到阈值后自动刷新会停止） */
  consecutiveFailures: number
  /**
   * 价格源专用：价格口径说明，会**原样显示在网页上**。
   * 例："moligod 现价（交易行最新成交参考），5 分钟刷新"
   */
  priceBasis?: string
}

/* ══════════════════════════════════════════════════════════════════════
 * 3. 物品主模型
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 品质等级。
 * 映射关系实测自 dergame 的 CSS 变量 `--color-grade-N`（不是猜的）：
 *   0=灰（枪械/载具，无品质） 1=白 2=绿 3=蓝 4=紫 5=金 6=红
 *
 * 用字面量联合类型而不是 `number`，是为了让 switch 能穷尽检查。
 */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 品质的色系名称，网页用来选取样式类。 */
export type GradeTone = 'gray' | 'white' | 'green' | 'blue' | 'purple' | 'gold' | 'red'

/**
 * 出产地的来源标记，网页据此显示徽章，让你一眼看出
 * 哪些数据是官方给的、哪些是你自己补的。
 */
export type ProvenanceSource = 'official' | 'manual' | 'merged'

/**
 * 赛季限定标记。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要单独一个概念，而不是直接写 availability/listable
 * ═══════════════════════════════════════════════════════════════════════
 * 赛季限定的特点是**状态随赛季变化**：
 *
 *   本赛季   →  可摸 + 可上架交易行
 *   下赛季   →  限时下架 + 不可上架（只能卖军需处）
 *   假如返场 →  又变回 可摸 + 可上架
 *
 * 如果直接写死 availability/listable，你**每赛季都要手工把几十条改一遍**。
 * 所以只记“本季 / 往季”这个标记，让程序自动推导 ——
 * 换季时只需跑一次 `npm run season:rollover`。
 */
export type SeasonalMark =
  /** 本赛季的赛季限定：可摸 + 可上架 */
  | 'current'
  /** 往季的赛季限定：限时下架 + 不可上架（可能返场） */
  | 'past'

/**
 * 物品的可获得性。
 *
 * ⚠️ **官方数据里没有这个信息**，只能人工标注。默认值 `lootable`。
 *
 * 为什么需要它：实测有些物资虽然在物品库里、甚至有价格，但
 * **在局内根本摸不到** —— 它们会让“摸金价值榜”出现“永远摸不到的东西”，
 * 白白占着排行榜前排。
 */
export type ItemAvailability =
  /** 局内可以拾到（默认值） */
  | 'lootable'
  /**
   * **限时下架**：曾经能拾到，现在不行了（赛季结束 / 活动结束）。
   * ⚠️ **可能返场** —— 旧赛季子弹就是这一类。
   * 所以它和 `unobtainable` 是两回事，不要混。
   */
  | 'expired'
  /**
   * **非战利品**：机制上就不作为战利品产出（只能通过兑换 / 制造 /
   * 军需处购买 / 任务奖励获得）。不会因为赛季变化而改变。
   */
  | 'unobtainable'

/*
 * 关于地图名的特殊值 `全地图`：
 *   它表示"所有地图都会出"。官方数据里真实出现过；人工覆盖文件里也可以写。
 *   它会在**后端被展开成明确的地图名列表**，所以网页拿到 `provenanceMaps` 时
 *   不需要知道这个特殊值的存在，直接 `maps.includes(当前选中地图)` 即可。
 *
 *   ⚠️ 这个字符串常量刻意放在 `get-data/src/constants.ts` 而不是这里 ——
 *      因为本包只允许有类型，加一个 `const` 会破坏下面的“铁律一”。
 */

/**
 * 统一物品模型。
 *
 * 所有数据源的数据都会被 normalize 成这个形状。
 *
 * 字段分为三段，**这个区分很重要**：
 *   A. 主数据 —— 来自 ItemSource（官方）
 *   B. 价格原料 —— 来自 PriceSource（moligod 等）
 *   C. 派生指标 —— 由 metrics.ts 计算，**全项目唯一实现处**
 *
 * C 段绝不能由适配器计算。否则换个价格源，同一个物资的排名就变了，
 * 而你说不清为什么变 —— 这是"可解释性"问题，不是洁癖。
 */
export interface Item {
  /* ---------- 身份 ---------- */

  /** 稳定唯一键：`${source}:${sourceItemId}`，例如 "official:15080050142" */
  key: string
  /** 这条主数据来自哪个物品主数据源 */
  source: ItemSourceId
  /** 源侧的物品 ID。官方源即 objectID（字符串化）。 */
  sourceItemId: string

  /* ---------- A. 主数据（来自 ItemSource） ---------- */

  /** 原始名称，可能带耐久度后缀，如 "H70 精英头盔（几乎全新）" */
  name: string
  /** 展示名称（源若提供别名则优先，否则等于 name） */
  displayName: string
  /** 别名 / 游戏内俗称 */
  alias: string | null
  /** 物品描述 */
  description: string | null
  /** 图标 URL */
  iconUrl: string
  /** 小图标 URL（列表页用，省流量）。官方源对应 prePic。 */
  thumbUrl: string | null

  /* ---------- A2. 分类（三级 + 出产地） ---------- */

  /** 大类代码：props / acc / gun / ammo / protect / vehicle / skin */
  categoryCode: string
  /** 大类中文名（由取数服务统一映射，网页只认这个） */
  categoryCn: string
  /** 子类代码：collection / key / consume / mandel / helmet / accScope ... */
  subcategory: string
  /** 子类中文名：收集品 / 钥匙 / 消耗品 / 曼德尔砖 / 头盔 ... */
  subcategoryCn: string
  /**
   * ⭐ 第三级分类代码，如 repair / drug / inject。
   * 实测只有"消耗品"这一类有第三级，其它类为 null。
   */
  thirdClass: string | null
  /** 第三级分类中文名：维修套件 / 药品 / 针剂 */
  thirdClassCn: string | null
  /** 更细的类型说明，如"工艺藏品" */
  itemSubtype: string | null

  /**
   * ⭐ 出产地：该物资**能在哪些地图被捡到**。例：`["长弓溪谷", "航天基地"]`。
   *
   * ⚠️ **含义是"能在这里捡到"，不是"它属于这张图"。** 这个区别很重要：
   *   · 普通钥匙（如「雷达站无人机平台」）从任何图的容器里都能摸到 → `["全地图"]`
   *   · **Boss 专属掉落**（如「酒店国王房」）—— 别的地图不刷对应 Boss，
   *     所以只能在那一张图里摸到 → `["长弓溪谷"]`
   *
   * 只有官方源提供；实测只覆盖 55% 的收集品，且**钥匙类 80 条一条都没有**。
   * 可用 `get-data/overrides/provenance.json` 人工补充。
   *
   * ⚠️ **只有地图名，没有点位**。官方原始值是 `"长弓溪谷-钻石皇后酒店"`，
   * 但实测点位信息不可靠（很多物资只标了某个“核心区”，实际全图都刷），
   * 显示一个不可靠的精确信息比不显示更糟。原始串仍保留在 `propsDetail.propsSource`。
   *
   * ⚠️ 特殊值 `全地图`（见上面的说明）已在后端**展开成明确的地图名**，
   * 所以网页只需要 `maps.includes(选中的地图)`，不必知道这个特殊值。
   *
   * ⚠️ `null` 的语义是“**没有数据**”，不是“不会出”。
   * 官方标注实测只覆盖 55%，所以“没标注”不能当作负向证据。
   */
  provenanceMaps: string[] | null

  /**
   * ⭐ 这份物资是不是**通用物资**（每张图都能刷）。
   *
   * 为什么必须由后端给这个布尔量：`provenanceMaps` 到网页手里时
   * **已经被展开过了** —— 「全地图」哨兵变成了 6 个具体图名。
   * 前端拿到那个数组后无法区分“标了全地图”与“逐个列了 6 张图”，
   * 只能靠“地图数 == 总地图数”去猜。而数据的事实应由产生它的那一层给出。
   *
   * 用途（实测数据里 1564 条中有 1297 条是通用，所以这两处差别很大）：
   *   · 「只看该图专属」开关 —— 隐藏通用物资，只留地图特产
   *     （选长弓溪谷：不开关是 1304 条，开开关只剩十几条）
   *   · 出产地列的**三态显示**：通用 / 地图名 / 待补
   *     （“通用”与“待补”必须能区分：前者是“每张图都出”，后者是“我们不知道”）
   */
  provenanceUniversal: boolean

  /** 上面那份出产地数据是官方给的、你补的、还是两者合并的 */
  provenanceSource: ProvenanceSource | null

  /**
   * 物品的可获得性（默认 `lootable`）。
   *
   * 官方数据不提供，纯人工标注。网页据此默认过滤掉摸不到的物资 ——
   * 否则价值榜前排会混进“永远摸不到的东西”。
   *
   * ⚠️ 若是赛季限定，这个值可能是由 `seasonal` **自动推导**出来的。
   *    想知道是不是推出来的，看 `seasonal` 是否为 null。
   */
  availability: ItemAvailability
  /** 如果标注了理由（如“只能军需处兑换”），记在这里 */
  availabilityNote: string | null

  /* ---------- A3. 品质 ---------- */

  grade: Grade
  /** 品质中文名：灰 / 白 / 绿 / 蓝 / 紫 / 金 / 红 */
  gradeCn: string
  gradeTone: GradeTone
  /** 品质色块的十六进制色值，如 "#cb464a" */
  gradeColor: string

  /* ---------- B. 价格原料（来自 PriceSource 与官方） ---------- */

  /**
   * 当前价格（哈夫币）。
   * null 表示"非卖品"或"源没给价格"——注意 `avgPrice: 0` 也必须归一化成 null，
   * 因为 0 是"无价格"而不是"零元"。
   *
   * ⚠️ 对护甲/头盔来说，这个值是**按耐久度选过档的**（默认取「破损」，最保守）。
   *    完整三档在 `priceVariants` 里。
   */
  price: number | null
  /** 源侧基准价 / 商店价 */
  basePrice: number | null

  /**
   * ⭐ 多状态报价 —— 目前只有护甲/头盔有（按耐久度分三档）。
   *
   * 为什么不能只给一个价：同一件护甲，全新 4,003,281 / 破损 707,547，
   * **差 5.7 倍**。只显示一个数字会把“取决于耐久度”这个事实藏起来，
   * 而它直接决定“值不值得摸”。所以三档都得给网页。
   *
   * 键是价格源给的原始状态标签（如「全新」「几乎全新」「破损」），
   * 插入顺序 = 显示顺序。普通物品为 `null`。
   *
   * 排序/判定用的是 `price`（已按档选好），不是这里的最大值。
   */
  priceVariants: Record<string, number | null> | null

  /** 官方给的统计均价。仅用于对照展示，**不参与判定**。 */
  officialAvgPrice: number | null
  /** 重量（源里是字符串，normalize 时已转数字） */
  weight: number | null

  /** 占格：宽 */
  width: number
  /** 占格：长 */
  length: number

  /**
   * ⭐ 一个格子里能放几个【定价单位】。
   *
   * 普通物品是 **1**（一个格子放一个物品）。
   * 子弹不是 —— 实测交易行报的是**每发单价**，而一个格子能放 60 发（部分 90）。
   * 所以子弹的 `unitsPerSlot` 是它的**每组发数**。
   *
   * ⚠️ `null` 表示**未知**（单格价值算不出来）。
   * 目前只有弹药会是这样：每组发数因弹而异（同一口径都可能不同），
   * 官方与 moligod 都不提供这个字段，必须人工标注。
   *
   * 为什么不给弹药默认 60：
   * 那会把“每发价”在无声无息中当成“每格价”，而 `1,666/格` 看上去完全合理。
   * 宁可显示“待补”，也不要给一个错得很像对的数字。
   */
  unitsPerSlot: number | null

  /**
   * 能不能上架到交易行。
   *
   * 默认 `true`（绝大多数物品）。为 `false` 的例：旧赛季子弹 ——
   * 交易行上能看到价格，但**那个价格你拿不到**，只能卖军需处。
   *
   * ⚠️ 这里是“**物品类型本身**能不能上架”（类型级），
   * 不是“从交易行买来的实例被标记为绑定”（实例级）——
   * 后者对掳金没影响，因为从地上摸到的东西从来不是绑定的。
   *
   * ⚠️ 若是赛季限定，这个值可能是由 `seasonal` **自动推导**出来的。
   */
  listable: boolean

  /**
   * 赛季限定标记：`'current'`（本季）/ `'past'`（往季）/ `null`（不是赛季限定）。
   *
   * 非 null 时，上面的 `availability` 与 `listable` **由它自动推导**
   * （除非你显式写了那两个字段 —— 显式优先于推导）。
   *
   * 网页据此显示一个「赛季限定」徽章，提示“可能随赛季变化”。
   */
  seasonal: SeasonalMark | null

  /* ---------- C. 派生指标（metrics.ts 唯一实现处） ---------- */

  /** 占格总数 = width * length。占格非法时为 0。 */
  slots: number
  /**
   * ⭐ 单格价值 = price × unitsPerSlot ÷ slots。
   *
   * 这个式子同时适用于两种物品：
   *   · 普通物品 unitsPerSlot=1：2×2 的 1000 元物品 → 250/格
   *   · 子弹 unitsPerSlot=60：1×1 的 1666/发 → 99,960/格
   *
   * 任一项非法（价格缺失 / 占格 0 / 每组发数未知）时为 null ——
   * 这是**除零守卫**，它同时兜住了载具（16 条）、皮肤（10 条）
   * 和未标注的弹药。
   */
  pricePerSlot: number | null
  /** ⭐ 今日涨幅% = (price - yesterdayAvg) / yesterdayAvg * 100 */
  todayChangePct: number | null
  /** 昨日均价（来自价格源） */
  yesterdayAvg: number | null
  yesterdayLow: number | null
  yesterdayHigh: number | null
  /** 更长时间区间（如 7 日）的低/高 */
  rangeLow: number | null
  rangeHigh: number | null

  /* ---------- D. 可携性 ---------- */

  /**
   * 是否能塞进背包。判定规则：slots > 0。
   * 载具与皮肤实测 length=width=0，因此为 false，网页默认过滤掉它们。
   */
  carryable: boolean

  /* ---------- E. 时间 ---------- */

  /** 源侧标注的最后更新时刻（原样字符串，如 "2026-09-28 14:24"） */
  lastUpdate: string | null
  /** 我们抓取到本条数据的时刻（ISO 8601） */
  fetchedAt: string
  /**
   * 本条数据的**源侧数据**是否陈旧（基于 lastUpdate 判断）。
   * 注意与 ApiItemsResponse.snapshotStale 区分：
   * 这个是"某个物资的价格很久没更新了"，那个是"我们整份快照很久没抓了"。
   */
  stale: boolean

  /* ---------- F. 调试用原始数据 ---------- */

  /**
   * ⚠️ 变长结构，按 secondClass / thirdClass 形状完全不同，**不要建固定类型**：
   *   收集品   → { type, propsSource }
   *   维修套件 → { repairPoints, repairArea, repairEfficiency, activeTime, replyEffect }
   *   药品     → { durability, activeTime } 或 { availableCount, activeTime }
   *   针剂     → { activeTime, bearEnhance / hearEnhance / bodyCapacity }
   *
   * 如果给它定义严格 schema，消耗品 34 条会被整批丢弃。
   */
  propsDetail: Record<string, unknown> | null
}

/* ══════════════════════════════════════════════════════════════════════
 * 4. 摸金判定（纯前端逻辑，后端不输出结论）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 排序与判定所依据的指标。
 * v1 提供两种模式，用户可切换；排序键与判定依据同步切换。
 */
export type LootMode = 'pricePerSlot' | 'price'

/** 判定结果 */
export type LootVerdict = 'must' | 'maybe' | 'skip' | 'unknown'

/**
 * 判定规则。存在浏览器 localStorage，**后端完全不感知**。
 *
 * 为什么放前端：① 判定规则是用户的偏好，不是数据的属性
 *              ② 拖滑块不该发网络请求、不该重启服务
 *              ③ 后端写死判定逻辑后，用户就没法快速试不同阈值了
 */
export interface LootRules {
  mode: LootMode
  /** 指标值 ≥ 该值 → 必摸 */
  mustThreshold: number
  /** 指标值 < 该值 → 跳过 */
  skipThreshold: number
}

/* ══════════════════════════════════════════════════════════════════════
 * 5. HTTP API 契约
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/items
 *
 * ⭐ 调用这个接口会**顺带触发按需刷新检查**（见 PLAN.md §6.7）：
 *   age < 15 分钟            → 什么都不做，直接返回
 *   15 ≤ age < 120 分钟      → 立即返回旧数据 + refreshing=true，后台开始抓
 *   age ≥ 120 分钟 或 无快照  → 阻塞等待一次抓取完成再返回
 *
 * ⚠️ `GET /api/meta` 与 `GET /api/sources` **也会触发同一个检查**。
 *    因为前端首屏会同时要它们，谁先到不确定 —— 不让调用方去管顺序，
 *    而是让这几个读接口都能当“第一个”。
 *    `GET /api/health` 刻意**不**触发（监控会频繁打它）。
 */
export interface ApiItemsResponse {
  items: Item[]
  count: number
  /** 物品主数据来自哪个源 */
  itemSource: ItemSourceId
  /** 价格来自哪个源 */
  priceSource: PriceSourceId
  /** 权威数据的抓取时刻（ISO 8601）；从未抓过则为 null */
  lastFetchAt: string | null
  /** 数据已用了多少秒（用于状态栏显示"3 分钟前"） */
  ageSeconds: number | null
  /** 整份快照是否已过期 */
  snapshotStale: boolean
  /** 后台是否正在抓取（前端据此轮询并显示"正在获取最新价格…"） */
  refreshing: boolean
}

/**
 * ⭐ 展示用的「文案与调色板」—— 由后端下发，前端不自己写一份。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么这些必须从后端来
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. **本包只能放类型**（见 AGENTS.md §5）。这里的前提是两端都用
 *    `import type`，编译后整行消失、运行时根本不加载本包。
 *    一旦在里面写 `export const GRADE_CN = {...}`，前端就必须改成普通
 *    `import`，运行时真去加载那个 `.ts` 文件 → 直接崩。
 *
 * 2. **同一件事不能有两份定义**。品质色值是实测自 dergame 的 CSS 变量
 *    （不是猜的），要是前后端各写一份，改一次得改两处 —— 迟早会出现
 *    网页上“金”的边框和“金”的文字是两种颜色这种事。
 *
 * 所以后端 `get-data/src/constants.ts` 是唯一定义处，通过 `GET /api/meta` 下发。
 */
export interface LabelPalette {
  /** 品质：值（`"0"`~`"6"`）→ 中文名与颜色 */
  grade: Record<string, GradeStyle>
  /** 大类代码 → 中文名（官方接口只给子类中文名，大类名必须我们自己维护） */
  category: Record<string, string>
  /** 可获得性：值 → 简短标签（“可摸”/“限时下架”/“非战利品”） */
  availability: Record<string, string>
  /** 可获得性：值 → 详细说明（网页 tooltip 用） */
  availabilityDesc: Record<string, string>
  /** 赛季限定：值 → 标签（“本季”/“往季”） */
  seasonal: Record<string, string>
  /** 出产地来源：值 → 标签（“官方”/“人工补录”/“官方+人工”） */
  provenanceSource: Record<string, string>
}

/** 品质的展示口径 */
export interface GradeStyle {
  /** 中文名，如 "金" */
  label: string
  /** 色系名，网页用来选样式类 */
  tone: GradeTone
  /** 十六进制色值 */
  color: string
}

/**
 * GET /api/meta —— 筛选器选项与源状态。
 *
 * 所有选项都带 count，方便网页显示"道具 (711)"这样的数量提示。
 */
export interface ApiMetaResponse {
  /**
   * ⭐ 集市当期物品 —— **人工维护**（集市没有可用的官方接口，详见 get-data/src/market.ts）。
   *
   * 只有 `itemIds`（官方 ID），因为网页已经有全部物品了 ✓ ——
   * 让它自己按 ID 过滤即可，不用重复传一份物品数据。
   *
   * `itemIds` 为空 = 还没维护过（网页要如实显示"待补"，不要拿别的数据顶上）。
   */
  market: {
    updatedAt: string | null
    itemIds: string[]
    /** 解析不了 / 同名歧义等问题，直接给用户看 */
    problems: string[]
  }
  categories: MetaOption[]
  subcategories: MetaOption[]
  thirdClasses: MetaOption[]
  grades: MetaOption[]
  /** 出产地里出现过的地图名（由后端从 provenance 里切分去重得到） */
  maps: MetaOption[]
  sources: SourceStatus[]
  /** 价格口径说明，会直接显示在网页上，避免误解价格含义 */
  priceBasis: string | null
  /** 主数据源与价格源的名称匹配率（0~1）。当前实测 1.0。 */
  matchRate: number | null
  /** ⭐ 标签与调色板（运行时常量，本包放不下，见 LabelPalette 的说明） */
  labels: LabelPalette
}

/** 筛选器的一个选项 */
export interface MetaOption {
  /** 用于筛选比较的值 */
  value: string
  /** 显示文本 */
  label: string
  /** 该选项下的物品数量 */
  count: number
}

/**
 * GET /api/sources —— 各源健康状态。
 * 网页据此：可用源进筛选器、挂掉的源显示黄条、字段不全的源自动隐藏对应列。
 */
export interface ApiSourcesResponse {
  itemSources: SourceStatus[]
  priceSources: SourceStatus[]
  activeItemSource: ItemSourceId
  activePriceSource: PriceSourceId
  matchRate: number | null
  /** 需要展示给用户的警告，如"价格源与主数据匹配率偏低" */
  warnings: string[]
}

/**
 * GET /api/health
 *
 * 注意：**没有 nextFetchAt** —— 本项目取消了定时器，
 * 改为按需刷新（见 PLAN.md §6.7），所以只有"下次可刷新时刻"。
 */
export interface ApiHealthResponse {
  ok: boolean
  uptimeSeconds: number
  lastFetchAt: string | null
  lastFetchOk: boolean
  lastError: string | null
  snapshotStale: boolean
  itemCount: number
  ageSeconds: number | null
  refreshing: boolean
  /** 距上次抓取不足最小间隔时，这里是何时才允许再次抓取（ISO 8601） */
  refreshEligibleAt: string | null
  consecutiveFailures: number
}

/**
 * GET /api/daily —— 每日地图密码。
 *
 * ⚠️ 这是**另一类数据**：它每天变一次，不进快照、不进历史、不参与任何判定。
 *    所以后端用一个独立的轻量缓存（半小时 TTL），不塞进 snapshot.json。
 *
 * ⚠️ `secret` 是**字符串**（如 `"0178"`）—— 它可能有前导零，
 *    转成数字会变成 `178`（少一位，看错）。
 */
export interface ApiDailyResponse {
  secrets: Array<{
    /** 官方给的地图 id；字段缺失时为 null */
    mapId: number | null
    mapName: string
    secret: string
  }>
  /** 这份密码是什么时候取到的（ISO 8601）*/
  fetchedAt: string
}

/** POST /api/refresh 的响应 */
export interface ApiRefreshResponse {
  started: boolean
  message: string
}

/** 错误码。前端据此显示对应的中文提示，而不是把英文错误码甩给用户。 */
export type ApiErrorCode =
  /** 已有抓取在进行中（single-flight，多个标签页同时触发也只抓一次） */
  | 'refresh_in_progress'
  /** 距上次抓取不足最小间隔（防狂点刷新 / 脚本刷接口） */
  | 'refresh_too_soon'
  /** 还没有任何快照 */
  | 'no_snapshot'
  /** 源侧出错 */
  | 'source_error'
  | 'internal_error'

export interface ApiErrorResponse {
  error: string
  code?: ApiErrorCode
  detail?: string
  /** 限流时告诉前端还要等多少秒 */
  retryAfterSeconds?: number
}

/* ══════════════════════════════════════════════════════════════════════
 * v2 扩展点（占位说明，v1 不实现）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 1. 多价格源对比：在 ApiItemsResponse 上加
 *      compare?: Record<string, CompareQuote>
 *    以物品名为键，让网页能显示"官方均价 vs moligod 现价"的分歧。
 *    实测两者平均差 7.4%、极端离群（扑克牌差 550%），所以 v1 刻意不做融合、
 *    不取平均，只标注口径。
 *
 * 2. 历史价格曲线：dergame 有现成接口
 *      POST https://dergame.cn/api/Items/chartData  { itemId, chartType: 7 | 30 }
 *    moligod 只有 7 日高低两个点，没有曲线。
 */
