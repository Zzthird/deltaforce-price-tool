/**
 * 一次性 QQ 扫码登录 —— **给运营者用的命令行工具，不是网站功能**。
 *
 * 网站是公开的；登录是你私人的凭据，只在取数时用 ✓
 *   · 没有 /api/login 路由，网页端完全不知道有这回事
 *   · 凭据落在 `get-data/data/auth.json`（被 .gitignore 覆盖）
 *   · 没登录就自动退回公开源
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 五步流程 —— 照 https://blog.sakurasen.cn/post/1769803187575/ 的实现
 * ═══════════════════════════════════════════════════════════════════════
 *   ① GET  xui.ptlogin2.qq.com/ssl/ptqrshow        二维码 PNG + qrsig
 *   ② 轮询 xui.ptlogin2.qq.com/ssl/ptqrlogin       等扫码（ptuiCB 状态）
 *   ③ GET  ② 返回的跳转 URL（★ 不跟随重定向）      **从它的 Set-Cookie 里取 p_skey**
 *   ④ POST graph.qq.com/oauth2.0/authorize         用 g_tk 换 code
 *   ⑤ GET  ams.game.qq.com/ams/userLoginSvr        用 code 换 access_token + openid
 *   ⑥ 存 data/auth.json
 *
 * ⚠️ 和网上另一份 PHP 实现的差异（本文件按上面那份写 ✓）：
 *
 *   | | blog（Go，本文件） | PHP 实现 |
 *   |---|---|---|
 *   | 先请求 xlogin | **不请求** ✓ | 请求，拿 pt_login_sig |
 *   | 轮询 login_sig | **qrsig** ✓ | pt_login_sig |
 *   | 授权表单 | **form_ptlogin**、auth_time **毫秒** ✓ | form_plogin、秒 |
 *
 *   我最初照 PHP 那份写，扫码能成功但拿到的 `p_skey` 是**受限的**
 *   （jar 里出现 `p_skey_forbid`、始终没有 `skey`），
 *   于是请求授权时腾讯返回 `oauth2.0/show?which=Login`。
 *   差别主要在**轮询的参数**：多带了 pt_login_sig / action / o1vId，
 *   少带了 has_onekey / js_ver 的新值 / Referer 头。
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
import { parseTokenJsonp, type CookieMap } from '../src/auth-flow'
import { pngToTerminalQr } from '../src/qr-ascii'
import { createLogger } from '../src/logger'

const RULE = '─'.repeat(78)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

/** 登录页要跳回的地方（换错了会拿不到 code ✗） */
const S_URL = 'https://graph.qq.com/oauth2.0/login_jump'
const REDIRECT_URI =
  'https://milo.qq.com/comm-htdocs/login/qc_redirect.html?parent_domain=https://df.qq.com&isMiloSDK=1&isPc=1'
/** 轮询时带的 Referer（blog 里是手写的一个 xlogin 地址，并不真的先访问它） */
const XLOGIN_REFERER =
  'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=716027609&daid=383&style=33' +
  '&login_text=%E7%99%BB%E5%BD%95&hide_title_bar=1&hide_border=1&target=self' +
  `&s_url=${encodeURIComponent(S_URL)}&pt_3rd_aid=${DF_APPID}` +
  '&pt_feedback_link=https%3A%2F%2Fsupport.qq.com%2Fproducts%2F77942' +
  `%3FcustomInfo%3Dmilo.qq.com.appid${DF_APPID}&theme=2&verify_theme=`
const CALLBACK = 'miloJsonpCb_80466'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ══════════════════════════ cookie 表 ══════════════════════════ */

/**
 * 这里用**扁平表**（不按域名隔离）—— 因为 blog 的实现就是这么做的：
 * Go 里 `req.AddCookie(c)` 不分域名地把 cookie 全带上 ✓
 * （后面那步官方接口认的就是这种"全带上" ✓）
 */
async function fetchNoRedirect(
  url: string,
  cookies: CookieMap,
  headers: Record<string, string> = {},
  /** 有 body 就发 POST（第 ④ 步换 code 必须带表单体 ✗ 漏了就拿不到 code）*/
  body?: string,
): Promise<Response> {
  const header = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  const res = await fetch(url, {
    ...(body !== undefined ? { method: 'POST', body } : {}),
    headers: {
      'User-Agent': UA,
      ...(header !== '' ? { Cookie: header } : {}),
      ...headers,
    },
    redirect: 'manual', // ★ 不跟随重定向（第 ③ 步必须如此）
  })
  return res
}

