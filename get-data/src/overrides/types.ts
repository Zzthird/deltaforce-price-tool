/**
 * 人工覆盖模块的共用类型。
 *
 * 目前只有"问题"这一种 —— 覆盖文件是**手写产物**，一定要假设它会写错。
 * 所有覆盖模块（出产地、可获得性）都用同一个形状报告问题，
 * 这样脚本里可以用同一段代码打印它们。
 */

export interface OverrideProblem {
  /** 出问题的键（物品名或 objectID）；文件级问题时为 null */
  key: string | null
  message: string
}
