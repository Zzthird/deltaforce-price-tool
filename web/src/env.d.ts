/// <reference types="vite/client" />

/**
 * Vite 环境类型声明。
 *
 * 这个文件让 TypeScript 认识 `import.meta.env`、`?raw` 后缀导入等 Vite 专有语法。
 * 它同时也是 `web` 包的一个输入文件 —— 没有它、且 `src/` 下也没有其它文件时，
 * `vue-tsc --noEmit` 会因为「找不到输入文件」而失败。
 *
 * 注意：本项目的 tsconfig 显式设置了 `"types": ["vite/client"]`，
 * 目的是**不把 @types/node 引入浏览器端**（否则 setTimeout 的返回类型
 * 会变成 NodeJS.Timeout 而不是 number，写 Vue 代码时会一直报类型错）。
 */
