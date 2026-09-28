<script setup lang="ts">
/**
 * 根组件 —— Phase 8 的第一版界面。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一版的目的：**在浏览器里第一次看到真数据**
 * ═══════════════════════════════════════════════════════════════════════
 * 所以它刻意只做三件事：
 *   1. 把数据状态说清楚（多少条、多久以前更新的、来自哪个源、价格是什么口径）
 *   2. 按**单格价值**降序显示排行
 *   3. 出错/加载中的样子
 *
 * **还没做的**（Phase 9 才做）：三级联动筛选、阈值滑块（必摸/可摸/跳过）、
 * 状态栏自动轮询、可配置列。现在只有"显示前 N 条"这一个开关。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * `<script setup>` 是什么
 * ═══════════════════════════════════════════════════════════════════════
 * Vue 的"单文件组件"把三样东西放一个文件里：
 *
 *   <script setup>  ← 逻辑（这个文件里所有顶层变量/函数，模板里都能直接用）
 *   <template>      ← 界面（长得像 HTML，但里面能用上面的变量）
 *   <style scoped>  ← 样式（`scoped` = 只作用于本组件，不会污染别处）
 *
 * 为什么能直接在模板里用 `rows`：`<script setup>` 的顶层绑定会**自动暴露**
 * 给模板。不需要（也不能）写 `data()` / `methods` / `return {}` 那一套。
 *
 * Python 类比：像一个类 —— `<script setup>` 是属性与方法、
 * `<template>` 是 `__str__` 的表现形式。区别是 Vue 的"属性"是响应式的：
 * 改了 `rows` 依赖的东西，界面会自己重画。
 */

import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { Item } from '@deltaforce/shared'

import { useItemsStore } from '@/stores/items'
import { useMetaStore } from '@/stores/meta'
import { formatAge, formatExact, formatMoney } from '@/utils/format'

const itemsStore = useItemsStore()
const metaStore = useMetaStore()

/**
 * 显示条数。
 *
 * 为什么不一次性渲染 1564 行：`el-table` 会把每一行都变成真实 DOM 节点，
 * 1500 多行的渲染 + 布局要好几秒，滚动也会卡。
 * 排行榜的用处本来就是"看最值钱的几个"，所以默认 100 条够用；
 * 完整筛选（按地图、按大类、按阈值）是 Phase 9 的事。
 */
const limit = ref(100)

/**
 * `onMounted` = "这个组件挂到页面上之后执行一次"。
 * 相当于 Python 里对象构造完后的初始化动作。
 *
 * 两个请求用 `Promise.all` 并发发出 —— 它们互不依赖，
 * 串行等就是白白多花一倍时间。
 */
onMounted(async () => {
  await Promise.all([itemsStore.load(), metaStore.load()])
})

/** 表格里真正渲染的行 */
const rows = computed(() => itemsStore.sortedByValue.slice(0, limit.value))

/** 品质色值：`"5"` → `"#e8a64e"`。色值来自后端下发的调色板，前端不写死 */
function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

/**
 * 出产地显示：最多列 2 张图，剩下的用"等 N 张"。
 *
 * 因为 1297 条物品的出产地是"全地图"（展开成 6 张），全列出来会把列撑爆。
 * 完整列表放在 hover 提示里（用 `el-tooltip`）。
 */
function mapsBrief(maps: string[] | null): string {
  if (!maps || maps.length === 0) return '—'
  if (maps.length <= 2) return maps.join('、')
  return `${maps.slice(0, 2).join('、')} 等 ${maps.length} 张`
}

async function onRefresh(): Promise<void> {
  const res = await itemsStore.manualRefresh()
  // 409（已在抓）和 429（刚抓过）都不是故障，所以用 warning 而不是 error 提示
  ElMessage({ type: res.ok ? 'success' : 'warning', message: res.message })
}
</script>

