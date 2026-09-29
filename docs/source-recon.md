# 数据源探测记录（Phase 0）

> 探测时间：2026-09-28 14:31 ~ 14:55
> 探测方式：只读 HTTP 请求（curl / node fetch），未登录任何账号、未使用 Cookie
> 探测人：Pi（AI 助手）+ 用户确认

本文件的目的：**记录试过哪些 URL、各自返回什么、结论是什么**，避免将来重复探测同一批地址。

---

## 结论摘要

| 数据源 | 可用性 | 定位 |
|---|---|---|
| **腾讯官方 AMS 接口** | ✅ **完全可用，无需登录/签名/加密** | **v1 主源** |
| moligod.com | ✅ 技术可用（AES-GCM 已破解） | 可选对比源（默认关闭） |
| dergame.cn | ✅ 可用但每次上限 100 条、无翻页 | 可选对比源（默认关闭） |

**Phase 0 的核心成果：官方接口同时提供「价格 + 占格数」，因此按方案预定的分叉规则，伦理问题不再需要决策。**

---

## 一、腾讯官方接口（✅ 主源）

### 1.1 接口定义

```
POST https://comm.ams.game.qq.com/ide/
  ?iChartId=352143
  &iSubChartId=352143
  &sIdeToken=YWRywA
  &method=dfm/object.list
  &source=2
  &param=<URL 编码的 JSON>
```

`param` 的 JSON 结构：

```json
{ "primary": "props", "second": "collection", "objectID": "" }
```

- `primary`：大类。留空返回 0 条（**不等于全量**）
- `second`：子类。留空时返回该大类全部子类
- `objectID`：官方物品 ID。填了则只返回该物品（实测返回 1 条，865 字节）

### 1.2 关键实测结论

| 事项 | 实测结果 |
|---|---|
| 需要 Cookie / 登录吗 | **不需要**。完全匿名请求即返回数据 |
| 需要签名吗 | **不需要**。URL 里的 `sIdeToken=YWRywA` 是公开静态值 |
| 有加密吗 | **没有**。明文 JSON |
| robots.txt | **404（无 robots.txt，无禁止声明）**。对比：moligod 与 dergame 都写了 `Disallow: /api/` |
| 一次能否拉全量 | **不能**。`primary` 全空时响应超过 2.2MB，**服务端会中途断开**（两次实测均 `curl: (18)`）。必须按大类分别请求 |
| 限流 | 未观测到。连续请求 + 间隔 0.8~3 秒均正常 |
| 无效 method 的报错 | 返回 `ret:-201 sMsg:"抱歉，目前访问人数太多！"`（⚠️ **误导性报错**，实际含义是方法不存在，不是限流） |
| 价格是否实时跳动 | **稳定**。同一物品在 1 分钟内外多次查询，`avgPrice` 完全一致（海洋之泪 = 33478148）→ 说明是统计均值/缓存值，**不需要高频抓取** |

### 1.3 大类清单（共 7 类，1592 条）

| primaryClass | 条数 | 说明 |
|---|---|---|
| `props` | 711 | 道具（收集品 586 + 钥匙 80 + 消耗品 34 + 曼德尔砖 11） |
| `acc` | 576 | 配件 |
| `ammo` | 113 | 弹药 |
| `protect` | 98 | 防护（头盔/护甲/背包/胸挂） |
| `gun` | 68 | 枪械 |
| `vehicle` | 16 | 载具 |
| `skin` | 10 | 皮肤（如「图灵砖-粥粥乐队」） |
| **合计** | **1592** | 7 次请求，约 1.4 MB |

其它试过但返回 0 条的大类名：`other` `misc` `special` `consume` `key` `mandel` `material` `resource` `item` `box` `task`。

### 1.4 字段清单（实测）

```jsonc
{
  "id": 10165,                  // AMS 内部 ID
  "objectID": 15010050001,      // ⭐ 官方物品 ID（第三方站的 ID 都是它的衍生）
  "objectName": "黄金瞪羚",
  "length": 2,                  // ⭐ 占格（长）
  "width": 2,                   // ⭐ 占格（宽）
  "grade": 6,                   // 品质 0~6
  "weight": "2.9",              // ⚠️ 字符串
  "primaryClass": "props",      // 大类
  "secondClass": "collection",  // 子类
  "secondClassCN": "收集品",     // ⭐ 子类中文名（含曼德尔砖单独成类）
  "desc": "黄金瞪羚，约300年历史…",
  "pic":  "https://playerhub.df.qq.com/playerhub/60004/object/15010050001.png",
  "prePic":"https://playerhub.df.qq.com/playerhub/60004/object/p_15010050001.png",
  "avgPrice": 424862,           // ⭐ 官方统计均价（0 表示非卖品/无价）
  "propsDetail": {
    "type": "工艺藏品",           // 道具细分类
    "propsSource": "长弓溪谷-钻石皇后酒店,航天基地-核心区"   // ⭐⭐ 出产地图与点位
  }
}
```

### 1.5 ⭐ 官方独有的 `propsSource`（出产地）

`propsSource` 直接给出「**哪张地图的哪个地点会刷出这个物资**」：

```
黄金瞪羚   => 长弓溪谷-钻石皇后酒店, 航天基地-核心区
强化碳纤维板 => 零号大坝-水泥厂, 航天基地-工业区
火箭燃料   => 航天基地-核心区, 航天基地-工业区
摄影机    => 长弓溪谷-哈夫克雷达站, 航天基地-核心区
显卡     => 长弓溪谷-哈夫克雷达站, 航天基地-核心区
海洋之泪   => 潮汐监狱-全地图
```

