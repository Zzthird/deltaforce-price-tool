/**
 * `auth.ts` 的单元测试 —— 私人凭据的读写与两个 QQ 登录算法。
 *
 * ⭐ 不发任何网络请求 ✓（登录的真实请求在 scripts/login.ts 里，只在你手动跑时发生）
 */

import { describe, expect, it } from 'vitest'
import {
  authCookieHeader,
  DF_APPID,
  describeQrCode,
  hash33,
  parsePtuiCb,
  parseQqFromRedirect,
  type AuthCredential,
} from './auth'

describe('hash33 —— QQ 的 ptqrtoken 算法', () => {
  it('返回正整数（官方要的是正整数，不能因 32 位溢出变成负数）', () => {
    const t = hash33('abcdefghijklmnop')
    expect(t).toBeGreaterThan(0)
    expect(Number.isInteger(t)).toBe(true)
  })

  it('同样的输入得到同样的值（纯函数）', () => {
    expect(hash33('qrsig-123')).toBe(hash33('qrsig-123'))
  })

  it('空串返回 0', () => {
    expect(hash33('')).toBe(0)
  })
})

describe('parsePtuiCb —— 解析官方的扫码状态', () => {
  it('成功：拿到跳转 URL 与昵称', () => {
    const r = parsePtuiCb(
      "ptuiCB('0','0','https://ptlogin2.qq.com/login?uin=123456&x=1','0','登录成功','张三')",
    )
    expect(r).toMatchObject({
      code: '0',
      redirectUrl: 'https://ptlogin2.qq.com/login?uin=123456&x=1',
      nickname: '张三',
    })
  })

  it('未扫码 / 已扫码待确认 / 过期 都能认出来', () => {
    expect(parsePtuiCb("ptuiCB('66','0','','0','二维码未失效。','')")?.code).toBe('66')
    expect(parsePtuiCb("ptuiCB('67','0','','0','二维码已扫码未确认。','')")?.code).toBe('67')
    expect(parsePtuiCb("ptuiCB('65','0','','0','二维码已失效。','')")?.code).toBe('65')
  })

  it('⭐ 不是 ptuiCB 时返回 null（不猜 —— 那通常意味着 cookie 不对）', () => {
    expect(parsePtuiCb('<html>登录</html>')).toBeNull()
    expect(parsePtuiCb('')).toBeNull()
  })
})

describe('describeQrCode —— 状态码翻译成人话', () => {
  it('66/67 是"继续等"，不是失败', () => {
    expect(describeQrCode('66').failed).toBe(false)
    expect(describeQrCode('66').done).toBe(false)
    expect(describeQrCode('67').failed).toBe(false)
    expect(describeQrCode('67').text).toContain('确认')
  })

  it('0 是成功', () => {
    expect(describeQrCode('0')).toMatchObject({ done: true, failed: false })
  })

  it('65/86 是失败', () => {
    expect(describeQrCode('65').failed).toBe(true)
    expect(describeQrCode('86').failed).toBe(true)
  })

  it('未知码也当失败（不假装成功）', () => {
    expect(describeQrCode('999').failed).toBe(true)
    expect(describeQrCode('999').text).toContain('999')
  })
})

describe('parseQqFromRedirect', () => {
  it('从跳转 URL 里抠 QQ 号', () => {
    expect(parseQqFromRedirect('https://x/?uin=123456&y=2')).toBe('123456')
    expect(parseQqFromRedirect('https://x/?a=1&uin=9')).toBe('9')
  })

  it('没有 uin 时返回 null', () => {
    expect(parseQqFromRedirect('https://x/?a=1')).toBeNull()
  })
})

describe('authCookieHeader —— 拼成官方接口认的 Cookie', () => {
  const cred: AuthCredential = {
    openid: 'OPENID',
    access_token: 'TOKEN',
    acctype: 'qc',
    appid: DF_APPID,
    savedAt: '2026-09-29T00:00:00.000Z',
  }

  it('⭐ 四个字段一个都不能少（官方会检查 acctype/appid）', () => {
    const h = authCookieHeader(cred)
    for (const k of ['openid=', 'access_token=', 'acctype=qc', `appid=${DF_APPID}`]) {
      expect(h).toContain(k)
    }
  })

  it('微信登录时 acctype=wx', () => {
    expect(authCookieHeader({ ...cred, acctype: 'wx' })).toContain('acctype=wx')
  })
})

/* ══════════ ⭐ 真实响应形状（用户实测扫成功时抓到的） ══════════ */

/**
 * ⚠️ 这一条来自**用户的真实输出**，不是我想象的形状。
 *
 * 他扫码成功、手机也点了确认，官方返回的是：
 *   ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?…&uin=…','0','…')
 *
 * ——**字段比我想的少** ✗。而我第一版正则写死了 6 段 `'…'` ✗，
 * 于是登录已经成功却被判成「不是 ptuiCB 格式」✗，
 * 而且报错还说「cookie 可能不对」——报错与真实原因完全无关 ✗。
 *
 * 教训和登录二维码那个「位深 1」的坑是同一类：
 * **合成测试数据必须来自真实样本**，否则测的是「我以为的格式」✗。
 */
describe('⭐ parsePtuiCb —— 真实响应（字段数不固定）', () => {
  it('5 个字段（用户实测的登录成功响应）', () => {
    const real =
      "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=1234567890&service=ptqrlogin&nodirect=0&ptsigx=abc','0','登录成功！', '')"
    const r = parsePtuiCb(real)
    expect(r).not.toBeNull()
    expect(r!.code).toBe('0')
    expect(r!.redirectUrl).toContain('check_sig')
    expect(parseQqFromRedirect(r!.redirectUrl!)).toBe('1234567890')
  })

  it('⭐ 字段更少（昵称都没有）也能解析', () => {
    const r = parsePtuiCb("ptuiCB('0','0','https://x/y','0','登录成功！')")
    expect(r?.code).toBe('0')
    expect(r?.redirectUrl).toBe('https://x/y')
    expect(r?.nickname).toBeNull()
  })

  it('6 个字段（带昵称）也照样解析', () => {
    const r = parsePtuiCb("ptuiCB('0','0','https://x/y','0','登录成功','张三')")
    expect(r?.nickname).toBe('张三')
  })

  it('前面有其它内容时仍能解析', () => {
    const r = parsePtuiCb("\n  ptuiCB('66','0','','0','二维码未失效。','')")
    expect(r?.code).toBe('66')
  })
})
