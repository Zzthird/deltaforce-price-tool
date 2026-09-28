/**
 * 取数服务入口。
 *
 * ⚠️ 这是 Phase 1 的占位文件，唯一作用是让 TypeScript 有输入文件可检查
 *    （否则 `tsc --noEmit` 会报 TS18003「No inputs were found」）。
 *
 * Phase 3 会把它替换成真正的实现，职责是：
 *   1. 加载并校验配置（config.ts）
 *   2. 初始化主数据源与价格源（sources/ registry、prices/ registry）
 *   3. 起 Fastify HTTP 服务（server.ts）
 *   4. 首次启动时若快照不存在或过旧，触发一次抓取
 *   注意：这里**不会**启动任何定时器 —— 刷新是按需触发的（见 PLAN.md §6.7）。
 */

console.log('[get-data] 骨架就绪（Phase 1）。真正的实现在 Phase 3。')

export {}
