# AGENTS.md — 项目与协作者说明

> 本文件是给 AI 助手看的**工作约定**。每次对话开始前请先读完本文件。
> 最后更新：2026-09-28（Phase 6.5 完成后）

---

## 一、关于用户（务必先读）

### 1.1 技术背景

**已掌握：**
- **Python**（大学学过，有实际编程经验）——熟悉变量、函数、类、列表/字典、模块导入、`pip`、虚拟环境这类概念
- **C 语言**（大学学过）——熟悉指针、数组、结构体、头文件 `#include`、编译与链接、静态类型、`gcc`/`Makefile`
- 通用的编程概念：循环、条件、递归、数据结构、算法、面向对象

**完全没有基础：**
- JavaScript / TypeScript
- Node.js / npm / 包管理生态
- 任何前端框架（Vue / React）、构建工具（Vite / Webpack）
- 任何 Web 后端框架（Fastify / Express）
- HTML / CSS
- 数据库、HTTP 协议细节

### 1.2 因此：讲解规范（**硬性要求**）

1. **从名词解释开始。** 任何 JS 生态新名词第一次出现时，必须解释。解释时**优先用 Python / C 做类比**：
   - `npm` ≈ JavaScript 世界的 `pip`
   - `package.json` ≈ `requirements.txt` + `setup.py` 的合体
   - `package-lock.json` ≈ `pip freeze` 的输出 / `poetry.lock`
   - `node_modules/` ≈ 每个项目独立的 `site-packages/`
   - `tsx` ≈ 直接 `python xxx.py` 那样运行 TS（跳过单独编译步骤）
   - `Vite` ≈ 把一个 Python 项目打包成单个可执行文件的那种工具（但面向 Web）
   - `import type` ≈ C 里只用于编译期检查、编译后完全消失的东西（如 `#define` 常量、`// 注释`）
   - TypeScript 的类型系统 ≈ C 的静态类型 + 编译期检查，但**编译后类型全部消失**

2. **讲"为什么"，不只讲"做了什么"。** 用户明确说过"不要黑盒"。所以：
   - 每个设计要说清楚**它解决什么问题**
   - 如果有替代方案，说明**为什么不选它**
   - 如果去掉这个设计，说明**会有什么后果**
   - 涉及底层机制时（比如"为什么 `import type` 会被擦除"）要展开原理

3. **诚实。** 不要假装成功、不要跳过验证、不要把"应该可以"说成"已经可以"。做不到的事直接说做不到，并说明原因。

4. **不要用"专业但不解释"的表述。** 例如不要只说"配置了 workspaces"，要说"配置了 workspaces——也就是让一个仓库里放多个包，类似于 Python 的一个 monorepo"。

### 1.3 工作节奏（用户明确要求）

1. **按阶段推进**：每完成一个阶段，**先解释这个阶段做了什么**，然后**得到用户确认才进入下一个阶段**。不要连续推进多个阶段。
2. **大规模改动前先说明要改什么。**
3. **需要决策时**：给出选项 + 推荐 + 理由，**不要替用户拍板有争议的事**（尤其是**伦理、合规、法律**相关的问题——必须让用户知情后自己决定）。
4. **实测优先于推断**：不要靠字段名或文档猜行为，能实测就实测。用户非常认可这一点（前期多次"我以为"被实测推翻）。

---

## 二、项目目标

做一个**本地运行**的中文网页工具，服务于《三角洲行动》的"摸金"（烽火地带搜刮）场景。

### 2.1 核心功能

1. **价值榜**：把物资按**每格价值**（单价 ÷ 占格数）排序，一眼看出"这趟该摸什么、什么别捡"
2. **按地图看**：选定一张地图，列出该图能刷出的物资及具体点位，按价值排序
3. **阈值判定**：可调的"必摸 / 可摸 / 跳过"徽章，纯前端计算
4. **三级筛选**：大类 → 子类 → 细类（官方数据实测有三级分类）
5. **人工补充出产地**：官方数据只覆盖 55% 的收集品，用户需要手工补充并持久保存

### 2.2 关键约束（都是实测得出的，不要重新推翻）

