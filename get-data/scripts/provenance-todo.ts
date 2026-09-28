/**
 * `npm run provenance:todo` —— 待补清单 + CSV 导出/更新
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它解决的是整个"人工补数据"流程里最难的环节
 * ═══════════════════════════════════════════════════════════════════════
 * 难点**不是编辑**，而是**知道该补哪些**。所以：
 *
 *   ① 按"待补优先"排序 —— **算不出单格价值的排最前面**
 *      （主要是还没标「每组发数」的弹药），并且待补项内部**按子类分组**，
 *      这样同一口径的子弹排在一起，Excel 里可以拖动填充
 *   ② 列出官方已有哪些地图、以及已有的人工标注
 *   ③ 导出成 CSV，让你在 Excel 里批量填
 *
 * ⭐ **重新导出不会丢你已填的内容** —— 导出前会先读一遍旧 CSV，
 *    把用户要填的那几列按官方ID 搬过来，并且会从已导入的标注文件回填。
 *
 * 用法：
 *   npm run provenance:todo                     # 只打印清单，不导出
 *   npm run provenance:todo --emit csv          # 导出/更新完整列表（推荐）
 *   npm run provenance:todo --emit csv --only-missing    # 只导出还没出产地的
 *   npm run provenance:todo --emit csv --no-keep         # 不保留旧填写（慎用）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadConfig } from '../src/config'
import {
  AVAILABILITY_CN,
  CATEGORY_CN,
  GRADE_CN,
  PROVENANCE_ALL_MAPS,
  SEASONAL_CN,
} from '../src/constants'
import { parseCsv, rowsToObjects, toCsv, type CsvCell } from '../src/csv'
import { joinPrices } from '../src/join'
import { createLogger } from '../src/logger'
import { computePricePerSlot, computeSlots } from '../src/metrics'
import {
  applyItemAttributesOverrides,
  loadItemAttributesOverrides,
  resolveUnitsPerSlot,
} from '../src/overrides/item-attributes'
import {
  applyProvenanceOverrides,
  loadProvenanceOverrides,
  validateMapNames,
} from '../src/overrides/provenance'
import { fetchEverything } from '../src/pipeline'
import { collectMapNames, expandAllMaps, parseProvenanceMaps } from '../src/provenance'

const RULE = '═'.repeat(84)
const THIN = '─'.repeat(84)

const fmtInt = (n: number): string => n.toLocaleString('zh-CN')
const catLabel = (code: string): string => CATEGORY_CN[code] ?? code

/** 用户在 CSV 里要填的列（重新导出时需要保留） */
const USER_COLUMNS = [
  '模式',
  '你填的地图',
  '可获得性',
  '赛季限定',
  '每组发数',
  '可上架',
  '备注',
] as const
/** 其中不属于「模式」的（判断"这行到底填过没有"时用） */
const FILLED_COLUMNS = ['你填的地图', '可获得性', '赛季限定', '每组发数', '可上架', '备注'] as const

/**
 * ⭐ 列改过名的，读旧 CSV 时要同时看旧列名。
 *
 * 不加这个的话，改列名会静默丢数据：保留逻辑按列名读取，
 * 旧 CSV 里叫「赛季弹」、新代码找「赛季限定」→ 读不到 → 你填的 191 行全丢。
 * （这是真实发生的：改完列名才发现用户已经填了 191 行）
 */
const LEGACY_COLUMN_NAMES: Readonly<Record<string, readonly string[]>> = {
  赛季限定: ['赛季弹'],
}

/** 读一个单元格：按新列名读不到时，尝试旧列名 */
function readCell(obj: Record<string, string>, column: string): string {
  const direct = obj[column]
  if (direct !== undefined) return direct
  for (const legacy of LEGACY_COLUMN_NAMES[column] ?? []) {
    const v = obj[legacy]
    if (v !== undefined) return v
  }
  return ''
}

/* ---------------------------- 参数解析 ---------------------------- */

interface Args {
  emitCsv: boolean
  onlyMissing: boolean
  keepFills: boolean
  outPath: string | null
  top: number
}

