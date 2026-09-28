/**
 * `npm run season:rollover` —— 换季时把「本季」批量改成「往季」
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它解决的痛点
 * ═══════════════════════════════════════════════════════════════════════
 * 赛季限定的状态会随赛季变化：
 *   本赛季   →  可摸 + 可上架交易行
 *   下赛季   →  限时下架 + 不可上架（只能卖军需处）
 *
 * 如果不做这个机制，你**每赛季都要手工把几十条改一遍**（而且很容易漏）。
 * 现在：只记「本季 / 往季」，换季时跑一条命令，状态自动跟着变。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 新赛季要做的两件事
 * ═══════════════════════════════════════════════════════════════════════
 *   1. `npm run season:rollover`        ← 把上赛季那批标成「往季」
 *      （先跑这个，再标新弹；顺序反了会把新弹也一起改成往季）
 *   2. 把本赛季的新弹标成「本季」
 *      在 CSV 的「赛季限定」列写「本季」，或者在 JSON 里写 `"seasonal": "current"`
 *
 * 用法：
 *   npm run season:rollover             # 预览（**默认不写文件**）
 *   npm run season:rollover -- --apply  # 真的改
 *
 * ⚠️ 默认是预览 —— 批量修改这种事，先看一眼"要改哪些"再动手。
 */

import { writeFile } from 'node:fs/promises'
import { loadConfig } from '../src/config'
import {
  checkAttributeConflicts,
  loadItemAttributesOverrides,
  serializeItemAttributesOverrides,
  type ItemAttributeEntry,
  type ItemAttributesOverrides,
} from '../src/overrides/item-attributes'

const RULE = '═'.repeat(80)
const THIN = '─'.repeat(80)

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply')
  const cfg = loadConfig()

  console.log(RULE)
  console.log('  三角洲行动 · 换季处理（把「本季」改成「往季」）')
  console.log(`  文件 ${cfg.itemAttributesOverridesPath}`)
  console.log(`  模式 ${apply ? '⚠️ 实际写入（--apply）' : '预览（不写文件）'}`)
  console.log(RULE)

  const load = await loadItemAttributesOverrides(cfg.itemAttributesOverridesPath)
  if (load.missing) {
    console.log(`\n⚠️  标注文件还不存在：${cfg.itemAttributesOverridesPath}`)
    console.log('   你还没有标过任何赛季限定物品，先跑 npm run provenance:todo --emit csv')
    return
  }
  for (const p of load.problems) {
    console.log(`  ⚠️  ${p.key ? `[${p.key}] ` : ''}${p.message}`)
  }

  /* ---------------- 找出所有「本季」 ---------------- */
  const currentKeys: string[] = []
  const pastKeys: string[] = []
  for (const [key, entry] of load.overrides.entries) {
    if (entry.seasonal === 'current') currentKeys.push(key)
    if (entry.seasonal === 'past') pastKeys.push(key)
  }

  console.log(`\n[1/3] 现状`)
  console.log(`      标注条目总数    ${load.overrides.entries.size}`)
  console.log(`      「本季」       ${currentKeys.length} 条  ← 这些会被改成「往季」`)
  console.log(`      「往季」       ${pastKeys.length} 条  ← 保持不动`)

  if (currentKeys.length === 0) {
    console.log('\n✅ 没有「本季」需要处理。')
    if (pastKeys.length > 0) {
      console.log('   如果本赛季出了新的赛季限定物品，把它们标成「本季」即可。')
    }
    console.log(RULE)
    return
  }

  console.log(`\n${THIN}`)
  console.log('[2/3] 将被改成「往季」的条目')
  console.log('  （改成往季后，它们会变成：限时下架 + 不可上架交易行）\n')
  for (const key of currentKeys) {
    const entry = load.overrides.entries.get(key)
    const extra: string[] = []
    if (entry?.unitsPerSlot !== undefined) extra.push(`每组 ${entry.unitsPerSlot} 发`)
    if (entry?.note) extra.push(`备注：${entry.note}`)
    console.log(`  · ${key}${extra.length > 0 ? `　（${extra.join('，')}）` : ''}`)
  }

  /* ---------------- 一致性检查 ---------------- */
  const conflicts = checkAttributeConflicts(load.overrides)
  if (conflicts.length > 0) {
    console.log(`\n${THIN}`)
    console.log(`⚠️  ${conflicts.length} 条标记与显式属性矛盾（不影响本次操作，但请看一下）：`)
    for (const c of conflicts) console.log(`  · [${c.key}] ${c.message}`)
  }

  if (!apply) {
    console.log(`\n${THIN}`)
    console.log('预览完毕。**没有修改任何文件。**')
    console.log(`确认无误后执行：npm run season:rollover -- --apply`)
    console.log(RULE)
    return
  }

  /* ---------------- 写入 ---------------- */
  const merged = new Map<string, ItemAttributeEntry>()
  for (const [key, entry] of load.overrides.entries) {
    if (entry.seasonal === 'current') {
      merged.set(key, { ...entry, seasonal: 'past' })
    } else {
      merged.set(key, entry)
    }
  }

  const finalOverrides: ItemAttributesOverrides = {
    entries: merged,
    rawKeyCount: merged.size,
  }
  await writeFile(cfg.itemAttributesOverridesPath, serializeItemAttributesOverrides(finalOverrides), 'utf8')

  console.log(`\n${THIN}`)
  console.log('[3/3] ✅ 已写入')
  console.log(`  ${currentKeys.length} 条已从「本季」改为「往季」`)
  console.log(`  现在共有「往季」${pastKeys.length + currentKeys.length} 条`)
  console.log('  下一步：把本赛季的新弹标成「本季」，然后跑 npm run fetch 看效果')
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error('\n❌ 失败：')
  console.error(err instanceof Error ? `   ${err.name}: ${err.message}` : `   ${String(err)}`)
  process.exitCode = 1
})
