<script setup lang="ts">
/**
 * 根组件 —— 把五个部件拼起来。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这个文件现在只做三件事
 * ═══════════════════════════════════════════════════════════════════════
 *   1. 首屏取数（并发发出 items + meta）
 *   2. 页面骨架（标题 + 四块内容 + 页脚）
 *   3. 布局（表格要占满剩余高度，靠 flex 而不是写死像素）
 *
 * 所有筛选、判定、轮询的逻辑都已经搬到各自的组件和 store 里了。
 * 根组件保持这么薄是有意的：**一个文件只该回答一个问题**
 * （"页面长什么样"），而不是顺带管业务逻辑。
 */

import { onMounted } from 'vue'
import { useItemsStore } from '@/stores/items'
import { useMetaStore } from '@/stores/meta'

import StatusBar from '@/components/StatusBar.vue'
import FilterBar from '@/components/FilterBar.vue'
import ThresholdSlider from '@/components/ThresholdSlider.vue'
import ItemsTable from '@/components/ItemsTable.vue'

const itemsStore = useItemsStore()
const metaStore = useMetaStore()

/**
 * 两个请求用 `Promise.all` **并发**发出 —— 它们互不依赖，
 * 串行等就是白白多花一倍时间。
 *
 * `/api/items` 可能很慢（后端在数据过期时会阻塞等一轮抓取，约 13 秒），
 * 所以界面上要有 loading 提示，不能让用户对着空白页等。
 */
onMounted(async () => {
  await Promise.all([itemsStore.load(), metaStore.load()])
})
</script>

<template>
  <div class="page">
    <!-- ── 标题 ── -->
    <header class="head">
      <h1>三角洲行动 · 摸金物资价值榜</h1>
      <p class="sub">
        按<b>每格价值</b>排序 —— 一眼看出这趟该摸什么、什么别捡
      </p>
    </header>

    <!-- ── 状态栏：数据可信度 ── -->
    <StatusBar />

    <!-- ── 筛选 ── -->
    <div class="filters">
      <FilterBar />
      <ThresholdSlider />
    </div>

    <!-- ── 表格 ── -->
    <div class="table-wrap">
      <!-- 首次加载（还没有任何数据）时显示骨架屏，避免白屏 -->
      <div v-if="itemsStore.loading && itemsStore.count === 0" class="loading">
        <el-skeleton :rows="10" animated />
        <p class="dim small">
          正在取数。后端首次启动需要抓一轮（约 13 秒），稍等一下…
        </p>
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
      <br />
      价格仅供参考，实际以游戏内交易行为准。
      <span v-if="metaStore.matchRate !== null">
        本次名称匹配率 {{ (metaStore.matchRate * 100).toFixed(1) }}%。
      </span>
      <span v-if="metaStore.sources.length > 0">
        数据源状态见 <code>/api/sources</code>。
      </span>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 整页用一个纵向 flex：标题和工具栏是固定高度，表格占满剩下的。
 *
 * 为什么不用 `height: calc(100vh - 320px)` 这种写死像素的写法：
 * 上面几块的高度会随内容变（警告多一条就多 40px、筛选栏在窄屏会折行），
 * 写死的话表格要么被截断、要么底下留一大块空白，而且改一处样式就得重算。
 * flex 让浏览器自己算。
 */
.page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 14px 18px;
  gap: 10px;
  max-width: 1900px;
  margin: 0 auto;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex: none;
}

h1 {
  margin: 0;
  font-size: 19px;
  letter-spacing: 0.5px;
  white-space: nowrap;
}

.sub {
  margin: 0;
  color: var(--df-text-dim);
  font-size: 13px;
}

.filters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* `min-height: 0` 是必须的 —— 没有它，flex 子项会被内容撑开而不是收缩，
   表格就永远不出现滚动条，而是把整页撑高。这是 flex 布局里最常见的坑。 */
.table-wrap {
  flex: 1;
  min-height: 0;
}

.loading {
  padding: 24px;
  text-align: center;
}

.foot {
  flex: none;
  text-align: center;
  line-height: 1.7;
}

a {
  color: #6f9fd8;
}

code {
  background: var(--df-bg-soft);
  padding: 1px 5px;
  border-radius: 3px;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
