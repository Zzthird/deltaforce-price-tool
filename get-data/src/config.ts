/**
 * 配置中心 —— 整个取数服务所有可调参数的**唯一出口**。
 *
 * 为什么要集中：如果各文件各自读 `process.env.XXX`，你永远不知道程序到底
 * 认了哪些配置、默认值是什么。集中到一处之后：
 *   1. 看这一个文件就知道全部可调项
 *   2. 启动时一次性校验，配置写错立刻报错，而不是跑一半才崩
 *   3. 类型安全 —— 别处拿到的是 `config.refreshAfterMinutes: number`，
 *      而不是可能为 undefined 的 `process.env.REFRESH_AFTER_MINUTES`
 *
 * Python 类比：这相当于把散落各处的 `os.environ.get()` 收进一个 pydantic
 * Settings 类，并在启动时 `Settings()` 一次校验。
 */

import 'dotenv/config' // 副作用导入：自动读取 get-data/.env 到 process.env
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/**
 * 环境变量的校验规则。
 *
 * 说明：`.env` 里的值**全部是字符串**（没有数字类型），所以数字项都用
 * `z.coerce.number()` —— coerce 的意思是"先尝试转换，再校验"。
 * 这与 Python 里 `int(os.environ["PORT"])` 是同一个动作，只是失败时会
 * 给出可读的错误而不是 `ValueError`。
 */
const EnvSchema = z
  .object({
    // ---- HTTP 服务 ----
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),

    // ---- 数据源选择 ----
    ITEM_SOURCE: z.enum(['official']).default('official'),
    PRICE_SOURCE: z.enum(['moligod', 'dergame', 'none']).default('moligod'),
    MOLIGOD_BASE_URL: z.string().url().default('https://moligod.com'),
    DERGAME_BASE_URL: z.string().url().default('https://dergame.cn'),

    // ---- 刷新策略（按需触发，无定时器）----
    REFRESH_AFTER_MINUTES: z.coerce.number().positive().default(15),
    BLOCKING_REFRESH_AFTER_MINUTES: z.coerce.number().positive().default(120),
    MIN_REFRESH_GAP_SECONDS: z.coerce.number().nonnegative().default(120),
    FAILURE_COOLDOWN_SECONDS: z.coerce.number().nonnegative().default(300),
    MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().positive().default(5),

    // ---- 礼貌策略 ----
    CONTACT_EMAIL: z.string().min(3).default('your-email@example.com'),
    CONCURRENCY: z.coerce.number().int().positive().default(1),
    REQUEST_DELAY_MIN_MS: z.coerce.number().nonnegative().default(1000),
    REQUEST_DELAY_MAX_MS: z.coerce.number().nonnegative().default(3000),
    REQUEST_TIMEOUT_MS: z.coerce.number().positive().default(20000),
    RETRY_MAX: z.coerce.number().int().nonnegative().default(3),
    RETRY_BASE_DELAY_MS: z.coerce.number().positive().default(2000),

    // ---- 存储 ----
    DATA_DIR: z.string().min(1).default('data'),
    HISTORY_KEEP_DAYS: z.coerce.number().int().positive().default(8),
    RAW_KEEP_ROUNDS: z.coerce.number().int().nonnegative().default(48),

    // ---- 人工覆盖 ----
    PROVENANCE_OVERRIDES: z.string().min(1).default('overrides/provenance.json'),
    ITEM_ATTRIBUTES_OVERRIDES: z.string().min(1).default('overrides/item-attributes.json'),

    // ---- 日志 ----
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  })
  .superRefine((env, ctx) => {
    // 逻辑校验：阻塞阈值必须 ≥ 后台刷新阈值，否则状态机第 ② 档永远不会命中
    if (env.BLOCKING_REFRESH_AFTER_MINUTES < env.REFRESH_AFTER_MINUTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BLOCKING_REFRESH_AFTER_MINUTES'],
        message:
          `BLOCKING_REFRESH_AFTER_MINUTES(${env.BLOCKING_REFRESH_AFTER_MINUTES}) ` +
          `不能小于 REFRESH_AFTER_MINUTES(${env.REFRESH_AFTER_MINUTES})，` +
          `否则"后台刷新"这一档永远不会被命中`,
      })
    }
    if (env.REQUEST_DELAY_MAX_MS < env.REQUEST_DELAY_MIN_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REQUEST_DELAY_MAX_MS'],
        message: 'REQUEST_DELAY_MAX_MS 不能小于 REQUEST_DELAY_MIN_MS',
      })
    }
  })

