<script setup lang="ts">
/**
 * 排行榜表格。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 这一版相比 Phase 8 的改动
 * ═══════════════════════════════════════════════════════════════════════
 *   ① 数据来自 `filtersStore.rows`（已筛选 + 已按当前指标排序），
 *      而不是直接读全部物品
 *   ② 多一列**判定徽章**（必摸 / 可摸 / 跳过 / 未知）
 *   ③ 加**分页** —— 筛完之后可能还是几百条，一次全渲染会卡
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么用分页而不是"只显示前 N 条"
 * ═══════════════════════════════════════════════════════════════════════
 * Phase 8 用"显示前 100 条"是因为那时候还没法筛选 —— 反正只能从头看。
 * 现在能筛了，你会想看"筛出来的**全部**"，而筛完可能是 3 条也可能是 400 条。
 * 分页能同时应付这两种，而且翻页时不用重算筛选。
 *
 * ⚠️ `el-table` 会把每一行变成真实 DOM 节点。所以**绝不能**
 *    把 1268 条一次全塞进去 —— 渲染要好几秒，滚动也卡。
 *    分页的意义不只是"好看"，是性能。
 */

import { computed, ref, watch } from 'vue'
import { useFiltersStore, type ItemRow } from '@/stores/filters'
import { useMetaStore } from '@/stores/meta'
import { useRulesStore, VERDICT_LABEL, VERDICT_TAG_TYPE } from '@/stores/rules'
import { formatExact, formatMoney } from '@/utils/format'

const filters = useFiltersStore()
const metaStore = useMetaStore()
const rules = useRulesStore()

/* ══════════════════ 分页 ══════════════════ */

const page = ref(1)
const pageSize = ref(50)

/**
 * 筛选条件变了 → 回到第一页。
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

/** 当前页要渲染的行 */
const pagedRows = computed<ItemRow[]>(() => {
  const start = (page.value - 1) * pageSize.value
  return filters.rows.slice(start, start + pageSize.value)
})

/** 分页控件上显示的总数（是筛选后的，不是全部） */
const total = computed(() => filters.rows.length)

/* ══════════════════ 显示辅助 ══════════════════ */

function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

/** 出产地最多列 2 张图，其余放 hover 提示（否则列会被撑爆） */
function mapsBrief(maps: string[] | null): string {
  if (!maps || maps.length === 0) return '待补'
  if (maps.length <= 2) return maps.join('、')
  return `${maps.slice(0, 2).join('、')} 等 ${maps.length} 张`
}

/**
 * 为什么"不可上架/不可摸"的物品判定显示成"未知"而不是"跳过"：
 * 它们不是"不值得摸"，是**判不了**（价格没有意义 / 压根摸不到）。
 * 把这两种混为一谈会让用户以为"系统建议跳过"，而实际上是"系统不知道"。
 */
function verdictReason(row: ItemRow): string {
  if (!row.item.listable) {
    return '不可上架交易行 —— 价格没有参考意义，无法判定'
  }
  if (row.item.availability !== 'lootable') {
    return `${metaStore.labels?.availability[row.item.availability] ?? row.item.availability} —— 摸不到，无法判定`
  }
  if (row.metric === null) {
    return '没有价格数据 —— 算不出指标，无法判定'
  }
  return `${rules.metricLabel} ${formatExact(row.metric)}`
}
</script>

