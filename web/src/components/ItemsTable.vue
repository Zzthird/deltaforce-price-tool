<script setup lang="ts">
/**
 * 排行榜表格。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 本轮的四个改动，每个都对应一个具体问题
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ① **排序改用 `sortable="custom"`**（原来用 `sortable`）
 *
 *    Element Plus 的普通 `sortable` 是**客户端排序** —— 它只排 `:data` 里的行。
 *    而分页之后 `:data` 只有当前页的 50 行 ✗。于是你点「单价」排序：
 *    50 行重排了，其余 1200 条纹丝不动，**而界面看起来"排好了"** ✗。
 *
 *    `sortable="custom"` 的意思是"只发事件、你自己排" ✓ ——
 *    排序交给 `filters` store 对**全量筛选结果**做，分页只负责切片。
 *
 * ② **加物品图标**（契约里一直有 `iconUrl`，从没用过）
 *
 *    认图比读文字快一个数量级。图标带**品质色描边**，
 *    于是一个元素同时表达了"这是什么"和"它多稀有" ——
 *    原来那个独立的小圆点就多余了。
 *
 * ③ **今日涨幅列**
 *
 *    后端一直在算 `todayChangePct`（用 moligod 的昨日均价），
 *    但界面写死显示"历史积累中" ✗。现成的数据白白扔了。
 *
 * ④ **出产地改三态 + 去掉子类列**
 *
 *    实测 1564 条里有 1297 条是"全地图"，铺开就是 6 个同样的图名 ✗ ——
 *    那一列 14 行里 13 行一模一样，等于没信息。现在通用物资显示「通用」，
 *    只有**特产**才显示地图名，于是这一列终于能一眼扫出"这张图特有的东西"。
 *
 *    子类列去掉是因为弹药名本身就以口径开头（"7.62x51mm M62"），
 *    完全重复。信息不丢 —— 展开详情里还有，筛选器也照样能用。
 */

import { computed, nextTick, ref, watch } from 'vue'
import type { TableInstance } from 'element-plus'
import { useFiltersStore, type ItemRow } from '@/stores/filters'
import { useMetaStore } from '@/stores/meta'
import { useRulesStore, VERDICT_LABEL, VERDICT_TAG_TYPE } from '@/stores/rules'
import { formatExact, formatMoney } from '@/utils/format'
import { describeChange, describeProvenance } from '@/utils/item'

const filters = useFiltersStore()
const metaStore = useMetaStore()
const rules = useRulesStore()

/* ══════════════════ 分页 ══════════════════ */

const page = ref(1)
const pageSize = ref(50)

/**
 * 筛选/排序变了 → 回到第一页。
 *
 * ⚠️ 不做这一步会有个很别扭的 bug：你在第 8 页，然后把筛选条件一改，
 *    结果只剩 3 页 → 表格变成空的，而数据其实有 —— 只是你在第 8 页。
 *    用户会以为"筛出来没结果"。
 */
watch(
  () => [
    filters.search,
    filters.category,
    filters.subcategory,
    filters.thirdClass,
    filters.grade,
    filters.map,
    filters.mapOnly,
    filters.verdictFilter,
    filters.includeExcluded,
    rules.mustThreshold,
    rules.skipThreshold,
    rules.mode,
  ],
  () => {
    page.value = 1
  },
)

/** 当前页要渲染的行（排序已在 store 里对全量做完，这里只是切片）*/
const pagedRows = computed<ItemRow[]>(() => {
  const start = (page.value - 1) * pageSize.value
  return filters.rows.slice(start, start + pageSize.value)
})

const total = computed(() => filters.rows.length)

/* ══════════════════ 表头排序 ══════════════════ */

const tableRef = ref<TableInstance>()

/**
 * 上一次同步给表格的排序标识（`"键:方向"`）。
 *
 * ⚠️ 这个变量是**防死循环**用的，不能省：
 *
 *   用户点表头 → `sort-change` → 写 store → watch 到 store 变了 → 调 `table.sort()`
 *   → 表格再发一次 `sort-change` → 又写一次 store → …
 *
 * 因为第二次写进去的值和第一次相同（幂等），`watch` 不会重复触发 ——
 * 但 `table.sort()` 会被白调一次，而且如果哪天 `applySortChange` 变成
 * 非幂等的（比如带计数），就会真的转起来。所以显式记住"已经同步过了"。
 */
const syncedSort = ref('')

/** store 里的排序变了 → 同步表头箭头（比如切判定依据时自动换排序键）*/
watch(
  [() => filters.sortKey, () => filters.sortDir],
  async ([key, dir]) => {
    const signature = `${key}:${dir}`
    if (syncedSort.value === signature) return

    await nextTick()
    const order = dir === 'asc' ? 'ascending' : 'descending'
    // `sortable="custom"` 下 `table.sort()` 只更新箭头 + 发事件，不会真的排数据
    tableRef.value?.sort(key, order)
    syncedSort.value = signature
  },
  { immediate: true },
)

