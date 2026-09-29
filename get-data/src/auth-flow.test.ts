import { describe, expect, it, vi } from 'vitest'
import { getGtk } from './auth'
import {
  buildAuthorizeForm,
  cookieHeaderOf,
  exchangeCodeForToken,
  parseCookiePaste,
  parseTokenJsonp,
} from './auth-flow'

describe('parseCookiePaste', () => {
  it('cURL（Copy as cURL）里抽 cookie 头', () => {
    const curl = `curl 'https://graph.qq.com/x' \\
  -H 'accept: */*' \\
  -H 'cookie: p_skey=abc; uin=123; RK=zz' \\
  -H 'user-agent: chrome' --compressed`
    expect(parseCookiePaste(curl)).toEqual({ p_skey: 'abc', uin: '123', RK: 'zz' })
  })

  it('cURL 用双引号也行', () => {
    expect(parseCookiePaste(`curl x --header "cookie: a=1; b=2"`)).toEqual({ a: '1', b: '2' })
  })

  it('「Cookie: a=1; b=2」原文', () => {
    expect(parseCookiePaste('Cookie: a=1; b=2')).toEqual({ a: '1', b: '2' })
  })

  it('纯 cookie 串', () => {
    expect(parseCookiePaste('  a=1;b=2 ;; c=3  ')).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('值里含等号也不截断', () => {
    expect(parseCookiePaste('tok=YWJj==; x=1')).toEqual({ tok: 'YWJj==', x: '1' })
  })

  it('解析不出来时报错，并说明支持的三种形态', () => {
    expect(() => parseCookiePaste('这是一段没有 cookie 的文字')).toThrow(/三种形态/)
    expect(() => parseCookiePaste('   ')).toThrow(/没收到任何内容/)
  })
})

describe('buildAuthorizeForm', () => {
  it('⭐ g_tk 用的是 getGtk（初始值 5381），不是 hash33（初始值 0）', () => {
    const form = buildAuthorizeForm({ p_skey: 'TESTKEY' }, 1_700_000_000_000)
    expect(form['g_tk']).toBe(String(getGtk('TESTKEY')))
    expect(form['g_tk']).not.toBe(String(getGtk('TESTKEY') + 1))
  })

  it('auth_time 是秒不是毫秒', () => {
    const form = buildAuthorizeForm({ p_skey: 'K' }, 1_700_000_000_000)
    expect(form['auth_time']).toBe('1700000000')
  })

  it('client_id 是 DF 的 appid', () => {
    expect(buildAuthorizeForm({ p_skey: 'K' })['client_id']).toBe('101491592')
  })
})

describe('parseTokenJsonp', () => {
  it('取出 JSONP 里的对象', () => {
    expect(parseTokenJsonp('cb({"iRet":0,"openid":"o"})', 'cb')).toEqual({ iRet: 0, openid: 'o' })
  })
  it('callback 名字不匹配 → null', () => {
    expect(parseTokenJsonp('other({})', 'cb')).toBeNull()
  })
  it('不是 JSON → null（不抛异常）', () => {
    expect(parseTokenJsonp('cb(not json)', 'cb')).toBeNull()
  })
})

describe('cookieHeaderOf', () => {
  it('拼成一行', () => {
    expect(cookieHeaderOf({ a: '1', b: '2' })).toBe('a=1; b=2')
  })
})

/* ══════════ exchangeCodeForToken（注入 fetch，绝不发真请求） ══════════ */

function jsonResponse(body: string, status = 200, location?: string): Response {
  const headers: [string, string][] = []
  if (location) headers.push(['location', location])
  return new Response(body, { status, headers })
}

describe('exchangeCodeForToken', () => {
  it('成功路径：authorize → 跳转 → userLoginSvr', async () => {
    const calls: string[] = []
    const fake: typeof fetch = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      calls.push(url)
      if (url.includes('/oauth2.0/authorize')) {
        return jsonResponse('', 302, 'https://milo.qq.com/cb?code=THECODE&x=1')
      }
      if (url.includes('userLoginSvr')) {
        return jsonResponse('cb({"iRet":0,"openid":"OPENID1","access_token":"TOK","expires_in":7776})')
      }
      return jsonResponse('', 200)
    }) as unknown as typeof fetch

    const steps: string[] = []
    const r = await exchangeCodeForToken(
      { p_skey: 'K', uin: '1' },
      { fetchImpl: fake, callback: 'cb', onStep: (s) => steps.push(s) },
    )

    expect(r).toEqual({ openid: 'OPENID1', access_token: 'TOK', expires_in: 7776, code: 'THECODE' })
    expect(calls[0]).toContain('/oauth2.0/authorize')
    expect(calls[1]).toContain('code=THECODE') // ② 确实走了跳转
    expect(calls[2]).toContain('userLoginSvr')
    expect(steps).toHaveLength(3)
  })

  it('code 里带 URL 编码也能还原', async () => {
    let seen = ''
    const fake = (async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('/oauth2.0/authorize')) {
        return jsonResponse('', 302, 'https://x/cb?code=A%2FB%2BC&y=2')
      }
      if (url.includes('userLoginSvr')) {
        seen = url
        return jsonResponse('cb({"iRet":0,"openid":"o","access_token":"t"})')
      }
      return jsonResponse('')
    }) as unknown as typeof fetch

    const r = await exchangeCodeForToken({ p_skey: 'K' }, { fetchImpl: fake, callback: 'cb' })
    expect(r.code).toBe('A/B+C')
    expect(decodeURIComponent(seen.split('qc_code=')[1]!.split('&')[0]!)).toBe('A/B+C')
  })

  it('⭐ 没有 p_skey 时提前报错，并列出实际有哪些 cookie', async () => {
    const fake = vi.fn() as unknown as typeof fetch
    await expect(
      exchangeCodeForToken({ uin: '1', RK: 'z' }, { fetchImpl: fake }),
    ).rejects.toThrow(/没有 p_skey.*uin, RK/s)
    expect(fake).not.toHaveBeenCalled() // 连请求都不该发
  })

  it('which=Login 时报错只说事实（cookie 名单），不猜原因', async () => {
    const fake = (async () =>
      jsonResponse('', 302, 'https://graph.qq.com/oauth2.0/show?which=Login&x=1')) as unknown as typeof fetch
    const err = await exchangeCodeForToken({ p_skey: 'K' }, { fetchImpl: fake }).catch(
      (e: unknown) => (e instanceof Error ? e.message : ''),
    )
    expect(err).toMatch(/请先登录/)
    expect(err).toMatch(/p_skey 长度 1/)
    expect(err).not.toMatch(/可能|大概|也许/)
  })

  it('iRet 非 0 时报错并带上原文', async () => {
    const fake = (async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('/oauth2.0/authorize')) {
        return jsonResponse('', 302, 'https://x/cb?code=C&y=2')
      }
      return jsonResponse('cb({"iRet":100,"msg":"bad"})')
    }) as unknown as typeof fetch
    await expect(exchangeCodeForToken({ p_skey: 'K' }, { fetchImpl: fake })).rejects.toThrow(
      /iRet.*100|换 token 失败/s,
    )
  })

  it('返回的不是 JSONP → 带上响应前 160 字', async () => {
    const fake = (async (input: string | URL) => {
      const url = input.toString()
      if (url.includes('/oauth2.0/authorize')) {
        return jsonResponse('', 302, 'https://x/cb?code=C&y=2')
      }
      return jsonResponse('<html>风控页面</html>', 200)
    }) as unknown as typeof fetch
    await expect(
      exchangeCodeForToken({ p_skey: 'K' }, { fetchImpl: fake, callback: 'cb' }),
    ).rejects.toThrow(/风控页面/)
  })
})
