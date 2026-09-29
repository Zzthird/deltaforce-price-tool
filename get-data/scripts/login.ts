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
import { CookieJar } from '../src/cookie-jar'
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
 * CookieJar 已抽到 `../src/cookie-jar.ts`（带 9 个单测 ✓）—— 因为它的
 * 「按域名隔离」是这条流程里最关键、也最容易错的一点。
 *
 * 一句话概括为什么：第 ④ 步的 `check_sig` 在 `ssl.ptlogin2.graph.qq.com` 上，
 * 而扫码阶段的 cookie（`qrsig`、`pt_login_sig` …）属于 `.ptlogin2.qq.com`
 * —— **一个都不该发过去**。不分域名的话就会把二维码会话 cookie 发给
 * 登录端点，服务器可能当作「还在扫码流程里」，发个受限的 p_skey
 * （实测表现为 `p_skey_forbid` 存在而 `skey` 始终不来），
 * 接下来请求授权时腾讯就说「请先登录」（`which=Login`）。
 */
/* ══════════════════════════ 小工具 ══════════════════════════ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function get(url: string, jar: CookieJar, extra: Record<string, string> = {}): Promise<Response> {
  const cookie = jar.header(url)
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      ...(cookie !== '' ? { Cookie: cookie } : {}),
      ...extra,
    },
    redirect: 'manual',
  })
  jar.absorb(res, url)
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

/**
 * 跟着跳转走，**每一跳都把 cookie 收下来**。
 *
 * ⚠️ 这一步本来我以为不用做 ✗（参考实现里写的是 `allow_redirects = false`）——
 *    但浏览器在 QQ 登录这条链上会接连跳好几跳，
 *    **登录态 cookie（skey / p_skey 之类）就是在某一跳里下的** ✗。
 *    不跟的话就拿着半套 cookie 去请求授权 → 腾讯说「你还没登录」✗
 *    （表现为 Location 里出现 `oauth2.0/show?which=Login`）。
 */
async function follow(
  startUrl: string,
  jar: CookieJar,
  maxHops = 6,
): Promise<{ finalUrl: string; hops: number; statuses: number[]; trail: string[] }> {
  let url = startUrl
  const statuses: number[] = []
  const trail: string[] = []
  for (let i = 0; i <= maxHops; i += 1) {
    const before = new Set(jar.names())
    const res = await get(url, jar)
    statuses.push(res.status)
    /**
     * ★ 每一跳之后：**这个主机发出了哪些 cookie、响应新下了哪些 cookie**。
     *
     * 这就是定位「腾讯说我没登录」的关键证据：
     *   · 发出了什么 → 有没有把 `qrsig` 之类的扫码 cookie 送错地方 ✗
     *   · 新下了什么 → 登录态（`skey` / `p_skey`）到底是哪一跳给的 ✓
     */
    const sent = jar.namesFor(url)
    const added = jar.names().filter((n) => !before.has(n))
    trail.push(
      `   ${new URL(url).host} → ${res.status} · 发出 ${sent.length} 个` +
        (added.length > 0 ? ` · 新下 [${added.join(', ')}]` : ''),
    )
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location')
      if (!next) break
      url = new URL(next, url).toString()
      continue
    }
    break
  }
  return { finalUrl: url, hops: statuses.length - 1, statuses, trail }
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
  const hop = await follow(redirectUrl, jar)
  const qq = parseQqFromRedirect(redirectUrl)
  console.log(
    `④ 登录跳转      ${hop.statuses.join('→')} · 跳了 ${hop.hops} 跳 · QQ = ${qq ?? '（没解析出来）'}`,
  )
  for (const line of hop.trail) console.log(line)
  /**
   * ★ **把 cookie 名字打出来** —— 这是排查“腾讯说我没登录”的唯一线索。
   *
   * 第一次失败时我把原因猜成“g_tk 算错”✗，完全猜错 ✗ ——
   * 真相是登录态 cookie 没带对（Location 里出现了 `which=Login`）✗。
   * 所以现在**直接把证据打印出来**，不靠猜 ✓
   */
  console.log(`   cookie 共 ${jar.names().length} 个：${jar.names().join(', ')}`)
  console.log(
    `   发给 graph.qq.com 的：${jar.namesFor('https://graph.qq.com/').join(', ') || '（无）'}`,
  )

  const pSkey = jar.get('p_skey')
  const skey = jar.get('skey')
  if (pSkey === null || skey === null) {
    console.log(
      `   ⚠️ 关键 cookie 缺失：${pSkey === null ? 'p_skey ' : ''}${skey === null ? 'skey' : ''}` +
        ` —— 下面换 code 那步大概会失败`,
    )
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
      Cookie: jar.header(authorizeUrl),
    },
    body: form.toString(),
    redirect: 'manual',
  })
  jar.absorb(r5, authorizeUrl)

  const location = r5.headers.get('location') ?? ''
  const codeMatch = /[?&]code=([^&]+)/.exec(location)
  console.log(`⑤ 换 code        HTTP ${r5.status} · ${codeMatch ? '拿到 code ✓' : '没拿到 code ✗'}`)

  if (!codeMatch?.[1]) {
    console.log(`   Location: ${location.slice(0, 300) || '（空）'}`)
    /**
     * ⚠️ **不要把可能的原因写成结论** —— 第一次我把这里写成
     *    “最常见的原因是 g_tk 算错”，结果真实原因是登录态 cookie 没带对 ✗。
     *    报错把人引到错误方向，比不报错还糟 ✗。
     *    现在只陈述**看到的事实**，并把 cookie 名单一并给出 ✓
     */
    if (location.includes('which=Login')) {
      throw new Error(
        '腾讯返回“请先登录”（Location 里有 which=Login）—— 说明发授权请求时' +
          `登录态 cookie 没带对。当前 cookie（${jar.names().length} 个）：${jar.names().join(', ')}`,
      )
    }
    throw new Error(
      '没拿到 code（Location 里也不含 code）。可能是：' +
        '① g_tk 算错（必须用 getGtk，初始值 5381）；' +
        '② cookie 过期或触发风控。' +
        `当前 cookie（${jar.names().length} 个）：${jar.names().join(', ')}`,
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
    headers: { 'User-Agent': UA, Cookie: jar.header(loginSvrUrl), Referer: 'https://df.qq.com/' },
  })
  jar.absorb(r6, loginSvrUrl)
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
