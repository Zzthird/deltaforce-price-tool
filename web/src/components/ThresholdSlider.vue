<script setup lang="ts">
/**
 * 阈值面板 —— 「必摸 / 可摸 / 跳过」两个可调边界。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 滑块 + 数字输入框，两个都要
 * ═══════════════════════════════════════════════════════════════════════
 * 你原话：「只用滑动条会导致无法精确选择数值，可以添加手动编辑（限制数字）」✓
 *
 * 两个控件的分工：
 *   · **滑块** —— 快速试。不知道"2 万算不算高"的时候，拖着看命中数怎么变
 *   · **输入框** —— 精确值。你心里已经有个数（比如"我就想卡 15000"）时直接敲
 *
 * 两者双向绑定同一个值，所以拖完滑块输入框会跟着变、敲完数字滑块也会动。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么滑块是**对数**的
 * ═══════════════════════════════════════════════════════════════════════
 * 单格价值跨度 1 ~ 3427 万（7 个数量级）。线性滑块在常用的
 * 5000~50000 区间只占千分之一点五 —— 动一下鼠标就从 2000 跳到 80 万，
 * 根本调不准。对数滑块给每个数量级相同的宽度。
 * 而**输入框里永远显示真实金额**，不是指数 —— 用户不该被迫理解对数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么拖滑块不发网络请求
 * ═══════════════════════════════════════════════════════════════════════
 * 判定规则存在浏览器里（localStorage），后端完全不知道 `verdict` 存在。
 * 所以拖动只是重算前端内存里的 1268 条 —— 随便拖。见 stores/rules.ts。
 */

import { computed } from 'vue'
import type { LootVerdict } from '@deltaforce/shared'
import { useRulesStore, VERDICT_LABEL, VERDICT_TAG_TYPE } from '@/stores/rules'
import { useFiltersStore } from '@/stores/filters'
import { formatMoney } from '@/utils/format'

const rules = useRulesStore()
const filters = useFiltersStore()

/** 滑块的量程（10 的几次方）：2 → 100，7 → 1000万 */
const LOG_MIN = 2
const LOG_MAX = 7

/**
 * 输入框的取值范围。
 *
 * ⚠️ 有上限是刻意的：单格价值最高约 3427 万（海洋之泪），
 *    上限给 1 亿就够，同时挡住"不小心粘进去一个 10 位数"。
 *    下限给 1（0 在本项目里表示"无价格"，不是"零元"）。
 */
const INPUT_MIN = 1
const INPUT_MAX = 100_000_000

/** 金额 → 滑块值（log10，夹在量程内）*/
function toLog(amount: number): number {
  return Math.min(LOG_MAX, Math.max(LOG_MIN, Math.log10(Math.max(amount, 1))))
}

/**
 * 两个阈值必须满足 `skip ≤ must`，所以改一个要**带着另一个走** ——
 * 否则会出现"必摸线低于跳过线"，判定里那个"可摸"中间档就消失了，
 * 界面上看起来一切正常但结论是错的。
 *
 * 为什么是"带着走"而不是"夹住当前这个"：夹住的话，把必摸线往左拖到底
 * 会卡在跳过线上不动，手感像坏了。带着走则符合直觉（那条线被推着一起动）。
 */
function clamp(n: number): number {
  if (!Number.isFinite(n)) return INPUT_MIN
  return Math.min(INPUT_MAX, Math.max(INPUT_MIN, Math.round(n)))
}

const mustLog = computed({
  get: () => toLog(rules.mustThreshold),
  set: (v: number) => {
    const amount = clamp(10 ** v)
    rules.mustThreshold = amount
    if (rules.skipThreshold > amount) rules.skipThreshold = amount
  },
})

const skipLog = computed({
  get: () => toLog(rules.skipThreshold),
  set: (v: number) => {
    const amount = clamp(10 ** v)
    rules.skipThreshold = amount
    if (rules.mustThreshold < amount) rules.mustThreshold = amount
  },
})

/** 数字输入框（可空 → 视为下限，而不是变成 NaN）*/
const mustInput = computed({
  get: () => rules.mustThreshold,
  set: (v: number | undefined) => {
    const amount = clamp(Number(v ?? INPUT_MIN))
    rules.mustThreshold = amount
    if (rules.skipThreshold > amount) rules.skipThreshold = amount
  },
})

const skipInput = computed({
  get: () => rules.skipThreshold,
  set: (v: number | undefined) => {
    const amount = clamp(Number(v ?? INPUT_MIN))
    rules.skipThreshold = amount
    if (rules.mustThreshold < amount) rules.mustThreshold = amount
  },
})

const VERDICTS: LootVerdict[] = ['must', 'maybe', 'skip', 'unknown']

const VERDICT_HINT: Readonly<Record<LootVerdict, string>> = {
  must: '指标 ≥ 必摸线',
  maybe: '介于两个阈值之间',
  skip: '指标 < 跳过线',
  unknown: '不可上架 / 不可摸 / 没有价格 —— 判不了',
}
</script>