/** 读响应的 Set-Cookie 到表里；返回**新下的**名字（诊断用） */
async function absorb(res: Response, into: CookieMap): Promise<string[]> {
  const added: string[] = []
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? ''
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (value === '') continue
    if (into[name] === undefined) added.push(name)
    into[name] = value
  }
  return added
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
  const logger = createLogger('warn')
  const jar: CookieMap = {}

  console.log(RULE)
  console.log('  三角洲行动 · 一次性 QQ 扫码登录')
  console.log('  ⚠️ 这是给运营者用的；网站本身不需要登录，也不会显示任何登录入口')
  console.log(RULE)

  /* ── ① 取二维码 ── */
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

  const r1 = await fetchNoRedirect(qrUrl, jar)
  const png = new Uint8Array(await r1.arrayBuffer())
  await absorb(r1, jar)
  const qrsig = jar['qrsig']
  if (qrsig === undefined || qrsig === '') {
    throw new Error(`没拿到 qrsig（HTTP ${r1.status}，${png.length} 字节）—— 登录服务可能变了`)
  }
  const ptqrtoken = hash33(qrsig)
  console.log(`① 取二维码      HTTP ${r1.status} · ${png.length} 字节 · ptqrtoken = ${ptqrtoken}`)

  /* ── ①b 画在终端里 ── */
  const art = pngToTerminalQr(png)
  console.log()
  if (art !== null) {
    console.log(art)
    const lines = art.split('\n')
    console.log(`\n   ↑ 用手机 QQ 扫这个码（${lines[0]?.length ?? 0} 列 × ${lines.length} 行）`)
  } else {
    // 渲染不出来就降级写文件 —— 不该因为"画不出来"而让登录失败 ✗
    const pngPath = resolve(cfg.dataDir, 'login-qr.png')
    await mkdir(dirname(pngPath), { recursive: true })
    await writeFile(pngPath, png)
    console.log(`   二维码存到了：${pngPath}\n   请打开它，用手机 QQ 扫`)
  }
  console.log()

  /* ── ② 轮询扫码状态 ── */
  const deadline = Date.now() + 3 * 60_000
  let redirectUrl: string | null = null
  let lastText = ''

  while (Date.now() < deadline) {
    const pollUrl =
      'https://xui.ptlogin2.qq.com/ssl/ptqrlogin?' +
      new URLSearchParams({
        ptqrtoken: String(ptqrtoken),
        login_sig: qrsig, // ★ blog 里就是把 qrsig 当 login_sig 用
        aid: QQ_CONNECT_APPID,
        daid: '383',
        pt_3rd_aid: DF_APPID,
        has_onekey: '1',
        js_ver: '25112611',
        ptredirect: '0',
        pt_js_version: '42f2bcc1',
        ptlang: '2052',
        h: '0',
        t: '1',
        g: '1',
        from_ui: '1',
        u1: S_URL,
      }).toString()

    // ★ 只带 qrsig 一个 cookie（blog 如此）—— 之前多带 pt_login_sig 是可疑点
    const r2 = await fetchNoRedirect(pollUrl, { qrsig }, { Referer: XLOGIN_REFERER })
    const text = await r2.text()
    const parsed = parsePtuiCb(text)
    if (parsed === null) {
      throw new Error(`扫码状态响应不是 ptuiCB 格式。原文前 120 字：${text.slice(0, 120)}`)
    }
    const state = describeQrCode(parsed.code)
    if (state.text !== lastText) {
      console.log(`   ${state.text}`)
      lastText = state.text
    }
    if (state.done) {
      redirectUrl = parsed.redirectUrl
      break
    }
    if (state.failed) throw new Error(state.text)
    await sleep(1500)
  }
  if (redirectUrl === null) {
    throw new Error('等待扫码超时（3 分钟）—— 重新跑一次 npm run login 即可')
  }
  const qq = parseQqFromRedirect(redirectUrl)

  /* ── ③ 换 p_skey：走跳转 URL 但**不跟随重定向** ── */
  const r3 = await fetchNoRedirect(redirectUrl, jar)
  const added = await absorb(r3, jar)
  console.log(`③ 取 p_skey      HTTP ${r3.status} · QQ = ${qq ?? '（没解析出来）'}`)
  console.log(
    `   这一跳新下的 cookie：${added.join(', ') || '（无）'}` +
      `\n   p_skey：${jar['p_skey'] !== undefined ? `有（长度 ${jar['p_skey'].length}）✓` : '没有 ✗'}` +
      `\n   skey：${jar['skey'] !== undefined ? '有 ✓' : '没有 ✗'}`,
  )
  const pSkey = jar['p_skey']
  if (pSkey === undefined || pSkey === '') {
    throw new Error(
      '第 ③ 步的响应里没有 p_skey —— 而下一步要用它算 g_tk。' +
        `当前 cookie：${Object.keys(jar).join(', ') || '（空）'}`,
    )
  }

  /* ── ④ 换 code ── */
  const authorizeUrl = 'https://graph.qq.com/oauth2.0/authorize'
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: DF_APPID,
    redirect_uri: REDIRECT_URI,
    scope: '',
    state: 'STATE',
    switch: '',
    form_ptlogin: '1', // ★ blog 用的是 form_ptlogin（PHP 那份是 form_plogin）
    src: '1',
    update_auth: '1',
    openapi: '1010',
    auth_time: String(Date.now()), // ★ blog 用**毫秒**
    ui: '2C0B3209-A5BA-46E3-88EC-3C7D0FA2C6AE',
    g_tk: String(getGtk(pSkey)), // ★ g_tk 用 getGtk（初始值 5381），不是 hash33（初始值 0）
  })

  const r4 = await fetchNoRedirect(
    authorizeUrl,
    jar,
    {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://xui.ptlogin2.qq.com/',
    },
    form.toString(),
  )
  const location = r4.headers.get('location') ?? ''
  const codeMatch = /[?&]code=([^&]+)/.exec(location)
  console.log(`④ 换 code        HTTP ${r4.status} · ${codeMatch?.[1] ? '拿到 code ✓' : '没拿到 code ✗'}`)

  if (!codeMatch?.[1]) {
    console.log(`   Location: ${location.slice(0, 300) || '（空）'}`)
    /**
     * ⚠️ 只陈述**看到的事实** + 给证据，不写"可能是什么原因"这种像结论的猜测
     *    —— 前几轮我两次这么写，两次都把排查方向带偏了 ✗
     */
    if (location.includes('which=Login')) {
      throw new Error(
        '腾讯返回「请先登录」（Location 里有 which=Login）—— 这份 cookie 不具备 ' +
          `graph.qq.com 的登录态。cookie 名单：${Object.keys(jar).join(', ')}`,
      )
    }
    throw new Error(`没拿到 code。Location（前 300 字）：${location.slice(0, 300) || '（空）'}`)
  }
  const qcCode = decodeURIComponent(codeMatch[1])

  /* ── ⑤ 换 access_token + openid ── */
  const tokenUrl =
    'https://ams.game.qq.com/ams/userLoginSvr?' +
    new URLSearchParams({
      a: 'qcCodeToOpenId',
      appid: DF_APPID,
      redirect_uri: 'https://milo.qq.com/comm-htdocs/login/qc_redirect.html',
      callback: CALLBACK,
      qc_code: qcCode,
      _: String(Date.now()),
    }).toString()

  // blog 这步不带 cookie，只带 referer
  const r5 = await fetch(tokenUrl, { headers: { 'User-Agent': UA, Referer: 'https://df.qq.com/' } })
  const body5 = await r5.text()
  const data = parseTokenJsonp(body5, CALLBACK)
  const openid = typeof data?.['openid'] === 'string' ? data['openid'] : ''
  const accessToken = typeof data?.['access_token'] === 'string' ? data['access_token'] : ''
  if (openid === '' || accessToken === '') {
    throw new Error(
      `换 token 失败。HTTP ${r5.status}，响应前 200 字：${body5.slice(0, 200)}`,
    )
  }
  console.log(`⑤ 换 token       openid = ${openid.slice(0, 12)}…`)

  /* ── ⑥ 落盘 ── */
  const cred: AuthCredential = {
    openid,
    access_token: accessToken,
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
  console.log('     到期后重新跑一次 npm run login 即可')
  console.log()
  console.log('  ⚠️ 这个文件已被 .gitignore 覆盖，不会被提交 ✓')
  console.log('  ⚠️ 网站不需要它就能跑（会退回公开源）；它只是让取数多几个官方字段 ✓')
  console.log(RULE)
  console.log()
  console.log('  下一步：npm run fetch —— 看看登录后能多拿到什么')

  await waitEnter('  按回车退出…')
  void logger
}

main().catch((err: unknown) => {
  console.error()
  console.error('❌ ' + (err instanceof Error ? err.message : String(err)))
  console.error()
  process.exitCode = 1
})