覆盖率：`propsSource` 有值 **323/1592**；`propsDetail.type` 有值 **581/1592**（主要覆盖 props 类）。

moligod 与 dergame **都没有这个字段**。这是官方源不可替代的核心价值，也是用户原始需求「哪些物资可以摸」的字面答案。

---

## 二、moligod.com（对比源）

### 2.1 取数方式

```
GET https://moligod.com/api/market/trade-house-snapshot
→ Content-Type: application/octet-stream
→ 响应头 x-trade-house-key: <密钥字符串>
```

### 2.2 ⚠️ 加密协议（完整逆向结论）

站长对数据做了「防机器人」包裹（**密钥随响应头明文下发，属于摩擦装置而非访问控制**）：

```
响应体布局：
  byte[0]      = 版本号，必须为 1
  byte[1..13]  = 12 字节 AES-GCM IV
  byte[13..]   = AES-GCM 密文（末尾 16 字节为认证标签）

密钥 = SHA-256(响应头 x-trade-house-key 的值)   ← 作为 raw key 直接导入
AAD  = "trade-house-snapshot-v1"
明文 = gzip 压缩的 JSON
```

**实测已验证可解密成功**（`status=ok`，1718 条）。

### 2.3 响应结构

顶层：`{ status, encoding, generated_at(ms), ttl_seconds(300), total, items[], filters{categories, subcategories, grades} }`

Item 字段：`id, object_id, name, display_name, alias_name, category, category_cn, subcategory, item_subtype, grade, icon_url, base_price(字符串), current_price, yesterday_avg_price, yesterday_low, yesterday_high, seven_day_low, seven_day_high, width, length, last_update`

### 2.4 与官方源的对比（名称匹配 1549/1574 = 98.4%）

| 维度 | 官方 AMS | moligod |
|---|---|---|
| 物品数 | 1592 | 1718 |
| 占格 | ✅ | ✅ |
| 价格 | `avgPrice`（官方统计均价） | `current_price`（现价） |
| 出产地 `propsSource` | ✅ | ❌ |
| 昨日均价 / 7 日高低 | ❌ | ✅ |
| 按耐久度区分 | ❌（头盔/护甲只有一个均值） | ✅（全新/几乎全新/破损 各一条） |
| 载具 | 16 条 | 1 条 |
| 加密 | 无 | AES-GCM |
| robots.txt | 无 | `Disallow: /api/`、`/moligod` |

### 2.5 ⚠️ 价格口径差异（重要）

1276 条两边都有价格：

- 平均绝对偏差 **7.40%**
- 偏差 ≤1%：129 条；≤5%：720 条（56%）
- **极端离群值**：

| 物品 | 官方 avgPrice | moligod 现价 | 偏差 |
|---|---|---|---|
| 扑克牌-6 | 5,895 | 906 | **+550.7%** |
| 扑克牌-5 | 5,129 | 905 | +466.7% |
| 扑克牌-8 | 4,647 | 908 | +411.8% |
| 轻型防弹衣 | 3,146 | 88,258,292 | **−100.0%**（耐久度差异） |
| 扑克牌-2 | 2,896 | 15,002 | −80.7% |

**解读**：两者口径不同 —— 官方 `avgPrice` 是跨耐久度的统计均价，moligod 的 `current_price` 是特定耐久度下的现价。阿萨拉牌（扑克牌）这类物品的价差尤其大。

**处理方式**：v1 以官方 `avgPrice` 为唯一权威价，UI 明确标注价格口径；moligod 降为**可选对比源（默认关闭）**，用于人工核对分歧。

---

## 三、dergame.cn（对比源）

### 2.6 dergame 复测修正（2026-09-28 15:40）

> ⚠️ **下面这一节修正了本文件早期版本的错误结论。** 早期版本写的是「dergame 无法作主源」，那是**测试不够彻底导致的误判**。

#### 早期误判的原因

早期只试了 `type` 一个维度，以及 8 个**不存在**的分页参数名，得出「硬上限 100 条、无翻页」的结论。实际上：

1. **不传 `grade` 反而比传具体 grade 拿得多**：`{type:["枪械"],grade:[]}` → 68 条，而 `{type:["枪械"],grade:["枪械"]}` → **0 条**。早期按 grade 拆枪械时全军覆没，才误以为枪械拿不到。
2. **`name` 参数可以和 type+grade 组合**：`{type:["配件"],grade:["绿色"],name:"a"}` → 25 条（真的过滤了）。未知字段 `primary` / `second` / `filter` / `sub` / `class` / `keyword` 全部被忽略。
3. 因此 100 条上限**可以通过「type × grade × name 关键词」多维拆分绕过**。

#### 最优抓取策略与实测覆盖率

```
对每个 type：
  1. 先发 {type, grade:[]}
  2. 若撞 100 上限 → 按 8 个 grade 拆
  3. 若仍撞上限 → 再用 27 个 name 关键词（a-z + 0-9 + 高频汉字）拆
  4. 合并去重
→ 约 320 次请求，抓到 1455 条唯一物品
```

对官方 1289 条**有价**物品的覆盖率：

| 大类 | 有价条数 | dergame 命中 | 覆盖率 |
|---|---|---|---|
| 道具（收集品/钥匙/消耗品/曼德尔砖） | 460 | 459 | **100%** |
| 防护（头盔/护甲/背包/胸挂） | 85 | 85 | **100%** |
| 枪械 | 68 | 68 | **100%** |
| 弹药 | 102 | 101 | 99% |
| 配件 | 574 | 464 | 81% |
| **合计** | **1289** | **1177** | **91.3%** |

