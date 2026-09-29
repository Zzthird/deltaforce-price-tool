/**
 * 主题切换。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么有两套主题开关要同时切
 * ═══════════════════════════════════════════════════════════════════════
 *   `<html class="dark">`           → Element Plus 的 `--el-*` 变量
 *   `<html data-df-theme="...">`    → 我自己的 `--df-*` 变量
 *
 * 只切一个就会花：表格是深色而分页/下拉/输入框还是白的。这正是
 * 上一轮那个 bug 的根因（实测 40% 的单元格是 #fafafa）。
 *
 * ⚠️ `applyTheme()` 必须在 **`app.mount()` 之前**跑一次 ——
 *    否则深色用户会先看到一帧白屏再变深色。所以它和 `loadTheme()`
 *    都是**不依赖 Pinia 的普通函数**，`main.ts` 可以直接调。
 */

import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'light' | 'dark'

/** 主题的中文名（UI 里显示）*/
export const THEME_LABEL: Readonly<Record<ThemeMode, string>> = {
  light: '日间',
  dark: '深色',
}

/** 主题的说明（悬浮提示用）—— 说清"什么时候用哪个" */
export const THEME_HINT: Readonly<Record<ThemeMode, string>> = {
  light: '日间：白底，白天光线亮时看',
  dark: '深色（默认）：深灰蓝底 + 卡片分层',
}

const STORAGE_KEY = 'deltaforce.theme.v1'

const MODES: readonly ThemeMode[] = ['light', 'dark']

/**
 * 读主题设置。
 *
 * ⚠️ localStorage 的内容不可信（旧版本写的、被手改过、别的网站同源留下的），
 *    所以校验取值合法性，不合法就回默认。默认是 `dark` ——
 *    它既能修掉白条问题，又不像纯黑那样在大屏上糊成一片。
 */
export function loadTheme(): ThemeMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return MODES.includes(raw as ThemeMode) ? (raw as ThemeMode) : 'dark'
  } catch {
    // 隐私模式下 localStorage 会直接抛异常 —— 不该让页面崩掉
    return 'dark'
  }
}

/**
 * 把主题写到 DOM 上。
 *
 * 三个东西一起设，少一个就会有不一致的地方：
 *   ① `data-df-theme`  —— 我的 `--df-*` 变量
 *   ② `dark` 类名      —— Element Plus 的 `--el-*` 变量（它挂在 `html.dark` 上）
 *   ③ `color-scheme`   —— 浏览器**原生**控件：滚动条、输入框光标、下拉箭头
 *                          不设的话日间主题下会得到一条黑滚动条
 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.setAttribute('data-df-theme', mode)
  el.classList.toggle('dark', mode !== 'light')
  el.style.colorScheme = mode === 'light' ? 'light' : 'dark'
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(loadTheme())

  function setMode(next: ThemeMode): void {
    mode.value = next
  }

  /** 三套之间循环（给快捷键/单按钮用）*/
  function cycle(): void {
    const i = MODES.indexOf(mode.value)
    mode.value = MODES[(i + 1) % MODES.length] as ThemeMode
  }

  watch(mode, (next) => {
    applyTheme(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 存不下只是刷新后丢设置，不该影响使用
    }
  })

  return { mode, setMode, cycle }
})
