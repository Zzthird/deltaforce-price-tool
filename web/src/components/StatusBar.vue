<script setup lang="ts">
/**
 * 状态栏 —— 这个组件的职责不是"好看"，而是**回答"这份数据能不能信"**。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 为什么这一栏是本项目的重点
 * ═══════════════════════════════════════════════════════════════════════
 * 价格来自第三方现价，**5 分钟就变**。所以页面上任何数字都隐含一个问题：
 * "这是多久以前的？"
 *
 * 不显示这个信息，用户就会拿一个不知道哪来的数字去做"这趟摸什么"的决策 ——
 * 而那正是整个工具存在的意义。所以宁可挤一点，也要把这三样说清楚：
 *
 *   ① **数据有多旧**（更新于 3 分钟前）
 *   ② **价格是什么口径**（moligod 现价，交易行最新成交参考）
 *   ③ **有多少条被排除了**（否则你会问"为什么总数对不上"）
 *
 * 第四样是**校验状态**：它说明"我还在盯着后端有没有新数据"，
 * 而不是一个静态页面。
 */

import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useItemsStore } from '@/stores/items'
import { useMetaStore } from '@/stores/meta'
import { useHealthPolling } from '@/composables/useHealthPolling'
import { formatAge } from '@/utils/format'

const itemsStore = useItemsStore()
const metaStore = useMetaStore()

/**
 * ⚠️ 必须**解构**，不能写 `const polling = useHealthPolling()` 然后在模板里
 *    用 `polling.visible`。
 *
 * 因为 Vue 在模板里只对**顶层**的 ref 自动解包。它是一个一层深的
 * `proxyRefs` —— 拿到 `polling` 这个普通对象后，里面的 `visible`
 * 仍然是个 Ref 对象，模板里拿到的是它而不是 `true`。
 * 写 `polling.lastCheckAt.toLocaleTimeString()` 更是会直接报错，
 * 因为那是 Ref 对象上的方法，不存在。
 *
 * 解构到顶层（并给重名项改名）是组合式函数的标准用法。
 */
const {
  visible: pollingVisible,
  lastCheckAt,
  error: pollingError,
} = useHealthPolling({ intervalMs: 60_000 })

/** 校验状态的说明文字（拼好再放模板，避免模板里写三元套三元）*/
const pollingText = computed(() => {
  if (pollingError.value) return '校验失败'
  if (!pollingVisible.value) return '已暂停校验（标签页在后台）'
  return '自动校验中'
})

/** 悬浮提示：把“多久校验一次、校验的是什么”说清楚 */
const pollingHint = computed(() => {
  const lines = [
    '只在标签页可见时每 60 秒校验一次后端是否有了新数据。',
    '查的是 /api/health —— 它刻意不触发抓取，响应只有 230 字节；',
    '而不是反复拉 /api/items（2MB 且会触发抓取）。',
  ]
  if (lastCheckAt.value) {
    lines.push(`最近校验：${lastCheckAt.value.toLocaleTimeString('zh-CN')}`)
  }
  if (pollingError.value) lines.push(`校验失败：${pollingError.value}`)
  return lines.join('\n')
})

async function onRefresh(): Promise<void> {
  const res = await itemsStore.manualRefresh()
  // 409（已有抓取在进行中）/ 429（刚抓过）都不是故障，是后端的锁在正常工作。
  // 所以用 warning 而不是 error —— 不该让用户以为坏了。
  ElMessage({ type: res.ok ? 'success' : 'warning', message: res.message, duration: 4000 })
}
</script>

