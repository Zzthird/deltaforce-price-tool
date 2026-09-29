/**
 * 私人登录凭据 —— **网站功能之外的东西**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⭐ 为什么它和"网站"是分开的（用户明确要求）
 * ═══════════════════════════════════════════════════════════════════════
 * 用户的原话：
 *   「网站是给所有人看的，但是这个登录是我私人的登录，和网站独立开，
 *     仅在获取数据时向我请求。假设现在我是一个网站用户，
 *     我是不知道背后的使用者使用过 QQ 登录的。」
 *
 * 也就是说，这份凭据的**性质**和 `.env` 里的 UA/邮箱一样 ——
 * 它是**运营者取数时的配置** ✓，不是网站功能 ✗：
 *
 *   · **没有 `/api/login` 路由** —— 网页端完全不知道有这回事
 *   · **网页上没有二维码、没有"登录"按钮** —— 访客看不到任何痕迹
 *   · API 响应形状**一行都不变** —— 访客拿到的数据和以前一模一样
 *   · 没登录时**自动退回公开源** —— 网站照常能用
 *
 * 登录只在**命令行**做一次（`npm run login`），凭据落在本地文件里。
 *
 * ⚠️ 文件放在 `get-data/data/` 下 —— 那个目录**整个被 .gitignore 覆盖** ✓，
 *    所以凭据永远不会被提交 ✓。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要登录（代价换到了什么）
 * ═══════════════════════════════════════════════════════════════════════
 * 官方接口分两类（实测）：
 *   · **公开**：物品列表 `dfm/object.list`（我们一直在用）✓
 *   · **需登录**：制造 365589 / 军需处 530479 / 官方现价 `object.price.latest`
 *     （实测 `ret=101` 未授权）✗
 *
 * 还有一个更关键的未知：**「参考价格」到底能不能从登录后的接口拿到** ——
 * 手续费公式的自变量就是它（见 `fee.ts` 的比值模型），
 * 而它不在我们的公开数据里（moligod 基准价 2528 差 13%、官方 avgPrice 差 8 倍）。
 * 登录之后第一件事就是试这个 ✓
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { AppConfig } from './config'

/**
 * 登录换来的凭据。
 *
 * 字段名**原样照抄官方 cookie** —— 不要改名，也不要做成嵌套结构：
 * 它最终就是要拼进 Cookie 请求头里的 ✓
 */
export interface AuthCredential {
  /** 官方接口认的账号标识 */
  openid: string
  /** 官方接口认的令牌（会过期）*/
  access_token: string
  /**
   * 登录方式：QQ 是 `qc`，微信是 `wx`。
   * ⚠️ 这个值官方接口会检查 —— 填错会得到 `ret=101`（看起来像"没登录"）✗
   */
  acctype: 'qc' | 'wx'
  /** 三角洲行动小程序的 appid */
  appid: string
  /** QQ 号（只用于显示与排查，接口不需要）*/
  qq?: string
  /** 这份凭据是什么时候拿到的（ISO 8601）*/
  savedAt: string
}

/** 三角洲行动小程序的 appid（实测：登录与接口都用它）*/
export const DF_APPID = '101491592'

/** QQ 互联的 appid（登录二维码那一步用它，与 DF_APPID 不是一回事）*/
export const QQ_CONNECT_APPID = '716027609'

export function authFilePath(cfg: AppConfig): string {
  return resolve(cfg.dataDir, 'auth.json')
}

/**
 * 读凭据。没有、或格式不对 → 返回 null。
 *
 * ⚠️ **文件内容不可信**（可能被手改、可能是旧版本写的），
 *    所以逐字段校验，任何一项不对就当"没登录"处理 ✓
 *    —— 宁可退回公开源，也不要拿一份半残的凭据去打官方接口 ✗
 */