**「摸金核心」子类（收集品/钥匙/消耗品/头盔/护甲/背包/胸挂）：545 条有价 → 命中 544 条 = 99.8%**

缺口集中在改装件：`枪管` 缺 97/155、`枪口` 缺 8/42、`瞄具` 缺 5/46、`消耗品` 缺 1/31。

#### 但代价很大，所以仍然不作主源

| | dergame | moligod |
|---|---|---|
| 每轮请求数 | **约 320 次** | **1 次** |
| 每轮流量 | 约 10 MB | 93 KB |
| 按 30 分钟一轮的月流量 | **约 14 GB** | 约 134 MB |

**结论修正为：dergame 数据可用（摸金核心 99.8% 覆盖），但抓取成本是 moligod 的 320 倍，因此定位为「moligod 失效时的应急备份源」，而非主价格源。**

#### 同时发现 dergame 前端的两个 bug（不影响 API，但说明其维护质量）

1. **点击筛选标签不重新请求**：`P()` 只做 `router.replace({query})`，从不调用发请求的 `T()`；`T()` 只在 `onMounted` 和两个搜索按钮里被调用 → 所以改筛选后必须手动刷新页面才生效。
2. **`grade:"枪械"` 作为筛选值返回 0 条**，而它 UI 里明确提供了这个选项。

#### 它独有、moligod 没有的能力

```
POST /api/Items/chartData   { itemId, chartType: 7 | 30 }
→ { name, values: [{ avg_price, max_price, min_price }] }
```

7 日 / 30 日历史价格曲线。moligod 只有 7 日高低两个点，没有曲线。**这是 dergame 唯一不可替代的能力**，v2 若要做走势图可从这里取。

---

### 2.7 早期版本的原始结论（已作废，保留作记录）

```
POST https://dergame.cn/api/Items/search
Content-Type: application/json
body: {"type": ["收集品"], "grade": []}   或   {"name": "M4"}
→ {"code":0, "updateTime":"…", "msg":"获取成功", "data":[…]}
```

| 事项 | 实测结果 |
|---|---|
| 需要鉴权 | 不需要 |
| **单次上限** | **硬上限 100 条** |
| 翻页 | ❌ **无**。试过 `limit` `limit:1000` `offset` `skip` `start` `pageIndex` `pageNo` `size` 共 8 个参数名，全部被忽略（首条 id 恒为同一值） |
| GET 带查询参数 | 被忽略，筛选必须用 POST |
| 独有能力 | `POST /api/Items/chartData` `{itemId, chartType:7或30}` → 历史价格曲线 |
| robots.txt | `Disallow: /api/` |

~~**结论：无法作主源**——它的 `props` 类实际有 700+ 条，但每次只返回 100 条，最值钱的钥匙类基本拿不到。~~

**↑ 该结论已于 2.6 节修正为：可用，但抓取成本过高。**

### 品质颜色映射（从 dergame 的 CSS 变量实测，权威）

```
grade 0 → 灰 #949595   （枪械 / 载具，无品质）
grade 1 → 白 #cdd5d5
grade 2 → 绿 #188d14
grade 3 → 蓝 #658bce
grade 4 → 紫 #9b61c8
grade 5 → 金 #e8a64e
grade 6 → 红 #cb464a
```

⚠️ dergame 前端筛选器给的选项是「枪械/白色/绿色/蓝色/紫色/金色/红色/非卖品」共 8 个，对应 7 个 `grade` 值 —— **若按选项猜映射必然错位**，必须用 CSS 变量。

---

## 四、试过但走不通的路径

| 尝试 | 结果 |
|---|---|
| `https://playerhub.df.qq.com/` 根路径 | 403 AccessDenied（腾讯云 COS 对象存储桶） |
| `.../object/<objectID>.json` | 404 NoSuchKey（只有 `.png` / `p_<id>.png` 可读） |
| COS 列目录 `?prefix=...` | 403 AccessDenied（无 ListBucket 权限） |
| `manifest.json` / `index.json` 等清单文件 | 全部 404 |
| `https://df.qq.com/` 官网 | 只是活动推广页，无任何数据接口 |
| 其它 method 名（`dfm/object.price`、`dfm/market.list`、`dfm/trade.list`、`dfm/object.detail`、`dfm/price.list`） | 全部 `ret:-201`（方法不存在） |
| 官方接口文档 `df-api.apifox.cn` | 社区整理，**作者已声明停止维护**，且明确要求「Openid 和 Accesstoken 请自行抓包获取」→ 但**实测 `dfm/object.list` 并不需要凭据** |

---

## 五、影响方案的技术结论

1. **不需要 Playwright / 无头浏览器 / HTML 解析 / OCR** —— 三个源都是纯 HTTP 结构性数据。
2. **不需要手工维护占格映射表** —— 三个源都直接提供 `length`/`width`。
3. **不需要为了伦理问题牺牲功能** —— 官方源覆盖 1592 条且含独有字段。
4. **官方源没有涨跌幅数据** —— 需要我们自己按时存快照，攒够两天后即可计算「昨日均价」「7 日高低」。
5. **官方源 `protect` 类不分耐久度** —— 该类价格需在 UI 上标注口径差异。
6. **抓取预算**：7 次请求 / 轮，约 1.4 MB / 轮。按 30 分钟一轮计 ≈ 336 请求/天、约 2 GB/月；由于 `avgPrice` 稳定不跳动，**无需更高频率**。
7. **`weight` 是字符串**、`avgPrice` 可能是 `0` 或缺失 —— normalize 阶段必须显式转换与校验。

---

## 六、原始响应留存

本轮探测的原始响应已保留在 `.recon/raw/`，用于将来对照字段变化：

