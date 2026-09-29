/**
 * 一次性 QQ 扫码登录 —— **给运营者用的命令行工具，不是网站功能**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 它和网站的关系（用户明确要求）
 * ═══════════════════════════════════════════════════════════════════════
 *   「网站是给所有人看的，但登录是我私人的，和网站独立开，
 *     仅在获取数据时向我请求。假设我是网站用户，是不知道背后
 *     使用者用过 QQ 登录的。」
 *
 * 所以：
 *   · **没有 /api/login 路由** —— 网页端完全不知道有这回事
 *   · 凭据落在 `get-data/data/auth.json` —— 那个目录被 .gitignore 整个覆盖 ✓
 *   · 之后取数时自动带上它 ✓；没登录就自动退回公开源 ✓
 *
 * 用法：
 *   npm run login          ← 跑这个，扫一下二维码就行
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 七步流程（每一步的参数都是从第三方项目代码里读出来后实测校准的）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① GET  xui.ptlogin2.qq.com/cgi-bin/xlogin        建立登录会话
 *   ② GET  xui.ptlogin2.qq.com/ssl/ptqrshow          拿二维码 PNG + qrsig
 *   ③ 轮询 ssl.ptlogin2.qq.com/ptqrlogin             等扫码（ptuiCB 状态）
 *   ④ GET  ③ 返回的跳转 URL                           登录态 cookie 落到 jar 里
 *   ⑤ POST graph.qq.com/oauth2.0/authorize           用 g_tk 换 code
 *   ⑥ GET  ams.game.qq.com/ams/userLoginSvr          用 code 换 access_token + openid
 *   ⑦ 存 data/auth.json
 *
 * ⭐ 两个最容易出错的地方（都不是"语法错误"，而是**静默失败**）：
 *   · `g_tk` 用的是 `getGtk`（初始值 5381），**不是** `hash33`（初始值 0）✗
 *     —— 用错会拿不到 code，而官方只会含糊地说"cookie 过期或触发风控" ✗
 *   · `redirect_uri` 必须与申请时一致（这里照抄参考实现的）✗
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { loadConfig } from '../src/config'
import {
  DF_APPID,
  QQ_CONNECT_APPID,
  authFilePath,
  describeQrCode,
  getGtk,
  hash33,
  parsePtuiCb,
  parseQqFromRedirect,
  saveAuth,
  type AuthCredential,
} from '../src/auth'
import { pngToTerminalQr } from '../src/qr-ascii'
import { createLogger } from '../src/logger'

const RULE = '─'.repeat(78)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** 登录页要跳回的地方（照抄参考实现 —— 换错了会拿不到 code ✗）*/
const S_URL = 'https://graph.qq.com/oauth2.0/login_jump'
const REDIRECT_URI =
  'https://milo.qq.com/comm-htdocs/login/qc_redirect.html?parent_domain=https://df.qq.com&isMiloSDK=1&isPc=1'

/* ══════════════════════════ Cookie 罐 ══════════════════════════ */

/**
 * 极简 cookie 罐 —— 够这个流程用。
 *
 * ⚠️ **不做域名作用域判断**（把所有 cookie 都发给所有 qq.com 的请求）。
 *    严格来说不对 ✗，但参考实现事实上也是这样用的，
 *    而这个流程里所有请求都在 `*.qq.com` / `*.ptlogin2.qq.com` 上
 *    —— 为它写一套完整的 RFC 6265 实现不值得 ✓
 */
class CookieJar {
  private readonly map = new Map<string, string>()