export interface AppConfig {
  readonly port: number
  readonly host: string

  readonly itemSource: 'official'
  readonly priceSource: 'moligod' | 'dergame' | 'none'
  readonly moligodBaseUrl: string
  readonly derGameBaseUrl: string

  readonly refreshAfterMinutes: number
  readonly blockingRefreshAfterMinutes: number
  readonly minRefreshGapSeconds: number
  readonly failureCooldownSeconds: number
  readonly maxConsecutiveFailures: number

  readonly contactEmail: string
  /** 每次请求都会带上的 User-Agent —— 万一站长看日志，得能找到人 */
  readonly userAgent: string
  readonly concurrency: number
  readonly requestDelayMinMs: number
  readonly requestDelayMaxMs: number
  readonly requestTimeoutMs: number
  readonly retryMax: number
  readonly retryBaseDelayMs: number

  /** get-data 包的根目录（绝对路径） */
  readonly packageRoot: string
  /** 抓取产物目录（绝对路径） */
  readonly dataDir: string
  /** 人工覆盖目录（绝对路径，入库 git） */
  readonly overridesDir: string
  /** 出产地覆盖文件（绝对路径） */
  readonly provenanceOverridesPath: string
  /** 可获得性覆盖文件（绝对路径） */
  readonly itemAttributesOverridesPath: string
  readonly historyKeepDays: number
  readonly rawKeepRounds: number

  readonly logLevel: LogLevel
}

/** get-data 包根目录。`src/config.ts` 的上一级即是。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

let cached: AppConfig | null = null

/**
 * 加载并校验配置。第一次调用后结果会被缓存，之后重复调用返回同一个对象。
 *
 * 校验失败时抛出的错误里会带上**每一处**问题，而不是只报第一个 ——
 * 这样你一次就能把 .env 改对，不用来回试。
 */
export function loadConfig(): AppConfig {
  if (cached) return cached

  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  · ${issue.path.join('.') || '(根)'}: ${issue.message}`,
    )
    throw new Error(
      `配置校验失败，请检查 get-data/.env（可参照 get-data/.env.example）：\n${lines.join('\n')}`,
    )
  }

  const env = parsed.data
  const dataDir = resolve(PACKAGE_ROOT, env.DATA_DIR)

  cached = {
    port: env.PORT,
    host: env.HOST,

    itemSource: env.ITEM_SOURCE,
    priceSource: env.PRICE_SOURCE,
    moligodBaseUrl: env.MOLIGOD_BASE_URL.replace(/\/+$/, ''),
    derGameBaseUrl: env.DERGAME_BASE_URL.replace(/\/+$/, ''),

    refreshAfterMinutes: env.REFRESH_AFTER_MINUTES,
    blockingRefreshAfterMinutes: env.BLOCKING_REFRESH_AFTER_MINUTES,
    minRefreshGapSeconds: env.MIN_REFRESH_GAP_SECONDS,
    failureCooldownSeconds: env.FAILURE_COOLDOWN_SECONDS,
    maxConsecutiveFailures: env.MAX_CONSECUTIVE_FAILURES,

    contactEmail: env.CONTACT_EMAIL,
    userAgent: `DeltaForce-PriceBoard/0.1.0 (personal read-only tool; ${env.CONTACT_EMAIL})`,
    concurrency: env.CONCURRENCY,
    requestDelayMinMs: env.REQUEST_DELAY_MIN_MS,
    requestDelayMaxMs: env.REQUEST_DELAY_MAX_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    retryMax: env.RETRY_MAX,
    retryBaseDelayMs: env.RETRY_BASE_DELAY_MS,

    packageRoot: PACKAGE_ROOT,
    dataDir,
    overridesDir: resolve(PACKAGE_ROOT, 'overrides'),
    provenanceOverridesPath: resolve(PACKAGE_ROOT, env.PROVENANCE_OVERRIDES),
    itemAttributesOverridesPath: resolve(PACKAGE_ROOT, env.ITEM_ATTRIBUTES_OVERRIDES),
    historyKeepDays: env.HISTORY_KEEP_DAYS,
    rawKeepRounds: env.RAW_KEEP_ROUNDS,

    logLevel: env.LOG_LEVEL,
  }

  return cached
}

/** 仅供测试使用：清掉缓存，让下次 loadConfig() 重新读环境变量。 */
export function resetConfigCache(): void {
  cached = null
}
