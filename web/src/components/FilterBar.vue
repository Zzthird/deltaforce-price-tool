<script setup lang="ts">
/**
 * 筛选栏 —— 三级联动 + 品质 + 地图 + 搜索。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三级联动是什么，为什么它不是"三个独立下拉框"
 * ═══════════════════════════════════════════════════════════════════════
 * 官方数据实测有三层分类（见 docs/source-recon.md）：
 *
 *   大类「道具」→ 子类「收集品」→ 细类（部分物品才有）
 *
 * 三层如果各自独立，会出两种难看的情况：
 *
 *   ① **结果 0 条而无解释**：筛了「道具 / 收集品」，再把大类改成「弹药」——
 *      子类还留着「收集品」，弹药的收集品当然没有 → 0 条。
 *      而下拉框里还显示着一个不属于弹药的可选项，你得自己一格一格清。
 *      → 修法：改大类时**自动清空子类与细类**（在 stores/filters.ts 的 setCategory 里）
 *
 *   ② **选项数量骗人**：已经筛了「长弓溪谷 + 弹药」，下拉里却显示「道具 (711)」，
 *      点进去 0 条 —— 因为那 711 是在**没有地图筛选时**数的。
 *      → 修法：交叉计数（faceted counts）。数某个维度的选项时，
 *        把这个维度自己的筛选去掉，其它筛选全部保留。
 *        实现就是 stores/filters.ts 里的 `pass(item, skip)`。
 *
 * 所以这里每个下拉框的 `count` 都是**"选了这个之后还剩多少"**，
 * 不是"这个选项一共有多少"。这两个数在筛选叠加时差别很大。
 */

import { computed } from 'vue'
import { useFiltersStore } from '@/stores/filters'
import { useMetaStore } from '@/stores/meta'

const filters = useFiltersStore()
const metaStore = useMetaStore()

/** 给品质选项涂上后端下发的色值 —— 前端不写死颜色 */
function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

/**
 * 子类/细类在下拉里的提示文案。
 *
 * 为什么要在没有父级时禁用而不是列出全部：列出全部会让人以为
 * "子类和父级无关"，而实际上是有关的。给一句"先选大类"更诚实。
 */
const needParentHint = '先选上一级'

/** 细类是否可用：需要先选到大类（细类挂在子类下，但子类可能为空） */
const thirdClassEnabled = computed(() => filters.category !== null)

/** 当前筛选下有没有结果 —— 没有时给一句引导，而不是一张空表 */
const isEmpty = computed(() => filters.rows.length === 0)
</script>

