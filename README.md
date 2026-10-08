# dsh-database-explorer

[![npm](https://img.shields.io/npm/v/dsh-database-explorer)](https://www.npmjs.com/package/dsh-database-explorer)
![license](https://img.shields.io/badge/license-MIT-green)

DeepSeek Harness 的数据库浏览器插件——在对话区「数据库」页签里，像 PyCharm 的 Database 面板一样直接浏览、查询、修改你的数据库。

A PyCharm-Database-style database panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), as a third Conversation tab.

---

## 它能做什么

### 支持的数据库（9 种）

| 类型 | 引擎 | 说明 |
|---|---|---|
| SQL | **SQLite** | 内置 `node:sqlite`，开箱即用，零驱动 |
| SQL | **MySQL / MariaDB** | mysql2 驱动 |
| SQL | **PostgreSQL** | pg 驱动（含 pgvector：`ORDER BY embedding <=> '[…]'`） |
| SQL | **SQL Server** | mssql 驱动 |
| SQL | **ClickHouse** | @clickhouse/client |
| NoSQL | **MongoDB** | mongodb 驱动，查询框收 JSON 命令文档 |
| NoSQL | **Redis** | 零依赖（RESP2 协议自实现），按 key 类型分组浏览 |
| NoSQL | **Elasticsearch** | 零依赖（Node 原生 fetch），便捷搜索或原始 REST |
| 向量 | **Qdrant** | 零依赖，向量搜索 / scroll / payload 浏览 |

SQL 驱动为可选依赖：装哪个用哪个，不用的不用装。

### 面板功能

- **结构树**：连接 → 库/Schema → 表/视图 → 字段，点击逐级展开；MySQL 大库内省走两条 `information_schema` 全量查询（300 表不再 300 次往返）
- **浏览数据**：点表名直接看数据，服务端 LIMIT/OFFSET 分页（50–1000 行/页），表头排序、过滤（值参数化防注入）
- **编辑数据**：双击单元格回车保存（按主键参数化 UPDATE，主键列标 🗝，无主键表只读）；**➕ 新增行**表单插入；行内删除
- **建表 / 改表**：可视化设计器，字段名/类型/主键/自增/唯一/默认值/外键全部点选，可先预览 SQL 再执行
- **导入 / 导出**：CSV（Excel 友好 BOM）/ JSON / SQL INSERT / Markdown 表格导出（上限 10 万行，SQL 层限流不撑内存）；CSV / JSON 导入带映射预览（dryRun 不写库）
- **E-R 关系图**：外键自动布局 + SchemaSpy 式命名推断（无外键约束的库也能画），表视图 / Chen 概念图两种画法；**可编辑**——拖动、改名、改基数、手工建实体和联系，「还原」一键回到数据库真实结构
- **单元格查看器**：长文本 / JSON 格式化 / PNG·JPEG 预览 / 二进制 hex，一键复制
- **查询历史**：最近 100 条，localStorage 持久化
- **连接档案导入 / 导出**：⬆/⬇ 一键迁移，导出永远脱敏（不含任何形式密码），换机器不用手抄
- **写操作审计**：所有写操作（含只读连接上被拒绝的尝试）逐条入账，面板 📜 查看最近 200 条，支持单条删除与清空（删除动作本身也留痕）

### 在聊天里直接用（agent 工具）

安装重启后，10 个工具自动注册给 DSH 的 AI 助手，聊天里直接说：

- “列出我的数据库连接” → `db_list_connections`
- “users 表前 10 行” → `db_connect` + `db_peek_page`
- “这个库有哪些表和字段？” → `db_schema` / `db_describe_table`
- “users 和 orders 是什么关系？” → `db_er_graph`

调用过程与结果摘要在会话中实时展示。**密码永不进入对话**——工具没有密码参数，连接一律使用面板记住的凭据。

### 接入任意 AI 客户端（MCP 出口）

零依赖 MCP stdio 服务器（`lib/mcp.js`），与面板共享连接档案和安全规则。在 Claude Desktop / Cursor 等客户端注册：

```json
{ "command": "node", "args": ["<插件目录>/lib/mcp.js"], "env": { "DSH_HOME": "可选，默认 ~/.dsh" } }
```

---

## 安装

**方式一：dshmarket 市场**（推荐）— 在 DSH 设置 → 插件 → 市场里搜 `dsh-database-explorer`，点安装。

**方式二：命令行**

```sh
npm install -g dsh-database-explorer   # 或
dsh plugin --profile web add dsh-database-explorer
```

**安装后必须完全退出并重启 DSH Desktop**（托盘右键退出，不是刷新页面）。插件的后端注册在 DSH 进程里，页面刷新更新不到它；升级后前后端版本不一致时，面板顶部会挂红色横幅明确提醒。

---

## 快速上手

1. 打开对话区 **数据库** 页签（聊天、轨迹旁边）
2. 点 **+** 新建连接：选类型、填主机/端口/账号，勾 **记住密码** 重启免输；生产库建议勾 **🔒 只读**
3. 展开连接，点表名——右侧出数据
4. 双击单元格改数据，或点 **➕ 行** 插入、**⤓** 导出、**⤒** 导入
5. 工具条 📜 看写操作审计，⛓ 画 E-R 图，**＋** 建表

---

## 安全模型

### 三层写权限

| 层 | 机制 | 效果 |
|---|---|---|
| 连接级只读 | 连接编辑勾选 **🔒 只读** | 该连接一切写路径被硬拒绝：面板写操作、agent 写工具、SQL/原生命令统一按语句预检（仅放行单条读语句；redis 按读命令白名单、mongo 仅 find/count/aggregate、es/qdrant 仅读端点）。SQLite 只读模式打开文件、pg 会话级只读、ClickHouse readonly=1 引擎级兜底 |
| agent 写工具授权 | 默认关闭 | SQL 执行 / 改格 / 插行 / 删行需在 `~/.dsh/plugin-data/dsh-database-explorer/` 创建空文件 `agent-write-tools` 显式授权（重启生效），删除文件即收回。模型不可自授 |
| 写操作审计 | 自动 | 改格/删行/插行/导入/建表/写 SQL（含被拒尝试）逐条记入 `plugin-data/dsh-database-explorer/audit-log.jsonl`（超 5MB 轮转一代）。面板 📜 查看；删除记录/清空日志的动作本身也会留痕 |

推荐用法：生产库建两个档案——「生产库 🔒 只读」日常浏览随便点，「生产库（可写）」真正要改数据时才连。

### 密码安全

- 默认只在内存；勾「记住密码」后 Windows 落盘自动经 **DPAPI（CurrentUser）** 加密为 `dpapi:v1:<密文>`，`connections.json` 不再有明文（防文件外流；不防同用户本地进程，DPAPI 语义如此）
- agent 工具 / MCP 无密码参数，一律复用面板记住的凭据
- 档案导出永远脱敏

### 网络围栏

所有接口同源校验 + Host 白名单（localhost / 127.0.0.1 / ::1），防 DNS rebinding；DSH 供局域网使用时，非本机请求返回 403 并说明原因。本插件仅允许本机浏览器访问。

---

## 排障

| 症状 | 原因与处理 |
|---|---|
| 没有「数据库」页签 | 完全退出 DSH Desktop 重启（后端注册在 DSH 进程里，刷新页面无效） |
| 面板顶部红色版本横幅 | 前后端版本不一致（升级后没重启）——完全退出重启即消 |
| 连接报「缺少驱动」 | SQL 驱动必须装进 DSH profile 的 `node_modules`（市场 / `dsh plugin add` 会装好；游离在 profile 外的插件副本装不了驱动） |
| 局域网另一台机器打开是 403 | 设计如此：本插件仅允许本机访问，在本机浏览器打开 |
| 单元格双击不能编辑 | 该表无主键（防误改），或当前连接是只读连接，或结果来自 SQL 查询（SQL 结果一律只读） |
| ES 深分页报错 | Elasticsearch `from+size` 引擎限制（>10000），用 scroll 或收窄条件 |

---

## 开发

```sh
npm test              # 全量回归（8 个套件，含真实 SQLite 边界用例）
npm run release       # 发布流水线：版本握手 → pack 清单闸门（拦截 lib/package.json 遮蔽宿主包定位）→ 三副本同步 → 回归 → git tag → npm publish
```

架构：宿主半区（`lib/index.js` 路由 + `lib/connections.js` 连接管理 + `lib/tools.js` agent 工具 + `lib/mcp.js` MCP 出口）运行在 DSH 进程；浏览器半区（`lib/client.js`）经 `dsh.client` 声明注入对话区。注意：`lib/` 目录下**不要放名为 `package.json` 的文件**——DSH 从模块位置向上找最近清单，会遮蔽包根配置导致 UI 无法注入（release 流水线已加闸门拦截）。

## Source / 源码

https://github.com/xing-he888/dsh-database-explorer

## License

MIT
