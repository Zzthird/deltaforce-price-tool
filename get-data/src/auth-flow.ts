/**
 * 「用一份已登录的 cookie 换 access_token」—— 抽成模块，两个脚本共用 + 可单测。
 *
 * 这段流程（第 ⑤⑥ 步）来自参考实现 `QQ.php::getAccessToken()`，它本身
 * **不负责登录** —— 第一行就是 `Request::param('cookie')`，要求调用方
 * 提供一份已经登录的 cookie。我们之前硬把扫码流程接在它前面，结果卡住：
 * 扫码流程给不出 `graph.qq.com` 认的 `p_skey`。
 *
 * 所以现在明确分成两件事：
 *   · 拿 cookie —— 从浏览器复制（scripts/login-import.ts）
 *   · 用 cookie 换 token —— 本文件
 *
 * 涉及的三个请求：
 *   ① POST graph.qq.com/oauth2.0/authorize   用 g_tk 换 code
 *   ② GET  ① 返回的 Location                 （参考实现也走这一步）
 *   ③ GET  ams.game.qq.com/ams/userLoginSvr  用 code 换 access_token + openid
 */

import { DF_APPID, getGtk } from './auth'

export const AUTHORIZE_URL = 'https://graph.qq.com/oauth2.0/authorize'
export const TOKEN_URL = 'https://ams.game.qq.com/ams/userLoginSvr'
export const REDIRECT_URI =
  'https://milo.qq.com/comm-htdocs/login/qc_redirect.html?parent_domain=https://df.qq.com&isMiloSDK=1&isPc=1'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

export type CookieMap = Record<string, string>

/* ═══════════════════════ 解析用户粘贴的内容 ═══════════════════════ */

/**
 * 把用户粘贴的东西变成 cookie 表。支持三种常见形态：
 *
 *   1. **浏览器「Copy as cURL」** —— 里面含 `-H 'cookie: xxx'` ✓（最省事 ✓）
 *   2. 请求头原文 —— `Cookie: a=1; b=2` ✓
 *   3. 纯 cookie 串 —— `a=1; b=2` ✓
 *
 * ⚠️ 不猜、不编：解析不出就报错，并说明**支持的三种形态** ✓。
 *    （前几轮的教训：报错必须说清"我实际看到了什么" ✗）
 */
export function parseCookiePaste(input: string): CookieMap {
  const text = input.trim()
  if (text === '') throw new Error('没收到任何内容')

  let cookiePart = text

  // 形态 1：cURL 里的 cookie 头（-H 'cookie: …' / --header "cookie: …"）
  const headerMatch = /(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/i.exec(text)
  if (headerMatch?.[2]) {
    cookiePart = headerMatch[2]
  } else {
    // 形态 2：`Cookie: a=1; b=2` 原文
    const plain = /^cookie\s*:\s*([\s\S]*)$/i.exec(text)
    if (plain?.[1]) cookiePart = plain[1]
  }

  const map: CookieMap = {}
  for (const piece of cookiePart.split(';')) {
    const eq = piece.indexOf('=')
    if (eq <= 0) continue
    const name = piece.slice(0, eq).trim()
    const value = piece.slice(eq + 1).trim()
    if (name === '') continue
    map[name] = value
  }

  const count = Object.keys(map).length
  if (count === 0) {
    throw new Error(
      `没能从你粘贴的内容里解析出 cookie（长度 ${text.length}，前 60 字：${text.slice(0, 60)}）。` +
        '支持三种形态：① 浏览器「Copy as cURL」 ② 「Cookie: a=1; b=2」 ③ 纯 cookie 串「a=1; b=2」',
    )
  }
  return map
}

/* ═══════════════════════ 三个请求 ═══════════════════════ */

export interface ExchangeResult {
  openid: string
  access_token: string
  expires_in: number
  code: string
}

/** 把 cookie 表拼成请求头（全部当 `.qq.com` 域，和参考实现一致） */
export function cookieHeaderOf(cookies: CookieMap): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
}

/** 构造 authorize 的表单参数（纯函数 → 可单测） */
export function buildAuthorizeForm(
  cookies: CookieMap,
  nowMs: number = Date.now(),
): Record<string, string> {
  const pSkey = cookies['p_skey'] ?? ''
  return {
    response_type: 'code',
    client_id: DF_APPID,
    redirect_uri: REDIRECT_URI,
    state: 'STATE',
    form_plogin: '1',
    src: '1',
    update_auth: '1',
    openapi: '1010',
    g_tk: String(getGtk(pSkey)),
    auth_time: String(Math.floor(nowMs / 1000)),
    ui: '979D48F3-6CE2-4E95-A789-3BD3187648B6',
  }
}

