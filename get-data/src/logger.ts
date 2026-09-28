/**
 * 极简日志。
 *
 * 为什么不直接用现成的库（pino / winston）：
 *   1. 我们的需求只有"分级 + 带上下文标签"，40 行就够
 *   2. 少一个依赖就少一份将来要升级、要担心破坏性变更的东西
 *   3. 自己写的东西你能看懂它每一行在干什么 —— 这是本项目的取向
 *
 * Python 类比：相当于自己写了个极简版 `logging`：
 *   logger = logging.getLogger("official"); logger.info("抓取完成", extra={...})
 *
 * 输出样子：
 *   [16:09:12] INFO  [official] 抓取完成   {"count":711,"ms":1234}
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/** 数值越大越严重。低于阈值的日志会被丢弃。 */
const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
}

/** 固定宽度，让多行日志在终端里对齐，便于扫读 */
const LABEL: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  /**
   * 派生一个带固定上下文的子 logger。
   * 例：`log.child({ source: 'official' })` 之后每条日志都会自动带上 [official]
   */
  child(bindings: Record<string, unknown>): Logger
}

/** 把值渲染成紧凑的一行，避免多行对象把日志冲乱 */
function renderMeta(meta: Record<string, unknown>): string {
  if (Object.keys(meta).length === 0) return ''
  try {
    return `  ${JSON.stringify(meta)}`
  } catch {
    // 循环引用等序列化失败的情况：退化成字符串，绝不因为日志本身而崩
    return '  [meta 无法序列化]'
  }
}

function renderBindings(bindings: Record<string, unknown>): string {
  const tags = Object.values(bindings)
    .filter((v) => v !== undefined && v !== null && v !== '')
    .map((v) => String(v))
  return tags.length > 0 ? `[${tags.join(':')}] ` : ''
}

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function createLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const threshold = SEVERITY[level]
  const prefix = renderBindings(bindings)

  const emit = (lvl: Exclude<LogLevel, 'silent'>) => (message: string, meta?: Record<string, unknown>) => {
    if (SEVERITY[lvl] < threshold) return
    const line = `[${nowStamp()}] ${LABEL[lvl]} ${prefix}${message}${renderMeta(meta ?? {})}`
    if (lvl === 'error') console.error(line)
    else if (lvl === 'warn') console.warn(line)
    else console.log(line)
  }

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  }
}

/** 什么都不输出的 logger，用于单元测试 */
export const silentLogger: Logger = createLogger('silent')