export async function loadAuth(cfg: AppConfig): Promise<AuthCredential | null> {
  try {
    const raw = await readFile(authFilePath(cfg), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const o = parsed as Partial<AuthCredential>

    if (
      typeof o.openid !== 'string' ||
      o.openid === '' ||
      typeof o.access_token !== 'string' ||
      o.access_token === ''
    ) {
      return null
    }

    return {
      openid: o.openid,
      access_token: o.access_token,
      acctype: o.acctype === 'wx' ? 'wx' : 'qc',
      appid: typeof o.appid === 'string' && o.appid !== '' ? o.appid : DF_APPID,
      ...(typeof o.qq === 'string' ? { qq: o.qq } : {}),
      savedAt: typeof o.savedAt === 'string' ? o.savedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

/** 存凭据 */
export async function saveAuth(cfg: AppConfig, cred: AuthCredential): Promise<void> {
  const path = authFilePath(cfg)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(cred, null, 2), 'utf8')
}

/**
 * 凭据 → Cookie 请求头。
 *
 * ⚠️ 域名必须是 `.qq.com`（官方接口在 `comm.ams.game.qq.com` 上，
 *    它是 qq.com 的子域）✓ —— 这也是为什么四个字段要一起带 ✓
 */
export function authCookieHeader(cred: AuthCredential): string {
  return [
    `openid=${cred.openid}`,
    `access_token=${cred.access_token}`,
    `acctype=${cred.acctype}`,
    `appid=${cred.appid}`,
  ].join('; ')
}

/* ══════════════════════════════════════════════════════════════════════
 * QQ 登录用到的两个纯算法（抽出来是为了能单测）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * QQ 的 `ptqrtoken` 算法（社区称 hash33）。
 *
 * 它是把 `qrsig` 揉成一个整数，作为轮询扫码状态时的凭据。
 * 网上有多个版本的实现，这里是**与第三方项目一致**的那版：
 * 每轮 `e = (e << 5) + e + charCode`，最后取 31 位。
 *
 * ⚠️ 必须用 `>>> 0` 语义之外的方式保证不溢出成负数：
 *    JS 的位运算是 32 位有符号的，而这里官方要的是**正整数**
 *    （实测第三方实现返回 `& 0x7fffffff` 的结果，我们照做）。
 */
export function hash33(qrsig: string): number {
  let e = 0
  for (let i = 0; i < qrsig.length; i += 1) {
    e += (e << 5) + qrsig.charCodeAt(i)
  }
  return e & 0x7fffffff
}

/**
 * 腾讯的 `g_tk` 算法 —— ⚠️ **和 `hash33` 不是同一个函数**！
 *
 * | | 初始值 | 用途 |
 * |---|---|---|
 * | `hash33` | **0** | `ptqrtoken`（轮询扫码状态）|
 * | `getGtk` | **5381** | `g_tk`（换 code 那一步）|
 *
 * 两者其余部分一样（都是 `e += (e<<5) + 字符` 再取 31 位）。
 *
 * ⚠️ **这是个很阴的坑**：用 `hash33` 算 `g_tk` 代码照样能跑，
 *    但官方会拒绝 → 拿不到 `code` ✗ → 表现为"cookie 过期或触发风控" ✗ ——
 *    **报错信息和真正的原因完全无关** ✗（官方只会在 Location 里不给 code）。
 *
 * 每轮都 `& 0x7fffffff` 是照抄参考实现的（PHP 整数溢出行为）——
 * 保持一致比"看起来更简洁"重要 ✓
 */
export function getGtk(skey: string): number {
  let e = 5381
  for (let i = 0; i < skey.length; i += 1) {
    e += (e << 5) + skey.charCodeAt(i)
    e &= 0x7fffffff
  }
  return e & 0x7fffffff
}

/** 轮询扫码状态时官方返回的结构 */
export interface QrPollResult {
  /** 官方状态码：0=成功，65=已过期，66=未扫码，67=已扫码待确认，其他=失败 */
  code: string
  message: string
  /** 成功时的跳转 URL（里面带 uin=QQ号）*/
  redirectUrl: string | null
  /** 昵称（成功时官方会给）*/
  nickname: string | null
}

/**
 * 解析官方返回的 `ptuiCB('0','0','https://...','0','登录成功','昵称')`。
 *
 * 返回 null 表示**这行根本不是 ptuiCB** —— 那通常意味着 cookie 不对
 * 或者流程走错了，此时不该继续往下猜 ✗
 */
export function parsePtuiCb(text: string): QrPollResult | null {
  /**
   * ⚠️ **不能写死"恰好 6 个字段"** —— 这里踩过一次真坑：
   *
   * 用户实际扫成功时官方返回的是（真实样本）：
   *   ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?…&uin=…','0','…')
   * ——字段更少 ✗。而我第一版的正则写了 6 段 `'…'` ✗，
   * 于是**登录已经成功却被判成"不是 ptuiCB 格式"** ✗，
   * 而且报错还说"cookie 可能不对" —— **报错和真实原因完全无关** ✗。
   *
   * 所以改成"把引号里的内容全抽出来"，不假设几个 ✓。
   * （又一个"拿真实样本才能测出来"的例子 ——
   *   和登录二维码那个位深 1 的坑是同一类。）
   */
  if (!text.includes('ptuiCB')) return null

  const args = [...text.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '')
  if (args.length < 3) return null

  const code = args[0] ?? ''
  const url = args[2] ?? ''
  const message = args[4] ?? ''
  const nickname = args[5] ?? ''

  return {
    code,
    message,
    redirectUrl: url !== '' ? url : null,
    nickname: nickname !== '' ? nickname : null,
  }
}

/** 把 ptuiCB 的状态码翻译成给人看的话 */
export function describeQrCode(code: string): { done: boolean; failed: boolean; text: string } {
  switch (code) {
    case '0':
      return { done: true, failed: false, text: '登录成功' }
    case '65':
      return { done: false, failed: true, text: '二维码已过期，请重新运行' }
    case '66':
      return { done: false, failed: false, text: '等待扫码…（用手机 QQ 扫一下）' }
    case '67':
      return { done: false, failed: false, text: '已扫码，等待你在手机上点确认…' }
    case '86':
      return { done: false, failed: true, text: '被拒绝登录' }
    default:
      return { done: false, failed: true, text: `登录失败（官方状态码 ${code}）` }
  }
}

/** 从跳转 URL 里抠出 QQ 号（`...?uin=123456&...`）*/
export function parseQqFromRedirect(url: string): string | null {
  const m = /[?&]uin=([^&]+)/.exec(url)
  return m && m[1] ? decodeURIComponent(m[1]) : null
}