```
ams-props-all.json          ams-acc-all.json         ams-gun-all.json
ams-ammo-all.json           ams-protect-all.json     ams-vehicle-all.json
ams-object-list.props-collection.json                ams-single-object.json
moligod-snapshot.json       （在 .recon/ 根目录，解密后的全量快照）
```

---

## 七、join 阶段实测到的字段陷阱（Phase 3，2026-09-28）

这一节记录实现阶段才暴露出来的问题。**都是被运行时校验（zod）抓住的，不是靠读文档发现的。**

### 7.1 ⚠️⚠️ moligod 同一字段类型不一致（最坑的一个）

`moligod` 的 1718 条中，有 **343 条的数值字段是【字符串】**，其余 1375 条是数字：

```json
{"name":"H70 精英头盔", "current_price":"2163983", "base_price":"2163983", ...}
{"name":"海洋之泪",     "current_price": 34275453,  "base_price":"31710588", ...}
```

`base_price` 则**全部 1718 条都是字符串**。

**后果（实测）**：若按 `z.number()` 严格校验，这 343 条会被静默丢弃。
而它们恰好是官方主数据要匹配的**头盔/护甲**，于是连带把名称匹配率
从 **98.5% 拉到 78.4%**（1236/1576）—— 一个类型错误造成两个看上去毫无关联的症状。

**处理**：数值字段全部用 `z.union([z.number(), z.string()])` 接收，再用统一的
转换函数处理。**教训：外部数据的字段类型不能假设，即使同一字段在同一源内也必须容忍多形态。**

### 7.2 `last_update` 可能是 `"N/A"`

上述 343 条非卖品的 `last_update` 是字符串 `"N/A"`，不是时间。
直接往下传会让网页显示一个叫 `N/A` 的时间，所以适配器层就把它归一化成 `null`。

### 7.3 官方数据里有重名条目

实测 `.300BLK` 在官方出现了 **3 次**，且官方均价各不相同：

```
.300BLK  [弹药/7.62x35mm]  官方均价 4,960
.300BLK  [弹药/7.62x35mm]  官方均价 1,705
.300BLK  [弹药/7.62x35mm]  官方均价   445
```

三条的 `objectID` 不同，但名称完全相同。这意味着：
· 按名称 join 时它们会共用同一个价格源条目（只能命中一个）
· 网页上会出现三行同名不同价的条目（可以靠 objectID 区分）

### 7.4 官方不分耐久度、moligod 分（导致 8 条头盔拿不到价格）

```
官方：   "D6 战术头盔"（一条，官方均价为跟耐久度无关的均值）
moligod："D6 战术头盔（全新）" / "（几乎全新）" / "（破损）"（三条，价格差异大）
```

精确匹配必然失败。实测**靠「去掉括号后缀」能救回 8 条，全部是头盔**；
但选择哪个耐久变体有歧义（不同耐久价格差很大），所以 v1 选择
**不做模糊匹配，让它们显示"暂无价格"**，而不是猜一个。

### 7.5 最终 join 结果（实测）

```
官方主数据           1,576 条
Moligod 名称索引      1,722 个键

① 匹配 + 有价格       1,283   (81.4%)
② 匹配 + 无价格         270   （join 正确，只是该物品非卖品）
③ 名字找不到            23   (1.5%)

名称匹配率 98.5% · 价格覆盖率 81.4%
```

那 23 条的完整构成：

| 数量 | 原因 | 能否修复 |
|---|---|---|
| 10 | 皮肤（图灵砖/喷漆/头像/军牌）| ❌ 到处都是无价，也不可携带，不影响 |
| 8 | 头盔的耐久度命名差异 | ⚠️ 可修但需先定「取哪个耐久」| 
| 3 | `.300BLK` 官方重名 | ❌ 价格源本身就只有一条 |
| 2 | `M249H.A.V.K链锯套件` 等护木 | ❌ moligod 确实没有这两条 |

### 7.6 按大类的价格覆盖率（实测）

| 大类 | 物品数 | 有价格 | 覆盖率 | 有出产地 |
|---|---|---|---|---|
| 道具 | 711 | 467 | 65.7% | 323 |
| 配件 | 576 | 572 | 99.3% | 0 |
| 弹药 | 113 | 99 | 87.6% | 0 |
| 防护 | 98 | 77 | 78.6% | 0 |
| 枪械 | 68 | 68 | 100.0% | 0 |
| 皮肤 | 10 | 0 | 0.0% | 0 |

道具覆盖率低是因为里面包含大量非卖品（藏宝图、阿萨拉牌等），不是 join 问题。

---

## 八、护甲价格与同名物品（Phase 6.5，2026-09-28）

> 这一节的两个结论都是**用户提示后实测发现的**，不是推测。
> 起因：用户指出「`.300BLK` 不同品质是不同的三种子弹」——
> 顺着这句话查下去，发现了一个影响 51 件护甲的价格口径错误。

### 8.1 ⚠️ moligod 对护甲给了 4 个条目，「裸名」那个不是行情

以 `H70 精英头盔` 为例，moligod 快照里同时存在：

| 名称 | `current_price` | `yesterdayAvg` | `updateTime` |
|---|---|---|---|
| `H70 精英头盔`（**裸名**）| 2,163,983 | `null` | `null` |
| `H70 精英头盔（全新）` | 4,003,281 | 3,817,828 | `2026-09-28 19:04` |
| `H70 精英头盔（几乎全新）` | 1,017,434 | 有 | 有 |
| `H70 精英头盔（破损）` | 707,547 | 有 | 有 |

