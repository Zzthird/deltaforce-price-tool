/**
 * 更新「集市当期物品」清单 —— 人工维护，因为集市没有可用的官方接口。
 *
 *   npm run market:set 腕带 锈迹斑斑的海盗铜币
 *   npm run market:set -- --list          # 只看当前存的
 *
 * 写完立刻打印「你填的键 → 实际命中的物品名」，让人一眼核对 ✓
 * （名字打错时不猜，直接报错并给出相近候选）
 */

import { loadConfig } from '../src/config'
import { loadMarket, resolveMarketKeys, saveMarket } from '../src/market'
import { loadSnapshot } from '../src/store'

const RULE = '─'.repeat(78)

async function main(): Promise<void> {
  const cfg = loadConfig()
  const path = `${cfg.overridesDir}/market.json`
  const args = process.argv.slice(2).filter((a) => a !== '--')

  if (args.length === 0 || args[0] === '--list') {
    const cur = await loadMarket(path)
    console.log(RULE)
    if (cur.keys.length === 0) console.log('  集市清单是空的' + (cur.missing ? '（还没有 market.json）' : ''))
    else {
      console.log(`  集市当期物品（更新于 ${cur.updatedAt ?? '未知'}）：`)
      for (const k of cur.keys) console.log(`    · ${k}`)
    }
    for (const p of cur.problems) console.log(`  ⚠️ ${p}`)
    console.log(RULE)
    console.log('  更新：npm run market:set 物品名1 物品名2 …')
    return
  }

  const loaded = await loadMarket(path)
  for (const p of loaded.problems) console.log(`  ⚠️ 原文件有问题：${p}`)

  const snapshot = await loadSnapshot(`${cfg.dataDir}/snapshot.json`)
  if (!snapshot) {
    console.error('没有快照数据 —— 先跑 npm run refresh')
    process.exitCode = 1
    return
  }
  const items = Object.values(snapshot.partitions)
    .flat()
    .map((p) => ({ sourceItemId: p.sourceItemId, name: p.name }))

  const r = resolveMarketKeys(args, items)

  console.log(RULE)
  console.log('  你填的键  →  实际命中的物品')
  for (const x of r.resolved) console.log(`    ${x.key}  →  ${x.name}`)
  for (const p of r.problems) console.log(`  ✗ ${p}`)
  console.log(RULE)

  if (r.problems.length > 0) {
    console.error('有键没能解析 —— **没有写入**。改对再来一次（同名物品请用官方 ID）')
    process.exitCode = 1
    return
  }

  await saveMarket(path, args, new Date())
  console.log(`  ✅ 已写入 ${path}`)
  console.log('  网页首页的「集市物品」卡片会在下次刷新接口时读到它')
}

main().catch((err: unknown) => {
  console.error('❌ ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
})
