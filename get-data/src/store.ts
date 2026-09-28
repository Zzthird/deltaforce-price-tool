/**
 * store —— 落盘与读取。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⭐ 关键设计：快照存的是「原料」，不是「成品」
 * ═══════════════════════════════════════════════════════════════════════
 * 存的是 `SourceItem[] + 价格表`（抓来的原料），**不是** normalize 之后的 `Item[]`。
 *
 * 好处：**改人工标注后不需要重新抓取** —— 重新 normalize 一遍就能看到效果。
 * 抓取是唯一"给别人添麻烦"的动作，能省则省。
 * （副作用：网页上"该不该摸"的结论也跟着标注实时变，不用等下一次抓取。）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三条必须实现的保护
 * ═══════════════════════════════════════════════════════════════════════
 *  ① **原子写**：先写 `.tmp` 再 `rename`。落盘时断电/被杀进程，
 *     不会留下半个坏 JSON（rename 在同一文件系统上是原子的）。
 *  ② **「解析出 0 条」绝不覆盖旧快照**：源站改字段名时解析器会返回 0 条，
 *     如果直接落盘，你攒了几周的数据就被一次故障洗掉了。
 *  ③ **部分失败时保留旧分区**：官方源一轮要发 7 次请求（每个大类一次），
 *     其中 1~2 个失败不该让另外 1500 条白抓 —— 失败的分类沿用旧快照。
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from './logger'
import type { PriceQuote } from './prices/types'
import type { SourceItem } from './sources/types'
import { HARD_EXCLUDED_CATEGORY_CODES, HARD_EXCLUDED_ITEM_IDS } from './constants'

/** 快照格式版本。字段结构变化时 +1，便于旧文件被识别并忽略。 */
export const SNAPSHOT_VERSION = 1

export interface SnapshotMeta {
  version: number
  /** 抓取时刻（ISO 8601） */
  fetchedAt: string
  itemSourceId: string
  itemSourceLabel: string
  priceSourceLabel: string | null
  /** 价格口径说明，会显示在网页上 */
  priceBasis: string | null
  /** 这一轮里失败的分区（它们的条目来自旧快照） */
  failedPartitions: Array<{ key: string; error: string }>
  /** 这一轮实际发出的 HTTP 请求次数 */
  requestCount: number
}

export interface Snapshot {
  meta: SnapshotMeta
  /**
   * 按分区存放的原料。
   * 分区键就是 `SourceItem.categoryCode`（官方源即大类），
   * 这样部分失败时能精确地按分区保留旧数据。
   */
  partitions: Record<string, SourceItem[]>
  /** 价格表：物品名 → 价格快照 */
  prices: Record<string, PriceQuote>
}

/** 运行时状态（跨重启保留，用于"失败冷却"与状态栏） */
export interface RefreshState {
  lastAttemptAt: string | null
  lastOkAt: string | null
  lastError: string | null
  consecutiveFailures: number
  lastDurationMs: number | null
}

export const EMPTY_REFRESH_STATE: RefreshState = {
  lastAttemptAt: null,
  lastOkAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastDurationMs: null,
}

/* ══════════════════════════════════════════════════════════════════════
 * 原子写
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 原子地写一个文本文件。
 *
 * 步骤：建目录 → 写 `<path>.tmp` → `rename`。
 * `rename` 在同一文件系统上是**原子操作**，所以读到的永远是完整文件，
 * 不会是"写了一半"的状态。
 *
 * Python 类比：相当于 `tempfile.NamedTemporaryFile(dir=...)` + `os.replace()`。
 * 注意必须让临时文件和目标文件**在同一个目录**，否则跨文件系统的 rename 不原子。
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/* ══════════════════════════════════════════════════════════════════════
 * 快照
 * ══════════════════════════════════════════════════════════════════════ */

export interface LoadOptions {
  logger?: Logger
}

/**
 * 读快照。
 *
 * **任何读取失败都返回 null，不抛异常** —— 因为"没有可用快照"是一个
 * 合法状态（首次运行），上层据此触发一次抓取即可。
 * 但坏文件会记一条日志，避免静默吞掉问题。
 */
export async function loadSnapshot(
  path: string,
  options: LoadOptions = {},
): Promise<Snapshot | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    options.logger?.error('读取快照失败', { path, error: (err as Error).message })
    return null
  }

  try {
    const parsed = JSON.parse(text) as Snapshot
    if (parsed?.meta?.version !== SNAPSHOT_VERSION) {
      options.logger?.warn('快照版本不符，已忽略（会重新抓取）', {
        expected: SNAPSHOT_VERSION,
        actual: parsed?.meta?.version,
      })
      return null
    }
    if (!parsed.partitions || typeof parsed.partitions !== 'object') {
      options.logger?.warn('快照结构不符（缺少 partitions），已忽略', { path })
      return null
    }
    return parsed
  } catch (err) {
    options.logger?.error('快照 JSON 解析失败，已忽略（会重新抓取）', {
      path,
      error: (err as Error).message,
    })
    return null
  }
}

