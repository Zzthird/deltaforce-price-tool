import { describe, expect, it } from 'vitest'
import { CookieJar } from './cookie-jar'

/** 造一个带 Set-Cookie 的假响应（不联网） */
function res(...setCookies: string[]): Response {
  return new Response(null, {
    headers: setCookies.map((c) => ['set-cookie', c] as [string, string]),
  })
}

describe('CookieJar —— 域名隔离', () => {
  it('Domain=.qq.com 的 cookie 发给所有子域', () => {
    const jar = new CookieJar()
    jar.absorb(res('p_skey=xyz; Domain=.qq.com; Path=/'), 'https://ssl.ptlogin2.qq.com/ptqrlogin')
    expect(jar.namesFor('https://graph.qq.com/oauth2.0/authorize')).toContain('p_skey')
    expect(jar.namesFor('https://ams.game.qq.com/ams/userLoginSvr')).toContain('p_skey')
    // 但**不能**发给不属于 qq.com 的主机
    expect(jar.namesFor('https://example.com/')).not.toContain('p_skey')
  })

  it('不带 Domain 的 host-only cookie 只发给同一个主机', () => {
    const jar = new CookieJar()
    jar.absorb(res('only=1'), 'https://example.com/a')
    expect(jar.namesFor('https://example.com/b')).toContain('only')
    expect(jar.namesFor('https://sub.example.com/')).not.toContain('only')
  })

  it('⭐ ptlogin2 系列主机上的 host-only cookie 归到 .ptlogin2.qq.com', () => {
    const jar = new CookieJar()
    jar.absorb(res('qrsig=abc123'), 'https://xui.ptlogin2.qq.com/ssl/ptqrshow')
    expect(jar.scopeOf('qrsig')).toBe('.ptlogin2.qq.com')
  })

  it('⭐⭐ 决定性验证：qrsig 带得到轮询、带不到 check_sig', () => {
    const jar = new CookieJar()
    // 扫码阶段在 ptlogin2 主机上下的 cookie
    jar.absorb(res('qrsig=abc123'), 'https://xui.ptlogin2.qq.com/ssl/ptqrshow')
    jar.absorb(res('pt_login_sig=sig'), 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin')

    // ③ 轮询：必须带得上（否则认不出这次扫码）
    const forPoll = jar.namesFor('https://ssl.ptlogin2.qq.com/ptqrlogin')
    expect(forPoll).toContain('qrsig')
    expect(forPoll).toContain('pt_login_sig')

    // ④ check_sig：**一个都不该带** ✓ ← 这就是参考实现在做的事
    const forCheckSig = jar.namesFor('https://ssl.ptlogin2.graph.qq.com/check_sig?uin=123')
    expect(forCheckSig).toEqual([])
  })

  it('空值 cookie 会被删掉（参考实现里也是丢掉的）', () => {
    const jar = new CookieJar()
    jar.absorb(res('x=1; Domain=.qq.com'), 'https://graph.qq.com/')
    expect(jar.get('x')).toBe('1')
    jar.absorb(res('x=; Domain=.qq.com'), 'https://graph.qq.com/')
    expect(jar.get('x')).toBeNull()
  })

  it('同名 cookie 后来者覆盖', () => {
    const jar = new CookieJar()
    jar.absorb(res('x=1; Domain=.qq.com'), 'https://graph.qq.com/')
    jar.absorb(res('x=2; Domain=.qq.com'), 'https://graph.qq.com/')
    expect(jar.get('x')).toBe('2')
  })

  it('同域的多个 cookie 拼成一行 Cookie 头', () => {
    const jar = new CookieJar()
    jar.absorb(res('a=1; Domain=.qq.com', 'b=2; Domain=.qq.com'), 'https://graph.qq.com/')
    const h = jar.header('https://graph.qq.com/x')
    expect(h).toContain('a=1')
    expect(h).toContain('b=2')
    expect(h).toContain('; ')
  })

  it('absorb 返回新下的 cookie 名（供诊断打印）', () => {
    const jar = new CookieJar()
    expect(jar.absorb(res('a=1; Domain=.qq.com'), 'https://graph.qq.com/')).toEqual(['a'])
    expect(jar.absorb(res('a=9; Domain=.qq.com'), 'https://graph.qq.com/')).toEqual([])
    expect(jar.absorb(res('b=2; Domain=.qq.com'), 'https://graph.qq.com/')).toEqual(['b'])
  })

  it('非法 URL 不会抛异常', () => {
    const jar = new CookieJar()
    expect(() => jar.absorb(res('a=1'), 'not a url')).not.toThrow()
    expect(jar.header('not a url')).toBe('')
    expect(jar.namesFor('not a url')).toEqual([])
  })
})