<template>
  <el-table :data="pagedRows" stripe size="small" row-key="item.key" height="100%">
    <!-- 全局序号：跨页连续，而不是每页都从 1 开始 -->
    <el-table-column label="#" width="62" align="right">
      <template #default="{ $index }: { $index: number }">
        <span class="dim num">{{ (page - 1) * pageSize + $index + 1 }}</span>
      </template>
    </el-table-column>

    <!-- ── 判定 ── -->
    <el-table-column label="判定" width="76" align="center">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip :content="verdictReason(row)" placement="right">
          <el-tag :type="VERDICT_TAG_TYPE[row.verdict]" size="small" effect="dark">
            {{ VERDICT_LABEL[row.verdict] }}
          </el-tag>
        </el-tooltip>
      </template>
    </el-table-column>

    <!-- ── 物品名 ── -->
    <el-table-column label="物品" min-width="230" show-overflow-tooltip>
      <template #default="{ row }: { row: ItemRow }">
        <span class="name">
          <i class="dot" :style="{ background: gradeColor(row.item.grade) }" />
          {{ row.item.name }}
        </span>
        <el-tag
          v-if="row.item.availability !== 'lootable'"
          size="small"
          type="info"
          class="inline"
        >
          {{ metaStore.labels?.availability[row.item.availability] ?? row.item.availability }}
        </el-tag>
        <el-tag v-if="!row.item.listable" size="small" type="danger" class="inline"> 不可上架 </el-tag>
      </template>
    </el-table-column>

    <el-table-column label="品质" width="60" align="center">
      <template #default="{ row }: { row: ItemRow }">
        <span :style="{ color: gradeColor(row.item.grade), fontWeight: 600 }">
          {{ row.item.gradeCn }}
        </span>
      </template>
    </el-table-column>

    <el-table-column label="大类" width="68" prop="item.categoryCn" />
    <el-table-column label="子类" width="96" show-overflow-tooltip>
      <template #default="{ row }: { row: ItemRow }">{{ row.item.subcategoryCn }}</template>
    </el-table-column>

    <el-table-column label="占格" width="56" align="right">
      <template #default="{ row }: { row: ItemRow }">
        <span class="num">{{ row.item.slots }}</span>
      </template>
    </el-table-column>

    <el-table-column label="每组" width="56" align="right">
      <template #default="{ row }: { row: ItemRow }">
        <!--
          弹药的一个格子放 60 发，交易行报的是**每发单价**。
          不显示这一列，用户会奇怪为什么一颗子弹的单格价值是单价的 60 倍。
          普通物品是 1（压暗显示，不抢注意力）。
        -->
        <span v-if="row.item.unitsPerSlot && row.item.unitsPerSlot !== 1" class="num">
          {{ row.item.unitsPerSlot }}
        </span>
        <span v-else class="dim num">1</span>
      </template>
    </el-table-column>

    <el-table-column label="单价" width="96" align="right" sortable prop="item.price">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip v-if="row.item.price !== null" :content="formatExact(row.item.price)" placement="left">
          <span class="num">{{ formatMoney(row.item.price) }}</span>
        </el-tooltip>
        <span v-else class="dim">暂无价格</span>
      </template>
    </el-table-column>

    <!-- ── 单格价值（当前排序依据时高亮）── -->
    <el-table-column label="单格价值" width="104" align="right" sortable prop="metric">
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip
          :content="`${formatExact(row.item.price)} × ${row.item.unitsPerSlot ?? 1} ÷ ${row.item.slots} 格 = ${formatExact(row.item.pricePerSlot)}`"
          placement="left"
        >
          <b class="num value" :class="{ active: rules.mode === 'pricePerSlot' }">
            {{ formatMoney(row.item.pricePerSlot) }}
          </b>
        </el-tooltip>
      </template>
    </el-table-column>

    <el-table-column label="出产地" min-width="170" show-overflow-tooltip>
      <template #default="{ row }: { row: ItemRow }">
        <el-tooltip
          v-if="row.item.provenanceMaps && row.item.provenanceMaps.length"
          :content="row.item.provenanceMaps.join('、')"
          placement="left"
        >
          <span>{{ mapsBrief(row.item.provenanceMaps) }}</span>
        </el-tooltip>
        <span v-else class="dim">待补</span>
      </template>
    </el-table-column>

    <!-- ── 展开详情 ── -->
    <el-table-column type="expand">
      <template #default="{ row }: { row: ItemRow }">
        <div class="detail">
          <div v-if="row.item.description" class="desc">{{ row.item.description }}</div>

          <el-descriptions :column="4" size="small" border>
            <el-descriptions-item label="官方ID">
              {{ row.item.sourceItemId }}
            </el-descriptions-item>
            <el-descriptions-item label="重量">
              {{ row.item.weight ?? '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="官方均价">
              <!-- 官方均价**仅供参考、不参与判定**：官方小程序自己写着"实时价请去游戏内看" -->
              {{ formatExact(row.item.officialAvgPrice) }}
            </el-descriptions-item>
            <el-descriptions-item label="基准价">
              {{ formatExact(row.item.basePrice) }}
            </el-descriptions-item>

            <el-descriptions-item label="出产地来源">
              {{
                row.item.provenanceSource
                  ? (metaStore.labels?.provenanceSource[row.item.provenanceSource] ??
                    row.item.provenanceSource)
                  : '—'
              }}
            </el-descriptions-item>
            <el-descriptions-item label="赛季">
              {{
                row.item.seasonal
                  ? (metaStore.labels?.seasonal[row.item.seasonal] ?? row.item.seasonal)
                  : '—'
              }}
            </el-descriptions-item>
            <el-descriptions-item label="今日涨幅">
              <!-- v1 的历史是自己一轮轮攒的，刚装上还没有昨天数据 -->
              <span class="dim">历史积累中</span>
            </el-descriptions-item>
            <el-descriptions-item label="别名">{{ row.item.alias ?? '—' }}</el-descriptions-item>
          </el-descriptions>

          <!--
            护甲的耐久度三档。
            实测发现：护甲的"裸名"价是**基础参考价、不是行情**，
            实时价在这三档里（详见 docs/source-recon.md §八）。
            排序用的是最保守的「破损」档，但三档都摊开给你看 ——
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
.name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}

.inline {
  margin-left: 6px;
}

.num {
  font-variant-numeric: tabular-nums;
}

.value {
  color: var(--df-text-dim);
}

/* 当前排序依据那一列的金色高亮 —— 一眼看出"现在按什么排的" */
.value.active {
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
