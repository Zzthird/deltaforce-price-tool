/**
 * 交易行手续费公式 —— 实测录入 + 实时分析。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 怎么用
 * ═══════════════════════════════════════════════════════════════════════
 *   npm run fee:probe
 *
 * 在交易行挂单，然后敲。**第一行带物品名，之后只敲两个数字**：
 *
 *   海洋之泪 1000 900        ← 带名字（顺便设成"当前物品"）
 *   10000 9000               ← 只敲数字，沿用当前物品 ✓
 *   100000 85000
 *   item D6 战术头盔          ← 换物品（不记录样本）
 *   10000 9000               ← 现在是 D6 战术头盔
 *
 * 每敲一行立刻算出费率，并告诉你**下一个该测什么价格**
 * （二分逼近档位边界）—— 所以不需要猜，几次就能把公式逼出来。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 打错了怎么办
 * ═══════════════════════════════════════════════════════════════════════
 *   fix 12000 10800   改掉**最后一条**的价格与到手（刚敲错用这个）
 *   del 3             删掉第 3 条（list 里有编号）
 *   undo              等价于删掉最后一条
 *   list              看所有样本与编号
 *
 * ⚠️ 这里**开着行编辑**（`terminal: true`）—— 所以上下键能翻历史、
 *    左右键能改字符、Ctrl+C 能退出。第一版把它关掉了，
 *    结果连"按上键改个数字再回车"都用不了，用起来很别扭。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 其它命令
 * ═══════════════════════════════════════════════════════════════════════
 *   report   完整分析（模型 + 档位 + 拟合情况）
 *   items    跨物品对比（费率是否还取决于物品本身）
 *   list     列出所有样本
 *   q        退出
 *
 * 分析逻辑全在 `src/fee.ts`（纯函数、有单测），这里只负责录入与打印。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { loadConfig } from '../src/config'
import {
  analyzeFee,
  analyzeRatioModel,
  compareAcrossItems,
  feeOf,
  findClosestItem,
  fmtRate,
  parseEntry,
  rateOf,
  type FeeSample,
} from '../src/fee'
import { loadSnapshot } from '../src/store'

const RULE = '─'.repeat(78)

/* ══════════════════════════ 存取 ══════════════════════════ */

async function loadSamples(path: string): Promise<FeeSample[]> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (x): x is FeeSample =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as FeeSample).item === 'string' &&
        typeof (x as FeeSample).price === 'number' &&
        typeof (x as FeeSample).net === 'number',
    )
  } catch {
    return []
  }
}

async function saveSamples(path: string, samples: readonly FeeSample[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(samples, null, 2), 'utf8')
}

/* ══════════════════════════ 打印 ══════════════════════════ */

function printSampleLine(s: FeeSample, index: number): void {
  const fee = feeOf(s)
  console.log(
    `  ${String(index).padStart(3)}. ${s.item.padEnd(18)} 挂价 ${s.price
      .toLocaleString('zh-CN')
      .padStart(12)}  到手 ${s.net.toLocaleString('zh-CN').padStart(12)}` +
      `  手续费 ${String(fee).padStart(10)}  →  ${fmtRate(rateOf(s))}`,
  )
}

