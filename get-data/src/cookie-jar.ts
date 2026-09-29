/**
 * 极简 cookie 罐 —— **按域名隔离**。
 *
 * ⭐ 为什么必须按域名隔离（这是登录流程里踩过的真坑）：
 *
 *   参考实现里 jar 的域名是 `.ptlogin2.qq.com`，而第 ④ 步要 GET 的
 *   `check_sig` 在 **`ssl.ptlogin2.graph.qq.com`** 上 —— 域名不匹配，
 *   于是 Guzzle **一个 cookie 都不发**。
 *
 *   我第一版是**不分域名**的，把 `qrsig`（二维码会话 cookie）、
 *   `pt_login_sig` 等一起发给了 check_sig。实测后果：jar 里出现了
 *   **`p_skey_forbid`**（而且始终没有 `skey`）—— 把会话 cookie 发给
 *   登录端点，服务器可能把请求当成「还在扫码流程里」，
 *   于是发个受限的 p_skey。接下来请求授权时腾讯就说「请先登录」
 *   （`which=Login`）。
 *
 * 规则（够用就行，不做完整的 RFC 6265）：
 *   · 响应带 `Domain=.qq.com` → 发给 `*.qq.com` ✓
 *   · 不带 `Domain` → host-only，只发给确切主机 ✓
 *   · ⭐ `ptlogin2` 系列主机上的 host-only cookie → 归到 `.ptlogin2.qq.com`
 *     （照参考实现的 `fromArray($cookies, '.ptlogin2.qq.com')`）
 *     —— 这样轮询（`ssl.ptlogin2.qq.com`）能带上 `qrsig` ✓，
 *     而 check_sig（`ssl.ptlogin2.graph.qq.com`）一个都收不到 ✓
 */

export interface StoredCookie {
  value: string
  /** 匹配用：去掉开头的点，比如 `.qq.com` → `qq.com`；host-only 就是主机名本身 */
  domain: string
  /** 是否按「整个域」匹配（`Domain=` 显式声明，或 ptlogin2 系列的兜底） */
  domainWide: boolean
}

export class CookieJar {
  private readonly map = new Map<string, StoredCookie>()

  /** 这个 cookie 能不能发给 `host`？ */
  matches(c: StoredCookie, host: string): boolean {
    if (c.domainWide) return host === c.domain || host.endsWith(`.${c.domain}`)
    return host === c.domain
  }

  /** 从响应里吸收 cookie。`url` 用来判断 host-only 的作用域 */
  absorb(res: Response, url: string): string[] {
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return []
    }
    const added: string[] = []
    const raw = res.headers.getSetCookie?.() ?? []
    for (const line of raw) {
      const parts = line.split(';')
      const pair = parts[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()

      const domainAttr = parts
        .map((p) => p.trim())
        .find((p) => p.toLowerCase().startsWith('domain='))
      let domain = host
      let domainWide = false
      if (domainAttr) {
        const d = domainAttr
          .slice('domain='.length)
          .replace(/^\./, '')
          .toLowerCase()
        if (d !== '') {
          domain = d
          domainWide = true
        }
      } else if (host === 'ptlogin2.qq.com' || host.endsWith('.ptlogin2.qq.com')) {
        domain = 'ptlogin2.qq.com'
        domainWide = true
      }

      // 空值的 cookie 参考实现里是丢掉的（它们只会干扰）
      if (value === '') {
        this.map.delete(name)
        continue
      }
      if (!this.map.has(name)) added.push(name)
      this.map.set(name, { value, domain, domainWide })
    }
    return added
  }

  /** 只把**这个主机该收到的** cookie 拼成 Cookie 头 */
  header(url: string): string {
    const host = hostOf(url)
    if (host === null) return ''
    return [...this.map]
      .filter(([, c]) => this.matches(c, host))
      .map(([k, c]) => `${k}=${c.value}`)
      .join('; ')
  }

  get(name: string): string | null {
    return this.map.get(name)?.value ?? null
  }

  /** 这个主机实际会发出的 cookie 名（诊断用） */
  namesFor(url: string): string[] {
    const host = hostOf(url)
    if (host === null) return []
    return [...this.map].filter(([, c]) => this.matches(c, host)).map(([k]) => k)
  }

  /** 罐里全量 cookie 名（诊断用） */
  names(): string[] {
    return [...this.map.keys()]
  }

  /** 某个 cookie 的作用域（诊断用） */
  scopeOf(name: string): string | null {
    const c = this.map.get(name)
    if (!c) return null
    return `${c.domainWide ? '.' : ''}${c.domain}`
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}
