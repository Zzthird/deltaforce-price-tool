/**
 * 统一的 HTTP 客户端 —— **所有对外请求的唯一出口**。
 *
 * 为什么不让各适配器自己调 fetch：
 *   1. 礼貌策略只写一份（UA / 超时 / 限速 / 退避重试）
 *   2. 出问题时只有一个地方要看
 *   3. 请求总数可统计 —— 这是"对源站负担"的唯一度量
 *
 * 内置的四条礼貌规则（对应 PLAN.md 的"礼貌策略"）：
 *   ① 串行：永远不并发，上一个请求彻底结束才发下一个
 *   ② 抖动延迟：两次同类请求之间随机等 1~3 秒（模拟人的节奏，不是机器定时）
 *   ③ 超时：默认 20 秒放弃
 *   ④ 退避重试：失败后等 2s / 4s / 8s 再试，最多 3 次
 *
 * 以及一条硬性红线：
 *   ⑤ 遇到 403 / 429 立刻放弃，**绝不重试** —— 这通常意味着被限流或封禁，
 *      继续重试等于往枪口上撞。抛 SourceBlockedError，由上层决定降级。
 *
 * Python 类比：相当于用 requests.Session 包一层，加上 tenacity 的退避重试
 * 和一个全局信号量（concurrency=1）。
 */

import type { AppConfig } from './config'
import type { Logger } from './logger'