function onSortChange(payload: {
  prop: string | null
  order: 'ascending' | 'descending' | null
}): void {
  // 先记下"这次是用户点出来的"，避免下面的 watch 再同步一遍
  const key = payload.order === null || payload.prop === null ? 'pricePerSlot' : payload.prop
  const dir = payload.order === 'ascending' ? 'asc' : 'desc'
  syncedSort.value = `${key}:${dir}`

  filters.applySortChange(payload)
}

/** 表头箭头的初始状态 —— 必须由 store 驱动，否则箭头与真实排序不一致 */
const defaultSort = computed(() => ({
  prop: filters.sortKey,
  order: (filters.sortDir === 'asc' ? 'ascending' : 'descending') as 'ascending' | 'descending',
}))

/* ══════════════════ 显示辅助 ══════════════════ */

function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

/**
 * 图标加载失败时把它藏掉，露出底下的**品质色底块**。
 *
 * 为什么不用 `v-if` + 状态位：那需要给每一行存一个"加载失败"标记，
 * 而表格行是每次翻页重建的。直接改 DOM 更省事，而且效果一样 ——
 * 外层 `span` 本来就有品质色背景，图片藏掉之后它就是个色块。
 */
function onIconError(e: Event): void {
  const img = e.target as HTMLImageElement | null
  if (img) img.style.visibility = 'hidden'
}

function mapsTooltip(row: ItemRow): string {
  return describeProvenance(row.item).full
}

function verdictReason(row: ItemRow): string {
  if (!row.item.listable) return '不可上架交易行 —— 价格没有参考意义，无法判定'
  if (row.item.availability !== 'lootable') {
    const label = metaStore.labels?.availability[row.item.availability] ?? row.item.availability
    return `${label} —— 摸不到，无法判定`
  }
  if (row.metric === null) return '没有价格数据 —— 算不出指标，无法判定'
  return `${rules.metricLabel} ${formatExact(row.metric)}`
}

/** 涨幅颜色：**中国习惯红涨绿跌**（与 A 股一致），不是国际的绿涨红跌 */
const CHANGE_CLASS: Readonly<Record<string, string>> = {
  up: 'change-up',
  down: 'change-down',
  flat: 'dim',
  none: 'dim',
}
</script>