| 约束 | 原因 |
|---|---|
| **官方接口不能作价格源** | 官方 `avgPrice` 是"近期平均交易价格"，官方小程序自述"仅供参考，实时价请去游戏内看"。用户实测误差极大、无法体现波动 |
| **价格来自第三方站** | v1 用 moligod（1 次请求拿全量 1718 条，5 分钟刷新）；dergame 作应急备份；付费的"数据帝"API 留作 v2 |
| **护甲价格必须按耐久度选档** | moligod 对护甲给的"裸名"价是**基础参考价、不是行情**（无昨日均价/无更新时间；官方 avgPrice 与它吻合 72/85）。实时价在 `（全新）/（几乎全新）/（破损）` 三档里。排序用 `ARMOR_PRICE_TIER`（当前 `'破损'`，最保守），三档同时下发给网页。**改 1 行常量就能换档** |
| **moligod 用品质前缀区分同名子弹** | 官方 `.300BLK` 有 3 条（品质 5/4/3，价格差 11 倍），moligod 叫 `金./紫./蓝.300BLK`。按名称精确匹配 → 三条全没价。兜底逻辑在 `join.ts`（那里能看到品质），**不能在适配器里做**（名称 Map 会三条互盖）| 
| **人工标注的键：名字唯一用名字，同名用官方ID** | 官方有 6 组同名物品（13 条）。用名字做键会让标注"同时打到 3 条"。导入时自动判断（`--key auto`，默认），13 条走 ID 键 |
| **物品主数据来自官方** | 官方独有：出产地、物品描述、重量、官方物品 ID、三级分类 |
| **不能用 7×24 定时器** | 用户要求"按需刷新"——只在有人用网站时才校验并抓取，减少对源站的负担 |
| **读接口都能当"第一个"** | 前端首屏会同时要 `/api/items` 与 `/api/meta`，谁先到不确定。所以这两个（加 `/api/sources`）**都触发按需刷新检查**。`/api/health` 刻意不触发（监控会频繁打）。**推论**：冷启动时若有抓取在进行中，`ensureFresh` 必须**等它抓完**而不是回空快照 —— 否则服务会回 503，网页显示成"抓取失败"而抓取其实正常（Phase 7 踩到的真 bug）|
| **前端只能用 `import type` 引 `shared`** | `shared` 没有构建产物。实测编译后 `deltaforce` 出现 0 次，就是因为 `import type` 被整行擦除。一旦写成普通 `import`，浏览器会去请求 `.ts` 文件 → 直接崩。**推论**：品质色值、中文标签等运行时常量必须由后端 `/api/meta` 下发 |
| **`@` 别名要写两处** | `vite.config.ts` 的 `resolve.alias`（Vite 用）+ `web/tsconfig.json` 的 `paths`（TS 用）。只写一处会出现“`npm run dev` 正常、`npm run typecheck` 报找不到模块”，且报错会连锁（模块解析不到 → 类变成未知类型 → `instanceof` 收窄失效）|
| **不碰游戏客户端** | 不读内存、不注入、不模拟操作、不截图 OCR（会触发反作弊，且违反游戏条款） |
| **数据源必须可插拔** | 用户未来可能换成付费数据源，换源成本必须是"1 个文件 + 1 行注册" |

### 2.3 项目定位

- **个人自用工具**，不是商业产品
- 未来可能自己搭服务器 / 上线，所以全部配置化（但 v1 只跑本地）
- **尊重数据源站点**：低频、限速、网页上标注来源并加外链、UA 带用户邮箱

---

## 三、技术栈（及用户对它的认知状态）

| 技术 | 作用 | 用户的类比锚点 |
|---|---|---|
| **Node.js** | JS 的运行环境 | Python 解释器 |
| **TypeScript** | 给 JS 加静态类型 | C 的静态类型 + 编译期检查 |
| **npm** | 包管理器 | pip |
| **npm workspaces** | 一个仓库多个包 | monorepo |
| **Fastify** | 后端 Web 框架 | Flask / Django |
| **zod** | 运行时数据校验 | pydantic |
| **原生 fetch** | 发 HTTP 请求 | requests |
| **Vite** | 前端构建工具 + 开发服务器 | 打包器 |
| **Vue 3** | 前端框架 | 无直接对应，可类比 GUI 框架 |
| **Element Plus** | UI 组件库（表格/滑块等） | 现成的控件库 |
| **Pinia** | 前端状态管理 | 全局变量 + 观察者 |
| **vitest** | 单元测试框架 | pytest / unittest |
| **tsx** | 直接运行 TS 文件 | `python xxx.py` |