**裸名条目的 `current_price === base_price`，且没有昨日均价、没有更新时间
—— 它是"基础参考价"，不是交易行行情。**

#### 铁证：官方 `avgPrice` 与裸名吻合

拿官方主数据的 `avgPrice` 与这四档逐一对比（差异 <25% 才算"像"）：

| 护甲 | 官方均价 | 裸名 | 全新 | 几乎全新 | 破损 | 最接近 |
|---|---|---|---|---|---|---|
| H70 精英头盔 | 1,780,559 | 2,163,983 | 4,003,281 | 1,017,434 | 707,547 | **裸名 (22%)** |
| HA-2防弹装甲 | 3,361,471 | 3,085,130 | 5,086,836 | 3,892,861 | 1,738,965 | **裸名 (8%)** |
| H09 防暴头盔 | 273,518 | 269,832 | 332,821 | 181,781 | 116,441 | **裸名 (1%)** |
| GN 重型头盔 | 166,690 | 139,160 | 215,615 | 127,726 | 114,337 | **裸名 (17%)** |

**统计：裸名 72 件 / 全新 5 / 几乎全新 5 / 破损 3（共 85 件可比）。**

结论：moligod 的裸名 = 官方的"基础参考价"，也就是官方自述
**"仅供参考、实时价请去游戏内查看"** 的那个数。而我们明令禁止用它做价格源。

#### 影响面

- **51 件护甲**的裸名条目只有基础价（无实时行情）→ 之前全部用了错的口径
- **8 件**（`D6 战术头盔`、`MHS 战术头盔`、`DICH 训练头盔`、`GT1 战术头盔`、
  `防暴头盔`、`H07 战术头盔`、`DAS 防弹头盔`、`MC201 头盔`）moligod
  **只有带后缀的三档、没有裸名** → 按名称精确匹配直接失败
- 差距：H70 精英头盔 全新/破损 = **5.7 倍**

#### 处理方式

`prices/moligod.ts` 的 `mergeConditionVariants()` 把三档合并回裸名放进
`PriceQuote.variants`；选哪一档由 `metrics.pickEffectivePrice()` 决定
（常量 `ARMOR_PRICE_TIER`，当前 `'破损'`，最保守）。
三档同时通过 `Item.priceVariants` 下发给网页展示。

### 8.2 ⚠️ 官方有 6 组同名物品（13 条）

| 名称 | 条数 | 差异 |
|---|---|---|
| `.300BLK` | 3 | **品质 5/4/3，官方均价 5174 / 1717 / 439** |
| 零号大坝藏宝图8号 | 2 | 官方ID 相邻（…228 / …229）|
| 长弓溪谷藏宝图8号 | 2 | 同上 |
| 巴克什藏宝图8号 | 2 | 同上 |
| AZ3藏宝图8号 | 2 | 同上 |
| 航天基地藏宝图8号 | 2 | 同上 |

**name join 对同名物品会互相覆盖**，所以：

1. **价格侧**：moligod 用**品质前缀**区分同名子弹 ——
   `金.300BLK`（5，5193）/ `紫.300BLK`（4，1757）/ `蓝.300BLK`（3，452）。
   前缀字符集恰好是 `{红金紫蓝绿白}`，与 `GRADE_CN` 的 7 个值一致；
   拼出来的键**一定命中**且与官方均价相差 <5%。
   → 修复在 `join.ts` 的 `fallbackKeys()`（那里能看到物品品质）。
   不能放在适配器里：那里只有一个「名称 → 价格」的 Map，三个前缀
   拆回裸名会互相覆盖，只剩一条。

2. **人工标注侧**：键改为「名字唯一时用名字，同名时用官方ID」
   （`provenance-import.ts` 的 `--key auto`，现为默认）。
   实测 13 条走 ID 键，其余 1563 条保持名字键。

### 8.3 修复后的效果

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 名称匹配率 | 98.5% | **99.2%** |
| ① 有价格 | 1,283 | **1,294** |
| ③ 名字找不到 | 23 | **12** |
| 弹药有价格 | 99 / 113 | **102 / 113** |
| 防护有价格 | 77 / 98 | **85 / 98** |

剩下的 12 条"找不到"：**10 条皮肤**（本来就没有交易行价）+ **2 条配件**
（`M249H.A.V.K链锯套件`、`HVK格斗套件` —— 翻遍 moligod 全量条目确认**源里根本没有**，
属于数据源覆盖缺口，修不了）。

---

## 九、官方接口的第二批发现（优化轮，2026-09-29）

> 线索来源：GitHub 项目 `coolxi-tech/deltaforce`（PHP + ThinkPHP 写的一个自建 API）。
> **没有抄它的代码** —— 只是从它那里看到了**官方的 iChartId 与 sIdeToken**，
> 然后我们直接实测官方接口（和 Phase 0 用官方 352143 是同一套做法）。

### 9.1 该项目的结构（供参考）

- `app/controller/Game.php` 里有 `items / price / password / manufacture /
  quartermaster / config / place / recommendation` 等方法
- 每个方法都是 POST 到同一个 `https://comm.ams.game.qq.com/ide/`，
  **靠不同的 `iChartId` + `sIdeToken` 区分功能**
- 它自己的 `public/df.db` 只有一张空表 `df_access`（存用户 token）——
  **没有内置游戏数据**；`config/ammo.php` 是作者硬编码的静态弹药表
- 它的 `robots.txt` 是 `User-agent: *` + 空的 `Disallow:`（允许所有）

### 9.2 ⭐ 实测：哪些接口**不需要登录**

**方法**：带 UA 直接 POST，**不带任何 cookie / openid / access_token**。