<template>
  <!--
    行高：`size="small"` 之后单元格上下各有 ~8px 内边距，一行约 34px，
    950px 高只能看到 14 行 ✗。而这个工具的核心动作就是"扫一遍看该摸什么"，
    看到的行越多越好。压到 4px 之后一行约 26px，能看到三十多行。
  -->
  <el-table
    ref="tableRef"
    class="tight-table"
    :data="pagedRows"
    stripe
    size="small"
    row-key="item.key"
    height="100%"
    :default-sort="defaultSort"
    @sort-change="onSortChange"
  >
    <!-- 全局序号：跨页连续，而不是每页都从 1 开始 -->
    <el-table-column label="#" width="54" align="right">
      <template #default="{ $index }: { $index: number }">
        <span class="dim num">{{ (page - 1) * pageSize + $index + 1 }}</span>
      </template>
    </el-table-column>

    <!-- ── 判定 ── -->
    <el-table-column label="判定" width="70" align="center">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip :content="verdictReason(row)" placement="right">
          <el-tag :type="VERDICT_TAG_TYPE[row.verdict]" size="small" effect="dark">
            {{ VERDICT_LABEL[row.verdict] }}
          </el-tag>
        </el-tooltip>
      </template>
    </el-table-column>

    <!-- ── 物品（图标 + 名字 + 状态徽章）── -->
    <el-table-column label="物品" min-width="240" sortable="custom" prop="name">
      <template #default="{ row }: { row: ItemRow }">
        <!--
          图标带品质色描边 —— 一个元素同时表达"是什么"和"多稀有"。

          ⚠️ 同时绑 `color`，因为 CSS 里色块用的是 `background: currentColor` ✗
             —— 不绑 `color` 的话 `currentColor` 会取到继承来的文字色（灰），
             图片加载失败时露出来的就是个灰块，而不是品质色块。

          加载失败时图片被 `onIconError` 藏掉，露出色块（不出现破图）。
        -->
        <span
          class="icon"
          :style="{ borderColor: gradeColor(row.item.grade), color: gradeColor(row.item.grade) }"
          :title="row.item.gradeCn"
        >
          <img
            v-if="row.item.iconUrl"
            :src="row.item.iconUrl"
            alt=""
            loading="lazy"
            referrerpolicy="no-referrer"
            @error="onIconError"
          />
        </span>

        <span class="name-text">{{ row.item.name }}</span>

        <el-tag
          v-if="row.item.availability !== 'lootable'"
          size="small"
          type="info"
          class="inline"
        >
          {{ metaStore.labels?.availability[row.item.availability] ?? row.item.availability }}
        </el-tag>
        <el-tag v-if="!row.item.listable" size="small" type="danger" class="inline">
          不可上架
        </el-tag>
        <el-tag
          v-if="row.item.seasonal"
          size="small"
          type="warning"
          effect="plain"
          class="inline"
        >
          {{ metaStore.labels?.seasonal[row.item.seasonal] ?? row.item.seasonal }}
        </el-tag>
      </template>
    </el-table-column>

    <el-table-column label="品质" width="54" align="center">
      <template #default="{ row }: { row: ItemRow }">
        <span :style="{ color: gradeColor(row.item.grade), fontWeight: 600 }">
          {{ row.item.gradeCn }}
        </span>
      </template>
    </el-table-column>

    <el-table-column label="大类" width="62" prop="item.categoryCn" />

    <el-table-column label="占格" width="54" align="right" sortable="custom" prop="slots">
      <template #default="{ row }: { row: ItemRow }">
        <span class="num">{{ row.item.slots }}</span>
      </template>
    </el-table-column>

    <el-table-column label="每组" width="54" align="right">
      <template #default="{ row }: { row: ItemRow }">
        <!--
          弹药一个格子放 60 发，而交易行报的是**每发单价**。
          不显示这一列，用户会奇怪为什么一颗子弹的单格价值是单价的 60 倍。
          普通物品是 1（压暗，不抢注意力）。
        -->
        <span v-if="row.item.unitsPerSlot && row.item.unitsPerSlot !== 1" class="num">
          {{ row.item.unitsPerSlot }}
        </span>
        <span v-else class="dim num">1</span>
      </template>
    </el-table-column>

    <el-table-column label="单价" width="92" align="right" sortable="custom" prop="price">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip
          v-if="row.item.price !== null"
          :content="formatExact(row.item.price)"
          placement="left"
        >
          <span class="num" :class="{ active: filters.sortKey === 'price' }">
            {{ formatMoney(row.item.price) }}
          </span>
        </el-tooltip>
        <span v-else class="dim">—</span>
      </template>
    </el-table-column>

    <el-table-column
      label="单格价值"
      width="100"
      align="right"
      sortable="custom"
      prop="pricePerSlot"
    >
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip
          :content="`${formatExact(row.item.price)} × ${row.item.unitsPerSlot ?? 1} ÷ ${row.item.slots} 格 = ${formatExact(row.item.pricePerSlot)}`"
          placement="left"
        >
          <b class="num value" :class="{ active: filters.sortKey === 'pricePerSlot' }">
            {{ formatMoney(row.item.pricePerSlot) }}
          </b>
        </el-tooltip>
      </template>
    </el-table-column>

    <!-- ── 今日涨幅（后端一直在算，之前写死"历史积累中"）── -->
    <el-table-column
      label="今日涨幅"
      width="86"
      align="right"
      sortable="custom"
      prop="todayChangePct"
    >
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip
          :content="`现价 ${formatExact(row.item.price)}｜昨日均价 ${formatExact(row.item.yesterdayAvg)}`"
          placement="left"
        >
          <span class="num" :class="CHANGE_CLASS[describeChange(row.item.todayChangePct).tone]">
            {{ describeChange(row.item.todayChangePct).text }}
          </span>
        </el-tooltip>
      </template>
    </el-table-column>

    <!-- ── 出产地（三态：通用 / 地图名 / 待补）── -->
    <el-table-column label="出产地" min-width="150">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip :content="mapsTooltip(row)" placement="left">
          <span
            :class="{
              dim: describeProvenance(row.item).kind !== 'maps',
              specialty: describeProvenance(row.item).kind === 'maps',
            }"
          >
            {{ describeProvenance(row.item).text }}
          </span>
        </el-tooltip>
      </template>
    </el-table-column>

    <!-- ── 展开详情 ── -->
    <el-table-column type="expand" width="36">
      <template #default="{ row }: { row: ItemRow }">
        <div class="detail">
          <div v-if="row.item.description" class="desc">{{ row.item.description }}</div>

          <el-descriptions :column="4" size="small" border>
            <el-descriptions-item label="官方ID">{{ row.item.sourceItemId }}</el-descriptions-item>
            <el-descriptions-item label="重量">{{ row.item.weight ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="官方均价">
              <!-- 官方均价**仅供参考、不参与判定**：官方小程序自己写着"实时价请去游戏内看" -->
              {{ formatExact(row.item.officialAvgPrice) }}
            </el-descriptions-item>
            <el-descriptions-item label="基准价">
              {{ formatExact(row.item.basePrice) }}
            </el-descriptions-item>

            <el-descriptions-item label="子类">
              <!-- 子类列从表格里去掉了（弹药名就含口径，重复），但信息留在这里 -->
              {{ row.item.subcategoryCn ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="细类">{{ row.item.thirdClassCn ?? '—' }}</el-descriptions-item>
            <el-descriptions-item label="出产地来源">
              {{
                row.item.provenanceSource
                  ? (metaStore.labels?.provenanceSource[row.item.provenanceSource] ??
                    row.item.provenanceSource)
                  : '—'
              }}
            </el-descriptions-item>
            <el-descriptions-item label="别名">{{ row.item.alias ?? '—' }}</el-descriptions-item>

            <el-descriptions-item label="昨日均价">
              {{ formatExact(row.item.yesterdayAvg) }}
            </el-descriptions-item>
            <el-descriptions-item label="昨日区间">
              {{ formatMoney(row.item.yesterdayLow) }} ~ {{ formatMoney(row.item.yesterdayHigh) }}
            </el-descriptions-item>
            <el-descriptions-item label="7日区间">
              {{ formatMoney(row.item.rangeLow) }} ~ {{ formatMoney(row.item.rangeHigh) }}
            </el-descriptions-item>
            <el-descriptions-item label="数据时间">
              {{ row.item.lastUpdate ?? '—' }}
            </el-descriptions-item>
          </el-descriptions>

          <!--
            护甲的耐久度三档。
            实测发现：护甲的"裸名"价是**基础参考价、不是行情**，
            实时价在这三档里（详见 docs/source-recon.md §八）。
            排序用最保守的「破损」档，但三档都摊开给你看 ——
            同一件甲全新和破损能差 5.7 倍，藏起来就是误导。
          -->
          <div v-if="row.item.priceVariants" class="variants">
            <span class="dim small">耐久度分档：</span>
            <el-tag
              v-for="(price, condition) in row.item.priceVariants"
              :key="condition"
              size="small"
              effect="plain"
              class="variant-tag"
            >
              {{ condition }} {{ formatMoney(price) }}
            </el-tag>
            <span class="dim small">（排行榜按最保守的「破损」档排序）</span>
          </div>
        </div>
      </template>
    </el-table-column>
  </el-table>

  <!-- ── 分页 ── -->
  <div class="pager">
    <el-pagination
      v-model:current-page="page"
      v-model:page-size="pageSize"
      :page-sizes="[30, 50, 100, 200]"
      :total="total"
      size="small"
      layout="total, sizes, prev, pager, next, jumper"
      background
    />
  </div>
</template>

<style scoped>
/*
 * 行高收紧。用 `:deep()` 是因为目标元素在 el-table 内部，
 * 而 `<style scoped>` 默认只作用于本组件的元素。
 */
.tight-table :deep(td.el-table__cell),
.tight-table :deep(th.el-table__cell) {
  padding: 3px 0;
}

/* 行内文字紧凑一点，避免行高被 line-height 撑开 */
.tight-table :deep(.cell) {
  line-height: 1.35;
}

/* ── 图标 ── */
.icon {
  display: inline-block;
  /* 18px 而不是 22px：行高是内容撑的，图标每大 4px，可视行数就少两行。
     18px 依然认得出来是什么东西。 */
  width: 18px;
  height: 18px;
  flex: none;
  vertical-align: middle;
  margin-right: 6px;
  border-radius: 3px;
  border: 1px solid var(--df-border);
  /* 品质色底块 —— 图片加载失败时露出来的就是它。
     用 currentColor 是因为外层已把 color 绑成了品质色。 */
  background: currentColor;
  overflow: hidden;
}

.icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

.name-text {
  vertical-align: middle;
}

.inline {
  margin-left: 6px;
  vertical-align: middle;
}

.num {
  font-variant-numeric: tabular-nums;
}

.value {
  color: var(--df-text-dim);
}

/* 当前排序依据那一列高亮 —— 一眼看出"现在按什么排的" */
.value.active,
.num.active {
  color: #e8a64e;
}

/* 涨跌：中国习惯红涨绿跌 */
.change-up {
  color: #e05a5a;
}

.change-down {
  color: #3fae6a;
}

/* 特产用正常色，一眼能从一片「通用」里跳出来 */
.specialty {
  color: var(--df-text);
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

.variant-tag {
  font-variant-numeric: tabular-nums;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding: 8px 0 0;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