<template>
  <!--
    ⚠️ `df-card` 写在**这里**，而不是父组件标签上。
    本组件有多个根节点（状态栏 + 若干告警），Vue 无法把父级传的 class
    自动继承下来 —— 会打出 "Extraneous non-props attributes" 警告，
    而且卡片样式根本不生效。
  -->
  <div class="df-card bar">
    <!-- ── 数量 ── -->
    <span class="item">
      <b>{{ itemsStore.count }}</b> 条物品
      <span class="dim">（可排序 {{ itemsStore.ranked.length }}）</span>
    </span>

    <span class="sep">·</span>

    <!-- ── 新鲜度 ── -->
    <span class="item">
      更新于 <b>{{ formatAge(itemsStore.ageSeconds) }}</b>
    </span>

    <!--
      三种状态用三种颜色，因为它们对应完全不同的行动：
        数据新鲜     → 放心用
        正在后台抓   → 等几秒就会变，别急着截图
        数据已过期   → 抓不到新数据了，你现在看到的可能已经不准
    -->
    <el-tag v-if="itemsStore.snapshotStale" type="danger" size="small" effect="dark">
      抓不到新数据，以下为旧数据
    </el-tag>
    <el-tag v-else-if="itemsStore.refreshing" type="warning" size="small" effect="dark">
      正在后台获取最新价格…
    </el-tag>
    <el-tag v-else type="success" size="small" effect="plain" class="fresh">数据新鲜</el-tag>

    <span class="sep">·</span>

    <!-- ── 价格口径 ── -->
    <!--
      这一条**不能省**。不同源的口径不同（现价 / 挂单价 / 统计均价），
      不标注就会误导判定。文字来自后端的 `priceBasis`，前端不自己写。
    -->
    <span class="item dim">{{ metaStore.priceBasis ?? '价格口径未知' }}</span>

    <span class="spacer" />

    <!-- ── 被排除的数量 ── -->
    <!--
      必须显示，否则用户会问"为什么总共 1564 条，表里只有 1268 条"。
      而且这三个数是**不同的原因**，混在一起会让人以为都是"没数据"：
        不可上架 288 → 有价但挂不上交易行，卖了也没价（如火箭燃料）
        不可摸 215   → 限时下架 / 非战利品（如旧赛季弹）
        无价格 270   → 名字对上了，但源里标着"非卖品"
    -->
    <span class="item dim small">
      已排除：不可上架 {{ itemsStore.excludedCounts.notListable }} ·
      不可摸 {{ itemsStore.excludedCounts.notLootable }} ·
      无价格 {{ itemsStore.excludedCounts.noPrice }}
    </span>

    <el-divider direction="vertical" />

    <!-- ── 校验状态 ── -->
    <el-tooltip :content="pollingHint" placement="bottom">
      <span class="item dim small">
        <span
          class="dot"
          :class="{ off: !pollingVisible, err: !!pollingError }"
        />
        {{ pollingText }}
      </span>
    </el-tooltip>

    <el-button size="small" type="primary" :loading="itemsStore.loading" @click="onRefresh">
      刷新数据
    </el-button>
  </div>

  <!-- ── 警告（后端 /api/sources 给的）── -->
  <!--
    这些是"数据本身有问题"的提示，比如标注文件里的矛盾：
    「花小蝶标了本季，但又显式写了不可上架」。
    放在状态栏里而不是弹窗里 —— 它们不是"错误"，是需要你知道的事实。
  -->
  <el-alert
    v-for="(w, i) in metaStore.warnings"
    :key="i"
    class="warn"
    type="warning"
    :closable="false"
    show-icon
    :title="w"
  />

  <el-alert
    v-if="itemsStore.error"
    class="warn"
    type="error"
    :closable="false"
    show-icon
    title="拿不到数据"
    :description="itemsStore.error"
  />

  <el-alert
    v-if="pollingError && !itemsStore.error"
    class="warn"
    type="info"
    :closable="false"
    show-icon
    title="后台校验暂时失败（页面上的数据仍可用）"
    :description="pollingError"
  />
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 12px;
  /*
   * 背景与边框交给外层的 `.df-card` —— 卡片只该在一处定义，
   * 否则“页面底色 / 内容面 / 控件底色”会变成三层各自定义，
   * 换主题时就要跟着改三处。
   */
  font-size: 13px;
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sep {
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

.fresh {
  margin-left: 2px;
}

.warn {
  margin-top: 10px;
}

/* 校验状态的小圆点：绿=在跑，灰=暂停，红=失败 */
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--df-down);
}

.dot.off {
  background: var(--df-text-faint);
}

.dot.err {
  background: var(--df-up);
}
</style>