/** 从 JSONP `callback({...})` 里取出对象（纯函数 → 可单测） */
export function parseTokenJsonp(body: string, callback: string): Record<string, unknown> | null {
  const m = new RegExp(`${callback}\\((.*?)\\)`, 's').exec(body)
  if (!m?.[1]) return null
  try {
    return JSON.parse(m[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface ExchangeOptions {
  /** 注入 fetch 便于测试（测试一律不发网络请求） */
  fetchImpl?: typeof fetch
  now?: () => number
  callback?: string
  /** 每步的回调，用来打印进度 */
  onStep?: (step: string) => void
}

/**
 * 用已登录的 cookie 换 `access_token` + `openid`。
 *
 * ⭐ 失败时的报错只陈述**看到的事实**（Location 里有没有 code、cookie 名单），
 *    不写"可能是什么原因"这种像结论的猜测 —— 这是前几轮反复踩到的教训。
 */
export async function exchangeCodeForToken(
  cookies: CookieMap,
  options: ExchangeOptions = {},
): Promise<ExchangeResult> {
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const callback = options.callback ?? 'deltaforce_priceboard'
  const step = options.onStep ?? ((): void => {})
  const cookieHeader = cookieHeaderOf(cookies)

  if (cookies['p_skey'] === undefined || cookies['p_skey'] === '') {
    throw new Error(
      '你粘贴的 cookie 里没有 p_skey —— 这一步要用它算 g_tk，没它必然失败。' +
        `当前有这些：${Object.keys(cookies).join(', ') || '（空）'}`,
    )
  }

  /* ── ① 换 code ── */
  const form = buildAuthorizeForm(cookies, now())
  const r1 = await doFetch(AUTHORIZE_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: cookieHeader,
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  })
  const location = r1.headers.get('location') ?? ''
  const codeMatch = /[?&]code=([^&]+)/.exec(location)
  step(`① 换 code        HTTP ${r1.status} · ${codeMatch?.[1] ? '拿到 code ✓' : '没拿到 code ✗'}`)

  if (!codeMatch?.[1]) {
    if (location.includes('which=Login')) {
      throw new Error(
        '腾讯返回「请先登录」（Location 里有 which=Login）—— 这份 cookie 不具备 ' +
          `graph.qq.com 的登录态。p_skey 长度 ${String(cookies['p_skey']).length}，` +
          `cookie 名单：${Object.keys(cookies).join(', ')}`,
      )
    }
    throw new Error(
      `没拿到 code。Location（前 200 字）：${location.slice(0, 200) || '（空）'}；` +
        `cookie 名单：${Object.keys(cookies).join(', ')}`,
    )
  }
  const code = decodeURIComponent(codeMatch[1])

  /* ── ② 走一遍跳转（参考实现也做这一步） ── */
  const jumpUrl = new URL(location, AUTHORIZE_URL).toString()
  const r2 = await doFetch(jumpUrl, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader },
    redirect: 'manual',
  })
  step(`② 走跳转        HTTP ${r2.status}`)

  /* ── ③ 换 access_token + openid ── */
  const tokenUrl =
    `${TOKEN_URL}?` +
    new URLSearchParams({
      a: 'qcCodeToOpenId',
      qc_code: code,
      appid: DF_APPID,
      redirect_uri: 'https://milo.qq.com/comm-htdocs/login/qc_redirect.html',
      callback,
      _: String(now()),
    }).toString()

  const r3 = await doFetch(tokenUrl, {
    headers: { 'User-Agent': UA, Cookie: cookieHeader, Referer: 'https://df.qq.com/' },
  })
  const body = await r3.text()
  const data = parseTokenJsonp(body, callback)
  if (data === null) {
    throw new Error(
      `userLoginSvr 没返回 JSONP。HTTP ${r3.status}，前 160 字：${body.slice(0, 160)}`,
    )
  }
  const iRet = typeof data['iRet'] === 'number' ? data['iRet'] : -1
  const accessToken = typeof data['access_token'] === 'string' ? data['access_token'] : ''
  const openid = typeof data['openid'] === 'string' ? data['openid'] : ''
  if (iRet !== 0 || accessToken === '' || openid === '') {
    throw new Error(`换 token 失败：${JSON.stringify(data).slice(0, 200)}`)
  }
  step(`③ 换 token       iRet=0 · openid = ${openid.slice(0, 12)}…`)

  return {
    openid,
    access_token: accessToken,
    expires_in: typeof data['expires_in'] === 'number' ? data['expires_in'] : 0,
    code,
  }
}