**重要**：讲解这些技术时，**不要假设用户认识它们的术语**。例如不要说"用 Pinia 做状态提升"，要说"用 Pinia 存数据——它相当于一个全局变量，任何组件改了它，用到它的组件都会自动重新渲染"。

---

## 四、目录结构

```
DeltaForce/
├─ AGENTS.md              ← 本文件
├─ PLAN.md                ← 完整实施方案（793 行，含讲解章节）
├─ docs/source-recon.md   ← 数据源实测记录（所有结论的依据都在这里）
├─ shared/src/index.ts    ← 前后端共享的类型定义（types-only，见 §5）
├─ get-data/              ← 取数服务（后端）
│   ├─ overrides/         ← 人工维护的数据（入库 git）
│   ├─ data/              ← 抓取产物（gitignore）
│   └─ src/
│       ├─ sources/       ← 物品主数据源适配器
│       ├─ prices/        ← 价格源适配器
│       ├─ wire/          ← moligod 解密
│       ├─ normalize.ts   ← 原始数据 → 统一格式
│       ├─ metrics.ts     ← 派生指标（单格价值/涨幅）唯一实现处
│       ├─ store.ts       ← 落盘
│       ├─ refresher.ts   ← 按需刷新
│       └─ server.ts      ← HTTP API
└─ web/                   ← 网页（前端）
    └─ src/
        ├─ api/           ← 访问后端的唯一入口
        ├─ stores/        ← Pinia 状态
        ├─ composables/   ← 可复用的逻辑函数
        └─ components/    ← UI 组件
```

### 4.1 三条架构铁律（讲解时请强调）

1. **派生指标只在 `metrics.ts` 算**（`slots` / `pricePerSlot` / `todayChangePct`）。适配器只提供原料。否则换源会导致同一物资排名变化，而用户说不清为什么。
2. **`import type` 是硬约束**：`shared/` 里**绝对不能出现 `const` 或 `function`**。原理见 §5。
3. **换源成本必须保持"1 个文件 + 1 行注册"**。如果换价格源需要改 `web/` 里任何一行，这个架构就是失败的。

---

## 五、`shared` 包为什么不需要构建（原理，讲解时展开）

```ts
import type { Item } from '@deltaforce/shared'
//     ^^^^ 这个关键字是关键
```

`import type` 在**编译期被完全擦除**——编译产物里这一行直接消失。所以：

- Vite 和 tsx 在**运行时根本不会加载这个包**
- 因此它不需要 `dist/`、不需要打包器处理
- 也就避开了"打包器加载工作区 TS 包"的经典坑（`server.fs.allow`、`optimizeDeps.exclude`、`tsconfig paths`）

**代价**：`shared/src/index.ts` 里一旦出现运行时值（`const`/`function`），这个前提就破了。所以品质调色板等运行时常量放在 `get-data/src/constants.ts`，通过 `/api/meta` 下发给网页。

**已验证**：Phase 1 用临时文件实测通过，且类型守卫生效（故意写错字段名会被 `tsc` 抓住）。

---

## 六、硬性禁令（来自全局 AGENTS.md，不可违反）

**禁止批量删除文件或目录。** 不要使用：
- `rm -rf`
- `rd /s`
- `del /s`
- `rmdir /s`
- `Remove-Item -Recurse`

需要删除文件时，只能删除**一个或多个有明确路径的文件**。

正确示例：`rm a.txt b.txt`

如果需要批量删除文件，**应停止操作并向用户请求，让用户手动删除**。

> 实例：Phase 1 需要修复被中断的 `node_modules`（150 个包、无锁文件）。
> 因不能 `rm -rf node_modules`，改为直接重跑 `npm install` —— npm 会自己对比 `package.json` 完成增删，结果正确。

---

