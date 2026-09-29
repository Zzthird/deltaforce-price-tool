<script setup lang="ts">
/**
 * 筛选栏 —— **平铺多选标签** + 子类/细类下拉 + 搜索。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么从下拉框改成平铺标签（这一轮最大的交互变化）
 * ═══════════════════════════════════════════════════════════════════════
 * 两个理由，一个是你的需求，一个是参照：
 *
 * ① **单选不够用。** 你原话：「我如果想看收藏品和消耗品呢，如果这个时候
 *    我也想看看枪的价格呢」—— 单选框表达不了"这几个一起看"。
 *    所以大类、品质、地图改成**多选标签**（同维 OR，跨维 AND）。
 *
 * ② **四个同类网站全都这么做。** dergame / moligod / shushu / kkrb
 *    里没有一个用下拉框 —— 因为下拉框要"展开→找→点→收起"四步，
 *    而标签一眼就能看到**有多少个选项、当前选了哪些**。
 *
 * 哪些用标签、哪些仍用下拉，是按**选项数量**分的：
 *   · 大类 5 个、品质 7 个、地图 6 个 → 标签平铺（一屏放得下）
 *   · 子类 46 个、细类少数 → 可搜索的多选下拉（平铺会占掉半屏）
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 标签上的数字是什么意思
 * ═══════════════════════════════════════════════════════════════════════
 * 是「**选中它、且满足其它维度筛选**的物品数」。
 *
 * ⚠️ 它**不随自己这一维的已选状态变化** —— 这是 faceted search 的标准行为，
 *    也是唯一不骗人的算法。比如已经选了「道具 + 弹药」，
 *    「配件」上显示的仍是"配件有多少条（在其它筛选下）"，
 *    而不是 0（那会让人以为配件没东西）。
 *
 * 实现在 `stores/filters.ts` 的 `pass(item, skip)` —— 数某维度时把它自己跳过。
 */

import { computed } from 'vue'
import { useFiltersStore } from '@/stores/filters'
import { useMetaStore } from '@/stores/meta'
/**
 * 判定档位的中文名 —— **从定义处导入，不在这里再写一份**。
 *
 * 重复写一份的后果很具体：改一处忘了另一处，于是表格里的判定标签
 * 和空结果提示里的说法不一致（一个说"必摸"，一个说"必须摸"）。
 */
import { VERDICT_LABEL } from '@/stores/rules'

const filters = useFiltersStore()
const metaStore = useMetaStore()

/** 品质色值来自后端下发的调色板，前端不写死 */
function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

/** 品质标签要按品质顺序排（灰→白→绿→蓝→紫→金→红），而不是按数量 */
const sortedGrades = computed(() =>
  [...filters.gradeOptions].sort((a, b) => Number(a.value) - Number(b.value)),
)

/** 大类标签按固定顺序（与后端清单一致），不按数量跳来跳去 */
const sortedCategories = computed(() => filters.categoryOptions)

const thirdClassEnabled = computed(() => filters.categories.length > 0)

const isEmpty = computed(() => filters.rows.length === 0)

/** 空结果时给一句引导 —— 最常见的空结果是"阈值把结果全排掉了" */
const emptyHint = computed(() => {
  if (!isEmpty.value) return ''
  if (filters.verdictFilter !== null) {
    return `注意你正在「只看${VERDICT_LABEL[filters.verdictFilter]}」—— 阈值或组合条件可能把结果全排掉了。`
  }
  return '当前条件下没有物品。试试去掉几个筛选标签，或者把地图的「只看该图专属」关掉。'
})


</script>

