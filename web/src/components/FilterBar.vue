<script setup lang="ts">
/**
 * 筛选栏 —— 顶层分组标签 + 每个分组一行子类 + 品质 + 出产地图。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么顶层是 7 个而不是官方的 5 个大类
 * ═══════════════════════════════════════════════════════════════════════
 * 官方把「收集品 / 钥匙 / 消耗品」放在 `props`（道具）的子类里，
 * 但玩家心里它们是并列的类别 —— moligod 就是一层平铺。
 * 所以前端把它们提升为顶层（见 stores/filters.ts 的 GROUP_DEFS）。
 * 这是**展示层的重组**，不改数据。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么子类要"每个分组一行"（用户提的方案，实测确认可行）
 * ═══════════════════════════════════════════════════════════════════════
 * 用户的原话：
 *   「别的网站把子类平铺的关键是他们不能自定义选择多个大类，因为大类对应的
 *     子类是不同的，如果我直接照抄他们会让界面变得很怪，但是下拉条同样无法
 *     避免过长后寻找困难的问题。我现在想的办法是，每选择一个大类，就在大类的
 *     下方添加一个独立的行，将对应大类的子类进行平铺」
 *
 * 他诊断的问题是真的：把「道具」和「弹药」都选上时，子类清单是两者的并集
 * （收集品/钥匙/消耗品 + 19 个弹药口径），混在一起**分不清谁属于谁**。
 *
 * 分行之后归属关系是**结构性**的。实测各分组的子类数量：
 *   收集品 0 · 消耗品 3 · 钥匙 0 · 配件 9 · 弹药 19 · 防护 4 · 枪械 8
 * 都只占一行（弹药折两行），而没有子类的分组**不显示空行**。
 *
 * 三点补充（防止"分行"本身带来新困惑）：
 *   ① 每行最左边标出分组名 —— 「收集品」「步枪」这类名字不自带父级信息
 *   ② 每行的「全部」只清**这一行**，不动别的行
 *   ③ 整个子类区可折叠 —— 不需要细筛时收起来，把空间让给表格
 */

import { computed } from 'vue'
import { useFiltersStore } from '@/stores/filters'
import { useMetaStore } from '@/stores/meta'
import { VERDICT_LABEL } from '@/stores/rules'

const filters = useFiltersStore()
const metaStore = useMetaStore()

/** 品质色值来自后端下发的调色板，前端不写死 */
function gradeColor(grade: number): string {
  return metaStore.gradeColors[String(grade)] ?? '#8b93a1'
}

const isEmpty = computed(() => filters.rows.length === 0)

const emptyHint = computed(() => {
  if (!isEmpty.value) return ''
  if (filters.verdictFilter !== null) {
    return `注意你正在「只看${VERDICT_LABEL[filters.verdictFilter]}」—— 阈值或组合条件可能把结果全排掉了。`
  }
  return '当前条件下没有物品。试试去掉几个标签，或者把「只看该图专属」关掉。'
})

/** 子类区该不该显示：至少有一个选中的分组带下一级 */
const showSubRows = computed(() => filters.groupsWithSubs > 0)
</script>