## 七、项目当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| Phase 0 | ✅ 完成 | 数据源探测（官方接口、moligod 解密、dergame 复测）。见 `docs/source-recon.md` |
| Phase 1 | ✅ 完成 | 工程骨架：3 个 workspace、tsconfig、`npm install` 干净通过、`npm run typecheck` 三包全绿 |
| Phase 2 | ✅ 完成 | `shared/src/index.ts` 重写为最终契约（`Item` 30+ 字段、API 响应类型、`ApiErrorCode`）|
| Phase 3 | ✅ 完成 | 两个数据源适配器 + name join（官方主数据 + moligod 价格）|
| Phase 4 | ✅ 完成 | 人工标注（出产地 / 可获得性 / 可上架 / 每组发数 / 赛季限定）+ CSV 往返 |
| Phase 5 | ✅ 完成 | `normalize.ts` + 单元测试 |
| Phase 6 | ✅ 完成 | `store.ts` 落盘 + `refresher.ts` 按需刷新（三道锁）|
| Phase 6.5 | ✅ 完成 | 数据修正：护甲耐久度选档、同名物品品质前缀兜底、标注键改官方ID。见 `docs/source-recon.md` §八 |
| Phase 7 | ✅ 完成 | HTTP API：`server.ts` 五个路由 + 真正的 `src/index.ts` 入口（**无定时器**）。25 个 `fastify.inject` 测试 |
| Phase 8 | ✅ 完成 | 网页骨架 + **第一版可用界面**：Vite + Vue 3 + Element Plus + Pinia + API 客户端。见 `web/src/` |
| Phase 9 | ✅ 完成 | `FilterBar`（三级联动 + 交叉计数）/ `ThresholdSlider`（对数滑块）/ `StatusBar`（可见性轮询）/ `ItemsTable`（判定列 + 分页）。26 个 store 测试 |
| **Phase 10** | ⏳ **下一步** | `MapView`（三档标记 + 三个开关）+ 出产地来源徽章 + 网页上就地补标注 |
| Phase 11 | 未开始 | 补齐测试 + 走完整验收 + README 每步中文原理讲解 |

**当前状态**：`npm run typecheck` 0 错误、`npm test` **359 个测试全绿**（333 后端 + 26 前端）。
已实测跑通：**1,564 条主数据 · 1,294 条带价格（82.7%）· 名称匹配率 100.0% · 出产地覆盖 85.6%**。
**网页已实测**：表格、三级联动、阈值判定、判定过滤、分页全部正常。

**当前可用的命令**：

| 命令 | 作用 |
|---|---|
| `npm run dev` | ⭐ **同时起后端 3000 + 前端 5173**（日常就用这个）|
| `npm run dev:api` / `dev:web` | 只起其中一个 |
| `npm run refresh` | 强制刷新并**落盘**（走三道锁）|
| `npm run fetch` | 只看不写的诊断（打印一张大表，**不落盘**）|
| `npm run provenance:todo / import / season:rollover` | 人工标注的导出 / 回写 / 换季 |
| `npm run typecheck` / `npm test` / `npm run build` | 全 workspace |

**HTTP 路由**（Phase 7）：`GET /api/items` · `/api/meta` · `/api/sources` · `/api/health` · `POST /api/refresh`。
三个读接口**都会触发按需刷新检查**（前端首屏不管先调哪个都对；`/api/items` 在数据过期时会阻塞约 13 秒）；
`/api/health` 刻意不触发，因为监控会频繁打它。

**前端结构**（Phase 8–9）：

```
web/src/
├─ api/client.ts            访问后端的**唯一入口**（统一错误处理 + 类型）
├─ stores/
│   ├─ items.ts             物品 + 刷新（含“可参与排序”过滤）
│   ├─ meta.ts              筛选器 + 标签调色板（色值/中文标签从后端来）
│   ├─ rules.ts             ⭐ 阈值 + 判定 + localStorage 持久化
│   └─ filters.ts           ⭐ 筛选状态 + 交叉计数 + 排序（逻辑最重的一处）
├─ composables/
│   └─ useHealthPolling.ts  只在**标签页可见时**轮询 /api/health
├─ components/
│   ├─ StatusBar.vue        数据可信度（多旧 / 什么口径 / 排除了多少）
│   ├─ FilterBar.vue        三级联动 + 品质 + 地图 + 搜索
│   ├─ ThresholdSlider.vue  对数滑块 + 判定命中数（可点击筛选）
│   └─ ItemsTable.vue       判定列 + 分页 + 展开详情
├─ utils/format.ts          金额（万/亿）、时间（“3 分钟前”）格式化
├─ App.vue                  只负责拼装与布局
└─ styles.css               全局样式（深色底）
```

