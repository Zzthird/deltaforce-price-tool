/**
 * 集市物品 —— **人工维护，从 overrides 里读**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么是人工维护（而不是抓来的）
 * ═══════════════════════════════════════════════════════════════════════
 * 「集市」是游戏里的**周期性兑换活动**：每期指定几件收集品，交上去换战备物资。
 * 一期可能一周、可能两周，看官方安排。
 *
 * 实测排查过：参考项目里出现的 method 总共 9 个，**没有任何一个是集市**；
 * 它的 `Tools.php` 是个抽奖玩具（名字里带 collection 才被搜到）。
 * 也就是说**集市没有可用的官方接口**。
 *
 * 所以和「出产地」一样走人工维护 ✓ —— 玩家（就是运营者本人）在游戏里看到
 * 当前是哪几件，敲一行命令更新即可：
 *
 *   npm run market:set 腕带 锈迹斑斑的海盗铜币
 *
 * ⚠️ 之前首页那张卡是我自己编的「现价 − 基准价 降序前 12 条」✗ ——
 *    用户指出那是错的：真实集市**就那几件**（当期为 2 件）。
 *    用「价格差排序」代替「官方指定清单」是把猜的东西当成事实 ✗。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface MarketOverride {
  /** 最后更新时间（ISO 字符串）；文件不存在时为 null */
  updatedAt: string | null
  /** 用户填的键：物品名**或**官方 ID（数字串） */
  keys: string[]
}

export interface LoadedMarket extends MarketOverride {
  /** 文件不存在（还没维护过）*/
  missing: boolean
  /** 读取/解析问题，直接给用户看 */
  problems: string[]
}

const EMPTY: MarketOverride = { updatedAt: null, keys: [] }

/** 从 JSON 文本解析（纯函数 → 可单测） */
export function parseMarket(text: string): { market: MarketOverride; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      market: EMPTY,
      problems: [`market.json 不是合法 JSON：${(err as Error).message}`],
    }
  }
  const o = raw as { updatedAt?: unknown; keys?: unknown }
  const problems: string[] = []
  if (!Array.isArray(o.keys)) {
    return { market: EMPTY, problems: ['market.json 缺少 keys 数组'] }
  }
  const keys: string[] = []
  for (const k of o.keys) {
    if (typeof k !== 'string' || k.trim() === '') {
      problems.push(`keys 里有非字符串或空项：${JSON.stringify(k)}`)
      continue
    }
    keys.push(k.trim())
  }
  const updatedAt = typeof o.updatedAt === 'string' ? o.updatedAt : null
  return { market: { updatedAt, keys }, problems }
}

export async function loadMarket(path: string): Promise<LoadedMarket> {
  try {
    const text = await readFile(path, 'utf8')
    const { market, problems } = parseMarket(text)
    return { ...market, missing: false, problems }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY, missing: true, problems: [] }
    }
    return {
      ...EMPTY,
      missing: false,
      problems: [`读取 market.json 失败：${(err as Error).message}`],
    }
  }
}

export async function saveMarket(path: string, keys: string[], now: Date): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const body = {
    updatedAt: now.toISOString(),
    note: '集市当期的收集品清单（游戏内周期性活动）。用 npm run market:set <名字或官方ID...> 更新。',
    keys,
  }
  await writeFile(path, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

/* ══════════════ 把键解析成物品 ══════════════ */

export interface MarketCandidate {
  sourceItemId: string
  name: string
}

export interface ResolvedMarket {
  itemIds: string[]
  /** 解析成功的键 → 实际物品名（用来让用户核对） */
  resolved: Array<{ key: string; name: string }>
  /** 解析不了 / 有歧义的键 + 原因，直接给用户看 */
  problems: string[]
}

/**
 * 键 → 官方 ID。
 *
 * 规则（和人工标注那套一致 ✓）：
 *   · 纯数字 → 当官方 ID 处理 ✓（同名物品必须用 ID，官方有 6 组同名）
 *   · 否则当名字精确匹配；**同名冲突时报错要求用 ID**，不猜 ✗
 *   · 找不到时给出"包含该关键词"的候选，方便改对 ✓
 */
export function resolveMarketKeys(keys: string[], items: MarketCandidate[]): ResolvedMarket {
  const byId = new Map(items.map((i) => [i.sourceItemId, i]))
  const byName = new Map<string, MarketCandidate[]>()
  for (const i of items) {
    const list = byName.get(i.name) ?? []
    list.push(i)
    byName.set(i.name, list)
  }

  const itemIds: string[] = []
  const resolved: Array<{ key: string; name: string }> = []
  const problems: string[] = []

  for (const key of keys) {
    if (/^\d+$/.test(key)) {
      const hit = byId.get(key)
      if (!hit) {
        problems.push(`官方 ID ${key} 不在物品主数据里`)
        continue
      }
      itemIds.push(hit.sourceItemId)
      resolved.push({ key, name: hit.name })
      continue
    }

    const hits = byName.get(key) ?? []
    if (hits.length === 1) {
      const hit = hits[0]!
      itemIds.push(hit.sourceItemId)
      resolved.push({ key, name: hit.name })
      continue
    }
    if (hits.length > 1) {
      problems.push(
        `名字「${key}」有 ${hits.length} 个同名物品（官方有 6 组同名情况）—— ` +
          `请改用官方 ID：${hits.map((h) => h.sourceItemId).join(' / ')}`,
      )
      continue
    }

    const fuzzy = items.filter((i) => i.name.includes(key)).slice(0, 5)
    problems.push(
      `找不到名字完全等于「${key}」的物品` +
        (fuzzy.length > 0
          ? `；相近的有：${fuzzy.map((f) => `${f.name}(${f.sourceItemId})`).join('、')}`
          : ''),
    )
  }

  return { itemIds, resolved, problems }
}
