/**
 * 取数服务入口。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个进程做的事（就四件）
 * ═══════════════════════════════════════════════════════════════════════
 *   1. 加载配置（config.ts）—— 校验失败会一次性列出所有问题
 *   2. 初始化刷新器（refresher.ts）—— 把磁盘上的快照与刷新状态读进内存
 *   3. 起 Fastify HTTP 服务（server.ts）—— 五个路由
 *   4. 后台预热一次数据（**不阻塞监听**）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 刻意没有的东西：定时器
 * ═══════════════════════════════════════════════════════════════════════
 * 没有 `setInterval`、没有 cron、没有"每 N 分钟抓一次"。
 * 刷新**只由请求触发**（见 PLAN.md §6.7）。
 *
 * 为什么：没人用网站时就不该抓。源站是个人站点（moligod）加官方接口，
 * 不该为"你睡觉时的 8 小时"付出 96 次请求。按需刷新的代价是
 * **第一个来访的人可能要等几秒** —— 这个代价我们接受。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么第 4 步要用"不阻塞监听"的写法
 * ═══════════════════════════════════════════════════════════════════════
 * 两种写法对比：
 *
 *   ❌ 先抓完再 listen     —— 冷启动时端口 13 秒不响应，
 *                          前端会显示"连不上服务器"，而其实一切正常
 *   ✅ 先 listen 再后台预热 —— 端口立刻可用；这时来的 /api/items 会
 *                          在 ensureFresh 里**等那一轮抓完**（refresher 里
 *                          专门为这种情况加了 waitForIdle），所以
 *                          用户看到的是"正在获取数据"而不是"失败"
 *
 * 第二条依赖 refresher 的 `ensureFresh` 正确处理 `in_progress` ——
 * 那是接 HTTP 时才发现的 bug，已修并加了测试。
 */

import { loadConfig } from './config'
import { createLogger } from './logger'
import { Refresher } from './refresher'
import { buildServer } from './server'

const RULE = '─'.repeat(78)

async function main(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger(cfg.logLevel)

  /* ---------- 1. 读磁盘状态 ---------- */
  const refresher = new Refresher({ cfg, logger })
  await refresher.init()

  /* ---------- 2. 起服务 ---------- */
  const app = await buildServer({ cfg, logger, refresher })

  try {
    await app.listen({ port: cfg.port, host: cfg.host })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 端口占用是最常见的启动失败，单独给一句人话
    if (/EADDRINUSE/i.test(message)) {
      logger.error(`端口 ${cfg.port} 已被占用 —— 是不是已经有一个服务在跑了？`, {
        hint: `想换端口就改 get-data/.env 里的 PORT`,
      })
    } else {
      logger.error('HTTP 服务启动失败', { error: message })
    }
    process.exitCode = 1
    return
  }

  /* ---------- 3. 启动信息 ---------- */
  const snapshot = refresher.getSnapshot()
  const ageSeconds = refresher.ageSeconds()
  const itemCount = snapshot
    ? Object.values(snapshot.partitions).reduce((n, list) => n + list.length, 0)
    : 0

  const ageText =
    ageSeconds === null
      ? '无本地数据'
      : ageSeconds < 60
        ? `${ageSeconds} 秒前`
        : ageSeconds < 3600
          ? `${Math.round(ageSeconds / 60)} 分钟前`
          : `${(ageSeconds / 3600).toFixed(1)} 小时前`

  console.log('')
  console.log(RULE)
  console.log('  三角洲行动 · 取数服务已启动')
  console.log(RULE)
  console.log(`  地址      http://${cfg.host}:${cfg.port}`)
  console.log(`  物品源    ${cfg.itemSource}`)
  console.log(`  价格源    ${cfg.priceSource}${snapshot?.meta.priceBasis ? ` —— ${snapshot.meta.priceBasis}` : ''}`)
  console.log(`  本地数据  ${itemCount} 条 · 更新于 ${ageText}`)
  console.log('')
  console.log('  路由')
  console.log('    GET  /api/items     物品列表（顺带触发按需刷新）')
  console.log('    GET  /api/meta      筛选器选项 + 标签调色板')
  console.log('    GET  /api/sources   数据源健康状态')
  console.log('    GET  /api/health    存活与新鲜度')
  console.log('    POST /api/refresh   手动刷新')
  console.log('')
  console.log('  ⚠️  本项目**没有定时器** —— 没人访问就不抓数据。')
  console.log(RULE)
  console.log('')

  /* ---------- 4. 后台预热（不 await） ---------- */
  /**
   * 为什么不 await：见文件头部的说明。端口要先能响应。
   *
   * 为什么用 `ensureFresh()` 而不是 `refreshNow()`：
   * `ensureFresh` 会**尊重三道锁**，所以反复重启服务不会把源站打爆
   * （15 分钟内什么都不做，最小间隔内也不抓）。`refreshNow` 会绕过 15 分钟判断，
   * 那是给"网页上的刷新按钮"用的，不是给启动用的。
   *
   * `.catch` 不能省：这是一条脱离 await 链的 promise，出错要自己接住，
   * 否则会变成 unhandledRejection 把进程干掉。
   */
  void refresher
    .ensureFresh()
    .then((result) => {
      logger.info('启动预热检查完成', {
        tier: result.tier,
        ageSeconds: result.ageSeconds,
        refreshing: result.refreshing,
      })
    })
    .catch((err: unknown) => {
      logger.error('启动预热失败（不影响服务，首个请求会再试一次）', {
        error: err instanceof Error ? err.message : String(err),
      })
    })

  /* ---------- 5. 优雅关闭 ---------- */
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    logger.info(`收到 ${signal}，正在关闭…`)

    void (async () => {
      try {
        // 先停止接受新连接
        await app.close()
        // 再等抓取跑完 —— 半路杀掉会让快照落盘到一半
        // （`writeFileAtomic` 其实不怕这个，但抓取本身会白做一轮请求，
        //   而请求是有礼貌配额的，能等就等）
        await refresher.waitForIdle()
        logger.info('已关闭')
      } catch (err) {
        logger.error('关闭时出错', { error: err instanceof Error ? err.message : String(err) })
        process.exitCode = 1
      }
    })()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err: unknown) => {
  // 配置校验失败会走到这里，错误信息本身就是给用户看的（一次列全部问题）
  console.error('')
  console.error(err instanceof Error ? err.message : String(err))
  console.error('')
  process.exitCode = 1
})