| 功能 | iChartId | sIdeToken | 额外参数 | 实测结果 |
|---|---|---|---|---|
| 物品列表（我们已在用）| 352143 | `YWRywA` | `method=dfm/object.list&source=2` | ✅ `ret=0` |
| **每日地图密码** | 352143 | `YWRywA` | `method=dfm/center.day.secret&source=2` | ✅ **`ret=0`** |
| 配置表 | 352143 | `YWRywA` | `method=dfm/config.list&source=5` | ✅ `ret=0` |
| 地点/设施 | 352143 | `YWRywA` | `method=dfm/place.list&source=2` | ✅ `ret=0` |
| **制造** | **365589** | `bQaMCQ` | `source=5` | ❌ **`ret=101`（未授权）** |
| **军需处** | **530479** | `SwgEeH` | `action=1` 或 `3` | ❌ **`ret=101`（未授权）** |
| 官方现价 | 352143 | `YWRywA` | `method=dfm/object.price.latest` | ❌ 需要登录（据该项目代码）|

⚠️ **在 `manufacture` / `quartermaster` 上我们猜测过"它传 cookie 只是多此一举"，
实测证明猜测错了** —— 这两个确实要登录（`ret=101`）。
而 `center.day.secret` 反过来：该项目传了 cookie，但**其实不需要** ✓
（教训：凭据要求只能实测，不能从别人代码的调用方式推断。）

### 9.3 每日地图密码（✅ 可用）

`POST /ide/?iChartId=352143&iSubChartId=352143&sIdeToken=YWRywA&method=dfm/center.day.secret&source=2`

返回（2026-09-29 实测）：

```json
{"ret":0,"jData":{"data":{"data":{"list":[
  {"mapID":1,"mapName":"零号大坝","secret":"1690"},
  {"mapID":?, "mapName":"长弓溪谷","secret":"0178"},
  {"mapName":"巴克什","secret":"9951"},
  {"mapName":"航天基地","secret":"1471"},
  {"mapName":"潮汐监狱","secret":"8485"},
  {"mapName":"AZ3","secret":"2516"}]}}}}
```

- **6 张图，每天变**，`secret` 是 4 位数字（注意可能是 `"0178"` 这种**带前导零**的字符串，
  必须按字符串处理，转数字会丢 `0`）
- 与我们的物品源**同一个 host、同一个 iChartId**，所以对源站的影响特征不变
- 响应约 500 字节

### 9.4 特勤处设施数据（✅ 可用，但注意它不是"制造"）

`dfm/place.list` 返回 47 个 `place`，每个带 `placeDetail`：

```json
{"place":"collect","placeDetail":{
   "hafCount":420000,                      // 升级要花的哈夫币
   "condition":"解锁等级43",                // 等级条件
   "required":[{"objectID":15080050099,"count":?}]}}  // 所需材料
```

- 这是**设施升级需求**（成本 + 材料 + 等级 + 属性加成）
- ⚠️ **不是**"制造配方" —— 制造在 `iChartId=365589`（要登录）
- 附带 `relateMap`：379 个物品的详情（名称/品质/重量/avgPrice），
  是这些设施需求里引用到的物品，**不是"物品↔地点"的出产地映射**（这点曾被我猜错）

### 9.5 结论：与用户三个需求的对应关系

| 用户需求 | 数据来源 | 可行性 |
|---|---|---|
| 每日地图密码 | `dfm/center.day.secret` | ✅ **公开可用，可立即实现** |
| 军需处 / 集市利润 | `iChartId=530479` | ⚠️ 需要**用户账号登录**（`ret=101`）|
| 特勤处制造推荐 | `iChartId=365589` | ⚠️ 需要**用户账号登录** |
| （替代方案）利润 | moligod 的现价 − 基准价 | ✅ 公开（我们已有 1276 条可算，其中 932 条为正差额）|

⚠️ **合规边界**：本项目的既定原则是「只读公开接口、不绕过登录」（PLAN §12.12）。
上面标 ✅ 的接口**无需任何凭据**，与我们在用的物品源同源同权限，属于公开接口 ✓；
标 ⚠️ 的接口**明确要求登录**，用它们必须由**用户本人**提供其账号凭据 ——
这是一个涉及账号安全与游戏条款的决定，**由用户知情后自行决定**。

---

## 十、登录成功之后：到底多拿到了什么（2026-09-29 实测）

### 10.1 扫码登录：换了一份公开实现才对

原先照一份 PHP 实现写，扫码能成功但拿到的 `p_skey` 是**受限的**
（cookie 里出现 `p_skey_forbid`，且始终没有 `skey`），
请求授权时腾讯返回 `oauth2.0/show?which=Login`。

改用 https://blog.sakurasen.cn/post/1769803187575/ 的流程后**一次通过**：

| 项目 | PHP 那份 | blog 那份（采用）|
|---|---|---|
| 先请求 `xlogin` 拿 `pt_login_sig` | 是 | **否** |
| 轮询的 `login_sig` | `pt_login_sig` | **`qrsig`** |
| 轮询参数 | 多带 `action`/`o1vId`/`pt_uistyle` | 带 `has_onekey=1`、`js_ver=25112611`、`pt_js_version=42f2bcc1`、`h=0` |
| 轮询 `Referer` | 无 | **xlogin 地址** |
| `p_skey` 来源 | 从 cookie 罐里翻 | **第 ③ 步响应的 Set-Cookie** |
| 授权表单 | `form_plogin=1`、`auth_time` 秒 | **`form_ptlogin=1`、`auth_time` 毫秒** |

