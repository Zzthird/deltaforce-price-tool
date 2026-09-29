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
import { useMetaStore } from '@/stores/meta'
import { formatAge, formatMoney } from '@/utils/format'

const itemsStore = useItemsStore()
const dailyStore = useDailyStore()
const metaStore = useMetaStore()

/**
 * 集市物品：**官方军需处接口抓的当期兑换需求** ✓
 *
 * σσ 历史教训（两个，都很典型）：
 *   ① 我最初做成「按现价−基准价降序前 12 条」—— 那是我自己编的排序 ✗，
 *      把猜的东西摆在事实的位置上 ✓。
 *   ② 接着我又写信说「集市没有可用的官方接口」✗ —— 也错了 ✗。
 *      它就在军需处那个 chartId 里，只是要 `action=3`，而我只试了 `action=1`
 *      （它返回一句**误导性的**「访问人数太多」）。
 *
 * 现在：后端每次重读。有登录就抓官方 ✓，抓不到才退回人工清单 ✓。
 * 官方数据里 **`itemIds` 是当期需要交的收集品（并集）** —— 那才是
 * "该去摸什么"的答案；`offers` 是"能换到什么"。
 */
const marketRows = computed(() => {
  const byId = new Map(itemsStore.items.map((it) => [it.sourceItemId, it]))
  return metaStore.marketItemIds
    .map((id) => byId.get(id))
    .filter((it): it is NonNullable<typeof it> => it !== undefined)
    .map((item) => ({
      item,
      spread:
        item.price !== null && item.basePrice !== null ? item.price - item.basePrice : null,
    }))
})

/** 兑换项：把 ID 换成名字（换到的物品可能不在我们主数据里，就显示 ID）*/
const marketOffers = computed(() => {
  const byId = new Map(itemsStore.items.map((it) => [it.sourceItemId, it]))
  const nameOf = (id: string): string => byId.get(id)?.name ?? `物品 ${id}`
  return metaStore.marketOffers.map((o) => ({
    key: `${o.itemId}-${o.requires.map((r) => r.itemId).join('_')}`,
    productName: nameOf(o.itemId),
    productQty: o.qty,
    needText: o.requires.map((r) => `${nameOf(r.itemId)}×${r.qty}`).join(' + '),
  }))
})

/** 活动倒计时（集市是周级活动，用"还剩几天"就够）*/
const marketCountdown = computed(() => {
  const end = metaStore.marketEndAt
  if (end === null) return null
  const ms = end * 1000 - Date.now()
  if (ms <= 0) return '已结束'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? `还剩 ${days} 天 ${hours} 小时` : `还剩 ${hours} 小时`
})

const hasMarketData = computed(() => itemsStore.items.length > 0)
/** 清单为空 = 还没拿到数据（要如实显示，不能拿别的数据顶上）*/
const marketEmpty = computed(
  () => hasMarketData.value && marketRows.value.length === 0 && metaStore.marketItemIds.length === 0,
)

onMounted(async () => {
  // 密码自己一个接口（后端有半小时缓存，打开首页最多打一次源站）
  // 物品列表和"价值榜"页共用同一份 store，所以那边切过去时是瞬间的
  await Promise.all([dailyStore.load(), itemsStore.load(), metaStore.load()])
})
</script>

<template>
  <div class="home">
    <header class="head">
      <h1>一图流首页</h1>
      <p class="sub">每天上线先看这三样：今天的密码 · 哪些值得买 · （制造推荐缺配方）</p>
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

      <!-- ══════════ 特勤处制造推荐（缺"配方"那一步）══════════ -->
      <section class="df-card card">
        <div class="card-head">
          <h2>特勤处制造推荐</h2>
          <el-tag size="small" type="info" effect="plain">缺配方</el-tag>
        </div>

        <p class="placeholder">
          目标是像截图那样，按<b>制造台</b>（技术中心 / 工作台 / 制药台 / 防具台）
          给出<strong>当前利润最高的产物</strong>。
        </p>
        <p class="placeholder dim">
          <b>已完成的部分：</b>账号已登录、大区已绑定，制造接口（<code>365589</code>）
          已能取到 —— 它返回 4 个制造台的状态，<b>与截图里的 4 个卡片一致</b> ✓。
          <br />
          <b>还差的部分：</b><b>配方</b>（材料 → 产物 + 产出数量）✗ ——
          那个接口里没有；目前最可能在 <code>dfm/config.list</code>（它还差一个参数形状）。
          <br />
          有了配方才能算「当前利润 = 产物售价 − 材料成本 − 手续费」——
          所以它和左边那个「最高利润」卡在等同一个前提（手续费公式）。
        </p>
      </section>

      <!-- ══════════ 集市物品（价格真、利润占位）══════════ -->
      <section class="df-card card wide">
        <div class="card-head">
          <h2>集市物品</h2>
          <span class="dim small">
            <template v-if="metaStore.marketSource === 'official'">官方军需处 · 当期需要交的收集品</template>
            <template v-else>当期需要交的收集品（人工维护）</template>
            <template v-if="marketCountdown"> · {{ marketCountdown }}</template>
          </span>
        </div>

        <div v-if="!hasMarketData" class="placeholder">
          还没取到物品数据。等一会儿或去「物资价值榜」页看看状态。
        </div>

        <!-- 没拿到清单：如实说 -->
        <div v-else-if="marketEmpty" class="placeholder dim">
          待补 —— 没能从官方接口拿到当期清单。<br />
          集市需要登录才能读（军需处接口），或手工填：
          <code>npm run market:set 物品名1 物品名2</code>
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
              <td :class="r.spread === null ? 'dim' : r.spread > 0 ? 'up' : 'down'">
                <template v-if="r.spread === null">—</template>
                <template v-else>
                  {{ r.spread > 0 ? '+' : '' }}{{ formatMoney(r.spread) }}
                </template>
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

        <!--
          ⭐ 兑换项："交什么 → 得什么"。
          官方数据里同一期存在「两件都要」「只要 A」「只要 B」三种，
          所以上面那张表是**并集**（要摸什么），这里是**具体菜单** ✓
        -->
        <div v-if="marketOffers.length > 0" class="offers">
          <div class="offers-title dim small">
            当期能换什么（共 {{ marketOffers.length }} 项）：
          </div>
          <ul>
            <li v-for="o in marketOffers" :key="o.key">
              <span class="need">{{ o.needText }}</span>
              <span class="arrow">→</span>
              <span class="got">{{ o.productName }}</span>
              <span v-if="o.productQty > 1" class="dim">×{{ o.productQty }}</span>
            </li>
          </ul>
        </div>

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

/* ── 集市兑换项 ── */
.offers {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--df-border);
}
.offers-title {
  margin-bottom: 6px;
}
.offers ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 4px 18px;
}
.offers li {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 13px;
  padding: 2px 0;
}
.offers .need {
  color: var(--df-text-dim);
}
.offers .arrow {
  color: var(--df-accent);
}
.offers .got {
  font-weight: 600;
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