<template>
  <div class="panel">
    <!-- ══════════ 第一行：判定依据 + 当前结果 + 重置 ══════════ -->
    <div class="row">
      <span class="group-label">判定依据</span>
      <!--
        直接 `v-model` 到 store 的 state。Pinia 的 setup store 返回的 ref 可写，
        所以不需要中间变量或事件处理函数。

        排序键与判定依据**同步切换** —— 不然会出现"按单价排序的列表、
        而右侧判定用的是单格价值"，排在前面的被判"跳过"，自相矛盾。
      -->
      <el-radio-group v-model="rules.mode" size="small">
        <el-radio-button value="pricePerSlot">单格价值</el-radio-button>
        <el-radio-button value="price">单价</el-radio-button>
      </el-radio-group>

      <span class="divider" />

      <span class="group-label">当前结果</span>
      <el-tooltip
        v-for="v in VERDICTS"
        :key="v"
        :content="`${VERDICT_HINT[v]}｜点击只看这一档，再点一次取消`"
        placement="bottom"
      >
        <!--
          四个计数可点 —— 调完阈值之后"只看必摸"是紧接着要做的事，
          把计数与筛选合成一个控件，省一步操作。
        -->
        <el-tag
          :type="VERDICT_TAG_TYPE[v]"
          :effect="filters.verdictFilter === v ? 'dark' : 'plain'"
          size="small"
          class="verdict-tag"
          @click="filters.setVerdictFilter(v)"
        >
          {{ VERDICT_LABEL[v] }} <b>{{ filters.verdictCounts[v] }}</b>
        </el-tag>
      </el-tooltip>
      <span class="dim small">（共 {{ filters.rowsBeforeVerdict.length }} 条）</span>

      <span class="spacer" />
      <el-button size="small" text @click="rules.reset()">重置阈值</el-button>
    </div>

    <!-- ══════════ 第二行：必摸线 ══════════ -->
    <div class="row">
      <span class="label">
        <el-tag type="danger" size="small" effect="dark">必摸</el-tag>
        ≥
      </span>
      <!--
        ⚠️ 这里**刻意没有 tooltip**。
        之前给输入框套了一层"精确值：xxx 哈夫币"的悬浮提示 —— 而输入框
        本身显示的就是精确值，提示内容完全重复 ✗，更糟的是鼠标一移上去
        就弹出来**盖住输入框**，想点进去改数字时很碍事（用户反馈：
        「删除鼠标悬停在第一张图的文本，影响操作」）。
      -->
      <el-input-number
        v-model="mustInput"
        class="num-input"
        size="small"
        :min="INPUT_MIN"
        :max="INPUT_MAX"
        :step="1000"
        :controls="false"
      />
      <span class="unit dim small">{{ formatMoney(rules.mustThreshold) }}</span>
      <el-slider
        v-model="mustLog"
        class="slider"
        :min="LOG_MIN"
        :max="LOG_MAX"
        :step="0.01"
        :show-tooltip="false"
      />
    </div>

    <!-- ══════════ 第三行：跳过线 ══════════ -->
    <div class="row">
      <span class="label">
        <el-tag type="info" size="small" effect="dark">跳过</el-tag>
        &lt;
      </span>
      <!-- 同上：刻意不加 tooltip -->
      <el-input-number
        v-model="skipInput"
        class="num-input"
        size="small"
        :min="INPUT_MIN"
        :max="INPUT_MAX"
        :step="500"
        :controls="false"
      />
      <span class="unit dim small">{{ formatMoney(rules.skipThreshold) }}</span>
      <el-slider
        v-model="skipLog"
        class="slider"
        :min="LOG_MIN"
        :max="LOG_MAX"
        :step="0.01"
        :show-tooltip="false"
      />
    </div>
  </div>
</template>

<style scoped>
/*
 * 这个面板原来占 164px（全页最大的空间消费者），压成三行紧凑布局后约 110px。
 * 表格可视区多了 50px ≈ 多两行。见 AGENTS.md 里记的空间分配数据。
 */
.panel {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 12px;
  /* 背景与边框交给外层 `.df-card` */
  font-size: 13px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}

.group-label {
  flex: none;
  color: var(--df-text-dim);
  font-size: 12px;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  width: 76px;
  color: var(--df-text-dim);
}

/* 数字输入框：定宽，避免数字位数变化时布局跳动 */
.num-input {
  flex: none;
  width: 104px;
}

.num-input :deep(.el-input__inner) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.unit {
  flex: none;
  width: 62px;
  font-variant-numeric: tabular-nums;
}

.slider {
  flex: 1;
  min-width: 200px;
  /* 默认高度偏矮，触控板上不好抓 */
  padding: 4px 0;
}

.divider {
  flex: none;
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--df-border);
}

.verdict-tag {
  cursor: pointer;
  user-select: none;
  font-variant-numeric: tabular-nums;
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
</style>