  absorb(res: Response): void {
    const raw = res.headers.getSetCookie?.() ?? []
    for (const line of raw) {
      const pair = line.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  get(name: string): string | null {
    return this.map.get(name) ?? null
  }

  header(): string {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  names(): string[] {
    return [...this.map.keys()]
  }
}

/* ══════════════════════════ 小工具 ══════════════════════════ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function get(url: string, jar: CookieJar, extra: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: jar.header(), ...extra },
    redirect: 'manual',
  })
  jar.absorb(res)
  return res
}

async function waitEnter(text: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await new Promise<void>((resolvePromise) => {
    rl.question(text, () => {
      rl.close()
      resolvePromise()
    })
  })
}

/* ══════════════════════════ 主流程 ══════════════════════════ */

async function main(): Promise<void> {
  const cfg = loadConfig()
  const logger = createLogger('warn') // 这里自己打印，不让日志刷屏
  const jar = new CookieJar()

  console.log(RULE)
  console.log('  三角洲行动 · 一次性 QQ 扫码登录')
  console.log('  ⚠️ 这是给运营者用的；网站本身不需要登录，也不会显示任何登录入口')
  console.log(RULE)

  /* ── ① 建立登录会话 ── */
  const xloginUrl =
    'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?' +
    new URLSearchParams({
      appid: QQ_CONNECT_APPID,
      daid: '383',
      style: '33',
      login_text: '登录',
      hide_title_bar: '1',
      hide_border: '1',
      target: 'self',
      s_url: S_URL,
      pt_3rd_aid: DF_APPID,
      theme: '2',
    }).toString()

  const r1 = await get(xloginUrl, jar)
  const loginSig = jar.get('pt_login_sig')
  console.log(`\n① 建立登录会话  HTTP ${r1.status} · cookie: ${jar.names().join(', ')}`)
  if (loginSig === null) {
    console.log('   ⚠️ 没拿到 pt_login_sig —— 扫码那一步可能过不去（继续试试）')
  }

  /* ── ② 取二维码 ── */
  const qrUrl =
    'https://xui.ptlogin2.qq.com/ssl/ptqrshow?' +
    new URLSearchParams({
      appid: QQ_CONNECT_APPID,
      e: '2',
      l: 'M',
      s: '3',
      d: '72',
      v: '4',
      t: String(Math.random()),
      daid: '383',
      pt_3rd_aid: DF_APPID,
      u1: S_URL,
    }).toString()

  const r2 = await get(qrUrl, jar)
  const png = new Uint8Array(await r2.arrayBuffer())
  const qrsig = jar.get('qrsig')
  if (qrSigMissing(qrsig)) {
    throw new Error(`没拿到 qrsig（HTTP ${r2.status}，${png.length} 字节）—— 登录服务可能变了`)
  }

  const ptqrtoken = hash33(qrsig)
  console.log(`② 取二维码      HTTP ${r2.status} · ${png.length} 字节 · ptqrtoken = ${ptqrtoken}`)

  /* ── ③ 把二维码画在终端里 ── */
  const art = pngToTerminalQr(png)
  console.log()
  if (art !== null) {
    console.log(art)
    const lines = art.split('\n')
    console.log(`\n   ↑ 用手机 QQ 扫这个码（${lines[0]?.length ?? 0} 列 × ${lines.length} 行）`)
  } else {
    // 渲染不出来就降级成写文件 —— 不该因为"画不出来"而让登录失败 ✗
    const pngPath = resolve(cfg.dataDir, 'login-qr.png')
    await mkdir(dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)
    console.log(`   二维码存到了：${pngPath}\n   请打开它，用手机 QQ 扫（这个 PNG 不支持在终端里画）`)
  }
  console.log()

  /* ── ③b 轮询扫码状态 ── */
  const deadline = Date.now() + 3 * 60_000
  let redirectUrl: string | null = null
  let lastText = ''

  while (Date.now() < deadline) {
    const pollUrl =
      'https://ssl.ptlogin2.qq.com/ptqrlogin?' +
      new URLSearchParams({
        u1: S_URL,
        ptqrtoken: String(ptqrtoken),
        ptredirect: '0',
        h: '1',
        t: '1',
        g: '1',
        from_ui: '1',
        ptlang: '2052',
        action: `0-0-${Date.now()}`,
        js_ver: '25040111',
        js_type: '1',
        login_sig: loginSig ?? '',
        pt_uistyle: '40',
        aid: QQ_CONNECT_APPID,
        daid: '383',
        pt_3rd_aid: DF_APPID,
        o1vId: '378b06c889d9113b39e814ca627809e3',
        pt_js_version: '530c3f68',
      }).toString()

    const r3 = await get(pollUrl, jar)
    const text = await r3.text()
    const parsed = parsePtuiCb(text)

    if (parsed === null) {
      throw new Error(
        `扫码状态响应不是 ptuiCB 格式 —— cookie 可能不对。原文前 120 字：${text.slice(0, 120)}`,
      )
    }

    const state = describeQrCode(parsed.code)
    // 只在状态变化时打印，避免刷屏（66/67 会重复出现）
    if (state.text !== lastText) {
      console.log(`   ${state.text}`)
      lastText = state.text
    }

    if (state.done) {
      redirectUrl = parsed.redirectUrl
      break
    }
    if (state.failed) throw new Error(state.text)

    await sleep(2000)
  }

  if (redirectUrl === null) {
    throw new Error('等待扫码超时（3 分钟）—— 重新跑一次 npm run login 即可')
  }

  /* ── ④ 走一遍跳转，把登录态 cookie 收下来 ── */
  const r4 = await get(redirectUrl, jar)
  const qq = parseQqFromRedirect(redirectUrl)
  console.log(`④ 登录跳转      HTTP ${r4.status} · QQ = ${qq ?? '（没解析出来）'}`)

  const pSkey = jar.get('p_skey')
  if (pSkey === null) {
    console.log('   ⚠️ cookie 里没有 p_skey —— 下面换 code 那一步很可能失败')
  }

  /* ── ⑤ 换 code ── */
  const authorizeUrl = 'https://graph.qq.com/oauth2.0/authorize'
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: DF_APPID,
    redirect_uri: REDIRECT_URI,
    state: 'STATE',
    form_plogin: '1',
    src: '1',
    update_auth: '1',
    openapi: '1010',
    g_tk: String(getGtk(pSkey ?? '')),
    auth_time: String(Math.floor(Date.now() / 1000)),
    ui: '979D48F3-6CE2-4E95-A789-3BD3187648B6',
  })

  const r5 = await fetch(authorizeUrl, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: jar.header(),
    },
    body: form.toString(),
    redirect: 'manual',
  })
  jar.absorb(r5)

  const location = r5.headers.get('location') ?? ''
  const codeMatch = /[?&]code=([^&]+)/.exec(location)
  console.log(`⑤ 换 code        HTTP ${r5.status} · ${codeMatch ? '拿到 code ✓' : '没拿到 code ✗'}`)

  if (!codeMatch?.[1]) {
    console.log(`   Location: ${location.slice(0, 200) || '（空）'}`)
    throw new Error(
      '没拿到 code。最常见的原因是 g_tk 算错（必须用 getGtk，初始值 5381）' +
        '，其次是 cookie 过期或触发了风控。',
    )
  }
  const qcCode = decodeURIComponent(codeMatch[1])

  /* ── ⑥ 换 access_token + openid ── */
  const loginSvrUrl =
    'https://ams.game.qq.com/ams/userLoginSvr?' +
    new URLSearchParams({
      a: 'qcCodeToOpenId',
      qc_code: qcCode,
      appid: DF_APPID,
      redirect_uri: 'https://milo.qq.com/comm-htdocs/login/qc_redirect.html',
      callback: 'deltaforce_priceboard',
      _: String(Date.now()),
    }).toString()

  const r6 = await fetch(loginSvrUrl, {
    headers: { 'User-Agent': UA, Cookie: jar.header(), Referer: 'https://df.qq.com/' },
  })
  const body6 = await r6.text()
  const jsonp = /deltaforce_priceboard\((.*?)\)/s.exec(body6)
  if (!jsonp?.[1]) {
    throw new Error(`userLoginSvr 没返回 JSONP。HTTP ${r6.status}，前 160 字：${body6.slice(0, 160)}`)
  }

  const data = JSON.parse(jsonp[1]) as {
    iRet?: number
    access_token?: string
    openid?: string
    expires_in?: number
  }
  if (data.iRet !== 0 || !data.access_token || !data.openid) {
    throw new Error(`换 token 失败：${JSON.stringify(data).slice(0, 200)}`)
  }
  console.log(`⑥ 换 token       iRet=0 · openid = ${data.openid.slice(0, 12)}…`)

  /* ── ⑦ 落盘 ── */
  const cred: AuthCredential = {
    openid: data.openid,
    access_token: data.access_token,
    acctype: 'qc',
    appid: DF_APPID,
    ...(qq !== null ? { qq } : {}),
    savedAt: new Date().toISOString(),
  }
  await saveAuth(cfg, cred)

  console.log()
  console.log(RULE)
  console.log('  ✅ 登录成功，凭据已保存')
  console.log(`     ${authFilePath(cfg)}`)
  console.log(`     有效期约 ${Math.round((data.expires_in ?? 0) / 86400)} 天 · 到期后重新跑一次 npm run login`)
  console.log()
  console.log('  ⚠️ 这个文件已被 .gitignore 覆盖，不会被提交 ✓')
  console.log('  ⚠️ 网站不需要它就能跑（会退回公开源）；它只是让取数多几个官方字段')
  console.log(RULE)
  console.log()
  console.log('  下一步：npm run fetch —— 看看登录后能多拿到什么（尤其是「参考价」）')

  await waitEnter('  按回车退出…')
  void logger
}

function qrSigMissing(v: string | null): v is null {
  return v === null || v === ''
}

main().catch((err: unknown) => {
  console.error()
  console.error('❌ ' + (err instanceof Error ? err.message : String(err)))
  console.error()
  process.exitCode = 1
})