<template>
  <div class="page">
    <!-- ───────────── 标题 ───────────── -->
    <header class="head">
      <div>
        <h1>三角洲行动 · 摸金物资价值榜</h1>
        <p class="sub">
          按<b>每格价值</b>排序 —— 一眼看出这趟该摸什么、什么别捡
        </p>
      </div>

      <div class="head-actions">
        <el-radio-group v-model="limit" size="small">
          <el-radio-button :value="100">前 100</el-radio-button>
          <el-radio-button :value="300">前 300</el-radio-button>
          <el-radio-button :value="1000">前 1000</el-radio-button>
        </el-radio-group>

        <el-button type="primary" :loading="itemsStore.loading" @click="onRefresh">
          刷新数据
        </el-button>
      </div>
    </header>

    <!-- ───────────── 警告（标注文件的矛盾等）───────────── -->
    <el-alert
      v-for="(w, i) in metaStore.warnings"
      :key="i"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      :title="w"
    />

    <!-- ───────────── 错误 ───────────── -->
    <el-alert
      v-if="itemsStore.error"
      class="alert"
      type="error"
      :closable="false"
      show-icon
      title="拿不到数据"
      :description="itemsStore.error"
    />

    <!-- ───────────── 状态栏 ───────────── -->
    <!--
      这一栏是本项目的重点之一：**必须让用户知道数据的可信度**。
      价格是第三方现价、5 分钟就变，不显示"这是几分钟前的数据"
      和"价格是什么口径"，用户就会拿一个不知道哪来的数字做决策。
    -->
    <div class="status">
      <span>
        <b>{{ itemsStore.count }}</b> 条物品
        <span class="dim">（可排序 {{ itemsStore.ranked.length }} 条）</span>
      </span>
      <span class="sep">·</span>
      <span>更新于 <b>{{ formatAge(itemsStore.ageSeconds) }}</b></span>
      <span class="sep">·</span>
      <span class="dim">{{ metaStore.priceBasis ?? '价格口径未知' }}</span>

      <el-tag v-if="itemsStore.snapshotStale" type="danger" size="small" effect="dark">
        数据已过期
      </el-tag>
      <el-tag v-else-if="itemsStore.refreshing" type="warning" size="small" effect="dark">
        正在后台获取最新价格…
      </el-tag>
      <el-tag v-else type="success" size="small" effect="plain">数据新鲜</el-tag>

      <span class="spacer" />

      <!--
        被排除在排序外的数量。一定要显示 ——
        否则用户会问"为什么总数 1564，表里只有 1294 条"。
      -->
      <span class="dim small">
        已排除：不可上架 {{ itemsStore.excludedCounts.notListable }} ·
        不可摸 {{ itemsStore.excludedCounts.notLootable }} ·
        无价格 {{ itemsStore.excludedCounts.noPrice }}
      </span>
    </div>

    <!-- ───────────── 加载中 ───────────── -->
    <div v-if="itemsStore.loading && itemsStore.count === 0" class="loading">
      <el-skeleton :rows="8" animated />
      <p class="dim">
        正在取数。首次启动后端需要抓一轮（约 13 秒），稍等一下…
      </p>
    </div>

    <!-- ───────────── 排行榜 ───────────── -->
    <el-table
      v-else
      :data="rows"
      stripe
      height="calc(100vh - 210px)"
      size="small"
      row-key="key"
    >
      <el-table-column type="index" label="#" width="52" align="right" />

      <el-table-column label="物品" min-width="220" show-overflow-tooltip>
        <template #default="{ row }: { row: Item }">
          <span class="name-cell">
            <i class="dot" :style="{ background: gradeColor(row.grade) }" />
            {{ row.name }}
          </span>
          <!-- 限时下架 / 非战利品要标出来：它们是"摸不到"的原因 -->
          <el-tag
            v-if="row.availability !== 'lootable'"
            size="small"
            type="info"
            class="tag-inline"
          >
            {{ metaStore.labels?.availability[row.availability] ?? row.availability }}
          </el-tag>
          <el-tag v-if="!row.listable" size="small" type="danger" class="tag-inline">
            不可上架
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="品质" width="64" align="center">
        <template #default="{ row }: { row: Item }">
          <span :style="{ color: gradeColor(row.grade), fontWeight: 600 }">
            {{ row.gradeCn }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="大类" width="72" prop="categoryCn" />
      <el-table-column label="子类" width="96" prop="subcategoryCn" show-overflow-tooltip />

      <el-table-column label="占格" width="58" align="right" prop="slots" />

      <el-table-column label="每组" width="58" align="right">
        <template #default="{ row }: { row: Item }">
          <!--
            弹药的一个格子放 60 发，交易行报的是每发单价。
            所以"每组发数"必须显示出来，否则用户会奇怪
            为什么一颗子弹的单格价值是单价的 60 倍。
          -->
          <span v-if="row.unitsPerSlot && row.unitsPerSlot !== 1">{{ row.unitsPerSlot }}</span>
          <span v-else class="dim">1</span>
        </template>
      </el-table-column>

      <el-table-column label="单价" width="100" align="right">
        <template #default="{ row }: { row: Item }">
          <el-tooltip v-if="row.price !== null" :content="formatExact(row.price)" placement="left">
            <span class="df-num">{{ formatMoney(row.price) }}</span>
          </el-tooltip>
          <span v-else class="dim">暂无价格</span>
        </template>
      </el-table-column>

      <el-table-column label="单格价值" width="110" align="right" sortable>
        <template #default="{ row }: { row: Item }">
          <el-tooltip
            :content="`${formatExact(row.price)} × ${row.unitsPerSlot ?? 1} ÷ ${row.slots} 格 = ${formatExact(row.pricePerSlot)}`"
            placement="left"
          >
            <b class="df-num value">{{ formatMoney(row.pricePerSlot) }}</b>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="出产地" min-width="180" show-overflow-tooltip>
        <template #default="{ row }: { row: Item }">
          <el-tooltip
            v-if="row.provenanceMaps && row.provenanceMaps.length"
            :content="row.provenanceMaps.join('、')"
            placement="left"
          >
            <span>{{ mapsBrief(row.provenanceMaps) }}</span>
          </el-tooltip>
          <span v-else class="dim">待补</span>
        </template>
      </el-table-column>

      <!-- ───────────── 展开：详情 ───────────── -->
      <el-table-column type="expand">
        <template #default="{ row }: { row: Item }">
          <div class="detail">
            <div v-if="row.description" class="desc">{{ row.description }}</div>

            <el-descriptions :column="4" size="small" border>
              <el-descriptions-item label="官方ID">{{ row.sourceItemId }}</el-descriptions-item>
              <el-descriptions-item label="重量">
                {{ row.weight === null ? '—' : `${row.weight}` }}
              </el-descriptions-item>
              <el-descriptions-item label="官方均价">
                <!--
                  官方均价**仅供参考、不参与判定** ——
                  官方小程序自己都写着"实时价请去游戏内交易行查看"。
                  列出来只是方便你对照。
                -->
                {{ formatExact(row.officialAvgPrice) }}
              </el-descriptions-item>
              <el-descriptions-item label="基准价">
                {{ formatExact(row.basePrice) }}
              </el-descriptions-item>

              <el-descriptions-item label="出产地来源">
                {{
                  row.provenanceSource
                    ? (metaStore.labels?.provenanceSource[row.provenanceSource] ??
                      row.provenanceSource)
                    : '—'
                }}
              </el-descriptions-item>
              <el-descriptions-item label="赛季">
                {{ row.seasonal ? (metaStore.labels?.seasonal[row.seasonal] ?? row.seasonal) : '—' }}
              </el-descriptions-item>
              <el-descriptions-item label="今日涨幅">
                <!-- v1 的历史是自己一轮轮攒的，刚装上还没有昨天数据 -->
                <span class="dim">历史积累中</span>
              </el-descriptions-item>
              <el-descriptions-item label="别名">{{ row.alias ?? '—' }}</el-descriptions-item>
            </el-descriptions>

            <!--
              护甲的耐久度三档。这是实测发现的事实：
              护甲的"裸名"价是**基础参考价、不是行情**，实时价在这三档里。
              排序用的是其中最保守的一档（破损），但三档都摊开给你看 ——
              因为同一件甲全新和破损能差 5 倍，藏起来就是误导。
            -->
            <div v-if="row.priceVariants" class="variants">
              <span class="variants-label">耐久度分档：</span>
              <el-tag
                v-for="(price, condition) in row.priceVariants"
                :key="condition"
                size="small"
                effect="plain"
                class="variant-tag"
              >
                {{ condition }} {{ formatMoney(price) }}
              </el-tag>
              <span class="dim small">
                （排行榜按最保守的「破损」档排序，见 AGENTS.md）
              </span>
            </div>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <!-- ───────────── 页脚 ───────────── -->
    <footer class="foot dim small">
      数据来源：腾讯官方接口（物品主数据）· moligod（现价）。
      价格仅供参考，实际以游戏内交易行为准。
      <span v-if="metaStore.matchRate !== null">
        名称匹配率 {{ (metaStore.matchRate * 100).toFixed(1) }}%。
      </span>
    </footer>
  </div>
</template>

<style scoped>
.page {
  padding: 16px 20px;
  max-width: 1800px;
  margin: 0 auto;
}

.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

h1 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.5px;
}

.sub {
  margin: 4px 0 0;
  color: var(--df-text-dim);
  font-size: 13px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.alert {
  margin-bottom: 10px;
}

.status {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--df-bg-soft);
  border: 1px solid var(--df-border);
  border-radius: 6px;
  font-size: 13px;
}

.status .sep {
  color: var(--df-border);
}

.spacer {
  flex: 1;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}

.loading {
  padding: 24px;
  text-align: center;
}

.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 品质色点 —— 让"金/紫/蓝"在一列文字里也能一眼扫出来 */
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.tag-inline {
  margin-left: 6px;
}

.value {
  color: #e8a64e;
}

.detail {
  padding: 8px 16px 16px 40px;
}

.desc {
  margin-bottom: 10px;
  color: var(--df-text-dim);
  font-size: 13px;
  line-height: 1.6;
}

.variants {
  margin-top: 12px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.variants-label {
  font-size: 13px;
  color: var(--df-text-dim);
}

.variant-tag {
  font-variant-numeric: tabular-nums;
}

.foot {
  margin-top: 12px;
  text-align: center;
  line-height: 1.6;
}
</style>
