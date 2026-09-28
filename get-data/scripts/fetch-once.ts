/**
 * `npm run fetch` —— 一次性抓取 + 完整管道，不开 HTTP 服务。
 *
 * 这是**排查问题的主力工具**：网页显示不对时先跑这个，看是主数据缺、
 * 价格缺、join 匹配不上、还是人工标注没生效。
 *
 * 它调用 `fetchAndBuild()`（和 Phase 7 的 HTTP 接口、Phase 6 的刷新器**同一套管道**），
 * 所以这里看到的结果与网页上的一定一致 —— 因为它内部不重复实现任何逻辑。
 *
 * 用法：
 *   npm run fetch                      # 按 .env 的配置抓
 *   PRICE_SOURCE=none npm run fetch    # 只抓主数据（验证价格源降级路径）
 */

import { loadConfig } from '../src/config'
import { AVAILABILITY_CN, CATEGORY_CN } from '../src/constants'
import { createLogger } from '../src/logger'
import type { Item } from '@deltaforce/shared'
import { fetchAndBuild } from '../src/pipeline'

const RULE = '═'.repeat(84)
const THIN = '─'.repeat(84)

const fmtInt = (n: number): string => n.toLocaleString('zh-CN')
const fmtPct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits)}%`
const catLabel = (code: string): string => CATEGORY_CN[code] ?? code

async function main(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger(cfg.logLevel)

  console.log(RULE)
  console.log('  三角洲行动 · 取数服务 — 一次性抓取')
  console.log(`  时间 ${new Date().toLocaleString('zh-CN')}`)
  console.log(`  配置 主数据源=${cfg.itemSource}  价格源=${cfg.priceSource}  日志级别=${cfg.logLevel}`)
  console.log(RULE)

  const t0 = Date.now()
  const r = await fetchAndBuild(cfg, logger)
  const elapsed = Date.now() - t0

  /* ══════════════ 抓取 ══════════════ */
  console.log(`\n[1/4] 抓取与合并（耗时 ${fmtInt(elapsed)}ms · 请求 ${fmtInt(r.requestCount)} 次）`)
  console.log(`      主数据源 ${r.itemSourceLabel} → ${fmtInt(r.items.length)} 条`)
  if (r.priceSourceLabel) {
    console.log(`      价格源   ${r.priceSourceLabel} → 口径「${r.priceBasis ?? '未声明'}」`)
  } else {
    console.log('      价格源   未使用')
  }
  console.log(
    `      名称匹配率 ${fmtPct(r.joinStats.nameMatchRate)}` +
      ` · 价格覆盖率 ${fmtPct(r.joinStats.priceCoverage)}` +
      `（①有价格 ${fmtInt(r.joinStats.matchedWithPrice)}` +
      ` ②匹配但无价 ${fmtInt(r.joinStats.matchedNoPrice)}` +
      ` ③找不到 ${fmtInt(r.joinStats.notFound)}）`,
  )

  /* ══════════════ 人工标注 ══════════════ */
  console.log('\n[2/4] 人工标注')
  console.log(
    `      出产地    ${fmtInt(r.provenanceStats.overrideCount)} 条标注` +
      ` · 命中 ${fmtInt(r.provenanceStats.applied)}` +
      ` · 新增补齐 ${fmtInt(r.provenanceStats.newlyFilled)}` +
      ` · 显式删除 ${fmtInt(r.provenanceStats.explicitlyCleared)}`,
  )
  console.log(
    `      物品属性  ${fmtInt(r.attributesStats.overrideCount)} 条标注` +
      ` · 命中 ${fmtInt(r.attributesStats.applied)}` +
      ` · 不可摸 ${fmtInt(r.attributesStats.unobtainable)}` +
      ` · 已失效 ${fmtInt(r.attributesStats.expired)}` +
      ` · 不可上架 ${fmtInt(r.attributesStats.notListable)}` +
      ` · 每格单位数未知 ${fmtInt(r.attributesStats.unitsUnknown)}`,
  )
  console.log(`      已知地图  ${r.mapNames.join('、') || '（无）'}`)

  if (r.warnings.length > 0) {
    console.log(`\n      ⚠️  ${fmtInt(r.warnings.length)} 条警告：`)
    for (const w of r.warnings.slice(0, 12)) console.log(`          · ${w}`)
    if (r.warnings.length > 12) console.log(`          …… 另有 ${r.warnings.length - 12} 条`)
  }

  /* ══════════════ 按大类统计 ══════════════ */
  console.log(`\n[3/4] 按大类统计`)
  console.log('  大类      物品数   有价格   价格覆盖   可算单格   有出产地   单格价值中位数')
  const byCat = new Map<string, Item[]>()
  for (const it of r.items) {
    const arr = byCat.get(it.categoryCode)
    if (arr) arr.push(it)
    else byCat.set(it.categoryCode, [it])
  }
  for (const [code, list] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const priced = list.filter((i) => i.price !== null).length
    const computable = list.filter((i) => i.pricePerSlot !== null).length
    const withProv = list.filter((i) => i.provenanceMaps !== null).length
    const values = list
      .map((i) => i.pricePerSlot)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b)
    const median = values.length > 0 ? values[Math.floor(values.length / 2)]! : null

    console.log(
      `  ${catLabel(code).padEnd(8)} ${String(list.length).padStart(6)} ` +
        `${String(priced).padStart(8)} ${fmtPct(priced / list.length).padStart(10)} ` +
        `${String(computable).padStart(10)} ${String(withProv).padStart(10)} ` +
        `${(median === null ? '—' : fmtInt(Math.round(median))).padStart(16)}`,
    )
  }

  /* ══════════════ 单格价值榜 ══════════════ */
  console.log(`\n[4/4] 单格价值 Top 25（只用价格源的现价；不可上架的不参与排序）`)

  const ranked = r.items
    .filter((i) => i.pricePerSlot !== null && i.listable && i.availability === 'lootable')
    .sort((a, b) => b.pricePerSlot! - a.pricePerSlot!)

  console.log(`      可参与排序 ${fmtInt(ranked.length)} 条`)
  console.log('      排名      单格价值  名称                        大类   子类      占格  每组   出产地')
  ranked.slice(0, 25).forEach((x, i) => {
    const prov = (x.provenanceMaps ?? []).join('、') || '—'
    console.log(
      `      ${String(i + 1).padStart(3)}  ${fmtInt(Math.round(x.pricePerSlot!)).padStart(12)}  ` +
        `${x.name.padEnd(26).slice(0, 26)}  ${catLabel(x.categoryCode).padEnd(5)} ` +
        `${x.subcategoryCn.padEnd(8)} ${String(x.slots).padStart(3)}  ` +
        `${String(x.unitsPerSlot ?? '?').padStart(4)}   ${prov.slice(0, 24)}`,
    )
  })

  /* 那些被排除在排序之外的 */
  const notListable = r.items.filter((i) => !i.listable)
  const unitsUnknown = r.items.filter((i) => i.unitsPerSlot === null)
  const notLootable = r.items.filter((i) => i.availability !== 'lootable')

  if (notListable.length > 0) {
    console.log(`\n      🔒 不可上架交易行的有 ${fmtInt(notListable.length)} 条，已排除在排序外：`)
    console.log(
      `         例：${notListable
        .slice(0, 5)
        .map((i) => i.name)
        .join(' / ')}`,
    )
  }
  if (unitsUnknown.length > 0) {
    console.log(`\n      ⚠️  每格单位数未知的 ${fmtInt(unitsUnknown.length)} 条（单格价值算不出来）：`)
    console.log(
      `         例：${unitsUnknown
        .slice(0, 5)
        .map((i) => i.name)
        .join(' / ')}`,
    )
    console.log('         填法：npm run provenance:todo --emit csv，填「每组发数」列后 import')
  }
  if (notLootable.length > 0) {
    console.log(`\n      ⚠️  不可摸/已失效的 ${fmtInt(notLootable.length)} 条，已排除在排序外：`)
    console.log(
      `         例：${notLootable
        .slice(0, 5)
        .map((i) => `${i.name}(${AVAILABILITY_CN[i.availability]})`)
        .join(' / ')}`,
    )
  }

  /* ══════════════ 汇总 ══════════════ */
  const s = r.normalizeStats
  console.log(`\n${THIN}`)
  console.log('汇总')
  console.log(`  物品总数              ${fmtInt(s.total)}`)
  console.log(`  有价格                ${fmtInt(s.withPrice)}  (${fmtPct(s.withPrice / Math.max(1, s.total))})`)
  console.log(`  可算单格价值          ${fmtInt(s.withPricePerSlot)}`)
  console.log(`  有出产地              ${fmtInt(s.withProvenance)}  (${fmtPct(s.withProvenance / Math.max(1, s.total))})`)
  console.log(`  ├ 其中人工补充/合并   ${fmtInt(s.manualProvenance)}`)
  console.log(`  可摸 / 不可摸 / 已失效  ${fmtInt(s.byAvailability.lootable)} / ${fmtInt(s.byAvailability.unobtainable)} / ${fmtInt(s.byAvailability.expired)}`)
  console.log(`  不可上架交易行        ${fmtInt(s.notListable)}`)
  console.log(`  每格单位数未知        ${fmtInt(s.unitsUnknown)}`)
  console.log(`  可携带（占格>0）      ${fmtInt(s.carryable)}`)
  console.log(`  数据陈旧（>24h）      ${fmtInt(s.stale)}`)
  console.log(`  共发出 HTTP 请求      ${fmtInt(r.requestCount)} 次`)
  console.log(`  原始响应留存          ${fmtInt(r.savedRaw.length)} 个文件 → ${cfg.dataDir}/raw`)

  const ok = r.joinStats.nameMatchRate >= 0.9 && s.withPrice > 0
  console.log(
    ok
      ? `\n✅ 管道跑通：${fmtInt(s.total)} 条主数据 · ${fmtInt(s.withPrice)} 条带价格` +
          ` · 名称匹配率 ${fmtPct(r.joinStats.nameMatchRate)}`
      : '\n⚠️  未达标，请检查上面的警告',
  )
  if (!ok) process.exitCode = 1
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error('\n❌ 抓取失败：')
  console.error(err instanceof Error ? `   ${err.name}: ${err.message}` : `   ${String(err)}`)
  if (err instanceof Error && err.stack && process.env['LOG_LEVEL'] === 'debug') {
    console.error(err.stack)
  }
  process.exitCode = 1
})