/** HTTP 层面的错误 */
export class HttpError extends Error {
  readonly status: number
  readonly url: string
  constructor(message: string, status: number, url: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

/**
 * 被源站拒绝（403 / 429）。
 * 上层应该：停止本轮抓取、保留旧快照、把错误展示在状态栏。
 */
export class SourceBlockedError extends HttpError {
  constructor(status: number, url: string) {
    super(
      `源站拒绝访问（HTTP ${status}）—— 可能被限流或封禁，已停止本轮抓取`,
      status,
      url,
    )
    this.name = 'SourceBlockedError'
  }
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** 覆盖默认超时 */
  timeoutMs?: number
  /** false 表示跳过礼貌延迟（例如同一轮里的第 1 个请求） */
  polite?: boolean
  /** false 表示不重试（默认会重试） */
  retry?: boolean
  signal?: AbortSignal
}

/**
 * 已经读进内存的响应。
 *
 * 为什么要先整个读进内存：因为同一个响应我们往往要**用两次** ——
 * 一次把原始字节存到 data/raw/（将来排查源改版用），一次解析成 JSON。
 * 而 HTTP 的响应体是**流**，只能读一次。先缓冲下来最简单也最安全。
 */
export interface HttpResponse {
  readonly status: number
  readonly ok: boolean
  readonly headers: Headers
  readonly url: string
  text(): string
  json<T = unknown>(): T
  bytes(): Uint8Array
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function makeResponse(status: number, headers: Headers, url: string, body: Uint8Array): HttpResponse {
  const decoder = new TextDecoder('utf-8')
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    url,
    bytes: () => body,
    text: () => decoder.decode(body),
    json: <T,>() => JSON.parse(decoder.decode(body)) as T,
  }
}

export class HttpClient {
  private readonly cfg: AppConfig
  private readonly logger: Logger

  /** 请求串行化的链条：下一个请求挂在上一个后面 */
  private chain: Promise<unknown> = Promise.resolve()

  /** 每个域名最近一次请求的时刻（用于礼貌延迟） */
  private readonly lastRequestAt = new Map<string, number>()

  /** 累计请求数 —— 用来证明"这次抓取到底给源站添了多少麻烦" */
  private sentCount = 0

  constructor(cfg: AppConfig, logger: Logger) {
    this.cfg = cfg
    this.logger = logger.child({ http: 'client' })
  }

  /** 到目前为止发出的请求总数 */
  get requestCount(): number {
    return this.sentCount
  }

  get(url: string, init: Omit<HttpRequestInit, 'method' | 'body'> = {}): Promise<HttpResponse> {
    return this.request(url, { ...init, method: 'GET' })
  }

  postJson(
    url: string,
    payload: unknown,
    init: Omit<HttpRequestInit, 'method' | 'body'> = {},
  ): Promise<HttpResponse> {
    return this.request(url, {
      ...init,
      method: 'POST',
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
    })
  }

  /**
   * 发一个请求。所有调用都会排进同一条串行队列。
   */
  request(url: string, init: HttpRequestInit = {}): Promise<HttpResponse> {
    // 关键：先同步地把任务挂到链条上，保证调用顺序 = 发送顺序
    const run = this.chain.then(
      () => this.executeWithRetry(url, init),
      () => this.executeWithRetry(url, init), // 上一个失败也要继续，不能被卡死
    )
    // 链条自身吞掉错误（否则一个失败会让后续请求永远不执行），
    // 但返回给调用方的 run 保留原样错误。
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /* ------------------------------------------------------------------ */

  private async executeWithRetry(url: string, init: HttpRequestInit): Promise<HttpResponse> {
    const maxAttempts = init.retry === false ? 1 : this.cfg.retryMax + 1
    let lastError: unknown = null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (init.polite !== false) await this.politeWait(url)

      this.sentCount += 1
      const startedAt = Date.now()

      try {
        const res = await this.fetchOnce(url, init)
        const ms = Date.now() - startedAt

        // ⚠️ 403 / 429 是红线：立刻放弃，绝不重试
        if (res.status === 403 || res.status === 429) {
          this.logger.warn('源站拒绝访问，停止本轮', { url, status: res.status, ms })
          throw new SourceBlockedError(res.status, url)
        }

        if (res.status >= 500) {
          lastError = new HttpError(`服务器错误 HTTP ${res.status}`, res.status, url)
          if (attempt < maxAttempts) {
            const wait = this.backoffMs(attempt)
            this.logger.warn('服务端 5xx，准备重试', { url, status: res.status, attempt, waitMs: wait })
            await sleep(wait)
            continue
          }
          throw lastError
        }

        this.logger.debug('请求完成', { url, status: res.status, ms, bytes: res.bytes().length })
        return res
      } catch (err) {
        if (err instanceof SourceBlockedError) throw err

        lastError = err
        const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

        if (attempt < maxAttempts) {
          const wait = this.backoffMs(attempt)
          this.logger.warn('请求失败，准备重试', { url, attempt, waitMs: wait, reason })
          await sleep(wait)
          continue
        }
        this.logger.error('请求失败且已用尽重试', { url, attempts: maxAttempts, reason })
        throw err instanceof Error ? err : new Error(reason)
      }
    }

    // 理论上不可达（循环内要么 return 要么 throw），保险起见
    throw lastError instanceof Error ? lastError : new Error(`请求失败: ${url}`)
  }

  private async fetchOnce(url: string, init: HttpRequestInit): Promise<HttpResponse> {
    const timeoutMs = init.timeoutMs ?? this.cfg.requestTimeoutMs

    // 把"超时"和"外部取消"两个信号合成一个
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (init.signal) signals.push(init.signal)
    const signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals)

    const headers: Record<string, string> = {
      'User-Agent': this.cfg.userAgent,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...init.headers,
    }

    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      signal,
      redirect: 'follow',
    })

    const body = new Uint8Array(await res.arrayBuffer())
    return makeResponse(res.status, res.headers, res.url || url, body)
  }

  /** 礼貌延迟：保证同一个域名两次请求之间至少隔 1~3 秒（随机） */
  private async politeWait(url: string): Promise<void> {
    let host: string
    try {
      host = new URL(url).host
    } catch {
      return
    }

    const { requestDelayMinMs: min, requestDelayMaxMs: max } = this.cfg
    const gap = min + Math.random() * Math.max(0, max - min)
    const last = this.lastRequestAt.get(host) ?? 0
    const waitMs = last + gap - Date.now()

    if (waitMs > 0) {
      this.logger.debug('礼貌等待', { host, waitMs: Math.round(waitMs) })
      await sleep(waitMs)
    }
    this.lastRequestAt.set(host, Date.now())
  }

  /** 指数退避：2s → 4s → 8s，并叠加 0~500ms 抖动避免规律性 */
  private backoffMs(attempt: number): number {
    const base = this.cfg.retryBaseDelayMs * 2 ** (attempt - 1)
    return Math.round(base + Math.random() * 500)
  }
}
