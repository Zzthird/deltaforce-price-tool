/**
 * 一次性导入浏览器 cookie —— **方案 A**（比扫码可靠 ✓）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么走这条路
 * ═══════════════════════════════════════════════════════════════════════
 * 扫码流程（scripts/login.ts）能登进 QQ，但**给不出 graph.qq.com 认的登录态**
 * —— 实测拿到 18~25 个 cookie，里面始终没有可用的 `p_skey`/`skey`，
 * 于是请求授权时腾讯返回 `oauth2.0/show?which=Login`。
 *
 * 参考实现其实也没解决这个问题：它的 `getAccessToken()` 第一行就是
 * `Request::param('cookie')` —— **要求调用方提供一份已登录的 cookie**。
 * 它自己的扫码部分（`pt_3rd_aid=101944512`）是给「游戏安全中心」用的，不是 DF。
 *
 * 所以这条路才是正路：**从浏览器里复制一份真正的登录态** ✓。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 用法
 * ═══════════════════════════════════════════════════════════════════════
 *   npm run login:import
 *
 * 然后粘贴（支持三种形态，最省事的是第一种）：
 *   ① 浏览器 F12 → Network → 对 graph.qq.com 的请求右键
 *      → Copy → Copy as cURL ← 整段粘进来 ✓（里面自带 cookie 头）
 *   ② `Cookie: p_skey=…; uin=…`
 *   ③ 纯 cookie 串 `p_skey=…; uin=…`
 *
 * 粘贴完**单独打一行 END**（或按 Ctrl+Z 回车）表示结束。
 *
 * ⚠️ 凭据落在 `get-data/data/auth.json` —— 那个目录被 .gitignore 整个覆盖 ✓
 * ⚠️ 网站不需要它；没有它时取数自动退回公开源 ✓
 */

import { createInterface } from 'node:readline'
import { loadConfig } from '../src/config'
import { DF_APPID, authFilePath, saveAuth, type AuthCredential } from '../src/auth'
import { exchangeCodeForToken, parseCookiePaste, type CookieMap } from '../src/auth-flow'

const RULE = '─'.repeat(78)

/**
 * 从 cookie 里推 QQ 号（纯展示用 ✓ —— 失败不影响流程）。
 *
 * QQ 的 `uin` 是 `o03605329035` 这种形式：`o` + 补零的 QQ 号 ✓
 */
export function qqFromCookies(cookies: CookieMap): string | null {
  for (const key of ['uin', 'pt2gguin', 'p_uin', 'luin']) {
    const raw = cookies[key]
    if (raw === undefined) continue
    const stripped = raw.replace(/^o/i, '').replace(/^0+/, '')
    if (/^\d{5,12}$/.test(stripped)) return stripped
  }
  return null
}

/** 读用户粘贴的内容：管道读全部；交互式则读到单独一行 END 为止 */
export async function readPaste(stdin: NodeJS.ReadStream): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer))
    return Buffer.concat(chunks).toString('utf8')
  }
  const rl = createInterface({ input: stdin, output: process.stdout })
  const lines: string[] = []
  for await (const line of rl) {
    if (line.trim().toUpperCase() === 'END') break
    lines.push(line)
  }
  rl.close()
  return lines.join('\n')
}

async function main(): Promise<void> {
  const cfg = loadConfig()

  console.log(RULE)
  console.log('  三角洲行动 · 导入浏览器 cookie（运营者用，与网站无关）')
  console.log(RULE)
  console.log('  请先在浏览器里登录 QQ，然后：')
  console.log('    F12 → Network → 找一条对 graph.qq.com 的请求')
  console.log('        → 右键 → Copy → Copy as cURL')
  console.log('  把整段粘到下面（粘完单独打一行 END）：')
  console.log()

  const raw = await readPaste(process.stdin)
  console.log()

  const cookies = parseCookiePaste(raw)
  const qq = qqFromCookies(cookies)
  console.log(`解析出 ${Object.keys(cookies).length} 个 cookie：${Object.keys(cookies).join(', ')}`)
  console.log(`p_skey：${cookies['p_skey'] ? `有（长度 ${cookies['p_skey'].length}）✓` : '没有 ✗'}`)
  if (qq !== null) console.log(`QQ 号：${qq}`)
  console.log()

  const result = await exchangeCodeForToken(cookies, {
    onStep: (s) => console.log(s),
  })

  const cred: AuthCredential = {
    openid: result.openid,
    access_token: result.access_token,
    acctype: 'qc',
    appid: DF_APPID,
    ...(qq !== null ? { qq } : {}),
    savedAt: new Date().toISOString(),
  }
  await saveAuth(cfg, cred)

  console.log()
  console.log(RULE)
  console.log('  ✅ 成功，凭据已保存')
  console.log(`     ${authFilePath(cfg)}`)
  console.log(
    `     有效期约 ${Math.round(result.expires_in / 86400)} 天 · 到期后重新导入一次即可`,
  )
  console.log()
  console.log('  ⚠️ 该文件已被 .gitignore 覆盖，不会被提交 ✓')
  console.log('  ⚠️ 网站不需要它；它只是让取数多几个官方字段 ✓')
  console.log(RULE)
}

main().catch((err: unknown) => {
  console.error()
  console.error('❌ ' + (err instanceof Error ? err.message : String(err)))
  console.error()
  process.exitCode = 1
})
