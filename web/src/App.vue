<script setup lang="ts">
/**
 * 外壳 —— 左侧边栏 + 右侧内容区。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么改成这个布局
 * ═══════════════════════════════════════════════════════════════════════
 * 加了首页之后就有**两个页面**了，需要导航 ✓。
 * 参考的四个同类网站（dergame / moligod / shushu / kkrb）**全都是**侧边栏 +
 * 内容区，而不是顶部横向导航 —— 因为：
 *   · 页面名字比较长（「一图流首页」「物资价值榜」），横排会占掉一整行高度
 *   · 侧边栏可以顺手放设置（主题切换就在左下角）
 *   · 以后再加页面时不需要动内容区
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 布局的两个关键点
 * ═══════════════════════════════════════════════════════════════════════
 * ① 外壳是 `height: 100vh` 的横向 flex，内容区 `flex: 1; min-height: 0`
 *    —— 这样"页面高度 = 视口高度"，价值榜里的表格才能算出自己该多高、
 *    出现内部滚动条，而不是把整页撑高 ✗
 * ② 侧边栏固定宽度、不参与伸缩 ✓（`flex: none`）
 *
 * 路由是极简的 hash 路由（见 `router.ts`）：只有两个页面，
 * 没必要引 vue-router。
 */

import { useRouter, NAV } from '@/router'
import { useThemeStore, THEME_HINT, THEME_LABEL, type ThemeMode } from '@/stores/theme'

import HomeView from '@/views/HomeView.vue'
import RankView from '@/views/RankView.vue'

const { view, go } = useRouter()
const theme = useThemeStore()

const THEMES: ThemeMode[] = ['light', 'dark']
</script>

<template>
  <div class="shell">
    <!-- ══════════ 侧边栏 ══════════ -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-title">三角洲行动</span>
        <span class="brand-sub">摸金工具</span>
      </div>

      <nav class="nav">
        <el-tooltip
          v-for="item in NAV"
          :key="item.id"
          :content="item.hint"
          placement="right"
          :show-after="300"
        >
          <button
            class="nav-item"
            :class="{ active: view === item.id }"
            type="button"
            @click="go(item.id)"
          >
            <span class="nav-icon">{{ item.icon }}</span>
            <span class="nav-label">{{ item.label }}</span>
          </button>
        </el-tooltip>
      </nav>

      <!-- 设置放左下角（参考网站都这么做：主内容区留给数据） -->
      <div class="sidebar-foot">
        <div class="themes">
          <el-tooltip
            v-for="t in THEMES"
            :key="t"
            :content="THEME_HINT[t]"
            placement="top"
            :show-after="300"
          >
            <button
              class="theme-btn"
              :class="{ active: theme.mode === t }"
              type="button"
              @click="theme.setMode(t)"
            >
              {{ THEME_LABEL[t] }}
            </button>
          </el-tooltip>
        </div>
      </div>
    </aside>

    <!-- ══════════ 内容区 ══════════ -->
    <main class="content">
      <HomeView v-if="view === 'home'" />
      <RankView v-else />
    </main>
  </div>
</template>

<style scoped>
/*
 * 外壳：横向 flex，整屏高。
 * `overflow: hidden` 让内部页面自己滚（而不是整页滚）——
 * 价值榜的表格依赖这一点才能算出"剩余高度"。
 */
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  flex: none;
  width: 148px;
  display: flex;
  flex-direction: column;
  padding: 12px 8px 10px;
  background: var(--df-surface);
  border-right: 1px solid var(--df-border);
}

.brand {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 8px 12px;
}

.brand-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.brand-sub {
  font-size: 11px;
  color: var(--df-text-faint);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--df-text-dim);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.nav-item:hover {
  color: var(--df-text);
  background: var(--df-surface-2);
}

/* 选中态用"淡底 + 强调色边框"，和筛选标签的选中态保持同一套视觉语言 */
.nav-item.active {
  color: var(--df-text);
  background: var(--df-accent-soft);
  border-color: var(--df-accent);
  font-weight: 600;
}

.nav-icon {
  font-size: 14px;
  line-height: 1;
}

.nav-label {
  white-space: nowrap;
}

/* 把设置推到最下面 */
.sidebar-foot {
  margin-top: auto;
}

.themes {
  display: flex;
  border: 1px solid var(--df-border);
  border-radius: 6px;
  overflow: hidden;
}

.theme-btn {
  flex: 1;
  border: 0;
  padding: 4px 6px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  background: var(--df-surface-2);
  color: var(--df-text-dim);
  transition: background 0.12s, color 0.12s;
}

.theme-btn:hover {
  color: var(--df-text);
}

.theme-btn.active {
  background: var(--df-accent);
  color: #fff;
}

.theme-btn + .theme-btn {
  border-left: 1px solid var(--df-border);
}

/*
 * 内容区：`min-width: 0` 与 `min-height: 0` 都不能省 ——
 * 没有它们，flex 子项会被内容撑开，内部的 `height: 100%` / `overflow`
 * 全部失效（表格会把页面撑出视口，而不是自己滚）。
 */
.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
