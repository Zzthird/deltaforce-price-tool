/**
 * `npm run provenance:import` —— 把填好的 CSV 回写成两个标注文件
 *
 * 配合 `npm run provenance:todo --emit csv` 使用：
 *   导出 CSV → 在 Excel 里填 → 跑这个脚本回写
 *
 * 它写两个文件（各管一件事）：
 *   overrides/provenance.json        ← 「模式」「你填的地图」列
 *   overrides/item-attributes.json   ← 「可获得性」「每组发数」「可上架」「备注」列
 *
 * 用法：
 *   npm run provenance:import                    # 读默认 CSV
 *   npm run provenance:import --from 别的.csv     # 指定输入
 *   npm run provenance:import --key id            # 用官方ID作键（默认用物品名）
 *   npm run provenance:import --replace-all       # 清空旧的，只保留 CSV 里的
 *   npm run provenance:import --dry-run           # 只报告不写文件
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三个刻意的设计
 * ═══════════════════════════════════════════════════════════════════════
 * ① **默认合并，不覆盖整个文件**：CSV 里填了的会更新，
 *    没出现在 CSV 里的旧条目**保持不动**。分几次填也不会丢东西。
 *
 * ② **“留空”的含义是“不动”，不是“清空”** —— 而且**逐字段判断**。
 *    即：你这次只填了「每组发数」，那这条的「可获得性」「可上架」
 *    会保持原样，不会被空值覆盖。
 *    想恢复默认值要**显式写**（可获得性写「可摸」、可上架写「是」）。
 *    这是刻意的安全设计 —— 否则 CSV 里 1500+ 行留空再导入，
 *    会把你已有的标注全删掉。
 *
 * ③ **键默认是「名字唯一时用物品名，名字有歧义时用官方ID」**（`--key auto`）。
 *    为什么不能一律用名字：实测官方有 **6 组同名物品**（ 13 条），
 *    最坑的是 `.300BLK` —— 3 条**不同品质、不同价**的子弹共用一个名字，
 *    给其中一个的标注会同时打到三条。
 *    为什么不能一律用官方ID：这个文件你以后要手读手改，
 *    名字比一串数字好认得多。所以只在必要处用 ID。
 *    注意：带 ID 键的都是**名字有歧义**的物品，所以故意写得很显眼，
 *    不会出现“偷偷有一半是 ID”这种看不懂的情况。
 *
 *    旧行为仍可用：`--key name`（全用名字）或 `--key id`（全用 ID）。
 *    加载器两种键都试（先 ID 再名字），所以新旧文件都能读。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadConfig } from '../src/config'
import { parseCsv, rowsToObjects, splitMapList } from '../src/csv'
import {
  loadItemAttributesOverrides,
  parseAvailability,
  parseListable,
  parseSeasonal,
  parseUnitsPerSlot,
  serializeItemAttributesOverrides,
  type ItemAttributeEntry,
  type ItemAttributesOverrides,
} from '../src/overrides/item-attributes'
import {
  loadProvenanceOverrides,
  serializeProvenanceOverrides,
  type OverrideMode,
  type ProvenanceOverrideEntry,
  type ProvenanceOverrides,
} from '../src/overrides/provenance'
import { parseProvenanceMaps } from '../src/provenance'

const RULE = '═'.repeat(84)
const THIN = '─'.repeat(84)

interface Args {
  from: string
  keyMode: 'auto' | 'name' | 'id'
  replaceAll: boolean
  dryRun: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let from = 'overrides/provenance-todo.csv'
  let keyMode: Args['keyMode'] = 'auto'
  let replaceAll = false
  let dryRun = false

  const takeValue = (arg: string, prefix: string): string | null =>
    arg.startsWith(prefix) ? arg.slice(prefix.length) : null

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--from' && argv[i + 1]) {
      from = argv[i + 1]!
      i += 1
      continue
    }
    const fromEq = takeValue(arg, '--from=')
    if (fromEq !== null) {
      from = fromEq
      continue
    }
    if (arg === '--key' && argv[i + 1]) {
      const v = argv[i + 1]
      keyMode = v === 'id' ? 'id' : v === 'name' ? 'name' : 'auto'
      i += 1
      continue
    }
    const keyEq = takeValue(arg, '--key=')
    if (keyEq !== null) {
      keyMode = keyEq === 'id' ? 'id' : keyEq === 'name' ? 'name' : 'auto'
    }
    if (arg === '--replace-all') replaceAll = true
    if (arg === '--dry-run') dryRun = true
  }

  return { from, keyMode, replaceAll, dryRun }
}

function normalizeMode(raw: string): OverrideMode {
  const v = raw.trim().toLowerCase()
  if (v === '追加' || v === 'append' || v === 'a' || v === 'add') return 'append'
  return 'replace'
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cfg = loadConfig()

  const csvPath = resolve(cfg.packageRoot, args.from)
  const provPath = cfg.provenanceOverridesPath
  const attrPath = cfg.itemAttributesOverridesPath

  console.log(RULE)
  console.log('  三角洲行动 · 回写人工标注')
  console.log(`  输入 ${csvPath}`)
  console.log(`  输出 ${provPath}`)
  console.log(`       ${attrPath}`)
  console.log(
    `  键用 ${
      args.keyMode === 'id'
        ? '官方ID（全部）'
        : args.keyMode === 'name'
          ? '物品名（全部）'
          : '自动：名字唯一用名字，同名用官方ID'
    }` +
      `${args.replaceAll ? ' · 清空旧数据' : ' · 与旧数据合并'}` +
      `${args.dryRun ? ' · dry-run（不写文件）' : ''}`,
  )
  console.log(RULE)

  /* ---------------- 1. 读 CSV ---------------- */
  let text: string
  try {
    text = await readFile(csvPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`\n❌ 找不到 CSV：${csvPath}`)
      console.error('   先生成一份：npm run provenance:todo --emit csv')
      process.exitCode = 1
      return
    }
    throw err
  }

  const { objects } = rowsToObjects(parseCsv(text))
  console.log(`\n[1/4] 读取 CSV：${objects.length} 行数据`)

  const MAP_COLUMN = '你填的地图'
  const AVAIL_COLUMN = '可获得性'
  const SEASONAL_COLUMN = '赛季限定'
  const UNITS_COLUMN = '每组发数'
  const LISTABLE_COLUMN = '可上架'
  const MODE_COLUMN = '模式'
  const NOTE_COLUMN = '备注'

  /*
   * ⭐ auto 模式：先算出哪些名字**有歧义**（同名物品 ≥ 2 条）。
   *
   * 官方实测有 6 组同名（ 13 条），最坑的是 `.300BLK`：
   * 3 条不同品质、价格差 11 倍的子弹共用一个名字。
   * 用名字做键的话，给其中一条的标注会同时打到三条。
   *
   * 所以：名字唯一 → 用名字（好认）；名字有歧义 → 用官方ID（精确）。
   */
  const nameCounts = new Map<string, number>()
  const idsByName = new Map<string, string[]>()
  for (const obj of objects) {
    const n = (obj['物品名'] ?? '').trim()
    const id = (obj['官方ID'] ?? '').trim()
    if (n === '') continue
    nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1)
    if (id !== '') {
      const arr = idsByName.get(n)
      if (arr) arr.push(id)
      else idsByName.set(n, [id])
    }
  }
  const ambiguousNames = new Set(
    [...nameCounts.entries()].filter(([, c]) => c > 1).map(([n]) => n),
  )

  /** 按模式算出这一行该用什么键 */
  function resolveKey(obj: Record<string, string>): string {
    if (args.keyMode === 'name') return (obj['物品名'] ?? '').trim()
    if (args.keyMode === 'id') return (obj['官方ID'] ?? '').trim()
    // auto：名字有歧义（或压根没名字）时退回官方ID
    const name = (obj['物品名'] ?? '').trim()
    if (name !== '' && !ambiguousNames.has(name)) return name
    return (obj['官方ID'] ?? '').trim()
  }

  if (args.keyMode === 'auto' && ambiguousNames.size > 0) {
    console.log(
      `      检测到 ${ambiguousNames.size} 个同名物品（共 ${[...ambiguousNames].reduce(
        (s, n) => s + (nameCounts.get(n) ?? 0),
        0,
      )} 条）→ 这些改用官方ID作键：`,
    )
    for (const n of ambiguousNames) {
      console.log(`        · ${n}（${nameCounts.get(n)} 条）`)
    }
  }

  const sample = objects[0]
  if (sample && !(MAP_COLUMN in sample)) {
    console.error(`\n❌ CSV 里找不到「${MAP_COLUMN}」列。`)
    console.error(`   实际列名：${Object.keys(sample).join(' | ')}`)
    console.error('   （旧版 CSV 请重新生成：npm run provenance:todo --emit csv）')
    process.exitCode = 1
    return
  }
  const hasNewColumns = sample ? UNITS_COLUMN in sample : false
  if (!hasNewColumns) {
    console.log(`      注意：这一版 CSV 没有「${UNITS_COLUMN}」列，本次不会回写每组发数`)
  }

  /* ---------------- 2. 解析 ---------------- */
  const incomingProv = new Map<string, ProvenanceOverrideEntry>()
  const incomingAttr = new Map<string, ItemAttributeEntry>()
  const problems: string[] = []
  let blank = 0
  let needKey = 0

  for (const obj of objects) {
    const rawMaps = obj[MAP_COLUMN] ?? ''
    const rawAvail = obj[AVAIL_COLUMN] ?? ''
    const rawSeasonal = obj[SEASONAL_COLUMN] ?? ''
    const rawUnits = hasNewColumns ? (obj[UNITS_COLUMN] ?? '') : ''
    const rawListable = hasNewColumns ? (obj[LISTABLE_COLUMN] ?? '') : ''
    const rawNote = (obj[NOTE_COLUMN] ?? '').trim()

    const explicitClear = /^[-—－]+$/.test(rawMaps.trim()) || rawMaps.trim() === '（无）'
    const maps = explicitClear ? [] : splitMapList(rawMaps)

    const availability = parseAvailability(rawAvail)
    const seasonal = parseSeasonal(rawSeasonal)
    const unitsPerSlot = parseUnitsPerSlot(rawUnits)
    const listable = parseListable(rawListable)

    const hasMapWork = maps.length > 0 || explicitClear
    const hasAttrWork =
      availability !== null ||
      seasonal !== null ||
      unitsPerSlot !== null ||
      listable !== null ||
      rawNote !== ''

    if (!hasMapWork && !hasAttrWork) {
      blank += 1
      continue
    }

    const key = resolveKey(obj)
    if (key === '') {
      needKey += 1
      continue
    }

    if (hasMapWork) {
      // 归一化：即使写了 "长弓溪谷-水泥厂"，写进文件的也是 "长弓溪谷"
      const normalized = maps.length > 0 ? (parseProvenanceMaps(maps.join(',')) ?? []) : []
      incomingProv.set(key, {
        // 写 `-` 显式清空时强制用 replace —— append + 空数组读起来很怪
        mode: normalized.length === 0 ? 'replace' : normalizeMode(obj[MODE_COLUMN] ?? ''),
        sources: normalized,
      })
    }

    if (hasAttrWork) {
      // ⭐ 只放"这次真的填了"的字段 —— 空字段不进 entry，
      //    合并时就不会把已有的值覆盖掉
      const entry: ItemAttributeEntry = {}
      if (availability !== null) entry.availability = availability
      if (seasonal !== null) entry.seasonal = seasonal
      if (unitsPerSlot !== null) entry.unitsPerSlot = unitsPerSlot
      if (listable !== null) entry.listable = listable
      if (rawNote !== '') entry.note = rawNote
      incomingAttr.set(key, entry)
    }
  }

  console.log(`[2/4] 解析填写内容`)
  console.log(
    `      地图 ${incomingProv.size} 条 · 物品属性 ${incomingAttr.size} 条` +
      ` · 空白跳过 ${blank} 行 · 缺键跳过 ${needKey} 行`,
  )
  for (const p of problems.slice(0, 5)) console.log(`      ⚠️  ${p}`)

  if (incomingProv.size === 0 && incomingAttr.size === 0) {
    console.log('\n⚠️  没有解析到任何填写内容 —— 你在 CSV 里填过东西吗？')
    console.log('   地图：写地图名，如「长弓溪谷」或「长弓溪谷、航天基地」')
    console.log('   可获得性：写「限时下架」或「非战利品」（留空 = 可摸）')
    console.log('   赛季限定：写「本季」或「往季」（留空 = 不是赛季限定）')
    console.log('   每组发数：只对弹药有意义，如 60 或 90')
    console.log('   可上架：不可上架的写「否」（留空 = 可上架）')
    process.exitCode = 1
    return
  }

  /* ---------------- 3. 合并 ---------------- */
  console.log('[3/4] 合并')
  const existProv = await loadProvenanceOverrides(provPath)
  const existAttr = await loadItemAttributesOverrides(attrPath)
  for (const p of [...existProv.problems, ...existAttr.problems]) {
    console.log(`      ⚠️  已有文件的问题：${p.key ? `[${p.key}] ` : ''}${p.message}`)
  }

  const mergedProv = new Map<string, ProvenanceOverrideEntry>()
  if (!args.replaceAll) for (const [k, v] of existProv.overrides.entries) mergedProv.set(k, v)

  const mergedAttr = new Map<string, ItemAttributeEntry>()
  if (!args.replaceAll) for (const [k, v] of existAttr.overrides.entries) mergedAttr.set(k, v)

  /*
   * ⭐ 一次性迁移：把「名字有歧义」的旧名字键升级成官方ID键。
   *
   * 为什么必须做：键的选择规则是「先按官方ID，再按名字」。
   * 如果留着旧的名字键，文件里就同时有一份**过期但仍在生效**的名字键 ——
   * 对没被单独标注的同名物品，它**仍然会静默生效**。
   * 下次你读这个文件会非常困惑：「.300BLK 这条到底算不算数？」
   *
   * 所以：把名字键的内容**搬到**每个同名物品的 ID 键上，再把名字键删掉。
   *
   * 幂等 —— 迁移过一次后名字键就不存在了，再跑是空操作。
   */
  let migrated = 0
  if (!args.replaceAll) {
    for (const name of ambiguousNames) {
      const ids = idsByName.get(name) ?? []
      if (ids.length < 2) continue

      const provEntry = existProv.overrides.entries.get(name)
      const attrEntry = existAttr.overrides.entries.get(name)
      if (!provEntry && !attrEntry) continue

      for (const id of ids) {
        // 不覆盖已经单独标注过的 ID 键
        if (provEntry && !mergedProv.has(id)) mergedProv.set(id, provEntry)
        if (attrEntry && !mergedAttr.has(id)) mergedAttr.set(id, attrEntry)
      }
      mergedProv.delete(name)
      mergedAttr.delete(name)
      migrated += 1
    }
    if (migrated > 0) {
      console.log(`      ↻ 迁移了 ${migrated} 个同名旧键 → 官方ID 键（旧名字键已删除）`)
    }
  }

  let provAdded = 0
  let provUpdated = 0
  for (const [k, v] of incomingProv) {
    if (mergedProv.has(k)) provUpdated += 1
    else provAdded += 1
    mergedProv.set(k, v)
  }

  // ⭐ 物品属性是**逐字段合并**：只改这次填了的字段，其余保持原样
  let attrAdded = 0
  let attrUpdated = 0
  for (const [k, inc] of incomingAttr) {
    const prev = mergedAttr.get(k)
    if (prev) attrUpdated += 1
    else attrAdded += 1
    const next: ItemAttributeEntry = { ...(prev ?? {}) }
    if (inc.availability !== undefined) next.availability = inc.availability
    if (inc.seasonal !== undefined) next.seasonal = inc.seasonal
    if (inc.listable !== undefined) next.listable = inc.listable
    if (inc.unitsPerSlot !== undefined) next.unitsPerSlot = inc.unitsPerSlot
    if (inc.note !== undefined) next.note = inc.note
    mergedAttr.set(k, next)
  }

  console.log(
    `      出产地      新增 ${provAdded} · 更新 ${provUpdated} · 总 ${mergedProv.size} 条`,
  )
  console.log(
    `      物品属性    新增 ${attrAdded} · 更新 ${attrUpdated} · 总 ${mergedAttr.size} 条（逐字段合并）`,
  )

  if (args.dryRun) {
    console.log('\n(dry-run：不实际写文件)')
    console.log(RULE)
    return
  }

  /* ---------------- 4. 写回 ---------------- */
  const finalProv: ProvenanceOverrides = { entries: mergedProv, rawKeyCount: mergedProv.size }
  const finalAttr: ItemAttributesOverrides = {
    entries: mergedAttr,
    rawKeyCount: mergedAttr.size,
  }

  await mkdir(dirname(provPath), { recursive: true })
  await writeFile(provPath, serializeProvenanceOverrides(finalProv), 'utf8')

  await mkdir(dirname(attrPath), { recursive: true })
  await writeFile(attrPath, serializeItemAttributesOverrides(finalAttr), 'utf8')

  console.log(`\n${THIN}`)
  console.log('✅ 已写入')
  console.log(`   出产地    ${String(mergedProv.size).padStart(4)} 条 → ${provPath}`)
  console.log(`   物品属性  ${String(mergedAttr.size).padStart(4)} 条 → ${attrPath}`)
  console.log('   下一步：npm run fetch 看效果')
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error('\n❌ 失败：')
  console.error(err instanceof Error ? `   ${err.name}: ${err.message}` : `   ${String(err)}`)
  process.exitCode = 1
})
