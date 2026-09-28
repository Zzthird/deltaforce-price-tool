/**
 * 后端 API 客户端 —— **前端访问后端的唯一入口**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么要有"唯一入口"这一层
 * ═══════════════════════════════════════════════════════════════════════
 * 如果每个组件自己写 `fetch('/api/items')`，会立刻遇到三个问题：
 *
 *   ① **错误处理会各写各的** —— 有一个组件忘了判断 `res.ok`，
 *      它就会拿着一份错误 JSON 当数据用，然后报一个毫不相关的错。
 *   ② **后端改了响应形状，没人提醒你** —— 因为 `fetch` 返回的是 `any`。
 *   ③ **没法统一加东西** —— 将来要加请求头、加超时、加重试，
 *      得改十几个地方。
 *
 * 所以：这里用 `fetch` 包一层，每个接口返回**有类型**的响应，
 * 出错统一抛 `ApiError`。组件只和这个文件打交道。
 *
 * ⚠️ 注意 `import type`：`shared` 包没有构建产物，全靠 `import type`
 *    在编译期被擦除才能工作（见 AGENTS.md §5）。
 */

import type {
  ApiErrorCode,
  ApiErrorResponse,
  ApiHealthResponse,
  ApiItemsResponse,
  ApiMetaResponse,
  ApiRefreshResponse,
  ApiSourcesResponse,
} from '@deltaforce/shared'

/**
 * 请求失败时抛出的错误。
 *
 * `code` 是后端给的结构化错误码（`refresh_too_soon` 之类），
 * 前端据此显示**对应的中文提示**，而不是把英文错误码甩给用户 ——
 * 这是 API 契约里明确要求的（见 ApiErrorCode 的注释）。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: ApiErrorCode | undefined,
    readonly status: number,
    /** 限流时后端会告诉我们还要等多少秒（也放在 Retry-After 头里） */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message)
    this.name = 'ApiError'
  }

  /**
   * 给用户看的中文说明。
   *
   * 为什么不直接用 `message`：后端的 message 偏技术（"刚更新过，请等 101 秒"），
   * 而这里要给出**下一步该做什么**。
   */
  get friendly(): string {
    switch (this.code) {
      case 'no_snapshot':
        return '还没有抓到数据。后端首次启动需要抓一轮（约 13 秒），稍等后刷新页面即可。'
      case 'refresh_in_progress':
        return '已经有一次抓取在进行中，等它完成就会自动更新。'
      case 'refresh_too_soon':
        return this.retryAfterSeconds !== undefined
          ? `刚更新过，请等 ${this.retryAfterSeconds} 秒后再试（为的是不给数据源添麻烦）。`
          : '刚更新过，稍等一会儿再试。'
      case 'source_error':
        return '数据源出错了。检查一下后端控制台的日志，或者看看 /api/health。'
      case 'internal_error':
        return '后端内部错误。看看后端控制台的日志。'
      default:
        return this.status === 0
          ? '连不上后端服务。确认已经在另一个终端跑了 `npm run dev:api`。'
          : `请求失败（HTTP ${this.status}）：${this.message}`
    }
  }
}

/**
 * 统一发请求。
 *
 * 这里做了三件容易被忘掉的事：
 *   ① 先读成文本再 `JSON.parse` —— 后端出错时可能返回空 body，
 *      直接 `.json()` 会抛一个和真实原因无关的解析错误
 *   ② 非 2xx 一律抛 `ApiError`，不让错误数据流进组件
 *   ③ 网络层失败（后端没起）包装成 `status: 0`，好和 HTTP 错误区分开
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...init?.headers },
    })
  } catch (err) {
    // fetch 只在"根本没连上"时抛异常（DNS、连接被拒、被取消）
    throw new ApiError(
      err instanceof Error ? err.message : String(err),
      undefined,
      0,
      undefined,
    )
  }

  const text = await res.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      throw new ApiError(`响应不是合法 JSON：${text.slice(0, 120)}`, undefined, res.status, undefined)
    }
  }

  if (!res.ok) {
    const errBody = body as ApiErrorResponse | null
    // Retry-After 是标准 HTTP 头；后端同时也把它放在 body 里，两个都认
    const retryAfterHeader = res.headers.get('Retry-After')
    const retryAfterSeconds =
      errBody?.retryAfterSeconds ??
      (retryAfterHeader !== null ? Number(retryAfterHeader) : undefined)

    throw new ApiError(
      errBody?.error ?? `HTTP ${res.status}`,
      errBody?.code,
      res.status,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    )
  }

  return body as T
}

/** 五个接口。参数与返回类型都对着 `shared/src/index.ts` 的契约。 */
export const api = {
  /**
   * 物品列表。
   *
   * ⚠️ 这个接口在数据有点旧时会**顺带在后台抓一轮**，数据很旧时会
   * **阻塞等到抓完**（约 13 秒）再返回 —— 所以它可能很慢，这是设计如此。
   * 组件里要显示 loading。
   */
  items: (): Promise<ApiItemsResponse> => request<ApiItemsResponse>('/items'),

  /** 筛选器选项 + 标签调色板（品质色值、中文标签都从这来） */
  meta: (): Promise<ApiMetaResponse> => request<ApiMetaResponse>('/meta'),

  /** 各数据源的能力与健康状态 */
  sources: (): Promise<ApiSourcesResponse> => request<ApiSourcesResponse>('/sources'),

  /** 存活与新鲜度。这个接口**不会**触发抓取，可以放心频繁调 */
  health: (): Promise<ApiHealthResponse> => request<ApiHealthResponse>('/health'),

  /**
   * 手动刷新（网页上的"刷新"按钮）。
   * 注意后端可能回 409（已在抓）或 429（刚抓过）—— 都是正常状态，不是故障。
   */
  refresh: (): Promise<ApiRefreshResponse> =>
    request<ApiRefreshResponse>('/refresh', { method: 'POST' }),
}
