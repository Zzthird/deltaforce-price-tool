<script setup lang="ts">
/**
 * 一图流首页 —— 三块信息。
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 三块数据的三种状态（这一页最重要的事就是**如实区分它们**）
 * ═══════════════════════════════════════════════════════════════════════
 *   ① 每日地图密码 —— **真的**（官方公开接口，实测 ret=0，不需要登录）
 *   ② 集市物品     —— **价格是真的**；"最高利润"留**占位**，见下
 *   ③ 特勤处制造   —— **占位**（官方接口实测 ret=101，需要登录）
 *
 * 为什么"最高利润"要留占位而不是先随便算一个：
 *   公开资料里手续费的说法互相矛盾（10% / 15% / 10–15% 浮动），
 *   而且有个逻辑硬伤 —— **固定比例不可能产生"利润最高点"**
 *   （利润 = P×(1−r) − 成本 对 P 的导数恒为正）。
 *   猜一个公式会得到一个"看着合理但错"的数字，那比空着更糟 ✗。
 *   实测工具已就绪：`npm run fee:probe`，测完把公式写进 metrics.ts 就能填上。
 *
 * 为什么特勤处那块不放"公开能拿到的设施升级需求"：
 *   它不是"制造推荐"、也没有小时/总利润 ✗ —— 放进来只会让人以为
 *   那就是要的东西。宁可空着并说明原因 ✓
 */

import { computed, onMounted } from 'vue'
import { useItemsStore } from '@/stores/items'
import { useDailyStore } from '@/stores/daily'
import { formatAge, formatMoney } from '@/utils/format'

const itemsStore = useItemsStore()
const dailyStore = useDailyStore()

/**
 * 集市物品：按「现价 − 基准价」降序取前 N。
 *
 * ⚠️ 这只是**占位排序** —— 等手续费公式实测出来之后，
 *    排序键要换成"最高利润"（那才是用户要的）。
 *    现在先按差额排，至少是真实数据、方向大体对。
 */
const MARKET_TOP_N = 12

const marketRows = computed(() => {
  const rows = itemsStore.items
    .filter((it) => it.price !== null && it.basePrice !== null && it.basePrice > 0)
    .map((it) => ({
      item: it,
      spread: (it.price as number) - (it.basePrice as number),
    }))
    .sort((a, b) => b.spread - a.spread)
  return rows.slice(0, MARKET_TOP_N)
})

const hasMarketData = computed(() => itemsStore.items.length > 0)

onMounted(async () => {
  // 密码自己一个接口（后端有半小时缓存，打开首页最多打一次源站）
  // 物品列表和"价值榜"页共用同一份 store，所以那边切过去时是瞬间的
  await Promise.all([dailyStore.load(), itemsStore.load()])
})
</script>

