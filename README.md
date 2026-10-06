# dsh-database

Database explorer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a PyCharm-Database-style panel as a third Conversation tab.

数据库浏览器插件：像 PyCharm 的 Database 面板一样，在 DeepSeek Harness 的对话区直接浏览和查询你的数据库。

![category](https://img.shields.io/badge/category-tools-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features / 功能

- 🗄 **Supported engines / 支持的数据库**：SQLite（内置 `node:sqlite`）、MySQL / MariaDB、PostgreSQL、SQL Server、MongoDB、ClickHouse
- 🌳 **Schema tree / 结构树**：connection → database/schema → table/view → column, expand on click（连接 → 库 → 表 → 字段，点击逐级展开）
- 👆 **Click a table to see its rows / 点表名直接看数据** — no LIMIT, host caps at 10,000 rows with a truncation notice（不拼 LIMIT，主机侧上限 10000 行，超出有提示）
- ✏️ **Inline cell editing / 双击单元格直接改数据**：double-click → edit → Enter saves via a parameterized, PK-addressed `UPDATE`; PK columns are marked 🗝; tables without a PK stay read-only（双击编辑，回车保存；主机侧参数化 UPDATE 按主键精确定位；无主键的表只读）
- 🖱 **Visual table designer / 可视化建表**：create a table by clicking — name, columns, types, PK/auto-increment/unique/default all picked in a form, optional SQL preview; the host builds engine-specific DDL（表名、字段、类型、主键/自增/唯一/默认值全部点选，可先看 SQL 预览；DDL 由主机端按引擎生成）
- ⤓ **Export / 导出**：one click to download the open table as CSV (Excel-friendly BOM) / JSON / SQL INSERTs, host-side streaming, up to 100,000 rows（一键下载当前表：CSV 带 BOM 方便 Excel、JSON、或可直接执行的 INSERT 语句；主机侧生成，上限 10 万行）
- ⤒ **Import / 导入**：pick a CSV (header row) or JSON (object array) file and it batch-inserts with parameterized statements, then reloads the grid（选 CSV 首行列名或 JSON 对象数组，参数化分批插入，完成后自动刷新）
- 💬 **SQL editor / SQL 编辑器**：Ctrl+Enter to run, MongoDB accepts JSON command documents（MongoDB 用 JSON 命令文档，如 `{"find":"users","filter":{},"limit":20}`）
- 🔐 **Secrets stay local / 密码本机保存**：passwords are kept in memory by default; tick "remember" to store locally and auto-reconnect after restart（密码默认只在内存；勾选「记住密码」后重启自动重连）
- 🛡 **Safety rails / 安全设计**：same-origin fence on all mutating routes, driver error listeners so a dropped connection can never crash the host, host-side row caps（所有写路由同源校验；驱动后台错误只记日志不崩主机；主机侧行数上限）

## Install / 安装

```sh
dsh plugin --profile web add dsh-database-explorer
```

## Usage / 使用

1. Open the **数据库 / Database** tab next to Chat and Trajectory（在聊天、轨迹页签旁打开「数据库」页签）
2. Click **+** to add a connection; tick **记住密码** to survive restarts（点 + 新建连接，勾选「记住密码」重启免输）
3. Expand the connection, click a table — data appears on the right（展开连接，点表名，右侧即出数据）
4. Double-click any cell to edit it（双击单元格可直接修改）
5. **⤓ CSV / JSON / SQL** above the grid exports the open table; **⤒ 导入数据** loads a CSV/JSON file into it（表格上方 ⤓ 导出当前表，⤒ 导入 CSV/JSON 文件）

## Notes / 说明

- Optional drivers (mysql2 / pg / mssql / mongodb / @clickhouse/client) are `optionalDependencies`: install only what you use, SQLite works out of the box（可选驱动按需安装，SQLite 开箱即用）
- For MySQL set `local_infile=false` clients aside — this plugin only issues ordinary queries（普通查询即可，无需特殊服务端配置）
- Restart DSH Desktop after installing / 安装后重启 DSH Desktop
- Drivers must be installed into the DSH profile's `node_modules` (the `dsh plugin add` path does this); a plugin copy sitting outside any profile cannot resolve mysql2/pg etc. and connect fails with「缺少驱动」(驱动必须装进 DSH profile 的 node_modules，游离在 profile 外的插件副本无法解析驱动)

## Changelog / 变更

### 0.7.2

**Blockers / 阻断修复**

- **Visual designer create/preview fixed**：「新建表」与「查看 SQL」的请求体此前缺少 connectionId，永远报「连接未打开」——已补上（设计器新建表与 SQL 预览恢复可用）
- **Startup auto-reconnect fixed**：自动重连此前写成了 cordis effect 的 disposer（宿主关闭时才启动定时器），实际从未在启动时执行——已改为在 effect 体内启动，并返回真正的清理函数

**Security / 安全**

- Same-origin fence now covers GET/HEAD too：DNS rebinding 页面此前可借 GET 读取连接元数据与结构树，现已全部过栅栏；Host 白名单收窄为 `localhost` / `127.0.0.1` / `::1`（移除 `*.localhost` 通配），并修复裸 `::1` Host 解析
- Unchecking「记住密码」is now honored：取消勾选后连接成功不再被自动落盘；仅当用户勾选记住、或在带提示的密码弹窗中输入时才保存
- CSV export defuses formula injection：以 `=` `+` `-` `@` 开头的文本单元格导出时加 `'` 前缀（数字不受影响）
- Designer default values restricted to safe shapes：数字 / `'字符串'` / 关键字（如 `CURRENT_TIMESTAMP`），不再接受可注入 `'`、`--` 的任意字符组合

**Data integrity / 数据完整性**

- SQLite multi-statement scripts now execute every statement：此前 `prepare()` 只执行第一条、其余静默丢弃——现按顶层 `;` 切分（正确处理字符串/注释内的分号）逐条执行并聚合影响行数
- Statement classification strips comments first：`-- 注释\nSELECT ...` 此前结果集被静默丢弃，现已正确返回
- Import over 50k rows reports `truncated` + original total：此前超限静默截断且 total 显示截断后数字
- Import body limit aligned (34 MB host / 32 MB browser)：此前宿主 2 MiB 直接拒绝大文件
- `saveProfiles` is now atomic (tmp + rename) and a corrupt file is preserved as `.bak` instead of being silently overwritten empty
- SQLite refuses a non-existent file path with a clear error instead of silently creating an empty database
- Multi-row cell update error now tells the truth (the statement committed) instead of claiming a rollback

**Engine compatibility / 引擎兼容**

- Import & cell-update placeholders are now engine-specific (`?` / `$n` / `@pN`)：PostgreSQL 与 SQL Server 的导入此前必然 400
- SQL Server handle now binds params and tolerates DDL answers (no `recordset` TypeError)
- Failed MongoDB connect closes its topology monitor (no background leak); concurrent connects to one profile are deduplicated
- Schema tree quotes identifiers through the engine quoter (removed the stray double-quote helper); ClickHouse SQL export escapes backslashes
- Clicking a table on an already-connected profile reuses the 30s schema cache instead of refetching everything with a "(cached)" toast each time
- Fixed 10 mojibake strings in the host entry (3 user-visible error messages included)

## Source / 源码

https://github.com/xing-he888/dsh-database-explorer

## License

MIT

---

## v0.8.0 新增：NoSQL 与向量数据库（全部零依赖）

| 引擎 | 端口 | 认证 | 查询框语法 |
|---|---|---|---|
| **Redis** | 6379 | 密码 → AUTH（RESP2 直连，自实现协议） | 直接输 Redis 命令行：`GET key` / `SCAN 0 MATCH user:* COUNT 100` / `HGETALL user:1` / `ZRANGE z 0 -1 WITHSCORES`。结构树按 key 类型分组（string/hash/list/set/zset/stream），点类型查看采样 key。`database` 字段填 DB 编号（0-15） |
| **Elasticsearch** | 9200 | 用户名+密码 → Basic（HTTPS 默认校验证书） | 两种 JSON：`{"index":"products","query":{"match_all":{}},"size":100}` 便捷搜索，或 `{"method":"POST","path":"products/_search","body":{…}}` 原始 REST。索引=表，mapping=列；JSON 导出 ✓ |
| **Qdrant（向量数据库）** | 6333 | 密码 → `api-key` 头 | `{"collection":"docs","command":"search","vector":[0.1,…],"limit":10}` 向量搜索（带 score）；`{"command":"scroll","collection":"docs","limit":50}` 翻页；`{"command":"count"}`；任意 `{"method","path","body"}` 原始 REST。结构树显示向量维度和 payload 键；点集合浏览 payload；JSON 导出 ✓ |

向量路线：pgvector（用现有 PostgreSQL 连接即可，`ORDER BY embedding <=> '[…]'` 内联字面量查询）；Milvus/Weaviate 按同一 handle 接口（`query/schema/peek/exportAll/close/adminPing` 五个方法）即可接入。

安装：`pnpm add file:…` 或复制本目录到 profile 的 node_modules，重启 DSH Desktop。无任何新增 npm 依赖（Redis 协议自实现、HTTP 走 Node 原生 fetch）。

---

## v0.9.0 新增：E-R 图 + 网格分页 + 查询历史

- **⛓ E-R 关系图**：库节点上点 ⛓ 按钮，纯 SVG 自绘（滚轮缩放/拖动平移/悬停高亮相关表），表节点显示列清单（🔑 主键 / ↗ 外键），外键连线自动布局。支持 SQLite / MySQL / PostgreSQL / SQL Server；Mongo/Redis/ES/Qdrant/ClickHouse 无外键元数据不提供
- **网格分页/排序/过滤**：点表进入分页模式（默认 200/页，可切 50–1000），表头点击排序（▲▼），过滤条支持 =/≠/包含/大于/小于（值参数化，防注入）；单元格编辑、导入后自动保留当前页
- **查询历史**：SQL 编辑器左下角 ⏱ 下拉，最近 100 条（localStorage 持久化）
- **⤓ MD 导出**：Markdown 表格（SQL 引擎）
- **导入映射预览**：选文件后先显示"匹配列/忽略列/行数"，确认后再导入（dryRun 不写库）
- 性能红利：点表从"全表物化后截断"改为**服务端 LIMIT/OFFSET**，大表不再撑爆内存（实测 200k 行表 55MB 堆尖峰消除）

---

## v0.9.1 补充（第七轮审计）

- **修复高危 R7-H1**：先点开 A 表再跑 SQL 查 B 表时，网格会把 A 表的主键元数据套在 B 表结果上——单元格编辑会 **UPDATE 到错误的表**（两表都有 id 列时即静默数据损坏）。现在 SQL 结果一律只读，切换连接/断开也清空编辑状态
- **修复 mssql 分页排序**：DESC 被静默忽略（漏拼方向）
- **断开连接清空编辑/分页残留**
- **🔍 单元格查看器**：长文本/JSON/Blob 列点击放大——JSON 自动格式化、PNG/JPEG 直接预览、二进制显示 hex，一键复制
- E-R 图滚轮缩放改原生非 passive 监听（之前缩放时页面会跟着滚）

---

## v0.9.2 补充（第八轮审计）

- **安全（R3-2 缓解落地）**：「测试连接」不再为**非内网地址**解析「密码环境变量名」——堵住"本机任意进程一次 POST 就能让 DSH 把进程环境变量当密码发给外部服务器"的通道；回环/内网地址不受影响，显式密码不受影响
- **LIKE 数字列修复**：过滤"包含"在 PostgreSQL/ClickHouse 的数字列上会报类型错，现已 CAST 成文本再匹配（其他引擎隐式转换）
- 导入映射预览、E-R 图、分页过滤在 pg/mssql/clickhouse/mongo 的 SQL 全部通过捕获式断言验证

---

## v0.9.3 新增：➕ 新增行（INSERT）

- 分页结果条上多了 **＋ 行** 按钮（SQL 引擎）：按当前表的列生成表单，留空 = NULL（自增主键留空即可），回车或点「➕ 插入」提交——参数化 INSERT，列名白名单校验，插入后自动刷新当前页
- 修复分页结果的"undefined 行"显示（分页响应补回 rowCount 兼容字段，行数条改为显示总行数）
- 末页时"下一页 ▶"正确禁用

---

## v0.9.4 新增：版本握手（升级不再"半新半旧"）

- 后端在 `/kinds` 接口带上自己的版本号；前端启动时对比，**不一致就在面板顶部挂红色横幅**："插件前端已是 x，但 DSH 进程里的后端是 y — 请完全退出 DSH Desktop 并重新打开"
- 以后升级如果忘记重启，不会再出现莫名其妙的 405/404，而是明确的人话提示

---

## v0.9.6 重做：E-R 模块化选择画板

- **修复打开即崩**：E-R 画布此前引用了五个从未定义的布局常量（`ER_NODE_W` 等），组件一渲染就抛 ReferenceError——这就是「点开 E-R 图很别扭/不对劲」的根源
- **模块化选择**：左侧新增模块栏——全部表可搜索、带外键关联数徽标，勾选才上画布；支持全选/清空/＋关联（把画布上各表的直接邻接表一键加入）；底部显示「n 张表在画布上」
- **真正的画板**：每个表节点可整表拖动（连线实时重算），空白处拖动平移，滚轮以光标为中心缩放，工具条提供「自动布局 / 适应画布」；节点表头带 ✕ 可直接移出画布
- **自动布局**：按外键关系 BFS 分层（外键方向从左到右），连通分量并排，替换掉原先按字母序的 √n 网格——连线不再大面积交叉
- **大库可用**：后端表清单上限从「>60 张直接整库拒绝」放宽为最多列 300 张并报告总数；首次打开时 ≤16 张全选，更多则只自动画有外键关系的表，其余在左侧按需勾选
- 首次打开自动适应画布；表头 ✕、悬停高亮、自引用外键环、`er.back` 文案等细节同步整理（移除了用 `filter.clear` 判断语言的 hack）

---

## v0.9.7 新增：Chen 式概念图（教科书 E-R 画法）

- 工具条新增「表视图 / Chen 图」切换：Chen 模式就是教科书上的 Peter Chen 概念模型画法——**实体 = 矩形**（表）、**属性 = 椭圆**（主键加下划线）、**联系 = 菱形**（外键），连线两端标注 **1 / N 基数**（引用方 N、被引用方 1）
- 属性默认只挂「关键属性」（主键 + 外键，每侧最多两行），一键切「全部属性」（超出 14 个显示 +n 虚线椭圆）
- 同一对表之间的多条外键并排画出多个菱形；自引用外键（如 categories.parent_id → categories）画成自环菱形
- 与表视图共用同一份实体坐标和模块勾选：拖动实体时属性与菱形跟随，切换画法不丢手工摆放；「适应画布」在 Chen 模式下会为属性预留边距
- 审计修复（同轮）：搜索过滤时「全选」只加入可见的表（画布已有表保持位置，新表找空位）；中文名/长名按显示宽度定实体与椭圆尺寸（CJK 按 2 单位计，不再溢出）；移除悬停中的表后邻接不再残留半透明；右键/中键拖动不再触发表/画布拖拽；Chen 模式适应画布边距加宽到 110px
- 内省修复（同轮）：SQLite `REFERENCES parent` 隐式外键（PRAGMA 的 to 为 null）现按 seq 对齐解析到父表主键列；PostgreSQL 复合外键改用 pg_catalog 的 conkey/confkey 按 WITH ORDINALITY 配对——原 information_schema 连接会产生 (a→y, b→x) 的错误连线
- 新增 test-v097.mjs：真实 SQLite 边界回归（隐式/复合外键、45 列截断、空格/引号/中文表名、69/311 张表的 tooMany 与清单截断、指向清单外表的 FK 安全丢弃）

---

## v0.9.8 修复：MariaDB 上 E-R 图整体塌成 undefined

- **根因**：MariaDB 的 `information_schema` 会把列标签返回成**大写**（`TABLE_NAME` / `COLUMN_NAME`…），而 Oracle MySQL 返回小写——内省按小写键取值，在你的 MariaDB 库上表名/列名全部取到 undefined：画布塌成一个 `undefined` 节点、所有列被误标成外键（搜索本身没有问题，是它后面的数据坏了）
- **修复**：内盛行统一做**键名小写归一化**（mysql / postgres / mssql 三个引擎一致处理），并拒绝无表名的行；不管连的是 MySQL 还是 MariaDB、驱动返回什么大小写，内省结果一致
- 新增 `test-v098.mjs`：MariaDB 大写键 + Oracle MySQL 小写键双路回归（含主键/外键标记断言）

---

## v0.9.9 重磅：E-R 画板从「看」升级为「画」——可编辑 ERD 设计器

- **比例修正**：Chen 图属性椭圆此前比实体矩形还大、自环基数标签压在实体框上——椭圆按 9.5px 字号重新定尺寸（实体恒大于属性），自环基数移到实体框右侧，普通联系的基数从菱形向两端量 28% 落位，不再被实体框盖住
- **实体编辑器**：单击画布上的实体（表视图/Chen 图皆可），左侧模块栏切换为属性编辑面板——实体改名、属性增删改名、主键勾选、从画布移除
- **从零新建实体**：工具条「＋ 实体」一键创建（默认带 id 主键），在编辑面板里改名加属性，与内省表同场摆放
- **手动建联系**：工具条「＋ 联系」进入连线模式（按提示先后点两个实体）→ 生成自定义联系，联系名/基数（1:1、1:N、N:1、M:N）随时改；单击自定义菱形（Chen 图）或紫色虚线（表视图）即可编辑或删除
- **内省只是底稿**：所有手工修改叠加在内省模型上，「还原」按钮一键回到数据库真实结构
- 选中态统一紫色描边（实体/自定义联系），与悬停蓝色区分；点击选中改在 pointerup 判定（>3px 位移视为拖动），规避指针捕获对 click 的重定向

---

## v0.9.10 修复：图层与可读性（对照专业画布工具的最佳实践）

- **不透明图层**：玻璃主题下 `bg-base` 是半透明色，画布形状直接拿来当填充会透出桌面壁纸、连线也会穿字——现在启动时把 `bg-base` 按主题明暗（亮字=暗主题）合成到不透明底色上，实体/椭圆/菱形/表节点全部实心渲染，连线永远在节点层之下（React Flow 等专业画布的标准做法）
- **连线改从实体边框出发**：不再从中心穿框而出，菱形不会被自己的实体盖住
- **基数标签置顶**：1/N/M 标签最后绘制，任何情况下不被实体框遮挡
- **拖动置顶**：拖动中的实体自动画到最上层
- **删除语义修正**：✕ 移除自定义实体 = 从模型彻底删除（连带其联系，左侧清单同步消失）；数据库表仍只是移出画布、清单保留可随时加回

---

## v0.9.11 修复：联系全部可编辑、菱形可拖动、「＋ 关联」反馈

- **数据库自带联系也能编辑**：内省出的外键联系此前点不动——现在每条联系都有统一身份，单击 Chen 图上任何菱形（或表视图下的紫色虚线）即可改名（如 CountryCode → 位于）、改基数（1:1/1:N/N:1/M:N）、从图中隐藏；编辑面板显示外键列来源，「还原」一键恢复
- **菱形可拖动**：拖动任何菱形即可挪动联系标签的位置，连线两端跟随重算，不再挤在一起
- **「＋ 关联」改名「＋ 邻接表」**：它做的事是把"与画布上各表直接相关但还没上画布的表"补进来，不是建立联系（建立联系用「＋ 联系」）；邻接表都已在画布上时不再静默无反应，会提示「没有可补充的表」，成功加入时提示数量

---

## v0.9.12 审计轮：nosql.js 全量审查 + 两处加固

- **Redis 采样内存加固**：peek 对 list 类型此前 `LRANGE key 0 -1` 拉取整个列表（百万元素级会撑爆内存），改为 `LRANGE 0 999` 且 hash/zset 推行时同步检查 1000 行上限
- **E-R 画板**：自动布局后清空菱形手工位移（旧偏移在新布局下会压到别的表上）；删除连线索点实体时自动取消连线模式
- **已知限制记录**（详见 AUDIT.md）：ES `from+size` 深分页超 1 万被 ES 拒绝（引擎限制）；mssql 非 dbo 架构下的表暂不在分页列获取范围
- nosql.js 全量审查结论：RESP2 解析器/SCAN 迭代上限/证书校验/超时/命令白名单外的原生命令语义均符合设计约定

---

## v0.9.13 修复（第 4 轮审计：S1 / F1 / F2）

- **S1 · envPassword 内网限制收口到 resolvePassword 层**：旧防线只在 /test 路由上，且用的是前缀正则——`10.0.0.1.attacker.net`、`127.evil.com`、`192.168.1.5.attacker.net`、`172.16.evil.net` 四类形如内网的域名全部能骗过校验，而 /profiles + /connect 与自动重连路径根本没有校验（本地进程可借 DSH 把任意环境变量当密码发给自己的服务器）。现在改为在 `resolvePassword`（所有连接路径的唯一入口）强制执行，主机匹配改为两端锚定的精确判定（IPv4 逐八位组校验、IPv6 回环/未指定/IPv4-mapped、`host:port`、方括号、zone id、`.localhost` 全覆盖），无法解析的值一律按公网处理（fail-closed）
- **F1 · MySQL 多语句脚本可用**：此前 mysql2 的 `multipleStatements` 保持关闭（开启会使 `?` 占位符失效），粘贴 `A; B; C` 直接报语法错，代码里那段"多语句结果"分支永远走不到。现在 SQL 控制台的多语句在主机端按 MySQL 语义拆分（`'` 与 `"` 内的反斜杠转义会被识别，`\'` 不再提前断句；反引号标识符内反斜杠不转义）后逐条顺序执行：写操作 affectedRows 聚合、首个结果集返回、insertId 取最后一次写入；多语句 + 绑定参数组合明确拒绝而非错位绑定
- **F2 · MongoDB 导出不再静默截断**：导出走新增的 `exportRows` 专用通道（绕过交互查询的 1 万行钳制），上限 10 万行 + 1 行判定 `truncated`；此前 100 万行的集合只会导出 1 万行且不报截断。旧句柄自动回落旧通道，不影响升级
- **回归套件 `test/test-v099.mjs`**：35 条断言全绿（S1 主机矩阵 18 条、resolvePassword 收口 5 条、F1 分词/聚合 13 条、F2 导出 3 条、版本握手 + SQLite 主路径冒烟 2 条），mongo/mysql 场景用 mock 驱动，无需真实服务器

---

## v0.9.14 修复（第 5 轮：外部复核驱动）+ 工程化基建

**安全 / 稳定性（外部复审 probe2 的全部高危项）**

- **RESP 解析异常不再杀死宿主进程（P0）**：socket 数据回调内加护栏——解析器异常时销毁连接、在等的命令全部收到错误返回；此前把 Redis 端口误填成 HTTP 服务会让整个 DSH 退出
- **RESP 深嵌套栈溢出（P0）**：递归加 64 层上限
- **重定向不再跟随**：数据库端点收到 3xx 一律报错——此前 Qdrant 的 api-key 会随 302 明文转发到跳转目标
- **真实 Redis 可用了**：+PONG 被解析成对象后与字符串比较恒不相等，导致真实 Redis 永远握手失败；现在正确识别
- **Redis SSL 生效**：勾选 SSL 走 TLS（此前完全忽略，密码明文）；证书校验跟随「校验 SSL 证书」勾选
- **ES 密码认证修复**：只填密码不填用户名时此前静默匿名，现在正常发 Basic 头
- **SQL 引擎 SSL 证书校验开关**：新连接默认勾选「校验 SSL 证书」，旧连接保持兼容；mysql/pg/mssql 三端贯穿
- **pg 语句级超时** 20s（此前只有连接超时，长查询面板永久 busy）

**功能 / 数据正确性**

- MongoDB / ES 分页过滤的 `>` `<` 补全映射（此前 Mongo 静默空结果、ES 直接报错）
- MD 导出竖线转义生效（此前替换串写错是空操作，值含 `|` 表格结构破坏）
- mssql 非 dbo 架构：新增行 / 导入 / 改表 / 设计器读列恢复正常（schema 参数化传入）
- 结构导出 DDL 标识符统一走转义器、注释头压平换行（导出文件投毒面收口）
- CSV 解析支持裸 `\r` 行结尾；空文件明确报错；匹配列 >900 上限
- MongoDB 导出经专用通道不再静默截断在 1 万行（v0.9.13 修复的补强，此处指 truncated 判定链路）
- MySQL 多语句可用（v0.9.13）；params/pk 非法输入给出友好错误而非 500
- 连接失败统一回收（pg/mssql/clickhouse）；Redis 命令 20s 超时、失败即销毁 socket、SCAN 游标兜底、大 key 改增量取；RESP 解析器重写（倍增缓冲）并校验协议头长度
- connections.json 结构异常不再静默清空（备份 .bak）；权限收紧补底
- 分页快速操作不再被乱序旧响应覆盖（请求序号守卫）；导入预览与真实导入格式一致；编辑 toast 不再回显敏感值；局域网访问的 403 附带场景说明

**工程化基建**

- `npm test`：v099/v100/v101 三套件统一入口（59 断言），`test/run-all.mjs` 汇总
- `npm run release`：发布流水线脚本——版本握手校验 → pack 清单检查 → 三副本同步/比对 → 全量回归 → git tag → npm publish，逐步可选
- GitHub Actions CI：push/PR 自动跑全部回归套件
- 新增 `sslVerify` 连接字段与 UI 勾选；i18n 硬编码字符串收敛进词典

---

## v0.9.15：E-R 图正确率提升 + pg 连接池

- **基数自动推导**：外键所在列是单列主键/唯一索引（mysql statistics / pg conkey / mssql 约束 / sqlite index_list）时联系自动标 1:1，其余 N:1——此前一律假设 N:1；画板上仍可手工修改
- **外键边截断可见**：全库外键超过 400 条时画布顶部黄条提示总数（此前静默丢弃，"怎么少了几条线"无从判断）
- **视图不再混入 E-R 图**：pg/mysql/mssql 的内省过滤 TABLE_TYPE = BASE TABLE，与 sqlite 行为对齐
- **pg 改用连接池**（max 4）：此前是单连接 Client，面板并行请求（分页 count + 取页）在一条连接上串行排队；语句超时、失败回收等 v0.9.14 行为保持
- 回归套件增至 4 个（v099–v102，67 断言）：新增 E-R 正确率套件（真 sqlite 推导 1:1/N:1、600 边截断上报、三引擎视图过滤 SQL、复合外键列序回归）

---

## v0.9.16：SchemaSpy 式推断关系 + 连接池可调

- **无外键约束的库也能画全关系图**：按命名约定推断关系（列 `user_id` → 表 `users` 主键，支持 `user_id/_no/_key/_code/_uuid` 后缀与 users/categories 单复数归一），画布上以虚线展示、工具栏可一键开关——参考 SchemaSpy 的 implied relationships 做法；保守规则保精确率：两表同名歧义不猜、复合主键不参与、显式外键列不重复推断
- **连接池大小可配置**：连接表单新增「连接池大小（1–64，留空 = 默认）」，作用于 mysql `connectionLimit`、pg `max`、mssql `pool.max`、mongo `maxPoolSize`；非法值自动回落引擎默认
- 回归套件增至 5 个（v099–v103，73 断言）

---

## v0.9.17：聊天里直接用——agent 原生工具

- **数据库能力进入聊天**：插件向 DSH agent 注册 9 个原生工具（`ctx.tools.register`），在聊天里说"帮我看 users 表前 10 行"→ 模型调用 `db_peek_page` → 会话内展示调用流程与结果摘要
- **读写分级**：只读工具（连接列表/连接/结构/分页/E-R）始终注册；写入工具（SQL 执行/单元格更新/插行/删行）默认关闭——在 `plugin-data/dsh-database-explorer/` 创建 `agent-write-tools` 空文件即显式授权（官方原则：授权确认类动作保持 user-only）
- **凭据隔离**：工具不含任何密码参数，连接一律使用面板已记住的凭据（`savedPassword` 永不进入模型上下文）
- **上下文保护**：工具结果 20000 字符截断、分页 100 行上限、超长树折叠为 preview；会话渲染只报计数不铺数据
- defineTool 解析两级兜底（裸说明符 → 宿主 app.asar require(esm)）；解析失败仅告警，面板不受影响
