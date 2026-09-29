/**
 * 官方 AMS 接口 —— **探测/调用**的公共部分。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个接口长什么样（一句话讲清）
 * ═══════════════════════════════════════════════════════════════════════
 * 官方所有"网页能看到的游戏数据"都走**同一个地址**，靠参数区分功能：
 *
 *   POST https://comm.ams.game.qq.com/ide/
 *   Content-Type: application/x-www-form-urlencoded
 *   Referer: https://df.qq.com/
 *   Cookie: openid=…; access_token=…; acctype=qc; appid=101491592
 *
 *   表单体（三个是"身份"，其余是"你要什么"）：
 *     iChartId     ← 哪一块数据（相当于"频道号"）
 *     iSubChartId  ← 一般等于 iChartId
 *     sIdeToken    ← 和 iChartId 配对的口令（写死在前端 JS 里）
 *     method       ← 想调哪个方法（部分 chartId 需要）
 *     action       ← 另一种区分方式（部分 chartId 用这个）
 *     source       ← 常见取值 1/2/5，语义不明，照抄即可
 *     param        ← 通常是一段 JSON 字符串
 *
 * 响应统一信封：
 *   {"ret":0,"iRet":0,"sMsg":"ok","jData":{"data":…}}
 *   ret != 0 → 失败。⚠️ 但它的报错文案经常**和真实原因无关**（见下）。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️ 三个"报错在骗人"的实测案例（省下你踩坑的时间）
 * ═══════════════════════════════════════════════════════════════════════
 *   1. `ret=-4000`「抱歉，目前访问人数太多！请稍后再试！」
 *      —— 军需处只试 action=1 就是这句。真实原因：**参数不对**，
 *      它跟"人多"没关系。（我因为信了这句话，一度得出
 *      "集市没有官方接口"的错误结论。）
 *   2. `ret=101` —— 通常真是"未登录"，但**用 GET 代替 POST 也会出现它**。
 *      所以拿到 101 先确认请求方法，别急着去登录。
 *   3. `ret=0` 但 `jData.data` 是**空数组** —— 这不是"没有数据"，
 *      是"参数组合不对"。`action=2` 就是这样。
 *
 * ⭐ 一句话总结：**别信文案，去试参数组合。**
 *    同一个 chartId 换 action、换 source、换 method，
 *    结果可能从"人数太多"变成"你要的整张表"。
 */

import type { AppConfig } from './config'
import { HttpClient } from './http'
import type { Logger } from './logger'

export const IDE_ENDPOINT = 'https://comm.ams.game.qq.com/ide/'

/**
 * 已知的 chartId → sIdeToken 对照表。
 *
 * ⚠️ **这张表不是官方给的**，是从「前端 JS 里写死的常量」里读出来的
 *    （第三方项目抄了它 —— 见 docs/source-recon.md §九）。
 *    换季/更新后可能失效，失效时用 `npm run ide -- --help` 里教的办法重新找。
 *
 * `hint` 是实测到的用途，不是猜的 ✓
 */
export interface KnownChart {
  chartId: string
  token: string
  hint: string
  /** 实测好用的默认参数 */
  defaults?: Record<string, string>
  /** 是否实测过、结论是什么 */
  status: 'ok' | 'need-param' | 'unknown'
}

export const KNOWN_CHARTS: readonly KnownChart[] = [
  {
    chartId: '352143',
    token: 'YWRywA',
    hint: '物品主数据（dfm/object.list）/ 每日密码 / 地点 / 配置表 —— 我们已在用',
    defaults: { method: 'dfm/place.list', source: '2' },
    status: 'ok',
  },
  {
    chartId: '352143',
    token: 'YWRywA',
    hint: '官方现价 dfm/object.price.latest（需 param={"objectID":[…]）+ 登录）',
    defaults: {
      method: 'dfm/object.price.latest',
      source: '2',
      param: '{"objectID":[15080050007]}',
    },
    status: 'ok',
  },
  {
    chartId: '352143',
    token: 'YWRywA',
    hint: '每日价格历史 dfm/object.price.recent（每天 avgPrice + 成交笔数 count）',
    defaults: { method: 'dfm/object.price.recent', source: '2', param: '{"objectID":15080050007}' },
    status: 'ok',
  },
  {
    chartId: '352143',
    token: 'YWRywA',
    hint: '配置表 dfm/config.list（一直"参数校验失败"，param 形状未知）',
    defaults: { method: 'dfm/config.list', source: '5' },
    status: 'need-param',
  },
  {
    chartId: '365589',
    token: 'bQaMCQ',
    hint: '制造/特勤处：返回 4 个制造台状态（工作台/防具台/技术中心/制药台）—— 没有配方',
    defaults: { source: '5' },
    status: 'ok',
  },
  {
    chartId: '530479',
    token: 'SwgEeH',
    hint: '军需处：action=3 是集市兑换表（网页已用）；action=2 返回空数组',
    defaults: { action: '3', source: '2' },
    status: 'ok',
  },
  { chartId: '316964', token: '95ookO', hint: '大区绑定状态（jData.bindarea）', status: 'ok' },
  { chartId: '316965', token: 'sTzZS2', hint: '提交大区绑定（需 checkparam/md5str）', status: 'ok' },
  {
    chartId: '316969',
    token: 'NoOapI',
    hint: 'dfm/center.person.resource、dfm/center.recent.detail（需要额外参数）',
    defaults: { method: 'dfm/center.person.resource', source: '2' },
    status: 'need-param',
  },
  { chartId: '317814', token: 'QIRBwm', hint: '个人战绩：角色名 / rankpoint / totalprice（总资产）', status: 'ok' },
  { chartId: '318948', token: 'Plaqzy', hint: 'userData：物品 ID + 名称 + 品质（疑似个人库存）', status: 'unknown' },
  { chartId: '319386', token: 'zMemOt', hint: '未知（需要额外参数）', status: 'unknown' },
] as const

