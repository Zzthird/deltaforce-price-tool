/**
 * 强制刷新一次并**落盘**（走刷新器的完整路径）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么需要这个脚本
 * ═══════════════════════════════════════════════════════════════════════
 * `npm run fetch`（`scripts/fetch-once.ts`）是**只看不写**的诊断脚本 ——
 * 它把结果打印成一张大表给你看，但不调用 `saveSnapshot`。
 *
 * 而磁盘上的 `get-data/data/snapshot.json` **只有刷新器会写**。
 * 于是出现过一个很费时间的坑：改完代码跑 `npm run fetch`，
 * 看到数字变了就以为落盘成功，然后去查 `snapshot.json` 发现没变 ——
 * 因为一直在读一个几十分钟前的旧文件。
 *
 * 这个脚本就是补这个缺口：**真的刷新、真的落盘**。
 * 它复用刷新器的三道锁（单飞 / 最小间隔 / 失败冷却）和历史留存，
 * 所以行为和 Phase 7 的 HTTP 服务完全一致 —— 只是没有 HTTP。
 *
 * 用法：
 *   npm run refresh            # 走全部三道锁
 *   npm run refresh -- --force # 绕过**失败冷却**（仍绕不过单飞与最小间隔）
 *
 * ⚠️ 绕过最小间隔是**故意不提供**的 —— 那是对源站的礼貌约束
 *    （`MIN_REFRESH_GAP_SECONDS`，manual 也不行）。
 *    开发时真需要立即重刷，用一个更小的一次性环境变量：
 *
 *      MIN_REFRESH_GAP_SECONDS=0 npm run refresh --workspace=@deltaforce/get-data
 *
 *    注意 dotenv **不会覆盖已存在的 process.env**，所以这样临时值优先。
 */

import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { Refresher } from '../src/refresher'

const RULE = '═'.repeat(84)

async function main(): Promise<void> {
  const force = process.argv.includes('--force')
  if (force) console.log('  （--force：绕过失败冷却；最小间隔与单飞仍生效）')
  const cfg = loadConfig()
  const logger = createLogger(cfg.logLevel)

  console.log(RULE)
  console.log('  三角洲行动 · 强制刷新并落盘')
  console.log(`  数据目录 ${cfg.dataDir}`)
  console.log(RULE)

  const refresher = new Refresher({ cfg, logger })
  await refresher.init()

  const before = refresher.getSnapshot()
  console.log(
    `  刷新前：${before ? `${before.partitions ? Object.values(before.partitions).flat().length : 0} 条` : '无快照'}` +
      ` · 已过 ${refresher.ageSeconds() ?? '—'} 秒`,
  )

  const started = Date.now()

  if (force) {
    const r = await refresher.refreshNow()
    console.log(`\n  刷新动作：${r.outcome} —— ${r.message}`)
    if (!r.started) {
      console.log('  （没有发起抓取；想去掉最小间隔限制请用 --force 以外的等待，或等它到期）')
    }
  } else {
    const r = await refresher.ensureFresh()
    console.log(
      `\n  刷新动作：${r.tier}` +
        `（refreshing=${r.refreshing} · 刷新前已过 ${r.ageSeconds ?? '—'} 秒）`,
    )
    if (r.lastError) console.log(`  ⚠️  最近一次失败：${r.lastError}`)
  }

  await refresher.waitForIdle()
  const elapsed = Date.now() - started

  const after = refresher.getSnapshot()
  if (!after) {
    console.error('\n❌ 刷新后仍然没有快照 —— 抓取失败了，看上面的日志。')
    process.exitCode = 1
    return
  }

  const count = Object.values(after.partitions).flat().length

  console.log()
  console.log('  刷新后：')
  console.log(`    物品        ${count} 条`)
  for (const [code, list] of Object.entries(after.partitions)) {
    console.log(`        ${code.padEnd(10)} ${list.length}`)
  }
  console.log(`    价格表键数  ${Object.keys(after.prices).length}`)
  console.log(`    抓取时间    ${after.meta.fetchedAt}`)
  console.log(`    耗时        ${(elapsed / 1000).toFixed(1)} 秒`)
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