<template>
  <!-- 同上：`df-card` 必须写在根节点上，本组件有两个根（筛选栏 + 空结果提示）-->
  <div class="df-card bar">
    <!-- ══════════ 第一行：大类标签 + 搜索 + 子类/细类 ══════════ -->
    <div class="row">
      <span class="group-label">大类</span>
      <button
        class="chip"
        :class="{ on: filters.categories.length === 0 }"
        type="button"
        @click="filters.clearCategories()"
      >
        全部
      </button>
      <button
        v-for="o in sortedCategories"
        :key="o.value"
        class="chip"
        :class="{ on: filters.categories.includes(o.value), zero: o.count === 0 }"
        type="button"
        @click="filters.toggleCategory(o.value)"
      >
        {{ o.label }}<span class="n">{{ o.count }}</span>
      </button>

      <span class="spacer" />

      <el-input
        v-model="filters.search"
        class="search"
        size="small"
        clearable
        placeholder="搜物品名 / 别名 / 官方ID"
      />

      <!-- 子类 46 个，平铺会占半屏 —— 用可搜索的多选 -->
      <el-select
        :model-value="filters.subcategories"
        class="sel"
        size="small"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        filterable
        :disabled="filters.categories.length === 0"
        :placeholder="filters.categories.length === 0 ? '先选大类' : '子类（可多选）'"
        @update:model-value="filters.setSubcategories($event)"
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
        :model-value="filters.thirdClasses"
        class="sel narrow"
        size="small"
        multiple
        collapse-tags
        collapse-tags-tooltip
        clearable
        filterable
        :disabled="!thirdClassEnabled"
        :placeholder="thirdClassEnabled ? '细类' : '先选大类'"
        @update:model-value="filters.thirdClasses = $event"
      >
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
    </div>

    <!-- ══════════ 第二行：品质标签 + 地图标签 + 开关 ══════════ -->
    <div class="row">
      <span class="group-label">品质</span>
      <button
        class="chip"
        :class="{ on: filters.grades.length === 0 }"
        type="button"
        @click="filters.grades = []"
      >
        全部
      </button>
      <button
        v-for="o in sortedGrades"
        :key="o.value"
        class="chip grade-chip"
        :class="{ on: filters.grades.includes(Number(o.value)), zero: o.count === 0 }"
        :style="{ '--chip-color': gradeColor(Number(o.value)) }"
        type="button"
        @click="filters.toggleGrade(Number(o.value))"
      >
        <i class="dot" />{{ o.label }}<span class="n">{{ o.count }}</span>
      </button>

      <span class="divider" />

      <span class="group-label">地图</span>
      <button
        class="chip"
        :class="{ on: filters.maps.length === 0 }"
        type="button"
        @click="filters.maps = []"
      >
        全部
      </button>
      <button
        v-for="o in filters.mapOptions"
        :key="o.value"
        class="chip"
        :class="{ on: filters.maps.includes(o.value) }"
        type="button"
        @click="filters.toggleMap(o.value)"
      >
        {{ o.label }}<span class="n">{{ o.count }}</span>
      </button>

      <!--
        「只看该图专属」：隐藏「全地图」的通用物资。
        没选地图时没有意义，所以禁用（并压暗，而不是默默无效）。
      -->
      <el-tooltip
        content="隐藏「全地图」的通用物资，只留这张图特有的。不选地图时无效。"
        placement="bottom"
        :show-after="400"
      >
        <span class="switch-wrap" :class="{ off: filters.maps.length === 0 }">
          <el-switch v-model="filters.mapOnly" size="small" :disabled="filters.maps.length === 0" />
          <span class="dim small">只看该图专属</span>
        </span>
      </el-tooltip>

      <el-tooltip
        content="不可上架（挂不上交易行）与不可摸（限时下架/非战利品）的物品默认不显示，因为它们不参与排序。打开可以查它们的情况 —— 比如“这条能摸到但卖不掉”。"
        placement="bottom"
        :show-after="400"
      >
        <span class="switch-wrap">
          <el-switch v-model="filters.includeExcluded" size="small" />
          <span class="dim small">含不可上架/不可摸</span>
        </span>
      </el-tooltip>

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
  </div>

  <!-- 空结果提示：给下一步，而不只是说"没有数据" -->
  <div v-if="isEmpty" class="empty-hint dim small">{{ emptyHint }}</div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  /* 背景与边框交给外层 `.df-card` */
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.group-label {
  flex: none;
  width: 30px;
  color: var(--df-text-dim);
  font-size: 12px;
}

/* ── 标签（chip）── */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--df-border);
  background: var(--df-surface-2);
  color: var(--df-text-dim);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  user-select: none;
}

.chip:hover {
  color: var(--df-text);
  border-color: var(--df-accent);
}

/*
 * 选中态用**强调色边框 + 淡底**，而不是实心填充 ——
 * 一屏可能有五六个标签同时选中，全填满会很吵。
 */
.chip.on {
  color: var(--df-text);
  border-color: var(--df-accent);
  background: var(--df-accent-soft);
  font-weight: 600;
}

/* 数量为 0 的选项压暗：它仍然可点（可能有别的组合），但不抢注意力 */
.chip.zero {
  opacity: 0.45;
}

.chip .n {
  color: var(--df-text-faint);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}

.chip.on .n {
  color: var(--df-text-dim);
}

/* 品质标签带一个品质色圆点 —— 和表格里的图标描边同一套色 */
.grade-chip .dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--chip-color);
}

.divider {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: var(--df-border);
}

.spacer {
  flex: 1;
}

.search {
  width: 190px;
}

.sel {
  width: 168px;
}

.sel.narrow {
  width: 120px;
}

/* 下拉选项里：左边名字、右边数量 */
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

.switch-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  cursor: pointer;
}

.switch-wrap.off {
  opacity: 0.55;
}

.empty-hint {
  margin: 4px 14px 0;
  line-height: 1.6;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