⚠️ 实测第 ③ 步下发的 cookie 是
`pt2gguin, p_uin, pt4_token, p_skey, pt_oauth_token, pt_login_type`
—— **没有 `skey`** ✓ 但流程照样走通 ✓。
所以"必须要有 skey"是我之前的错误推断。

### 10.2 登录解锁了什么（实测）

| 接口 | 未登录 | 登录后 |
|---|---|---|
| 物品列表 `dfm/object.list` | `ret=0` | `ret=0` |
| 每日密码 `dfm/center.day.secret` | `ret=0` | `ret=0` |
| **官方现价 `dfm/object.price.latest`** | 参数/鉴权失败 | ✅ **`ret=0`** |
| **每日价格历史 `dfm/object.price.recent`** | — | ✅ **`ret=0`** |
| 制造 `iChartId=365589` | `ret=101` | `ret=99998`「**请刷新页面，先绑定大区！**」|
| 军需处 `iChartId=530479` | `ret=101` | 同上 |

**制造/军需处只差一步「绑定大区」** —— 参考实现里的步骤（`Game.php`）：

1. `iChartId=316964` / `sIdeToken=95ookO` 查绑定状态（`jData.bindarea`）
2. 未绑定时查角色：`needGopenid=1&sAMSAcctype=qq&sAMSAccessToken=…&sAMSAppOpenId=…`
   `&sAMSTargetAppId=1110543085&sAMSSourceAppId=101491592&game=dfm`
   `&sCloudApiName=ams.gameattr.role&area=36&platid=1&partition=36`
3. 用返回的 `checkparam`/`md5str` 提交绑定：`iChartId=316965` / `sIdeToken=sTzZS2`
   + `sArea`/`sPlatId`/`sPartition`/`sCheckparam`/`sRoleId`/`md5str`

⚠️ 里面的 `area=36`、`platid=1` 是**写死的一个大区** —— 换个账号要改。
所以这条要问用户自己在哪个大区，不能替他决定。

### 10.3 ⛔ 「参考价」不在官方开放接口里

参考实现里出现的 method **总共只有 9 个**，已全部列出，
**没有任何一个是参考价/交易行手续费**：

```
dfm/center.day.secret      dfm/center.person.resource   dfm/center.recent.detail
dfm/config.list            dfm/object.list              dfm/object.price.latest
dfm/object.price.recent    dfm/place.list               dfm/solution.arms.list
```

实测 `dfm/object.price.latest` 只返回 `{objectID: {avgPrice}}` ✓，
`dfm/object.price.recent` 返回**最近 7 天的 `{date, avgPrice, count}`** ✓
—— 即"近期平均交易价格 + 交易量"，**没有参考价** ✗。

> 对「锈迹斑斑的海盗铜币」（官方 ID 15080050007）实测：
> `avgPrice = 23488`，与之前 Phase 0 量到的 23,340 吻合 ✓，
> 也与玩家截图里的**参考价格 2,860 相差 8 倍** ✓ ——
> 再次印证「`avgPrice` 不能当价格源」这条结论 ✓。

**推论**：参考价不在这些接口里。要么在**交易行**那条链（moligod 抓的就是它），
要么是客户端本地算的。**手续费公式的标定要继续，就得换个地方找参考价**
（或退一步：用 moligod 基准价 × 实测比例近似 —— 目前只有 1 个样本点，不够）。

### 10.4 新发现：官方有**交易量**数据

`dfm/object.price.recent` 每天带 `count`（成交笔数 ✓）。
对"这东西到底好不好卖"是有用信号 ✓ —— 比如某物资单格价值高但
成交量极低，说明挂着卖不掉。可以作为 v2 的排序因子考虑。

---

## 十一、⭐ 集市有官方接口（2026-09-29 实测，推翻 §十 的结论）

§十 里我写了「集市没有可用的官方接口」——**错了** ✗。
它就在**军需处**那个 chartId 里，只是要换 `action`：

```
POST https://comm.ams.game.qq.com/ide/
  iChartId=530479 & iSubChartId=530479 & sIdeToken=SwgEeH & action=3 & source=2
  Cookie: openid=…; access_token=…; acctype=qc; appid=101491592
```

返回（每期一组，实测当期 7 条兑换项）：

```json
{"ret":0,"jData":{"data":[
  {"Item":"11050004004,1",
   "ExchangedProps":"15080050007,1;15080050194,1",   ← ★ 需要交的收集品
   "IsBound":"1",
   "BeginTime":"1790301600","EndTime":"1790906399"},   ← ★ 活动起止
  {"Item":"13130000168,1","ExchangedProps":"15080050007,1", …},
  {"Item":"13130000164,1","ExchangedProps":"15080050194,1", …},
  …
]}}
```

**`15080050007` = 锈迹斑斑的海盗铜币、`15080050194` = 腕带**
—— 与用户当时在游戏里看到的「这次是腕带和海盗铜币」**完全一致** ✓✓

### 11.1 解析要点

| 字段 | 含义 |
|---|---|
| `Item` | `物品ID,数量` —— 兑换**得到**什么 |
| `ExchangedProps` | `物品ID,数量;物品ID,数量` —— 兑换**需要交**什么（★ 这才是"集市物品"）|
| `BeginTime` / `EndTime` | Unix 秒，活动起止 |
| `IsBound` | 是否绑定 |

**注意**：不是每个兑换项都要同样多的收集品 ——
实测当期有「两件都要」「只要铜币」「只要腕带」三种 ✓。
所以网页要展示的是**当期需要哪些收集品**（并集），而不是某一个兑换项 ✓。

### 11.2 `action` 的取值（军需处 530479）