/** 把 `SourceItem[]` 按 `categoryCode` 分到各个分区里 */
export function groupByPartition(items: readonly SourceItem[]): Record<string, SourceItem[]> {
  const partitions: Record<string, SourceItem[]> = {}
  for (const item of items) {
    const key = item.categoryCode || 'unknown'
    const bucket = partitions[key]
    if (bucket) bucket.push(item)
    else partitions[key] = [item]
  }
  return partitions
}

export interface SaveOptions {
  logger?: Logger
}

/**
 * 写快照（原子写 + 0 条保护）。
 *
 * ⭐ **0 条保护**：如果整份快照一条数据都没有，直接跳过写入并返回 false。
 * 为什么：源站改字段名时解析器会返回 0 条，而那时**旧快照是唯一的好数据** ——
 * 落盘覆盖它等于把攒了几周的数据洗掉。
 *
 * @returns 是否真的写了
 */
export async function saveSnapshot(
  path: string,
  snapshot: Snapshot,
  options: SaveOptions = {},
): Promise<boolean> {
  const total = Object.values(snapshot.partitions).reduce((n, arr) => n + arr.length, 0)
  if (total === 0) {
    options.logger?.error('拒绝写入空快照（0 条）—— 这通常说明源站改了字段，保留旧快照才是对的', {
      path,
    })
    return false
  }

  await writeFileAtomic(path, JSON.stringify(snapshot))
  options.logger?.debug('快照已落盘', { path, items: total })
  return true
}

/**
 * 把这一轮抓取的结果与旧快照合并 —— **失败的分类沿用旧数据**。
 *
 * 这是方案里明确要求的行为：官方源一轮 7 次请求，其中 1~2 个失败
 * 不该让另外 1500 条白抓。合并后 `failedPartitions` 会如实记录哪些是旧的。
 *
 * 价格表同理：价格源挂了就整份沿用旧价（并在 warnings 里说明）。
 */
export interface MergeInput {
  fetchedAt: string
  itemSourceId: string
  itemSourceLabel: string
  priceSourceLabel: string | null
  priceBasis: string | null
  /** 这一轮成功抓到的条目 */
  items: readonly SourceItem[]
  /** 成功抓取的分类键 */
  okPartitions: readonly string[]
  /** 失败的分类键及原因 */
  failedPartitions: readonly { key: string; error: string }[]
  /** 这一轮的价格表（价格源失败时由调用方传空） */
  prices: ReadonlyMap<string, PriceQuote>
  priceFetchFailed: boolean
  requestCount: number
  logger?: Logger
}

