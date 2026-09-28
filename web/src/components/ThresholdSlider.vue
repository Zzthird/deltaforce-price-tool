<script setup lang="ts">
/**
 * 阈值滑块 —— 「必摸 / 可摸 / 跳过」两个可调边界。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么用**对数**滑块
 * ═══════════════════════════════════════════════════════════════════════
 * 单格价值的实际跨度是从个位数到 3427 万（海洋之泪），跨了 7 个数量级。
 * 线性滑块在这种数据上完全没法用：
 *
 *   · 量程设到 3400 万 → 常用的 5000~50000 区间只占滑块千分之一点五，
 *     动一下鼠标就从 2000 跳到 80 万，根本调不准
 *   · 量程只设到 20 万 → 那么 100 万以上的物品全都"挤"在最右边，
 *     而且你再也调不到更高
 *
 * 对数滑块把每个数量级给同样的宽度，于是 1000 / 1万 / 10万 / 100万
 * 都各自有一段舒服的调节范围。滑块的数值就是"10 的几次方"。
 *
 * 界面上显示的仍然是真实金额（1000 / 1万 / 10万），不是指数 ——
 * 用户不该被迫理解对数。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么拖滑块不发网络请求
 * ═══════════════════════════════════════════════════════════════════════
 * 判定规则存在浏览器里（localStorage），后端完全不知道 `verdict` 存在。
 * 所以拖动只是重算一遍前端内存里的 1268 条 —— 随便拖。见 stores/rules.ts。
 */

import { computed } from 'vue'
import type { LootVerdict } from '@deltaforce/shared'
import { useRulesStore, VERDICT_LABEL, VERDICT_TAG_TYPE } from '@/stores/rules'
import { useFiltersStore } from '@/stores/filters'
import { formatExact, formatMoney } from '@/utils/format'

const rules = useRulesStore()
const filters = useFiltersStore()

/**
 * 滑块的量程（10 的几次方）。
 *   2 → 100      （低于 100 单格价值的东西基本不用讨论）
 *   7 → 1000万   （再往上只有极少数收藏品，用"全部显示"看更合适）
 */
const LOG_MIN = 2
const LOG_MAX = 7

/** 金额 → 滑块值（log10，夹在量程内）*/
function toLog(amount: number): number {
  return Math.min(LOG_MAX, Math.max(LOG_MIN, Math.log10(Math.max(amount, 1))))
}

/**
 * 必摸阈值的滑块绑定。
 *
 * ⚠️ 两个阈值必须满足 `skip ≤ must`，所以拖动一个时要**带着另一个走** ——
 * 否则会出现"必摸线低于跳过线"，判定里那个"可摸"中间档就消失了，
 * 界面上看起来一切正常但结论是错的。
 *
 * 为什么是"带着另一个走"而不是"夹住当前这个"：
 * 夹住的话，你把必摸线往左拖到底会卡在跳过线上不动，手感像坏了。
 * 带着走则符合直觉（那条线被推着一起动）。
 */
const mustLog = computed({
  get: () => toLog(rules.mustThreshold),
  set: (v: number) => {
    const amount = Math.round(10 ** v)
    rules.mustThreshold = amount
    if (rules.skipThreshold > amount) rules.skipThreshold = amount
  },
})

const skipLog = computed({
  get: () => toLog(rules.skipThreshold),
  set: (v: number) => {
    const amount = Math.round(10 ** v)
    rules.skipThreshold = amount
    if (rules.mustThreshold < amount) rules.mustThreshold = amount
  },
})

/** 判定档位，固定顺序显示 */
const VERDICTS: LootVerdict[] = ['must', 'maybe', 'skip', 'unknown']

/** 为什么 unknown 单独解释：它不是"值介于中间"，而是"判不了" */
const VERDICT_HINT: Readonly<Record<LootVerdict, string>> = {
  must: '指标 ≥ 必摸线',
  maybe: '介于两个阈值之间',
  skip: '指标 < 跳过线',
  unknown: '不可上架 / 不可摸 / 没有价格 —— 判不了',
}
</script>

