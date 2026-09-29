<script setup lang="ts">
/**
 * 物资价值榜 —— 原来就是整个 App，现在搬进 `views/` 成为一页。
 *
 * 页头里的**主题切换搬去了侧边栏底部**（和参考网站一样：
 * 设置类的东西放左下角，主内容区留给数据）。
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
 * 两个请求**并发**发出 —— 它们互不依赖，串行等就是白白多花一倍时间。
 * `/api/items` 可能很慢（后端在数据过期时会阻塞等一轮抓取，约 13 秒），
 * 所以界面上要有 loading 提示。
 */
onMounted(async () => {
  await Promise.all([itemsStore.load(), metaStore.load()])
})
</script>

<template>
  <div class="page">
    <header class="head">
      <h1>物资价值榜</h1>
      <p class="sub">按<b>每格价值</b>排序 —— 一眼看出这趟该摸什么、什么别捡</p>
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

    <!--
      来源标注与外链是**伦理要求**的一部分（见 AGENTS.md §2.3），不是装饰。
      数据来自别人的站点，用的时候要写清楚是谁给的。
    -->
    <footer class="foot dim small">
      数据来源：
      <a href="https://df.qq.com" target="_blank" rel="noreferrer noopener">腾讯官方接口</a>
      （物品主数据：名称 / 官方ID / 占格 / 品质 / 三级分类 / 出产地）·
      <a href="https://moligod.com/trade" target="_blank" rel="noreferrer noopener">moligod</a>
      （现价）。价格仅供参考，实际以游戏内交易行为准。
      <span v-if="metaStore.matchRate !== null">
        本次名称匹配率 {{ (metaStore.matchRate * 100).toFixed(1) }}%。
      </span>
    </footer>
  </div>
</template>

<style scoped>
/*
 * 整页纵向 flex：页头与工具栏固定高度，表格占满剩下的。
 * 不写 `height: calc(100vh - 320px)` 那种死值 —— 上面几块的高度会随内容变
 * （多一条警告就多 40px、窄屏筛选栏会折行），写死就会截断或留白。
 *
 * ⚠️ 高度用 `100%` 而不是 `100vh` —— 现在外面还有一层侧边栏外壳，
 *    用 vh 会超出内容区（外壳自己有 padding）。
 */
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 14px;
  gap: 8px;
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