<template>
  <div class="home">
    <header class="head">
      <h1>一图流首页</h1>
      <p class="sub">每天上线先看这三样：今天的密码 · 哪些值得买 · （制造推荐待接）</p>
    </header>

    <div class="grid">
      <!-- ══════════ 每日地图密码（真数据）══════════ -->
      <section class="df-card card">
        <div class="card-head">
          <h2>每日地图密码</h2>
          <span class="dim small" v-if="dailyStore.fetchedAt !== null">
            取于 {{ formatAge(dailyStore.ageSeconds) }}
          </span>
        </div>

        <el-skeleton v-if="dailyStore.loading && dailyStore.secrets.length === 0" :rows="6" animated />

        <el-alert
          v-else-if="dailyStore.error !== null && dailyStore.secrets.length === 0"
          type="error"
          :closable="false"
          show-icon
          title="暂时取不到密码"
          :description="dailyStore.error"
        />

        <ul v-else class="secrets">
          <li v-for="s in dailyStore.secrets" :key="s.mapName">
            <span class="map">{{ s.mapName }}</span>
            <!--
              ⚠️ 密码必须是字符串 —— 可能是 "0178" 这种带前导零的，
                  转数字会变成 178（少一位，看错）。后端也全程按字符串传。
            -->
            <code class="code">{{ s.secret }}</code>
          </li>
        </ul>

        <p class="note dim small">
          来自官方公开接口（与物品主数据同一个接口族，不需要登录）。每天变一次。
        </p>
      </section>

      <!-- ══════════ 特勤处制造推荐（占位）══════════ -->
      <section class="df-card card">
        <div class="card-head">
          <h2>特勤处制造推荐</h2>
          <el-tag size="small" type="info" effect="plain">待接</el-tag>
        </div>

        <p class="placeholder">
          这一块需要官方的<b>制造接口</b>，实测它返回 <code>ret=101</code>（未授权）——
          <b>必须用你的账号登录</b>才能取。
        </p>
        <p class="placeholder dim">
          另外那个接口给的是<b>配方</b>（材料 → 产物），没有现成的「小时利润 / 总利润」✗ ——
          要把利润算出来，还得先有手续费公式（和左边"最高利润"是同一个前置条件）。
        </p>
        <p class="placeholder dim">
          是否要用你的 QQ / 微信账号登录，涉及账号安全与游戏条款，由你决定。
        </p>
      </section>

      <!-- ══════════ 集市物品（价格真、利润占位）══════════ -->
      <section class="df-card card wide">
        <div class="card-head">
          <h2>集市物品</h2>
          <span class="dim small">按「现价 − 基准价」降序前 {{ MARKET_TOP_N }} 条</span>
        </div>

        <div v-if="!hasMarketData" class="placeholder">
          还没取到物品数据。等一会儿或去「物资价值榜」页看看状态。
        </div>

        <table v-else class="market">
          <thead>
            <tr>
              <th class="left">物品</th>
              <th>现价</th>
              <th>基准价</th>
              <th>差额</th>
              <th class="profit-col">最高利润</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in marketRows" :key="r.item.key">
              <td class="left">
                <i class="dot" :style="{ background: r.item.gradeColor }" />
                {{ r.item.name }}
              </td>
              <td>{{ formatMoney(r.item.price) }}</td>
              <td class="dim">{{ formatMoney(r.item.basePrice) }}</td>
              <td :class="r.spread > 0 ? 'up' : 'down'">
                {{ r.spread > 0 ? '+' : '' }}{{ formatMoney(r.spread) }}
              </td>
              <!--
                ⭐ 占位。不是忘了做 —— 是在等手续费公式实测出来。
                详见文件头的说明：猜一个公式比空着更糟。
              -->
              <td class="profit-col">
                <el-tooltip
                  content="需要交易行手续费公式才能算。已做好实测工具：npm run fee:probe —— 挂几次单、把 report 发我，就能填上。"
                  placement="left"
                >
                  <span class="todo">待手续费公式</span>
                </el-tooltip>
              </td>
            </tr>
          </tbody>
        </table>

        <p class="note dim small">
          「现价」来自 <a href="https://moligod.com/trade" target="_blank" rel="noreferrer noopener">moligod</a>
          （交易行现价）；「基准价」是它给的源侧基准价 / 商店价。
          「最高利润」= 挂到某个价格、扣掉手续费之后的净收益最大值 ——
          它<b>依赖手续费公式</b>，而那个公式公开资料互相矛盾，所以正在用
          <code>npm run fee:probe</code> 实测。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/*
 * 页面宽度：**刻意不占满整个屏幕**（用户要求「显示空间恰好」）。
 * 内容居中、上限 1120px —— 太宽的话一张表要横跨 1900px，
 * 眼睛从物品名扫到"最高利润"要走很远。
 */
.home {
  max-width: 1120px;
  margin: 0 auto;
  padding: 14px 16px 24px;
}

.head {
  margin-bottom: 12px;
}

h1 {
  margin: 0;
  font-size: 18px;
  letter-spacing: 0.5px;
}

.sub {
  margin: 4px 0 0;
  color: var(--df-text-dim);
  font-size: 12px;
}

/* 左窄右宽 + 下面一整行。窄的那两块正好放"6 行密码"和"一段说明" */
.grid {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(260px, 1fr);
  gap: 12px;
  align-items: start;
}

.card {
  padding: 12px 14px;
}

/* 集市物品那横跨两列 */
.card.wide {
  grid-column: 1 / -1;
}

.card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

/* ── 密码列表 ── */
.secrets {
  list-style: none;
  margin: 0;
  padding: 0;
}

.secrets li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 0;
  border-bottom: 1px solid var(--df-border-soft);
  font-size: 13px;
}

.secrets li:last-child {
  border-bottom: 0;
}

.map {
  color: var(--df-text-dim);
}

.code {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--df-value);
  /* 密码是给眼睛抄的，所以字要大、要等宽、要有字距 */
}

/* ── 占位说明 ── */
.placeholder {
  margin: 0 0 8px;
  font-size: 12px;
  line-height: 1.7;
}

.placeholder:last-child {
  margin-bottom: 0;
}

/* ── 集市表 ── */
.market {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.market th,
.market td {
  padding: 5px 8px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.market th {
  color: var(--df-text-dim);
  font-weight: 500;
  font-size: 12px;
  border-bottom: 1px solid var(--df-border);
}

.market td {
  border-bottom: 1px solid var(--df-border-soft);
}

.market tr:last-child td {
  border-bottom: 0;
}

.left {
  text-align: left !important;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

/* 涨跌用中国习惯：红涨绿跌 */
.up {
  color: var(--df-up);
}

.down {
  color: var(--df-down);
}

.profit-col {
  width: 130px;
}

.todo {
  color: var(--df-text-faint);
  font-size: 12px;
  border-bottom: 1px dashed var(--df-border);
  cursor: help;
}

.note {
  margin: 10px 0 0;
  line-height: 1.7;
}

a {
  color: var(--df-accent);
}

code {
  background: var(--df-surface-2);
  padding: 1px 5px;
  border-radius: 3px;
}

.dim {
  color: var(--df-text-dim);
}

.small {
  font-size: 12px;
}
</style>
