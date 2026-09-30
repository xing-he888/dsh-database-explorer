# dsh-database

Database explorer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — a PyCharm-Database-style panel as a third Conversation tab.

数据库浏览器插件：像 PyCharm 的 Database 面板一样，在 DeepSeek Harness 的对话区直接浏览和查询你的数据库。

![category](https://img.shields.io/badge/category-tools-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features / 功能

- 🗄 **Supported engines / 支持的数据库**：SQLite（内置 `node:sqlite`）、MySQL / MariaDB、PostgreSQL、SQL Server、MongoDB、ClickHouse
- 🌳 **Schema tree / 结构树**：connection → database/schema → table/view → column, expand on click（连接 → 库 → 表 → 字段，点击逐级展开）
- 👆 **Click a table to see its rows / 点表名直接看数据** — no LIMIT, host caps at 10,000 rows with a truncation notice（不拼 LIMIT，主机侧上限 10000 行，超出有提示）
- ✏️ **Inline cell editing / 双击单元格直接改数据**：double-click → edit → Enter saves via a parameterized, PK-addressed `UPDATE`; PK columns are marked 🗝; tables without a PK stay read-only（双击编辑，回车保存；主机侧参数化 UPDATE 按主键精确定位；无主键的表只读）
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

## Notes / 说明

- Optional drivers (mysql2 / pg / mssql / mongodb / @clickhouse/client) are `optionalDependencies`: install only what you use, SQLite works out of the box（可选驱动按需安装，SQLite 开箱即用）
- For MySQL set `local_infile=false` clients aside — this plugin only issues ordinary queries（普通查询即可，无需特殊服务端配置）
- Restart DSH Desktop after installing / 安装后重启 DSH Desktop

## Source / 源码

https://github.com/xing-he888/dsh-database-explorer

## License

MIT