function printAnalysis(samples: readonly FeeSample[]): void {
  /**
   * ⭐ 先看**比值模型** —— 实测发现这才是真正的规律。
   *
   * 用户手填 113 条样本，按「挂价」怎么拟合都对不上 ✗；
   * 直到他发了游戏截图，看到界面上有「参考价格 2,860」——
   * 按「挂价 ÷ 参考价」重排，U 形规律立刻出来（最低点正好在比值 ≈ 1）。
   *
   * 所以只要样本里带了参考价，就先报这个。
   */
  const ratio = analyzeRatioModel(samples)
  if (ratio.ready) {
    console.log()
    console.log(RULE)
    console.log(`  分析 · 比值模型（共 ${ratio.points.length} 个带参考价的样本）`)
    console.log(RULE)
    console.log(ratio.summary)
  } else if (ratio.points.length > 0 || samples.length >= 3) {
    console.log()
    console.log(RULE)
    console.log(ratio.summary)
    console.log(RULE)
  }

  console.log()
  console.log(RULE)
  console.log(`  分析 · 挂价模型（共 ${samples.length} 个样本）`)
  console.log(RULE)
  const a = analyzeFee(samples)
  console.log(a.summary)

  if (a.mismatches.length > 0) {
    console.log()
    console.log(`  ⚠️ ${a.mismatches.length} 个样本与模型不符：`)
    for (const m of a.mismatches.slice(0, 8)) {
      console.log(
        `    ${m.sample.item} @ ${m.sample.price.toLocaleString('zh-CN')}` +
          `  实测手续费 ${m.actualFee}，模型预测 ${m.predictedFee}`,
      )
    }
    if (a.mismatches.length > 8) console.log(`    …还有 ${a.mismatches.length - 8} 个`)
  }
  console.log(RULE)
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main(): Promise<void> {
  const cfg = loadConfig()
  const argv = process.argv.slice(2)
  const fileArgIndex = argv.indexOf('--file')
  const path = resolve(
    cfg.packageRoot,
    fileArgIndex >= 0 && argv[fileArgIndex + 1] ? argv[fileArgIndex + 1]! : 'data/fee-samples.json',
  )

  const samples = await loadSamples(path)

  /**
   * "当前物品" —— 从**最后一条样本**推断，不需要额外存状态。
   *
   * 为什么这样够用：你挂单时是在反复改**同一个**物品的价格，
   * 所以"上一条是哪个物品"几乎总是"现在要测哪个物品" ✓
   * （换物品时敲一句 `item 名字` 就行）
   */
  let currentItem: string | null = samples.length > 0 ? (samples[samples.length - 1]?.item ?? null) : null

  /**
   * 从本地快照补物品信息 —— **参考价是关键**。
   *
   * 为什么要参考价：搜索结果里说费率可能"按物品**参考价区间**浮动"、
   * "偏离官方推荐价格 → 费率上涨"。如果真是这样，那么自变量是
   * 「挂价 ÷ 参考价」而不是挂价本身 —— 而参考价我们本来就有。
   *
   * ⚠️ 用**模糊匹配**：用户手填的名字可能和游戏数据差几个字
   *    （实测：「海盗铜币」vs「锈迹斑斑的海盗铜币」）。
   */
  const meta = new Map<string, { grade: number; category: string; ref: number | null }>()
  const names: string[] = []
  try {
    const snap = await loadSnapshot(resolve(cfg.dataDir, 'snapshot.json'))
    for (const list of Object.values(snap?.partitions ?? {})) {
      for (const it of list) {
        const name = it.name.trim()
        const q = snap?.prices[name]
        names.push(name)
        meta.set(name, {
          grade: it.grade,
          category: it.categoryCode,
          // 参考价：优先 moligod 基准价（商店价），回退官方 avgPrice
          ref:
            (typeof q?.basePrice === 'number' ? q.basePrice : null) ??
            (typeof it.officialAvgPrice === 'number' ? it.officialAvgPrice : null),
        })
      }
    }
  } catch {
    // 快照不存在（第一次跑）→ 不带参考价也能用
  }

  /** 输入的名字 → 数据里的名字（查不到就返回原样，并让调用方提示） */
  function resolveItem(input: string): { name: string; how: string; ref: number | null } {
    const hit = findClosestItem(input, names)
    if (hit.matched === null) return { name: input, how: 'none', ref: null }
    return { name: hit.matched, how: hit.how, ref: meta.get(hit.matched)?.ref ?? null }
  }

  console.log(RULE)
  console.log('  三角洲行动 · 交易行手续费实测')
  console.log(`  样本文件 ${path}`)
  console.log(`  已有 ${samples.length} 个样本${samples.length > 0 ? '（敲 report 看分析）' : ''}`)
  if (currentItem !== null) console.log(`  当前物品 ${currentItem}（换物品敲：item 名字）`)
  console.log(RULE)
  console.log('  挂单后敲：  【物品名】 挂价 预计到手')
  console.log('    · 第一行带物品名：海洋之泪 1000 900')
  console.log('    · 之后只敲两个数：10000 9000        （沿用当前物品，不用再打名字）')
  console.log('    · 也可以：fee=100  或  r=10%')
  console.log('  打错了： fix 12000 10800（改最后一条） / del 3（删第 3 条） / undo / list')
  console.log('  其它：   report 分析 / items 跨物品对比 / q 退出')
  console.log('  提示：上下键可以翻历史，左右键可以改字符')
  console.log(RULE)

  /**
   * ⚠️ `terminal` 要按实际情况给。
   *
   * `terminal: true` 才有行编辑（左右键改字符）和上下键历史 ——
   * 而 `terminal: false` 会把它们全关掉，连"按上键改个数字再回车"都用不了 ✗。
   *
   * 但管道输入（`echo ... | npm run fee:probe`）时不能开 terminal ✗
   * （非 TTY 下开 terminal 模式会回显错乱）。所以按 `isTTY` 自动选 ✓
   */
  const isTTY = process.stdin.isTTY === true
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: isTTY,
    historySize: 200,
  })

  const prompt = (): void => {
    process.stdout.write(currentItem === null ? '\n物品? > ' : `\n${currentItem} > `)
  }

  prompt()

  for await (const rawLine of rl) {
    const line = rawLine.trim()

    if (line === '') {
      prompt()
      continue
    }

    if (line === 'q' || line === 'quit' || line === 'exit' || line === '退出') {
      break
    }

    if (line === 'report') {
      printAnalysis(samples)
      prompt()
      continue
    }

    if (line === 'items') {
      console.log()
      console.log(samples.length > 0 ? compareAcrossItems(samples) : '  （还没有样本）')
      prompt()
      continue
    }

    if (line === 'list') {
      if (samples.length === 0) console.log('  （还没有样本）')
      else samples.forEach((s, i) => printSampleLine(s, i + 1))
      prompt()
      continue
    }

    if (line === 'undo') {
      const removed = samples.pop()
      if (removed) {
        await saveSamples(path, samples)
        console.log(`  已删除：${removed.item} @ ${removed.price.toLocaleString('zh-CN')}（剩 ${samples.length} 个）`)
      } else {
        console.log('  （没有可删的）')
      }
      prompt()
      continue
    }

    /* ---------- del N：删掉指定编号 ---------- */
    const delMatch = /^del\s+(\d+)$/i.exec(line)
    if (delMatch) {
      const n = Number(delMatch[1])
      if (n < 1 || n > samples.length) {
        console.log(`  ✗ 没有第 ${n} 条（共 ${samples.length} 条，敲 list 看编号）`)
      } else {
        const [removed] = samples.splice(n - 1, 1)
        await saveSamples(path, samples)
        console.log(
          `  已删除第 ${n} 条：${removed?.item} @ ${(removed?.price ?? 0).toLocaleString('zh-CN')}` +
            `（剩 ${samples.length} 个）`,
        )
      }
      prompt()
      continue
    }

    /* ---------- fix 价格 到手：改最后一条 ---------- */
    const fixMatch = /^fix\s+(\S+)\s+(\S+)$/i.exec(line)
    if (fixMatch) {
      if (samples.length === 0) {
        console.log('  ✗ 还没有样本可改')
      } else {
        const last = samples[samples.length - 1]!
        const fixed = parseEntry(`${currentItem ?? last.item} ${fixMatch[1]} ${fixMatch[2]}`, last.item)
        if (fixed.kind !== 'sample') {
          console.log('  ✗ 看不懂，格式：fix 挂价 到手     例：fix 12000 10800')
        } else {
          const price = fixed.sample.price
          const net = fixed.sample.net
          samples[samples.length - 1] = { ...fixed.sample, item: last.item }
          await saveSamples(path, samples)
          console.log(
            `  已修正最后一条：${last.item}  挂价 ${last.price.toLocaleString('zh-CN')} → ${price.toLocaleString('zh-CN')}` +
              `  到手 ${last.net.toLocaleString('zh-CN')} → ${net.toLocaleString('zh-CN')}` +
              `  →  ${fmtRate(net === price ? 0 : (price - net) / price)}`,
          )
        }
      }
      prompt()
      continue
    }

    /* ---------- 录入 / 切换物品 ---------- */
    const parsed = parseEntry(line, currentItem)

    if (parsed.kind === 'switch') {
      currentItem = parsed.item
      console.log(`  已切换当前物品 → ${currentItem}（这条不记入样本）`)
      prompt()
      continue
    }

    if (parsed.kind === 'error') {
      console.log(`  ✗ ${parsed.message}`)
      prompt()
      continue
    }

    const sample = parsed.sample
    currentItem = sample.item

    const resolved = resolveItem(sample.item)
    const info = meta.get(resolved.name)
    if (info) {
      sample.grade = info.grade
      sample.category = info.category
    }
    if (resolved.how === 'none') {
      console.log(`  ⚠️ 数据里找不到「${sample.item}」—— 参考价查不到，跨物品对比会缺这一条`)
    } else if (resolved.how !== 'exact') {
      console.log(`  · 名字匹配到「${resolved.name}」（${resolved.how}）· 参考价 ${resolved.ref === null ? '—' : resolved.ref.toLocaleString('zh-CN')}`)
    } else if (resolved.ref !== null) {
      console.log(`  · 参考价 ${resolved.ref.toLocaleString('zh-CN')}`)
    }

    samples.push(sample)
    await saveSamples(path, samples)

    console.log(
      `  ✓ ${sample.item}  挂价 ${sample.price.toLocaleString('zh-CN')}` +
        `  到手 ${sample.net.toLocaleString('zh-CN')}` +
        `  手续费 ${feeOf(sample).toLocaleString('zh-CN')}` +
        `  →  ${fmtRate(rateOf(sample))}` +
        (info ? `  [品质 ${info.grade} · ${info.category}]` : ''),
    )

    /** 每录一条就重算一遍 —— 这样能立刻看到"比例变了"和"下一个测哪" */
    const mine = samples.filter((s) => s.item === sample.item)
    const a = analyzeFee(mine)
    console.log(`  ${sample.item} 已有 ${mine.length} 个样本`)
    if (a.kind === 'insufficient') {
      console.log(`  ${a.summary}`)
    } else if (a.kind === 'flat') {
      console.log(`  目前看是【固定比例 ${fmtRate(a.tiers[0]?.rate ?? 0)}】`)
      if (mine.length >= 4) {
        console.log('  → 已测 4 次以上且比例一致。可以再测一个很大的价格确认，然后换下一个物品')
      }
    } else {
      console.log(a.summary)
    }

    prompt()
  }

  rl.close()
  await saveSamples(path, samples)
  console.log()
  console.log(RULE)
  console.log(`  已保存 ${samples.length} 个样本 → ${path}`)
  if (samples.length > 0) printAnalysis(samples)
  console.log('  把上面「分析」那一段发我，我就能把公式写进 metrics.ts。')
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
