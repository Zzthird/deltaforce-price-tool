<script setup lang="ts">
/**
 * 根组件 —— 拼装 + 布局。
 *
 * 这一轮的两处变化：
 *   ① 顶部加了**主题切换**（日间 / 深色 / 深夜）
 *   ② 各块套上 `.df-card` —— 把"页面底色"与"内容面"分开
 *
 * 为什么第 ② 点重要：原来整页从顶到底一个同色，眼睛分不清
 * "哪些是界面控件、哪些是数据"。参考的四个同类网站都用"页面底 + 内容卡片"
 * 两层结构，这也是消除"全黑一坨"观感最直接的一步。
 */

import { onMounted } from 'vue'
import { useItemsStore } from '@/stores/items'
import { useMetaStore } from '@/stores/meta'
import { useThemeStore, THEME_HINT, THEME_LABEL, type ThemeMode } from '@/stores/theme'

import StatusBar from '@/components/StatusBar.vue'
import FilterBar from '@/components/FilterBar.vue'
import ThresholdSlider from '@/components/ThresholdSlider.vue'
import ItemsTable from '@/components/ItemsTable.vue'

const itemsStore = useItemsStore()
const metaStore = useMetaStore()
const theme = useThemeStore()

/** 两个主题按钮（日间 → 深色）*/
const THEMES: ThemeMode[] = ['light', 'dark']

/**
 * 两个请求用 `Promise.all` **并发**发出 —— 它们互不依赖，
 * 串行等就是白白多花一倍时间。
 *
 * `/api/items` 可能很慢（后端在数据过期时会阻塞等一轮抓取，约 13 秒），
 * 所以界面上要有 loading 提示。
 */
onMounted(async () => {
  await Promise.all([itemsStore.load(), metaStore.load()])
})
</script>

<template>
  <div class="page">
    <!-- ── 标题 + 主题切换 ── -->
    <header class="head">
      <h1>三角洲行动 · 摸金物资价值榜</h1>
      <p class="sub">按<b>每格价值</b>排序 —— 一眼看出这趟该摸什么、什么别捡</p>

      <span class="spacer" />

      <!--
        主题切换用「分段按钮」而不是下拉框：只有三个选项，
        而且切换后**立刻能看到效果** —— 下拉框要先展开再选，多一步。
      -->
      <div class="themes">
        <el-tooltip
          v-for="t in THEMES"
          :key="t"
          :content="THEME_HINT[t]"
          placement="bottom"
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
    </header>

    <StatusBar />

    <div class="filters">
      <FilterBar />
      <ThresholdSlider class="df-card" />
    </div>

    <div class="table-wrap df-card">
      <div v-if="itemsStore.loading && itemsStore.count === 0" class="loading">
        <el-skeleton :rows="10" animated />
        <p class="dim small">正在取数。后端首次启动需要抓一轮（约 13 秒），稍等一下…</p>
      </div>
      <ItemsTable v-else />
    </div>

    <!-- ── 页脚：数据来源标注 ── -->
    <!--
      来源标注与外链是**伦理要求**的一部分（见 AGENTS.md §2.3），
      不是装饰。数据来自别人的站点，用的时候要写清楚是谁给的。
    -->
    <footer class="foot dim small">
      数据来源：
      <a href="https://df.qq.com" target="_blank" rel="noreferrer noopener">腾讯官方接口</a>
      （物品主数据：名称 / 官方ID / 占格 / 品质 / 三级分类 / 出产地）·
      <a href="https://moligod.com/trade" target="_blank" rel="noreferrer noopener">moligod</a>
      （现价）。
      价格仅供参考，实际以游戏内交易行为准。
      <span v-if="metaStore.matchRate !== null">
        本次名称匹配率 {{ (metaStore.matchRate * 100).toFixed(1) }}%。
      </span>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 整页纵向 flex：标题和工具栏固定高度，表格占满剩下的。
 * 不写 `height: calc(100vh - 320px)` 那种死值 —— 上面几块的高度会随内容变
 * （多一条警告就多 40px、窄屏筛选栏会折行），写死就会截断或留白。
 */
.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 10px 14px;
  gap: 8px;
  max-width: 1900px;
  margin: 0 auto;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex: none;
  padding: 0 2px;
}

h1 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.sub {
  margin: 0;
  color: var(--df-text-dim);
  font-size: 12px;
}

.spacer {
  flex: 1;
}

.themes {
  display: flex;
  gap: 0;
  border: 1px solid var(--df-border);
  border-radius: 6px;
  overflow: hidden;
  align-self: center;
}

.theme-btn {
  border: 0;
  padding: 4px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  background: var(--df-surface);
  color: var(--df-text-dim);
  transition: background 0.12s, color 0.12s;
}

.theme-btn:hover {
  color: var(--df-text);
  background: var(--df-surface-2);
}

.theme-btn.active {
  background: var(--df-accent);
  color: #fff;
}

/* 相邻按钮之间一条细线（选中态不画，避免出现多余的竖线）*/
.theme-btn + .theme-btn {
  border-left: 1px solid var(--df-border);
}

.filters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* `min-height: 0` 不能省 —— 没有它，flex 子项会被内容撑开而不是收缩，
   表格就永远不出现滚动条，而是把整页撑高。flex 布局里最常见的坑。 */
.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 6px 8px 0;
}

.loading {
  padding: 24px;
  text-align: center;
}

.foot {
  flex: none;
  text-align: center;
  line-height: 1.6;
}

a {
  color: var(--df-accent);
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