<template>
  <div class="bar">
    <!-- ══════════ 第一行：分组标签 + 搜索 ══════════ -->
    <div class="row">
      <span class="group-label">大类</span>

      <button
        class="chip"
        :class="{ on: filters.groups.length === 0 }"
        type="button"
        @click="filters.clearGroups()"
      >
        全部
      </button>

      <button
        v-for="o in filters.groupOptions"
        :key="o.value"
        class="chip"
        :class="{ on: filters.groups.includes(o.value), zero: o.count === 0 }"
        type="button"
        @click="filters.toggleGroup(o.value)"
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

      <!-- 子类区折叠开关：不需要细筛时收起来，把空间让给表格 -->
      <el-tooltip
        :content="`展开后每个已选大类各占一行，显示它的${filters.groupsWithSubs}组细分。收起可以把空间让给表格。`"
        placement="bottom"
        :show-after="400"
        :disabled="!showSubRows"
      >
        <el-button
          size="small"
          text
          :disabled="!showSubRows"
          @click="filters.subsExpanded = !filters.subsExpanded"
        >
          {{ filters.subsExpanded ? '收起细分 ▴' : '展开细分 ▾' }}
        </el-button>
      </el-tooltip>
    </div>

    <!-- ══════════ 子类行：每个已选分组一行 ══════════ -->
    <template v-if="showSubRows && filters.subsExpanded">
      <div v-for="row in filters.subOptionsByGroup" :key="row.group" class="row sub-row">
        <!-- ① 标出分组名 —— 否则三行子类并排时分不清谁属于谁 -->
        <span class="sub-label">{{ row.label }} ·</span>

        <!-- ② 这一行的「全部」只清这一行 -->
        <button class="chip tiny" type="button" @click="filters.clearSubsOf(row.group)">
          全部
        </button>

        <button
          v-for="o in row.options"
          :key="o.value"
          class="chip tiny"
          :class="{ on: filters.subs.includes(o.value), zero: o.count === 0 }"
          type="button"
          @click="filters.toggleSub(o.value)"
        >
          {{ o.label }}<span class="n">{{ o.count }}</span>
        </button>
      </div>
    </template>

    <!-- ══════════ 最后一行：品质 + 出产地图 + 开关 ══════════ -->
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
        v-for="o in filters.gradeOptions"
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

      <!--
        ③ 地图前面加「出产地图」标签 —— 用户建议：
        与「钥匙」这类名称区分开（钥匙也是一种"类"，但地图是出产地，不是分类）。
      -->
      <span class="group-label wide">出产地图</span>
      <el-tooltip
        content="选地图后只显示**已确认**会在这张图刷出的物资。没标注出产地的（待补，约 225 条）也会被隐藏 —— 因为无法确认它会不会出。"
        placement="bottom"
        :show-after="500"
      >
        <el-select
          v-model="filters.maps"
          class="sel map-sel"
          size="small"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          placeholder="不限"
        >
          <el-option
            v-for="o in filters.mapOptions"
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
      </el-tooltip>

      <el-tooltip
        content="隐藏「全地图」的通用物资，只留这张图特有的。不选地图时无效。"
        placement="bottom"
        :show-after="500"
      >
        <span class="switch-wrap" :class="{ off: filters.maps.length === 0 }">
          <el-switch v-model="filters.mapOnly" size="small" :disabled="filters.maps.length === 0" />
          <span class="dim small">只看该图专属</span>
        </span>
      </el-tooltip>

      <el-tooltip
        content="不可上架（挂不上交易行）与不可摸（限时下架/非战利品）的物品默认不显示，因为它们不参与排序。打开可以查它们的情况 —— 比如“这条能摸到但卖不掉”。"
        placement="bottom"
        :show-after="500"
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

  <div v-if="isEmpty" class="empty-hint dim small">{{ emptyHint }}</div>
</template>

<style scoped>
.bar {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 12px;
  /* 背景与边框交给外层 `.df-card`（本组件有两个根节点，
     父级传的 class 无法自动继承，所以 df-card 写在根节点上）*/
}

.row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

/* 子类行缩进 + 左侧一条竖线：视觉上从属于上面的分组标签 */
.sub-row {
  padding-left: 10px;
  border-left: 2px solid var(--df-border);
  margin-left: 4px;
}

.group-label {
  flex: none;
  width: 52px;
  color: var(--df-text-dim);
  font-size: 12px;
}

.group-label.wide {
  width: auto;
  margin-right: 2px;
}

.sub-label {
  flex: none;
  color: var(--df-text-dim);
  font-size: 12px;
  min-width: 52px;
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

.chip.tiny {
  padding: 1px 7px;
  font-size: 11px;
  line-height: 16px;
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

/* 数量为 0 的选项压暗：它仍可点（可能有别的组合），但不抢注意力 */
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

/* 品质标签带一个品质色圆点 —— 和表格里图标描边同一套色 */
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
  width: 186px;
}

.sel {
  width: 168px;
}

.map-sel {
  width: 140px;
}

/*
 * 下拉三角的可点区域放大。
 *
 * 用户反馈：「最右边的下拉三角感觉有点难点，更改成点击这一个栏位就能触发展开」。
 * 实测原因：`clearable` 的清除叉紧挨着三角，鼠标稍偏左就变成了"清空"
 * 而不是"展开"，感觉不可预测。这里把整个控件变成手型光标，
 * 并给三角与叉之间留出间距。
 */
:deep(.el-select__wrapper) {
  cursor: pointer;
}

:deep(.el-select__caret) {
  font-size: 14px;
  margin: 0 -2px 0 2px;
  padding: 3px 1px;
}

:deep(.el-select__clear) {
  margin-left: 2px;
  margin-right: 2px;
}

:deep(.el-select__wrapper.is-small) {
  min-height: 24px;
}

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