<template>
  <div class="panel">
    <div class="row">
      <span class="label">判定依据</span>
      <!--
        直接 `v-model` 到 store 的 state。Pinia 的 setup store 返回的 ref
        是可写的，所以不需要中间变量或事件处理函数。
      -->
      <el-radio-group v-model="rules.mode" size="small">
        <!--
          排序键与判定依据**必须同步切换**。
          如果按单价排序、按单格价值判定，列表上就会出现
          "排在前面的被判跳过"这种自相矛盾的东西。

          这两个值不是 `LootMode` 的字面量写死在这里 ——
          它们要和 `shared` 的声音保持一致（改契约时这里会报错）。
        -->
        <el-radio-button value="pricePerSlot">单格价值</el-radio-button>
        <el-radio-button value="price">单价</el-radio-button>
      </el-radio-group>

      <span class="hint dim">
        当前按 <b>{{ rules.metricLabel }}</b> 排序与判定
      </span>
    </div>

    <!-- ── 必摸线 ── -->
    <div class="row">
      <span class="label">
        <el-tag type="danger" size="small" effect="dark">必摸</el-tag>
        ≥
        <b class="amount">{{ formatMoney(rules.mustThreshold) }}</b>
      </span>
      <el-slider
        v-model="mustLog"
        class="slider"
        :min="LOG_MIN"
        :max="LOG_MAX"
        :step="0.02"
        :show-tooltip="false"
      />
      <el-tooltip :content="`精确值：${formatExact(rules.mustThreshold)} 哈夫币`" placement="top">
        <span class="dim small num">{{ formatMoney(rules.mustThreshold) }}</span>
      </el-tooltip>
    </div>

    <!-- ── 跳过线 ── -->
    <div class="row">
      <span class="label">
        <el-tag type="info" size="small" effect="dark">跳过</el-tag>
        &lt;
        <b class="amount">{{ formatMoney(rules.skipThreshold) }}</b>
      </span>
      <el-slider
        v-model="skipLog"
        class="slider"
        :min="LOG_MIN"
        :max="LOG_MAX"
        :step="0.02"
        :show-tooltip="false"
      />
      <el-tooltip :content="`精确值：${formatExact(rules.skipThreshold)} 哈夫币`" placement="top">
        <span class="dim small num">{{ formatMoney(rules.skipThreshold) }}</span>
      </el-tooltip>
    </div>

    <!-- ── 判定命中数（可点击筛选）── -->
    <div class="row verdicts">
      <span class="label">当前结果</span>

      <el-tooltip
        v-for="v in VERDICTS"
        :key="v"
        :content="`${VERDICT_HINT[v]}｜点击只看这一档，再点一次取消`"
        placement="bottom"
      >
        <!--
          这四个是可以点的 —— 调完阈值之后，"只看必摸"是紧接着要做的事，
          所以把计数和筛选合成一个控件，省掉一步操作。
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

      <span class="dim small">
        （共 {{ filters.rowsBeforeVerdict.length }} 条）
      </span>

      <span class="spacer" />

      <el-button size="small" text @click="rules.reset()">重置阈值</el-button>
    </div>
  </div>
</template>

<style scoped>
.panel {
  padding: 10px 14px;
  background: var(--df-bg-soft);
  border: 1px solid var(--df-border);
  border-radius: 6px;
  font-size: 13px;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 34px;
}

.label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  width: 190px;
  color: var(--df-text-dim);
}

.amount {
  color: var(--df-text);
  font-variant-numeric: tabular-nums;
}

.slider {
  flex: 1;
  min-width: 220px;
  /*
   * 滑块默认高度比较矮，在触控板上不好抓。
   * 加高一点点击区域（Element Plus 的滑块轨道在中间）。
   */
  padding: 6px 0;
}

.num {
  flex: none;
  width: 84px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.hint {
  font-size: 12px;
}

.verdicts {
  border-top: 1px solid var(--df-border);
  margin-top: 6px;
  padding-top: 8px;
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