function parseArgs(argv: readonly string[]): Args {
  let emitCsv = false
  let onlyMissing = false
  let keepFills = true
  let outPath: string | null = null
  let top = 25

  const takeValue = (arg: string, prefix: string): string | null =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--emit' && argv[i + 1] === 'csv') {
      emitCsv = true
      i += 1
      continue
    }
    const emitEq = takeValue(arg, '--emit=')
    if (emitEq !== null) {
      emitCsv = emitEq.trim().toLowerCase() === 'csv'
      continue
    }
    if (arg === '--only-missing') {
      onlyMissing = true
      continue
    }
    if (arg === '--no-keep') {
      keepFills = false
      continue
    }
    if (arg === '--out' && argv[i + 1]) {
      outPath = argv[i + 1]!
      i += 1
      continue
    }
    const outEq = takeValue(arg, '--out=')
    if (outEq !== null) {
      outPath = outEq
      continue
    }
    if (arg === '--top' && argv[i + 1]) {
      top = Number(argv[i + 1]) || top
      i += 1
      continue
    }
    const topEq = takeValue(arg, '--top=')
    if (topEq !== null) top = Number(topEq) || top
  }

  return { emitCsv, onlyMissing, keepFills, outPath, top }
}

/* ---------------------------- 保留旧填写 ---------------------------- */

/** 从已存在的 CSV 里读出用户填写过的内容（按官方ID 索引） */
async function readExistingFills(csvPath: string): Promise<Map<string, Record<string, string>>> {
  const map = new Map<string, Record<string, string>>()
  let text: string
  try {
    text = await readFile(csvPath, 'utf8')
  } catch {
    return map
  }

  const { objects } = rowsToObjects(parseCsv(text))
  for (const obj of objects) {
    const id = (obj['官方ID'] ?? '').trim()
    if (id === '') continue
    const kept: Record<string, string> = {}
    let hasAnything = false
    for (const col of USER_COLUMNS) {
      kept[col] = readCell(obj, col).trim()
    }
    for (const col of FILLED_COLUMNS) {
      if ((kept[col] ?? '') !== '') hasAnything = true
    }
    if (hasAnything) map.set(id, kept)
  }
  return map
}

/* ---------------------------- 一行数据 ---------------------------- */

interface TodoRow {
  sourceItemId: string
  name: string
  categoryCode: string
  categoryCn: string
  subcategory: string
  thirdClass: string
  gradeCn: string
  slots: number
  price: number | null
  perSlot: number | null
  officialMaps: string[]
  finalMaps: string[] | null
  provenanceSource: string | null
  availability: string
  unitsPerSlot: number | null
  listable: boolean
  note: string | null
  suggestedMode: '替换' | '追加'
}

