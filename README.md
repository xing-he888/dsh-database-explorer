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
