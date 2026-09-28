/**
 * 极简 CSV 读写。
 *
 * 为什么不装 `papaparse` 这类库：
 *   1. 我们只需要 RFC4180 的一个子集（引号包裹、字段内逗号/换行/双引号）
 *   2. 100 行就能写完，而且你能看懂它每一行
 *   3. 少一个依赖 = 少一件将来要升级、要担心破坏性变更的事
 *
 * ⚠️ 一个容易踩的细节：**UTF-8 BOM**。
 * Windows 版 Excel 打开 CSV 时，如果没有 BOM，会把中文显示成乱码。
 * 所以写文件时默认加上 BOM（`\uFEFF`），读文件时自动去掉。
 */

/** 一个单元格的值 */
export type CsvCell = string | number | null | undefined

/**
 * 转义单个单元格。
 * 规则：含逗号 / 双引号 / 换行 / 回车时，用双引号包起来，并把内部的双引号翻倍。
 */
function escapeCell(value: CsvCell): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export interface ToCsvOptions {
  /** 是否在开头加 UTF-8 BOM（默认 true，为了 Excel 不乱码） */
  bom?: boolean
}

/**
 * 把二维数组渲染成 CSV 文本。
 * 行分隔符用 `\r\n`（Excel 最稳），并以换行结尾。
 */
export function toCsv(
  rows: readonly (readonly CsvCell[])[],
  options: ToCsvOptions = {},
): string {
  const body = rows.map((row) => row.map(escapeCell).join(',')).join('\r\n')
  return `${options.bom === false ? '' : '\uFEFF'}${body}\r\n`
}

/**
 * 解析 CSV 文本为二维数组。
 *
 * 状态机实现，能正确处理：
 *   · 双引号包裹的字段（内含逗号、换行、双引号）
 *   · `""` 表示一个字面双引号
 *   · `\r\n` / `\n` / `\r` 三种行尾
 *   · 开头的 UTF-8 BOM
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < src.length) {
    const ch = src[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      i += 1
      continue
    }
    if (ch === '\r') {
      // ⚠️ 单独的 \r 也是换行（老 Mac 风格行尾）。
      // 不能只“跳过”它 —— 那会把两行粘成一行（曾经的真 bug）。
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += src[i + 1] === '\n' ? 2 : 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i += 1
      continue
    }
    field += ch
    i += 1
  }

  // 收尾：最后一行没有换行时也要收进来
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

/**
 * 把一行解析结果按表头映射成对象。
 * 多余/缺失的列会被忽略，不会抛错 —— 因为用户可能在 Excel 里动过列。
 */
export function rowsToObjects(
  rows: readonly string[][],
): { header: string[]; objects: Record<string, string>[] } {
  const header = (rows[0] ?? []).map((h) => h.trim())
  const objects: Record<string, string>[] = []
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r]
    if (!row) continue
    // 整行空白就跳过（Excel 常在末尾留空行）
    if (row.every((c) => c.trim() === '')) continue
    const obj: Record<string, string> = {}
    for (let c = 0; c < header.length; c += 1) {
      const key = header[c]
      if (!key) continue
      obj[key] = (row[c] ?? '').trim()
    }
    objects.push(obj)
  }
  return { header, objects }
}

/**
 * 解析"用户填的地图"这一列。
 * 容忍/宽容接受多种分隔符（含斜线 `/` 与全角`／`）：半角逗号、中文逗号、顿号、竖线、分号、空格。
 * 这样你在 Excel 里怎么写都能识别。
 */
export function splitMapList(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(/[,，、|;；\/／\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