<template>
  <div class="bar">
    <!-- ── 搜索 ── -->
    <el-input
      v-model="filters.search"
      class="search"
      size="small"
      clearable
      placeholder="搜物品名 / 别名 / 官方ID"
    />

    <!-- ── 三级联动 ── -->
    <el-select
      :model-value="filters.category"
      class="sel"
      size="small"
      clearable
      placeholder="全部大类"
      @update:model-value="filters.setCategory($event)"
    >
      <!-- 大类全部列出（含 0 条的）—— "弹药现在是 0 条"本身是信息 -->
      <el-option
        v-for="o in filters.categoryOptions"
        :key="o.value"
        :value="o.value"
        :label="o.label"
      >
        <span class="opt">
          <span>{{ o.label }}</span>
          <span class="count" :class="{ zero: o.count === 0 }">{{ o.count }}</span>
        </span>
      </el-option>
    </el-select>

    <el-select
      :model-value="filters.subcategory"
      class="sel"
      size="small"
      clearable
      :disabled="filters.category === null"
      :placeholder="filters.category === null ? needParentHint : '全部子类'"
      @update:model-value="filters.setSubcategory($event)"
    >
      <el-option
        v-for="o in filters.subcategoryOptions"
        :key="o.value"
        :value="o.value"
        :label="o.label"
      >
        <span class="opt">
          <span>{{ o.label }}</span>
          <span class="count">{{ o.count }}</span>
        </span>
      </el-option>
    </el-select>

    <el-select
      :model-value="filters.thirdClass"
      class="sel"
      size="small"
      clearable
      :disabled="!thirdClassEnabled"
      :placeholder="thirdClassEnabled ? '全部细类' : needParentHint"
      @update:model-value="filters.thirdClass = $event"
    >
      <!--
        ⚠️ 细类选项可能为空 —— 官方数据里只有少数物品带 thirdClass。
        空下拉不是 bug，是数据实况，所以提示语要说清楚。
      -->
      <el-option
        v-for="o in filters.thirdClassOptions"
        :key="o.value"
        :value="o.value"
        :label="o.label"
      >
        <span class="opt">
          <span>{{ o.label }}</span>
          <span class="count">{{ o.count }}</span>
        </span>
      </el-option>
    </el-select>

    <!-- ── 品质 ── -->
    <el-select
      v-model="filters.grade"
      class="sel narrow"
      size="small"
      clearable
      placeholder="全部品质"
    >
      <el-option v-for="o in filters.gradeOptions" :key="o.value" :value="Number(o.value)">
        <span class="opt">
          <span class="grade-name">
            <i class="dot" :style="{ background: gradeColor(Number(o.value)) }" />
            {{ o.label }}
          </span>
          <span class="count">{{ o.count }}</span>
        </span>
      </el-option>
    </el-select>

    <!-- ── 地图 ── -->
    <el-select
      v-model="filters.map"
      class="sel"
      size="small"
      clearable
      filterable
      placeholder="全部地图"
    >
      <el-option v-for="o in filters.mapOptions" :key="o.value" :value="o.value" :label="o.label">
        <span class="opt">
          <span>{{ o.label }}</span>
          <span class="count">{{ o.count }}</span>
        </span>
      </el-option>
    </el-select>

    <span class="spacer" />

    <!-- ── 是否显示被排除的物品 ── -->
    <el-tooltip
      content="不可上架（挂不上交易行）与不可摸（限时下架/非战利品）的物品默认不显示，因为它们不参与排序。打开可以查它们的情况 —— 比如“这条能摸到但卖不掉”。"
      placement="bottom"
    >
      <span class="switch-wrap">
        <el-switch v-model="filters.includeExcluded" size="small" />
        <span class="dim small">含不可上架/不可摸</span>
      </span>
    </el-tooltip>

    <!-- ── 清除 ── -->
    <el-button
      size="small"
      text
      :disabled="filters.activeFilterCount === 0"
      @click="filters.resetFilters()"
    >
      清除筛选
      <span v-if="filters.activeFilterCount > 0">({{ filters.activeFilterCount }})</span>
    </el-button>
  </div>

  <!--
    空结果提示。
    不只是说"没有数据"，而是给出下一步 —— 因为最常见的空结果是
    "某张图的某类东西本来就不多"，而不是"程序坏了"。
  -->
  <div v-if="isEmpty" class="empty-hint dim small">
    当前筛选下没有物品。
    <template v-if="filters.verdictFilter !== null">
      注意你正在「只看{{ filters.verdictFilter === 'must' ? '必摸' : filters.verdictFilter === 'maybe' ? '可摸' : filters.verdictFilter === 'skip' ? '跳过' : '未知' }}」，
      阈值可能把结果全排掉了。
    </template>
    <template v-else-if="filters.map !== null">
      这张图 + 当前条件的组合可能是空集 —— 试试去掉几个筛选条件。
    </template>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  background: var(--df-bg-soft);
  border: 1px solid var(--df-border);
  border-radius: 6px;
}

.search {
  width: 210px;
}

.sel {
  width: 148px;
}

.sel.narrow {
  width: 118px;
}

/* 选项里：左边名字、右边数量，数量右对齐成一列才好扫 */
.opt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.count {
  color: var(--df-text-dim);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.count.zero {
  opacity: 0.45;
}

.grade-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.spacer {
  flex: 1;
}

.switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.empty-hint {
  margin: -4px 0 10px;
  padding: 0 4px;
  line-height: 1.6;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