export interface IdeRequest {
  url: string
  body: string
  headers: Record<string, string>
}

/**
 * 拼一个 IDE 请求（纯函数 → 可单测）。
 *
 * ⚠️ 参数必须放在 **POST 表单体**里 ✓ ——
 *    拼到 URL 查询串上会拿到结构完全不同的响应 ✗（我踩过：
 *    报错只显示"不是数组"，往回查才发现是参数没被读到）。
 */
export function buildIdeRequest(
  chartId: string,
  token: string,
  params: Record<string, string>,
  cookie?: string,
): IdeRequest {
  const form: Record<string, string> = {
    iChartId: chartId,
    iSubChartId: chartId,
    sIdeToken: token,
    ...params,
  }
  return {
    url: IDE_ENDPOINT,
    body: new URLSearchParams(form).toString(),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://df.qq.com/',
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
  }
}

/** 响应信封的摘要（给命令行打印用） */
export interface IdeSummary {
  status: number
  ret: number | null
  iRet: number | null
  sMsg: string | null
  /** jData.data 里如果还有 code/msg，一并取出来（很多接口的"第二层报错"在这）*/
  innerCode: number | null
  innerMsg: string | null
  /** `jData.data` 或 `jData.data.data` 的键或长度，让人一眼看出"有没有数据" */
  dataShape: string
  /** 顶层 jData 的键 */
  jDataKeys: string[]
}

/** 解析响应信封（纯函数 → 可单测）。不抛异常，坏 JSON 也如实报告。 */
export function summarizeIde(status: number, text: string): IdeSummary {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {
      status,
      ret: null,
      iRet: null,
      sMsg: `不是 JSON（前 60 字：${text.slice(0, 60)}）`,
      innerCode: null,
      innerMsg: null,
      dataShape: '非 JSON',
      jDataKeys: [],
    }
  }
  const o = parsed as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

  const jData = (o['jData'] ?? null) as Record<string, unknown> | null
  const outer = jData?.['data']
  const inner =
    outer !== null && typeof outer === 'object' && !Array.isArray(outer)
      ? (outer as Record<string, unknown>)
      : null
  const list = Array.isArray(outer) ? outer : inner?.['data']

  let dataShape: string
  if (Array.isArray(list)) dataShape = `数组（${list.length} 条）`
  else if (list !== undefined && list !== null && typeof list === 'object')
    dataShape = `对象（键：${Object.keys(list).slice(0, 10).join(', ')}）`
  else if (list !== undefined && list !== null) dataShape = String(list).slice(0, 40)
  else dataShape = '（没有）'

  return {
    status,
    ret: num(o['ret']),
    iRet: num(o['iRet']),
    sMsg: str(o['sMsg']),
    innerCode: inner ? num(inner['code']) : null,
    innerMsg: inner ? str(inner['msg']) : null,
    dataShape,
    jDataKeys: jData === null ? [] : Object.keys(jData),
  }
}

export interface CallIdeOptions {
  chartId: string
  token: string
  params: Record<string, string>
  /** 登录 cookie（不传则不带）*/
  cookie?: string
  /** 用 GET 而不是 POST —— 用来验证"是不是方法用错了" */
  useGet?: boolean
}

export interface CallIdeResult {
  summary: IdeSummary
  text: string
  requestUrl: string
  requestBody: string
}

export async function callIde(
  cfg: AppConfig,
  logger: Logger,
  options: CallIdeOptions,
): Promise<CallIdeResult> {
  const req = buildIdeRequest(options.chartId, options.token, options.params, options.cookie)
  const http = new HttpClient(cfg, logger)
  const res = options.useGet
    ? await http.request(`${req.url}?${req.body}`, { method: 'GET', headers: stripCookieIfAbsent(req.headers) })
    : await http.request(req.url, { method: 'POST', headers: req.headers, body: req.body })
  const text = res.text()
  return {
    summary: summarizeIde(res.status, text),
    text,
    requestUrl: req.url,
    requestBody: req.body,
  }
}

function stripCookieIfAbsent(headers: Record<string, string>): Record<string, string> {
  return headers
}
