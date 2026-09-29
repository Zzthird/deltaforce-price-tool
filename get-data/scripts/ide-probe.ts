/**
 * 官方接口探测器 —— **给你自己用的**。
 *
 *   日常最重要的一条命令：
 *     npm run ide -- --list                       看看已知的频道（chartId）
 *     npm run ide -- 530479:SwgEeH action=3       打一个请求，把响应打出来
 *     npm run ide -- 352143:YWRywA method=dfm/place.list source=2
 *     npm run ide -- --no-auth 352143:YWRywA method=dfm/place.list source=2
 *     npm run ide -- --get 530479:SwgEeH action=3  用 GET 试试（对比 POST）
 *     npm run ide -- --out=x.json 530479:SwgEeH    把原始响应存到文件
 *     npm run ide -- --full 530479:SwgEeH action=3 打印完整响应（不截断）
 *
 * 为什么要这么设计（而不是写死几个命令）：
 *   官方这个接口**用一个地址 + 一堆参数**区分所有功能，
 *   所以真正需要的不是"多写几个脚本"，而是"能随手改参数试"。
 *   有了这个命令，你发现新东西时不用等我 —— 直接试。
 */

import { writeFileSync } from 'node:fs'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/logger'
import { loadAuth, authCookieHeader } from '../src/auth'
import { KNOWN_CHARTS, callIde } from '../src/ide'

const RULE = '─'.repeat(78)

/** `530479:SwgEeH` → {chartId, token}；只给 chartId 时从已知表里查 token */
export function parseChartArg(
  arg: string,
): { chartId: string; token: string } | { error: string } {
  if (arg.includes(':')) {
    const [chartId, token] = arg.split(':')
    if (!chartId || !token) return { error: `看不懂「${arg}」，应该是 频道号:口令，如 530479:SwgEeH` }
    return { chartId, token }
  }
  const hit = KNOWN_CHARTS.find((c) => c.chartId === arg)
  if (!hit) return { error: `频道号 ${arg} 不在已知表里 —— 请写成 频道号:口令 的形式` }
  return { chartId: hit.chartId, token: hit.token }
}

/** `action=3` → ['action','3']；不成对就报错（不静默忽略） */
export function parseParamArg(arg: string): [string, string] | null {
  const eq = arg.indexOf('=')
  if (eq <= 0) return null
  return [arg.slice(0, eq), arg.slice(eq + 1)]
}

function printList(): void {
  console.log(RULE)
  console.log('  已知的官方频道（chartId:口令 = sIdeToken）')
  console.log(RULE)
  for (const c of KNOWN_CHARTS) {
    const mark = c.status === 'ok' ? '✅' : c.status === 'need-param' ? '⚠️ 缺参数' : '❓ 未知'
    console.log(`  ${c.chartId}:${c.token}  ${mark}`)
    console.log(`      ${c.hint}`)
    if (c.defaults) {
      console.log(
        `      默认参数：${Object.entries(c.defaults)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
      )
    }
  }
  console.log(RULE)
  console.log('  用法：npm run ide -- <频道号[:口令]> [参数=值 …]')
  console.log('  例：  npm run ide -- 530479:SwgEeH action=3')
  console.log()
  console.log('  ⚠️ 这些报错文案会骗人，别信：')
  console.log('     ret=-4000「访问人数太多」 → 其实是参数不对')
  console.log('     ret=101                   → 可能只是把 POST 写成了 GET')
  console.log('     ret=0 但 data 是空数组    → 参数组合不对，不是"没数据"')
  console.log()
  console.log('  怎么找新的频道号/口令：官方网站或活动页 F12 → Network，')
  console.log('  看请求体里的 iChartId / sIdeToken（它们写死在前端 JS 里）。')
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--')

  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printList()
    return
  }
  if (argv.includes('--list')) {
    printList()
    return
  }

  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const positional = argv.filter((a) => !a.startsWith('--'))
  const chartArg = positional[0]
  if (chartArg === undefined) {
    console.error('缺少频道号。看用法：npm run ide -- --list')
    process.exitCode = 1
    return
  }

  const chart = parseChartArg(chartArg)
  if ('error' in chart) {
    console.error('✗ ' + chart.error)
    process.exitCode = 1
    return
  }

  const params: Record<string, string> = {}
  for (const a of positional.slice(1)) {
    const kv = parseParamArg(a)
    if (kv === null) {
      console.error(`✗ 看不懂参数「${a}」—— 应该是 名字=值 的形式（例 action=3）`)
      process.exitCode = 1
      return
    }
    params[kv[0]] = kv[1]
  }
  // 没给参数时用已知默认值（只补缺失的，不覆盖你写的）
  const known = KNOWN_CHARTS.find(
    (c) => c.chartId === chart.chartId && c.token === chart.token,
  )
  if (known?.defaults) {
    for (const [k, v] of Object.entries(known.defaults)) {
      if (params[k] === undefined) params[k] = v
    }
  }

  const cfg = loadConfig()
  const logger = createLogger('error')

  let cookie: string | undefined
  if (!flags.has('--no-auth')) {
    const cred = await loadAuth(cfg)
    if (cred !== null) {
      cookie = authCookieHeader(cred)
      console.log('（带了登录 cookie）')
    } else {
      console.log('（没找到 data/auth.json —— 这次请求不带登录 cookie）')
    }
  } else {
    console.log('（--no-auth：故意不带登录 cookie）')
  }

  const useGet = flags.has('--get')
  console.log(RULE)
  console.log(`  ${useGet ? 'GET ' : 'POST'} ${chart.chartId}:${chart.token}`)
  console.log(`  参数：${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('  ') || '（无）'}`)
  console.log(RULE)

  const result = await callIde(cfg, logger, {
    chartId: chart.chartId,
    token: chart.token,
    params,
    ...(cookie === undefined ? {} : { cookie }),
    ...(useGet ? { useGet } : {}),
  })
  const s = result.summary

  console.log(`HTTP ${s.status}`)
  console.log(`ret=${String(s.ret)}  iRet=${String(s.iRet)}  sMsg=${s.sMsg ?? '(空)'}`)
  if (s.innerCode !== null || s.innerMsg !== null) {
    console.log(`第二层：code=${String(s.innerCode)}  msg=${s.innerMsg ?? '(空)'}`)
  }
  console.log(`jData 键：${s.jDataKeys.join(', ') || '（无）'}`)
  console.log(`数据形状：${s.dataShape}`)
  console.log()

  const out = flags.has('--out')
    ? argv.find((a) => a.startsWith('--out='))?.slice('--out='.length)
    : undefined
  if (out !== undefined) {
    writeFileSync(out, result.text)
    console.log(`原始响应已存到 ${out}（${result.text.length} 字节）`)
  } else if (flags.has('--full')) {
    console.log(result.text)
  } else {
    console.log(result.text.slice(0, 1500))
    if (result.text.length > 1500) {
      console.log(`\n…（共 ${result.text.length} 字节，加 --full 看全部，或 --out=x.json 存文件）`)
    }
  }

  // 复现提示 —— 方便你去浏览器里重现同一个请求
  console.log()
  console.log('想在浏览器里复现这个请求？F12 → Console 里粘：')
  console.log(
    `  fetch('${result.requestUrl}', { method: '${useGet ? 'GET' : 'POST'}', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '${result.requestBody.replace(/'/g, "\'")}' }).then(r => r.json()).then(console.log)`,
  )
}

main().catch((err: unknown) => {
  console.error('❌ ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
})