/** 这条是不是"待补"（有价格但算不出单格价值） */
const isTodo = (r: TodoRow): boolean => r.price !== null && r.perSlot === null

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()
  const logger = createLogger(cfg.logLevel)

  console.log(RULE)
  console.log('  三角洲行动 · 待补清单 / CSV 更新')
  console.log(`  时间 ${new Date().toLocaleString('zh-CN')}`)
  console.log(RULE)

  /* ---------------- 1. 取数 ---------------- */
  console.log('\n[1/4] 抓取数据（清单要按单格价值排序，所以需要价格）')
  const fetched = await fetchEverything(cfg, logger)
  const { items: joined } = joinPrices(fetched.items, fetched.prices)
  const pricedCount = joined.filter((j) => j.quote?.price != null).length
  console.log(`      主数据 ${fmtInt(fetched.items.length)} 条 · 有价格 ${fmtInt(pricedCount)} 条`)

  /* ---------------- 2. 合并人工标注 ---------------- */
  console.log('\n[2/4] 合并人工标注')
  const provLoad = await loadProvenanceOverrides(cfg.provenanceOverridesPath)
  const attrLoad = await loadItemAttributesOverrides(cfg.itemAttributesOverridesPath)

  for (const p of [...provLoad.problems, ...attrLoad.problems]) {
    console.log(`      ⚠️  ${p.key ? `[${p.key}] ` : ''}${p.message}`)
  }

  const provApplied = applyProvenanceOverrides(fetched.items, provLoad.overrides)
  const attrApplied = applyItemAttributesOverrides(fetched.items, attrLoad.overrides)

  console.log(
    `      出产地    ${fmtInt(provLoad.overrides.entries.size)} 条标注` +
      ` · 命中 ${fmtInt(provApplied.stats.applied)}`,
  )
  console.log(
    `      物品属性  ${fmtInt(attrLoad.overrides.entries.size)} 条标注` +
      ` · 命中 ${fmtInt(attrApplied.stats.applied)}` +
      `（不可摸 ${fmtInt(attrApplied.stats.unobtainable)}` +
      ` · 已失效 ${fmtInt(attrApplied.stats.expired)}` +
      ` · 不可上架 ${fmtInt(attrApplied.stats.notListable)}` +
      ` · 每格单位数未知 ${fmtInt(attrApplied.stats.unitsUnknown)}）`,
  )

  for (const [label, keys] of [
    ['出产地', provApplied.stats.unmatchedKeys],
    ['物品属性', attrApplied.stats.unmatchedKeys],
  ] as const) {
    if (keys.length === 0) continue
    console.log(`      ⚠️  ${label}有 ${keys.length} 个键没匹配上：`)
    console.log(`          ${keys.slice(0, 8).join(' | ')}${keys.length > 8 ? ' …' : ''}`)
  }

  const officialMapNames = collectMapNames(fetched.items)

  /* ⭐ 地图名软校验：只警告，不阻拦 */
  const unknownMaps = validateMapNames(provLoad.overrides, officialMapNames)
  if (unknownMaps.length > 0) {
    console.log('\n      ⚠️  以下地图名在官方数据里从未出现过（可能是打错字，也可能是新地图）：')
    for (const u of unknownMaps) {
      console.log(
        `          「${u.mapName}」被 ${u.usedBy} 条覆盖使用，例如：${u.keys.slice(0, 3).join(', ')}`,
      )
    }
    console.log(`          官方见过：${officialMapNames.join('、') || '（无）'}`)
  }

  /* ---------------- 3. 构建清单 ---------------- */
  console.log('\n[3/4] 生成清单')

  const rows: TodoRow[] = []
  for (const { item, quote } of joined) {
    const price = quote?.price ?? null
    const slots = computeSlots(item.width, item.length)
    const officialMaps = parseProvenanceMaps(item.rawProvenance) ?? []
    const mergedProv = provApplied.byItemId.get(item.sourceItemId)
    const attr = attrApplied.byItemId.get(item.sourceItemId)

    const unitsPerSlot = resolveUnitsPerSlot(item.categoryCode, attr)

    rows.push({
      sourceItemId: item.sourceItemId,
      name: item.name,
      categoryCode: item.categoryCode,
      categoryCn: catLabel(item.categoryCode),
      subcategory: item.subcategoryCn ?? item.subcategory,
      thirdClass: item.thirdClassCn ?? item.thirdClass ?? '',
      gradeCn: GRADE_CN[item.grade as 0 | 1 | 2 | 3 | 4 | 5 | 6] ?? String(item.grade),
      slots,
      price,
      perSlot: computePricePerSlot(price, slots, unitsPerSlot),
      officialMaps,
      finalMaps: expandAllMaps(mergedProv?.maps ?? null, officialMapNames),
      provenanceSource: mergedProv?.source ?? (officialMaps.length > 0 ? 'official' : null),
      availability: attr?.availability ?? 'lootable',
      unitsPerSlot,
      listable: attr?.listable ?? true,
      note: attr?.note ?? null,
      suggestedMode: officialMaps.length > 0 ? '追加' : '替换',
    })
  }

  /**
   * ⭐ 排序：待补的排最前
   *
   *   ① 待补项（有价格但算不出单格价值）在最前，**内部按子类分组**
   *      —— 这样同一口径的子弹排在一起，Excel 里可以拖动填充
   *   ② 其余按单格价值降序
   *
   * 为什么把待补项放最前：CSV 是**填写工具**（浏览用网页），
   * 所以排序应该服务于"你接下来要填什么"。
   */
  rows.sort((a, b) => {
    const aTodo = isTodo(a)
    const bTodo = isTodo(b)
    if (aTodo !== bTodo) return aTodo ? -1 : 1

    if (aTodo && bTodo) {
      const bySub = a.subcategory.localeCompare(b.subcategory, 'zh')
      if (bySub !== 0) return bySub
      return a.name.localeCompare(b.name, 'zh')
    }

    if (a.perSlot === null && b.perSlot === null) return a.name.localeCompare(b.name, 'zh')
    if (a.perSlot === null) return 1
    if (b.perSlot === null) return -1
    if (b.perSlot !== a.perSlot) return b.perSlot - a.perSlot
    return a.name.localeCompare(b.name, 'zh')
  })

  const todoRows = rows.filter(isTodo)
  const missing = rows.filter((r) => r.finalMaps === null)
  const missingLootable = missing.filter((r) => r.availability === 'lootable')
  const selected = args.onlyMissing ? missing : rows

  console.log(`      全部物品        ${fmtInt(rows.length)} 条`)
  console.log(
    `      ⚠️ 待补单格价值  ${fmtInt(todoRows.length)} 条` +
      `（${[...new Set(todoRows.map((r) => r.subcategory))].slice(0, 5).join('/')} …）` +
      ` —— 这些排在最前面方便你填`,
  )
  console.log(
    `      待补出产地      ${fmtInt(missing.length)} 条，其中 ${fmtInt(missingLootable.length)} 条可摸（真正该补的）`,
  )
  console.log(`      不可上架交易行  ${fmtInt(rows.filter((r) => !r.listable).length)} 条`)
  console.log(`      本次导出范围    ${args.onlyMissing ? '只含待补出产地的' : '完整列表'} → ${fmtInt(selected.length)} 条`)

  /* ---------------- 待补单格价值的明细（最重要的一屏） ---------------- */
  if (todoRows.length > 0) {
    console.log(`\n${THIN}`)
    console.log(`  ⚠️ 待补「每组发数」的 ${fmtInt(todoRows.length)} 条（按子类分组，优先级从上到下）`)
    console.log('  序号  物品名                          大类   子类         单价      条数')
    const bySub = new Map<string, TodoRow[]>()
    for (const r of todoRows) {
      const arr = bySub.get(r.subcategory)
      if (arr) arr.push(r)
      else bySub.set(r.subcategory, [r])
    }
    for (const [sub, list] of [...bySub.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(
        `        ${catLabel(list[0]!.categoryCode).padEnd(6)} ${sub.padEnd(12)}` +
          ` ${String(list.length).padStart(4)} 条` +
          `   例：${list
            .slice(0, 2)
            .map((x) => `${x.name}(${x.price ?? '无价'})`)
            .join(', ')}`,
      )
    }
  }

  /* ---------------- Top N 预览 ---------------- */
  console.log(`\n${THIN}`)
  console.log(`  单格价值 Top ${args.top}（已能排序的）`)
  console.log('  排名      单格价值  名称                        大类   子类      占格  每组   出产地')
  rows
    .filter((r) => r.perSlot !== null && r.listable && r.availability === 'lootable')
    .slice(0, args.top)
    .forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(4)}  ${fmtInt(Math.round(r.perSlot!)).padStart(12)}  ` +
          `${r.name.padEnd(26).slice(0, 26)}  ${r.categoryCn.padEnd(5)} ` +
          `${r.subcategory.padEnd(8)} ${String(r.slots).padStart(3)}  ` +
          `${String(r.unitsPerSlot ?? '?').padStart(4)}   ${(r.officialMaps.join('、') || '—').slice(0, 22)}`,
      )
    })

  /* ---------------- 导出 CSV ---------------- */
  if (!args.emitCsv) {
    console.log(`\n${THIN}`)
    console.log('  提示：加 --emit csv 可把清单导出成 Excel 可编辑的表格')
    console.log('        npm run provenance:todo --emit csv')
    console.log(RULE)
    return
  }

  const outPath = resolve(cfg.packageRoot, args.outPath ?? 'overrides/provenance-todo.csv')
  await mkdir(dirname(outPath), { recursive: true })

  // ⭐ 先读旧文件的填写内容，避免覆盖掉你的工作
  const kept = args.keepFills ? await readExistingFills(outPath) : new Map<string, Record<string, string>>()
  if (args.keepFills && kept.size > 0) {
    console.log(`\n${THIN}`)
    console.log(`♻️  检测到旧 CSV 里已有 ${fmtInt(kept.size)} 行填写内容，本次导出会保留它们`)
  }

  const header = [
    '序号', '官方ID', '物品名', '大类', '子类', '细类', '品质',
    '占格', '单价', '单格价值', '官方已标注的地图',
    '模式', '你填的地图', '可获得性', '赛季限定', '每组发数', '可上架', '备注',
  ]

  const csvRows: CsvCell[][] = [header]
  let carried = 0
  let refilled = 0

  selected.forEach((r, i) => {
    const old = kept.get(r.sourceItemId)
    if (old) carried += 1

    const provEntry =
      provLoad.overrides.entries.get(r.sourceItemId) ?? provLoad.overrides.entries.get(r.name)
    const attrEntry =
      attrLoad.overrides.entries.get(r.sourceItemId) ?? attrLoad.overrides.entries.get(r.name)

    // ── 你填的地图：优先旧 CSV（还没导入的进行中内容），其次从覆盖文件回填
    let mapsCell = old?.['你填的地图'] ?? ''
    if (mapsCell === '' && provEntry) {
      mapsCell = provEntry.sources.length > 0 ? provEntry.sources.join('、') : '-'
      refilled += 1
    }
    const modeCell = old?.['模式'] || (mapsCell === '-' ? '替换' : r.suggestedMode)

    // ── 可获得性
    let availCell = old?.['可获得性'] ?? ''
    if (availCell === '' && attrEntry?.availability) {
      availCell = AVAILABILITY_CN[attrEntry.availability] ?? attrEntry.availability
    }

    // ── 赛季限定（留空 = 不是赛季限定）
    let seasonalCell = old?.['赛季限定'] ?? ''
    if (seasonalCell === '' && attrEntry?.seasonal) {
      seasonalCell = SEASONAL_CN[attrEntry.seasonal] ?? attrEntry.seasonal
    }

    // ── 每组发数（只对弹药有意义；非弹药留空 = 用默认值 1）
    let unitsCell = old?.['每组发数'] ?? ''
    if (unitsCell === '' && attrEntry?.unitsPerSlot !== undefined) {
      unitsCell = String(attrEntry.unitsPerSlot)
    }

    // ── 可上架（留空 = 可上架）
    let listableCell = old?.['可上架'] ?? ''
    if (listableCell === '' && attrEntry?.listable === false) listableCell = '否'

    const noteCell = old?.['备注'] || attrEntry?.note || ''

    csvRows.push([
      i + 1,
      r.sourceItemId,
      r.name,
      r.categoryCn,
      r.subcategory,
      r.thirdClass,
      r.gradeCn,
      r.slots,
      r.price ?? '',
      r.perSlot === null ? '' : Math.round(r.perSlot),
      r.officialMaps.join('、'),
      modeCell,
      mapsCell,
      availCell,
      seasonalCell,
      unitsCell,
      listableCell,
      noteCell,
    ])
  })

  await writeFile(outPath, toCsv(csvRows), 'utf8')

  console.log(`\n${THIN}`)
  console.log(`✅ 已导出 ${fmtInt(selected.length)} 行 → ${outPath}`)
  if (args.keepFills && kept.size > 0) console.log(`   ♻️  保留了 ${fmtInt(carried)} 行的旧填写内容`)
  if (refilled > 0) console.log(`   ♻️  从覆盖文件回填了 ${fmtInt(refilled)} 行的「你填的地图」`)

  console.log('\n   要填的列：')
  console.log('     「你填的地图」 —— 这个物品【能在这张图拾到】才写（不是"它属于这张图"）')
  console.log('                      多个地图用 `、` `,` `/` `|` 或空格分隔；写 `-` 表示确认没有出产地')
  console.log('                      普通钥匙哪都能拾到 → 写「全地图」；Boss 专属掉落 → 写那一张图')
  console.log('     「可获得性」   —— 留空 = 可摸')
  console.log('                      「限时下架」= 曾经能拾、现在下架，**可能返场**（如旧赛季子弹）')
  console.log('                      「非战利品」= 机制上不产出，**不随赛季变化**（如只能兑换的道具）')
  console.log('     「赛季限定」     —— 留空 = 不是赛季限定；或写「本季」「往季」')
  console.log('                      ⭐ 填了它就**自动推导**可获得性和可上架性，不用重复填那两列')
  console.log('                      换季时只需跑一次 npm run season:rollover', )
  console.log('     「每组发数」   —— **只对弹药有意义**：一个格子能放多少发（如 60 或 90）')
  console.log('                      非弹药留空即可；弹药留空 = 单格价值算不出来')
  console.log('     「可上架」     —— 留空 = 可上架交易行；**不可上架**的写「否」')
  console.log('                      例：旧赛季子弹（有交易行价但只能卖军需处）')
  console.log('\n   填完后运行：npm run provenance:import')
  if (officialMapNames.length > 0) {
    console.log(`\n   已知地图名 → ${officialMapNames.join('、')}`)
    console.log(`   也可以写特殊值「${PROVENANCE_ALL_MAPS}」表示所有地图都会出`)
  }
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error('\n❌ 失败：')
  console.error(err instanceof Error ? `   ${err.name}: ${err.message}` : `   ${String(err)}`)
  process.exitCode = 1
})