export function mergeIntoSnapshot(
  previous: Snapshot | null,
  input: MergeInput,
): { snapshot: Snapshot; keptPartitions: string[]; keptPrices: boolean } {
  const fresh = groupByPartition(input.items)
  const partitions: Record<string, SourceItem[]> = { ...(previous?.partitions ?? {}) }
  const keptPartitions: string[] = []

  // 成功的分区用新数据覆盖
  for (const key of input.okPartitions) {
    /*
     * ⚠️ 硬排除的大类不参与“0 条 = 可疑”判定 —— 它们**本来就该是空的**。
     * 不跳过的话，每轮刷新都会打一条误导性警告：
     *
     *   WARN 分区抓到 0 条，已沿用旧数据 {"partition":"skin"}
     *
     * 让人以为源站出问题了，实际上是设计如此。
     */
    if (HARD_EXCLUDED_CATEGORY_CODES.includes(key)) continue

    const bucket = fresh[key]
    if (bucket && bucket.length > 0) {
      partitions[key] = bucket
    } else {
      // 分区“成功”但 0 条 —— 可疑（源站可能改了字段），沿用旧数据
      if (partitions[key]) {
        keptPartitions.push(key)
        input.logger?.warn('分区抓到 0 条，已沿用旧数据', { partition: key })
      }
    }
  }

  // 失败的分区保留旧的
  for (const failed of input.failedPartitions) {
    if (partitions[failed.key]) {
      keptPartitions.push(failed.key)
      input.logger?.warn('分区抓取失败，已沿用旧数据', {
        partition: failed.key,
        error: failed.error,
      })
    }
  }

  // 不在 okPartitions 里也没在 failedPartitions 里的分区（例如源把某个分类删了）
  // —— 保守起见：只要它在旧快照里有、这轮没被更新，就保留
  for (const key of Object.keys(partitions)) {
    if (!input.okPartitions.includes(key)) {
      if (!keptPartitions.includes(key)) keptPartitions.push(key)
    }
  }

  /*
   * ⭐ 硬排除的大类必须从快照里**删掉**，不能只是"这轮不写"。
   *
   * 为什么需要这一步 —— 一个实测踩到的连环坑：
   *
   * 上面那两道守卫（"分区 0 条 → 沿用旧数据"与"未更新的分区 → 保留"）
   * 会把旧快照里的分区**救回来**。而硬排除的大类（载具/皮肤）正是
   * "永远 0 条" —— 于是旧快照里的 10 条皮肤会被一次次救回来，
   * 硬排除形同虚设。实测日志里写得很清楚：
   *
   *   WARN [refresher] 分区抓到 0 条，已沿用旧数据 {"partition":"skin"}
   *   DEBUG [refresher] 快照已落盘 {"items":1574}   ← 本该是 1564
   *
   * 所以顺序很重要：**先让守卫跑完，再按排除清单做最后一道清理**。
   * 反过来的话，被删掉的分区又会被守卫从旧快照里搬回来。
   *
   * 另外这一步也让**旧快照**能自愈：以前存进去的皮肤/载具，
   * 不用等下一次抓取就会在落盘时消失。
   */
  for (const code of HARD_EXCLUDED_CATEGORY_CODES) {
    if (partitions[code]) delete partitions[code]
    const i = keptPartitions.indexOf(code)
    if (i >= 0) keptPartitions.splice(i, 1)
  }

  // 单条物品级的排除（按官方ID）—— 同样要能清理旧快照里已经存下的
  for (const [code, list] of Object.entries(partitions)) {
    const kept = list.filter((it) => !HARD_EXCLUDED_ITEM_IDS.includes(it.sourceItemId))
    if (kept.length !== list.length) partitions[code] = kept
  }

  const prices: Record<string, PriceQuote> = input.priceFetchFailed
    ? { ...(previous?.prices ?? {}) }
    : Object.fromEntries(input.prices)

  const snapshot: Snapshot = {
    meta: {
      version: SNAPSHOT_VERSION,
      fetchedAt: input.fetchedAt,
      itemSourceId: input.itemSourceId,
      itemSourceLabel: input.itemSourceLabel,
      priceSourceLabel: input.priceSourceLabel,
      priceBasis: input.priceBasis,
      failedPartitions: [...input.failedPartitions],
      requestCount: input.requestCount,
    },
    partitions,
    prices,
  }

  return {
    snapshot,
    keptPartitions: [...new Set(keptPartitions)],
    keptPrices: input.priceFetchFailed,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 历史快照（为将来的涨跌幅 / 走势图攒数据）
 * ══════════════════════════════════════════════════════════════════════ */

export interface HistoryFile {
  date: string
  /** objectID → 价格（精简，只存数字）。非卖品不存。 */
  prices: Record<string, number>
}

export function historyFilePath(dir: string, date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return join(dir, `${y}-${m}-${d}.json`)
}

/**
 * 追加一条当日历史记录。
 *
 * 每天一个文件，同一份文件里按 objectID 覆盖 —— 意思是"今天最后一次看到的价格"。
 * 为什么不做成时间序列：v1 只需要"昨日均价"这个量级的精度，
 * 而一天一个文件在体积（几十 KB）和可读性上都更实际。
 */
export async function appendHistory(
  dir: string,
  items: readonly { sourceItemId: string; price: number | null }[],
  now: Date,
): Promise<{ path: string; count: number }> {
  const path = historyFilePath(dir, now)
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  let existing: HistoryFile = { date, prices: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as HistoryFile
    if (parsed?.date === date && parsed.prices) existing = parsed
  } catch {
    // 首次写入当天，或文件坏了 —— 都重新开始
  }

  let count = 0
  for (const item of items) {
    if (item.price === null) continue
    existing.prices[item.sourceItemId] = item.price
    count += 1
  }

  await writeFileAtomic(path, JSON.stringify(existing))
  return { path, count }
}

/**
 * 清理超过保留天数的历史文件。
 *
 * ⚠️ 只删除**本模块自己写出来的、文件名严格符合 `YYYY-MM-DD.json` 的文件**。
 * 不做任何通配符/递归删除 —— 这是刻意的（见 AGENTS.md 的批量删除禁令，
 * 这个约束对程序自己也一样适用：宁可不删，也不要误删）。
 */
export async function pruneHistory(
  dir: string,
  keepDays: number,
  now: Date,
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000)
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const removed: string[] = []
  for (const name of names) {
    // 严格匹配我们自己的命名，别的文件一律不碰
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue
    if (name.slice(0, 10) >= cutoffKey) continue
    const full = join(dir, name)
    try {
      await unlink(full)
      removed.push(name)
    } catch {
      // 删不掉就算了 —— 历史文件多留几天没有危害
    }
  }
  return removed
}

/** 读某一天的历史价格（将来算涨跌幅要用） */
export async function loadHistory(dir: string, date: Date): Promise<HistoryFile | null> {
  try {
    const parsed = JSON.parse(await readFile(historyFilePath(dir, date), 'utf8')) as HistoryFile
    return parsed?.prices ? parsed : null
  } catch {
    return null
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 运行时状态（跨重启保留）
 * ══════════════════════════════════════════════════════════════════════ */

export async function loadRefreshState(
  path: string,
  options: LoadOptions = {},
): Promise<RefreshState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as RefreshState
    return { ...EMPTY_REFRESH_STATE, ...parsed }
  } catch {
    // 没有状态文件（首次运行）或文件坏了 —— 都从干净状态开始
    options.logger?.debug('没有可用的抓取状态，从初始状态开始')
    return { ...EMPTY_REFRESH_STATE }
  }
}

export async function saveRefreshState(path: string, state: RefreshState): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(state, null, 2))
}