| action | 结果 |
|---|---|
| 1 | `ret=-4000`「访问人数太多」（**误导性报错**，实为参数/状态不符）|
| **2** | `ret=0`，`data: []`（空数组 —— 不是集市）|
| **3** | ✅ **`ret=0`，集市兑换表** ✓ |
| 4 | `ret=190001`「系统繁忙」|

### 11.3 顺带确认的两件事

1. **`requestIde` 必须用 POST + 表单参数**（参考实现如此）。
   之前用 GET 探测制造/军需处拿到 `ret=101` / `ret=99998`，
   换成 POST 后正常 —— **`ret=101` 里有一部分是方法用错造成的**，不全是"未授权" ✗。
2. **绑定大区流程可用**（`iChartId=316964` 查状态 → `comm.aci.game.qq.com/main` 查角色
   → `iChartId=316965` 提交绑定），实测一次通过，
   绑定后制造（`365589`）返回 `placeData`：工作台 / 防具台 / 技术中心 / 药房 ✓
   —— 这正是首页「特勤处」那张卡要的数据 ✓。

### 11.4 其他 chartId 的用途（实测）

| chartId | sIdeToken | 返回 |
|---|---|---|
| 317814 | QIRBwm | **个人战绩**：`charac_name`、`rankpoint`、`totalprice`（总资产）|
| 318948 | Plaqzy | `userData`：物品 ID + 名称 + 品质（**个人库存**？）|
| 316969 | NoOapI | `center.person.resource` / `center.recent.detail` —— 需额外参数，`ret=190001` |
| 319386 | zMemOt | 需额外参数 |
| 365589 | bQaMCQ | ✅ 制造设施（绑定后可用）|
| 530479 | SwgEeH | ✅ `action=3` = 集市 |

---

## 十二、`dfm/config.list` 打开了（2026-09-29）

**卡了很久的原因：差一个 `param` 形状** ✗。我试过 `{}`、`{"type":"recipe"}`、
`{"key":"recipe"}`、`[]` 全是 `code=11001 参数校验失败`。
真身是：

```
param = {"configType":"all"}      ← ★ 猜不出来，是从第三方项目源码里读到的
method = dfm/config.list  & source=5
→ jData.data.data.config
```

整个响应只有 16KB，所以**不是配方表**（配方比这个大得多）✗。

### 12.1 `config` 里有什么（实测，去 keys 后的清单）

| 键 | 内容 | 判断 |
|---|---|---|
| `mapList` | **官方地图表**，分三类：`bd`(3) / `gun`(6) / `operator`(14) | ⭐ **有用** |
| `objectMapping` | 分类映射，8 个：`acc, ammo, assets, consume, gun, props, protect, vehicle` | ⭐ 说明我们漏了 `assets` |
| `keyTypeMapList` | 开锁方式：二指/三指/四指/五指/六指 | 小配置 |
| `gunSlotMap` | **枪械配件槽位表**，48 个（后握把/枪管/…，带 `sort` 与图标）| ⭐ 有用 |
| `exchange` | **部门兑换配置**，5 个部门 × 各自可兑换的物品类型 | ⭐ 待确认语义 |
| `cdnFormat` | 图标 CDN 前缀 `https://playerhub.df.qq.com/playerhub/60004/object/` | 工具用 |

### 12.2 `mapList` 三类（这是官方口径的地图名单）

| 类 | 内容 |
|---|---|
| `gun`（6，烽火地带）| 长弓溪谷 / 零号大坝 / 航天基地 / …，**每张图带 `difficulties`（normal/hard/elite）** |
| `bd`（3，大战场）| 航天中转站 / 蓝水屋电站 / 萨米尔山庄 |
| `operator`（14）| 攀升 / 烬区 / 临界点 / 贯穿 / 堑壕战 / 断轨 / … |

⚠️ 我们的「出产地」地图名是从**物品数据里的字符串**切出来的（截断只留地图名），
而这里是**官方口径的地图表 + 难度**。两者能否对齐需要实测比对。

### 12.3 `exchange` 的 5 个部门（待与用户确认语义）

| type | 名称 | 可兑换类型 |
|---|---|---|
| `fight` | 战斗部门 | 档案箱 / 枪械 / 外观 / 武器箱 / 门票 / 特殊道具 |
| `medic` | 医疗部门 | 材料箱 / 收集品 / 外观 / 药品 / 医药箱 / 特殊道具 |
| `rd` | 研发部门 | 钥匙卡包 / 外观 / 藏品箱 / 任务道具 |
| `tactics` | 战术部门 | 弹药箱 / 枪械配件 / 外观 / 物品箱 / 子弹 / 赛季限定子弹 |
| `logistics` | 后勤部门 | 背包 / 防弹衣 / 头盔 / 外观 / 胸挂 / 装备箱 |

### 12.4 `assets` 分类实测（不抓是对的）

`object.list` + `primary=assets` → **1840 条**，是**挂饰/外观**类：
字段结构和物品不同（用 `objectName` 而不是 `name`、`length/width` 为 0、
`primaryClass:"assets"`、`secondClass:"pendant"` 挂饰、`avgPrice:0`）。

**结论**：装饰品，无格数无价格 → 继续排除 ✓（和 `skin` / `vehicle` 同类）。

### 12.5 仍然找不到的

| 想要 | 状态 |
|---|---|
| **制造配方**（材料 → 产物 + 产出数量）| ✗ 不在 `config.list`、也不在制造 `365589`（那里只有 4 个台子的状态）|
| **交易行参考价** | ✗ 已知 9 个 method 里没有 |
| **手续费公式** | ✗ 同上 |
| 那两个集市产物 `32230000010` / `32230000017` | ✗ **任何分类里都没有**（不是物品主数据里的东西）|
