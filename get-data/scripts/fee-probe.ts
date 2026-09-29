/**
 * 交易行手续费公式 —— 实测录入 + 实时分析。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 怎么用
 * ═══════════════════════════════════════════════════════════════════════
 *   npm run fee:probe
 *
 * 然后在游戏交易行里挂单，每挂一次敲一行：
 *
 *   <物品名> <挂价> <预计到手>
 *
 * 例：
 *   海洋之泪 1000 900
 *   海洋之泪 10000 9000
 *   海洋之泪 1000000 850000
 *
 * 也支持直接给手续费（如果交易行显示的只有手续费）：
 *   海洋之泪 1000 fee=100
 *
 * 每敲一行它会立刻算出费率，并告诉你**下一个该测什么价格**
 * （二分逼近档位边界）—— 所以你不需要猜，几十次就能把公式逼出来。
 *
 * 其它命令：
 *   report   完整分析（模型 + 档位 + 拟合情况）
 *   items    跨物品对比（费率是否还取决于物品本身）
 *   list     列出所有样本
 *   undo     删掉最后一条（敲错了用）
 *   q        退出
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要有这个工具
 * ═══════════════════════════════════════════════════════════════════════
 * 「最高利润」依赖手续费公式，而公开资料互相矛盾且找不到官方费率表
 * （详见 docs/source-recon.md §九）。猜公式会算出一个"看着合理但错"的数，
 * 所以宁可实测。分析逻辑全在 `src/fee.ts`（纯函数、有单测），
 * 这个脚本只负责**录入与打印**。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { loadConfig } from '../src/config'
import {
  analyzeFee,
  compareAcrossItems,
  feeOf,
  fmtRate,
  parseSampleLine,
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
  console.log()
  console.log(RULE)
  console.log(`  分析（共 ${samples.length} 个样本）`)
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
   * 从本地快照里补物品的品质与大类。
   *
   * 为什么要补：搜索资料里有一条说费率可能"按物品参考价区间浮动" ——
   * 那意味着费率可能取决于**物品**而不只是挂价。带上品质/大类，
   * 事后才能验证"是不是品质越高费率越高"这类假设。
   * 找不到就算了（不阻断录入 —— 这是实测工具，不该被数据缺失拦住）。
   */
  const meta = new Map<string, { grade: number; category: string }>()
  try {
    const snap = await loadSnapshot(resolve(cfg.dataDir, 'snapshot.json'))
    for (const list of Object.values(snap?.partitions ?? {})) {
      for (const it of list) meta.set(it.name.trim(), { grade: it.grade, category: it.categoryCode })
    }
  } catch {
    // 快照不存在（第一次跑）→ 不带品质也能用
  }

  console.log(RULE)
  console.log('  三角洲行动 · 交易行手续费实测')
  console.log(`  样本文件 ${path}`)
  console.log(`  已有 ${samples.length} 个样本${samples.length > 0 ? '（report 看分析）' : ''}`)
  console.log(RULE)
  console.log('  在交易行挂单，然后敲：  物品名 挂价 预计到手')
  console.log('  例：  海洋之泪 1000 900        （也支持 fee=100 或 r=10%）')
  console.log('  命令： report / items / list / undo / q')
  console.log(RULE)

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })

  const prompt = (): void => {
    process.stdout.write('\n> ')
  }

  prompt()

  for await (const rawLine of rl) {
    const line = rawLine.trim()

    if (line === '' ) {
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
        console.log(
          `  已删除：${removed.item} @ ${removed.price.toLocaleString('zh-CN')}` +
            `（剩 ${samples.length} 个）`,
        )
      } else {
        console.log('  （没有可删的）')
      }
      prompt()
      continue
    }

    /* ---------- 录入一条样本 ---------- */
    const sample = parseSampleLine(line)
    if (sample === null) {
      console.log('  ✗ 看不懂这一行。格式：物品名 挂价 预计到手       例：海洋之泪 1000 900')
      prompt()
      continue
    }

    const info = meta.get(sample.item)
    if (info) {
      sample.grade = info.grade
      sample.category = info.category
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

    /** 每录一条就重算一遍 —— 这样你能立刻看到"比例变了"和"下一个测哪" */
    const a = analyzeFee(samples.filter((s) => s.item === sample.item))
    console.log(`  ${sample.item} 已有 ${samples.filter((s) => s.item === sample.item).length} 个样本`)
    if (a.kind === 'insufficient') {
      console.log(`  ${a.summary}`)
    } else if (a.kind === 'flat') {
      console.log(`  目前看是【固定比例 ${fmtRate(a.tiers[0]?.rate ?? 0)}】`)
      if (samples.filter((s) => s.item === sample.item).length >= 4) {
        console.log('  → 已测 4 次以上且比例一致，这个物品可以换下一个了（或再测一个很大的价格确认）')
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