⚠️ **前端有三条必须守住的规矩**：

1. **从 `@deltaforce/shared` 导入只能用 `import type`**。这个包没有构建产物，靠“`import type` 编译期被整行擦除”才能工作。实测：编译后 `main.ts` / `App.vue` / `stores/*.ts` 里 `deltaforce` 出现 **0 次**。品质色值、中文标签这类运行时常量**由后端 `/api/meta` 下发**。
2. **判定规则（阈值）只在前端**（`stores/rules.ts`），存 localStorage，后端完全不感知 —— 拖滑块不该发网络请求。
3. **组合式函数返回的对象里的 ref 不会在模板里自动解包**。Vue 只对**顶层**绑定做一层 `proxyRefs`。所以要么解构（`const { visible } = useX()`），要么用 `.value`。否则模板里拿到的是 Ref 对象，`polling.lastCheckAt.toLocaleTimeString()` 会直接报错。

**Phase 9 的关键设计**（与直觉相反但很重要）：

- **交叉计数（faceted counts）**：下拉选项后的数字必须是“**选了这个还剩多少**”，不是“这个选项一共有多少”。否则会出现“显示道具 (711)、点进去 0 条”。实现：`filters.ts` 的 `pass(item, skip)` —— 数某维度时把这个维度自己的筛选去掉。
- **改大类要清空子类/细类**：否则“道具/收集品”改成“弹药”后会得 0 条，且下拉里显示一个不属于弹药的选项。
- **`unknown` ≠ `skip`**：不可上架/不可摸/无价格的物品判为“未知”（判不了），不是“跳过”（建议别捡）。这两句话的下一步行动完全不同。
- **判定计数不随判定过滤变化**：从 `rowsBeforeVerdict` 算，否则点了“只看必摸”之后其它档全变 0，就切不回去了。
- **对数滑块**：单格价值跨度 1 ~ 3427 万（7 个数量级），线性滑块根本调不准。
- **轮询 `/api/health`（230 字节、不触发抓取）而不是 `/api/items`（2MB、会触发抓取）**，且只在标签页可见时。
- **`propsDetail` 字段**：`Item` 必填，前端 fixture 容易漏。

**⚠️ 一个容易踩的坑**：`npm run fetch` 是**只看不写**的（`scripts/fetch-once.ts`
不调 `saveSnapshot`）。磁盘上的 `get-data/data/snapshot.json` 由**刷新器**写，
所以它可能是几十分钟前的旧文件。要验证改动后的落盘效果，得走 `ensureFresh()`
（Phase 7 的 HTTP 服务）或临时脚本调 `saveSnapshot`。
> 实例：Phase 6.5 查 `variants` 为什么没进 snapshot 查了很久，
> 最后发现一直在读一个 40 分钟前的旧文件。

---

## 八、讲解风格示例（反面 / 正面）

**❌ 不要这样写：**
> 配置了 npm workspaces，补充了 tsconfig，重跑 npm install 修复了 node_modules 的不一致状态，typecheck 通过。

**✅ 应该这样写：**
> 我把项目配成了 **npm workspaces**（一个仓库里放多个包，类似 Python 的 monorepo）。
> 为什么要分成 3 个包：`get-data` 是后端、`web` 是前端、`shared` 放两者共用的类型定义。第三个包是关键——如果 `Item` 这个类型（30 多个字段）前后端各写一份，就会出现"后端改了字段名、前端不知道"的问题，而 TypeScript 的价值恰恰是编译期发现字段名错误。
> 装完之后 npm 做了 4 件事：读依赖清单 → 解析依赖树（共 196 个包）→ 下载到 `node_modules/` → 建软链接把 3 个包互相连起来。最后一步很重要：`node_modules/@deltaforce/get-data` 不是拷贝，而是**指向源码目录的快捷方式**，所以改源码立即生效，不需要重新安装。
