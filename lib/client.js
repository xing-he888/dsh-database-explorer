/**
 * dsh-database — browser half.
 *
 * Registers a third Conversation view ("数据库" / "Database") next to Chat and
 * Trajectory, exactly the way @deepseek-ai/dsh-client-ui-trajectory registers
 * "trajectory": an injection into the "conversation.view" list slot whose
 * registration carries the view id, order and label, plus the component that
 * renders when the view is active.
 *
 * The panel itself talks to the host over /dsh-database/api/* fetches (same
 * origin as document.baseURI, like dsh-market's client does).
 */
window.__ModuleLoader__.load({
  id: "dsh-database-explorer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsx = require("react/jsx-runtime");

    const NS = "dsh-database";
    const CLIENT_VERSION = "0.9.13";
    const VIEW_ID = "database";
    const VIEW_ORDER = 20; // chat=0, trajectory=10, database=20
    /** 0.9.0：支持 E-R 图的引擎（有外键元数据）。 */
    const ER_ENGINES = ["sqlite", "mysql", "postgres", "mssql"];
    /** 0.9.0：支持服务端分页浏览的引擎。 */
    const PEEK_PAGINATED_ENGINES = ["sqlite", "mysql", "postgres", "mssql", "clickhouse", "mongodb", "elasticsearch"];

    /**
     * Resolve an API path against the document's own directory, then hand back
     * BOTH the path and its query.
     *
     * The query matters: an earlier version returned `url.pathname` alone, which
     * silently dropped `?id=…` — so every schema read arrived without a
     * connection id and the panel showed "no connection selected" / "0 databases"
     * for a perfectly healthy server.
     */
    function api(path) {
      const relative = path.replace(/^\/+/, "");
      if (typeof document === "undefined") return `/${relative}`;
      const url = new URL(relative, document.baseURI);
      return `${url.pathname}${url.search}`;
    }

    async function apiGet(path) {
      const response = await fetch(api(path), { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    }

    async function apiPost(path, payload) {
      const response = await fetch(api(path), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    }

    // ---------------------------------------------------------------------
    // Localized strings (the same zh/en shape official plugins register).
    // ---------------------------------------------------------------------
    const zh = {
      "view.database": "数据库",
      "panel.title": "数据库",
      "panel.empty": "没有数据库连接。点击 + 新建一个。",
      "conn.add": "新建连接",
      "conn.name": "名称",
      "conn.kind": "类型",
      "conn.host": "主机",
      "conn.port": "端口",
      "conn.database": "数据库 / 文件路径",
      "conn.user": "用户名",
      "conn.password": "密码",
      "conn.passwordSaved": "已保存，留空表示不修改",
      "conn.passwordHint": "密码默认只存在内存里；勾选「记住密码」会保存在本机（明文），重启后自动重连，不用每次再输。",
      "conn.rememberPassword": "记住密码（明文保存在本机）",
      "conn.ssl": "SSL",
      "conn.envPassword": "密码环境变量名(可选)",
      "conn.save": "保存",
      "conn.cancel": "取消",
      "conn.delete": "删除",
      "conn.edit": "编辑",
      "conn.test": "测试连接",
      "conn.testing": "测试中…",
      "conn.connect": "连接",
      "conn.disconnect": "断开",
      "conn.connected": "已连接",
      "conn.offline": "未连接",
      "toast.connected": "连接成功",
      "toast.disconnected": "已断开连接",
      "toast.connectFailed": "连接失败",
      "schema.tables": "表",
      "schema.views": "视图",
      "schema.refresh": "刷新结构",
      "schema.title": "数据库",
      "schema.hintExpand": "点连接展开库和表；点表名查看数据",
      "schema.counts": "{db} 个库 · {table} 张表",
      "schema.loading": "正在读取表结构…",
      "schema.expandHint": "点这里展开库和表",
      "schema.readFailed": "读取表结构失败",
      "schema.emptyHint": "点「连接」后这里会列出数据库和表",
      "schema.noDatabases": "没有可显示的数据库（系统库已自动隐藏）",
      "schema.emptyDatabase": "(没有表)",
      "schema.noSelection": "请先在左侧选择一个连接",
      "schema.notConnected": "该连接尚未连接，请先点「连接」",
      "sql.placeholder": "输入 SQL，Ctrl+Enter 执行",
      "sql.run": "执行 (Ctrl+Enter)",
      "sql.rows": "行",
      "sql.ms": "耗时",
      "sql.truncated": "结果超过 10000 行，仅显示前 10000 行",
      "sql.affected": "受影响行数",
      "sql.error": "错误",
      "select.table": "查看全部数据",
      "cell.editHint": "双击单元格可直接修改",
      "edit.done": "已保存",
      "edit.failed": "更新失败",
      "auto.needPassword": "未记住密码，连接后勾选「记住密码」可自动重连",
      "result.hint": "点左侧的表名即可查看数据（双击单元格可直接修改），或在上方输入 SQL 执行（Ctrl+Enter）",
      "designer.newTable": "新建表",
      "designer.title": "新建表",
      "designer.tableName": "表名",
      "designer.tableNamePlaceholder": "例如 users",
      "designer.columnName": "字段名",
      "designer.columnType": "类型",
      "designer.columnLength": "长度",
      "designer.columnPk": "主键",
      "designer.columnNotNull": "非空",
      "designer.columnAutoInc": "自增",
      "designer.columnUnique": "唯一",
      "designer.columnDefault": "默认值",
      "designer.columnFk": "外键",
      "designer.fkNone": "（无）",
      "designer.addColumn": "＋ 添加字段",
      "designer.removeColumn": "删除此字段",
      "designer.moveUp": "上移",
      "designer.moveDown": "下移",
      "designer.create": "创建表",
      "designer.showSql": "查看 SQL",
      "designer.hideSql": "隐藏 SQL",
      "designer.cancel": "取消",
      "designer.created": "表已创建",
      "designer.failed": "创建失败",
      "designer.needConnect": "请先连接，再新建表",
      "designer.noColumns": "请至少添加一个字段",
      "designer.sqlPreview": "将执行的 SQL（只读预览）",
      "designer.intHint": "只有整型主键可以自增",
      "designer.pickDatabase": "该连接有多个数据库，请在左侧数据库行点「＋▦」新建表",
      "designer.editTitle": "编辑表结构",
      "designer.editHint": "勾选 ✕ 删除字段；下方添加新字段（主键/自增不可在此修改）",
      "designer.existing": "现有字段",
      "designer.drop": "删除",
      "designer.keep": "保留",
      "designer.addNew": "新增字段",
      "designer.apply": "应用修改",
      "designer.edited": "表结构已更新",
      "designer.editTable": "编辑表结构",
      "export.csv": "导出 CSV",
      "export.json": "导出 JSON",
      "export.sql": "导出 SQL",
      "export.structure": "导出结构 SQL",
      "export.needTable": "请先在左侧点一个表，打开数据后再导出",
      "export.done": "导出完成",
      "export.failed": "导出失败",
      "export.truncated": "表太大，仅导出前 100000 行",
      "import.button": "导入数据",
      "import.title": "导入数据到表",
      "import.pickFile": "选择文件（CSV 首行为列名，或 JSON 对象数组）",
      "import.format": "格式",
      "import.run": "开始导入",
      "import.done": "导入完成",
      "import.truncated": "文件超过 5 万行，已只导入前 5 万行",
      "import.noFile": "请先选择文件",
      "import.readFailed": "读取文件失败",
      "import.tooBig": "文件超过 32 MB，请先拆分再导入",
      "import.failed": "导入失败",
      "ask.title": "需要密码才能连接",
      "ask.placeholder": "输入密码…",
      "ask.connect": "连接",
      "ask.cancel": "取消",
      "ask.hint": "密码只输这一次，之后会记住并自动连接",
      "designer.healFailed": "自动重连未成功（可能需要密码，已在面板上方弹出输入框）— 原始错误",
      "er.button": "E-R 图",
      "er.title": "E-R 关系图",
      "er.loading": "正在读取关系…",
      "er.failed": "读取关系失败",
      "er.back": "✕ 返回",
      "er.search": "搜索表…",
      "er.all": "全选",
      "er.clear": "清空",
      "er.related": "＋ 邻接表",
      "er.relatedHint": "把与画布上各表直接相关、但还没上画布的表加进来",
      "er.noneToAdd": "没有可补充的表（邻接表都已上画布）",
      "er.addedNeighbors": "已加入 {n} 张邻接表",
      "er.fkCol": "外键列",
      "er.hideRel": "从图中隐藏",
      "er.autoLayout": "自动布局",
      "er.fit": "适应画布",
      "er.newEntity": "＋ 实体",
      "er.newRel": "＋ 联系",
      "er.cancelLink": "取消连线",
      "er.resetModel": "还原",
      "er.resetTitle": "丢弃全部手工修改，回到数据库内省的底稿",
      "er.backToList": "← 返回清单",
      "er.entityName": "实体名",
      "er.attrs": "属性（勾选 = 主键）",
      "er.addAttr": "＋ 属性",
      "er.removeFromCanvas": "从画布移除",
      "er.deleteEntity": "删除实体",
      "er.relName": "联系名",
      "er.card": "基数",
      "er.delRel": "删除联系",
      "er.linkHint1": "连线模式：点击第一个实体（再点一次「＋联系」取消）",
      "er.linkHint2": "连线模式：已选起点 {n} — 点击第二个实体",
      "er.pickHint": "单击实体编辑属性 / 单击自定义菱形编辑联系",
      "er.viewTable": "表视图",
      "er.viewChen": "Chen 图",
      "er.attrsKey": "关键属性",
      "er.attrsAll": "全部属性",
      "er.onboard": "{n} 张表在画布上",
      "er.links": "{n} 条外键连线",
      "er.empty": "在左侧勾选表，把它们放到画布上",
      "er.noTables": "这个库里没有表",
      "er.noEdges": "画布上的表之间没有外键连线",
      "er.tooMany": "共 {n} 张表 — 已关闭自动全选，请在左侧勾选需要的表",
      "er.hint": "滚轮缩放 · 空白拖动平移 · 拖表移动 · 悬停高亮",
      "history.title": "历史",
      "pager.page": "第 {p} / {t} 页 · 共 {n} 行",
      "filter.column": "过滤列",
      "filter.apply": "过滤",
      "filter.clear": "清除",
      "viewer.copy": "复制",
      "viewer.copied": "已复制",
    };
    const en = {
      "view.database": "Database",
      "panel.title": "Database",
      "panel.empty": "No connections yet. Click + to add one.",
      "conn.add": "New connection",
      "conn.name": "Name",
      "conn.kind": "Type",
      "conn.host": "Host",
      "conn.port": "Port",
      "conn.database": "Database / file path",
      "conn.user": "User",
      "conn.password": "Password",
      "conn.passwordSaved": "saved — leave blank to keep it",
      "conn.passwordHint": "Kept in memory by default; ticking “remember” stores it locally (plain text) so the panel reconnects by itself after a restart.",
      "conn.rememberPassword": "Remember password (plain text on this machine)",
      "conn.ssl": "SSL",
      "conn.envPassword": "Password env var name (optional)",
      "conn.save": "Save",
      "conn.cancel": "Cancel",
      "conn.delete": "Delete",
      "conn.edit": "Edit",
      "conn.test": "Test connection",
      "conn.testing": "Testing…",
      "conn.connect": "Connect",
      "conn.disconnect": "Disconnect",
      "conn.connected": "connected",
      "conn.offline": "offline",
      "toast.connected": "Connected",
      "toast.disconnected": "Disconnected",
      "toast.connectFailed": "Connection failed",
      "schema.tables": "Tables",
      "schema.views": "Views",
      "schema.refresh": "Refresh schema",
      "schema.title": "Databases",
      "schema.hintExpand": "expand a connection for databases and tables; click a table to view rows",
      "schema.counts": "{db} databases · {table} tables",
      "schema.loading": "Reading schema…",
      "schema.expandHint": "expand here for databases and tables",
      "schema.readFailed": "Could not read the schema",
      "schema.emptyHint": "Press Connect and the databases and tables appear here",
      "schema.noDatabases": "No databases to show (system schemas are hidden)",
      "schema.emptyDatabase": "(no tables)",
      "schema.noSelection": "Select a connection on the left first",
      "schema.notConnected": "That connection is not open yet — press Connect first",
      "sql.placeholder": "SQL here, Ctrl+Enter to run",
      "sql.run": "Run (Ctrl+Enter)",
      "sql.rows": "rows",
      "sql.ms": "ms",
      "sql.truncated": "Over 10000 rows, showing first 10000",
      "sql.affected": "affected",
      "sql.error": "Error",
      "select.table": "View all rows",
      "cell.editHint": "Double-click a cell to edit it",
      "edit.done": "Saved",
      "edit.failed": "Update failed",
      "auto.needPassword": "Password not remembered — connect once with “remember” ticked to auto-reconnect",
      "result.hint": "Click a table on the left to view its rows (double-click a cell to edit), or run SQL above (Ctrl+Enter)",
      "designer.newTable": "New table",
      "designer.title": "New table",
      "designer.tableName": "Table name",
      "designer.tableNamePlaceholder": "e.g. users",
      "designer.columnName": "Column",
      "designer.columnType": "Type",
      "designer.columnLength": "Length",
      "designer.columnPk": "PK",
      "designer.columnNotNull": "Not null",
      "designer.columnAutoInc": "Auto inc",
      "designer.columnUnique": "Unique",
      "designer.columnDefault": "Default",
      "designer.columnFk": "Foreign key",
      "designer.fkNone": "(none)",
      "designer.addColumn": "＋ Add column",
      "designer.removeColumn": "Remove this column",
      "designer.moveUp": "Move up",
      "designer.moveDown": "Move down",
      "designer.create": "Create table",
      "designer.showSql": "Show SQL",
      "designer.hideSql": "Hide SQL",
      "designer.cancel": "Cancel",
      "designer.created": "Table created",
      "designer.failed": "Create failed",
      "designer.needConnect": "Connect first, then create a table",
      "designer.noColumns": "Add at least one column",
      "designer.sqlPreview": "SQL to be run (read-only preview)",
      "designer.intHint": "Only an integer primary key can auto-increment",
      "designer.pickDatabase": "This connection has several databases — use ＋▦ on a database row to pick one",
      "designer.editTitle": "Edit table structure",
      "designer.editHint": "Tick ✕ to drop columns; add new ones below (PK / auto-increment are not editable here)",
      "designer.existing": "Existing columns",
      "designer.drop": "Drop",
      "designer.keep": "Keep",
      "designer.addNew": "New columns",
      "designer.apply": "Apply changes",
      "designer.edited": "Table structure updated",
      "designer.editTable": "Edit table structure",
      "export.csv": "Export CSV",
      "export.json": "Export JSON",
      "export.sql": "Export SQL",
      "export.structure": "Export structure SQL",
      "export.needTable": "Open a table first, then export",
      "export.done": "Export finished",
      "export.failed": "Export failed",
      "export.truncated": "Table too large — exported the first 100000 rows",
      "import.button": "Import data",
      "import.title": "Import data into table",
      "import.pickFile": "Pick a file (CSV with header row, or JSON objects)",
      "import.format": "Format",
      "import.run": "Start import",
      "import.done": "Import finished",
      "import.truncated": "file exceeded 50,000 rows — only the first 50,000 were imported",
      "import.noFile": "Pick a file first",
      "import.readFailed": "Could not read the file",
      "import.tooBig": "File exceeds 32 MB — split it first",
      "import.failed": "Import failed",
      "ask.title": "Password required to connect",
      "ask.placeholder": "Type the password…",
      "ask.connect": "Connect",
      "ask.cancel": "Cancel",
      "ask.hint": "Type it once — it is remembered and auto-connects from now on",
      "designer.healFailed": "Auto-reconnect failed (a password may be needed — a prompt opened above) — original error",
      "er.button": "E-R diagram",
      "er.title": "E-R diagram",
      "er.loading": "Reading relationships…",
      "er.failed": "Could not read relationships",
      "er.back": "✕ Back",
      "er.search": "Search tables…",
      "er.all": "All",
      "er.clear": "None",
      "er.related": "+ Neighbors",
      "er.relatedHint": "Add tables directly related to the ones on canvas that are not placed yet",
      "er.noneToAdd": "Nothing to add (all neighbors are on the canvas)",
      "er.addedNeighbors": "Added {n} neighbor(s)",
      "er.fkCol": "FK column",
      "er.hideRel": "Hide from diagram",
      "er.autoLayout": "Auto layout",
      "er.fit": "Fit",
      "er.newEntity": "+ Entity",
      "er.newRel": "+ Rel",
      "er.cancelLink": "Cancel",
      "er.resetModel": "Reset",
      "er.resetTitle": "Discard manual edits and restore the introspected schema",
      "er.backToList": "← Back to list",
      "er.entityName": "Entity",
      "er.attrs": "Attributes (tick = PK)",
      "er.addAttr": "+ attr",
      "er.removeFromCanvas": "Remove",
      "er.deleteEntity": "Delete entity",
      "er.relName": "Name",
      "er.card": "Cardinality",
      "er.delRel": "Delete",
      "er.linkHint1": "Link mode: click the first entity (click ＋Rel again to cancel)",
      "er.linkHint2": "Link mode: from {n} — click the second entity",
      "er.pickHint": "Click an entity to edit attrs / a custom diamond to edit the relation",
      "er.viewTable": "Table view",
      "er.viewChen": "Chen view",
      "er.attrsKey": "Key attrs",
      "er.attrsAll": "All attrs",
      "er.onboard": "{n} tables on canvas",
      "er.links": "{n} foreign-key links",
      "er.empty": "Tick tables on the left to place them on the canvas",
      "er.noTables": "No tables in this database",
      "er.noEdges": "No foreign keys among the selected tables",
      "er.tooMany": "{n} tables total — auto-select is off, tick what you need",
      "er.hint": "wheel=zoom · drag bg=pan · drag a table=move · hover=highlight",
      "history.title": "History",
      "pager.page": "page {p} / {t} · {n} rows",
      "filter.column": "filter column",
      "filter.apply": "Filter",
      "filter.clear": "Clear",
      "viewer.copy": "Copy",
      "viewer.copied": "Copied",
    };

    // ---------------------------------------------------------------------
    // Small components
    // ---------------------------------------------------------------------
    function Toolbar({ onAdd, onRefresh, onNewTable, t }) {
      return jsx.jsxs("div", {
        style: { display: "flex", gap: 6, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
        children: [
          jsx.jsx("button", {
            type: "button", onClick: onAdd, title: t("conn.add"),
            style: btnStyle(),
            children: "+",
          }),
          jsx.jsx("button", {
            type: "button", onClick: onNewTable, title: t("designer.newTable"),
            style: { ...btnStyle(), fontWeight: 700 },
            children: "＋▦",
          }),
          jsx.jsx("button", {
            type: "button", onClick: onRefresh, title: t("schema.refresh"),
            style: btnStyle(),
            children: "⟳",
          }),
          jsx.jsx("span", { style: { fontWeight: 600, fontSize: 13, marginLeft: 4 }, children: t("panel.title") }),
        ],
      });
    }

    function btnStyle() {
      return {
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-interactive-bg-hover)",
        color: "var(--dsw-alias-label-secondary)",
        borderRadius: 6, cursor: "pointer", lineHeight: "18px",
        padding: "1px 9px", fontSize: 13,
      };
    }

    function ProfileForm({ kinds, initial, onSaved, onCancel, onTest, testing, t }) {
      const [form, setForm] = react.useState(() => ({
        name: initial?.name ?? "",
        kind: initial?.kind ?? "sqlite",
        host: initial?.host ?? "localhost",
        port: initial?.port ?? "",
        database: initial?.database ?? "",
        user: initial?.user ?? "",
        envPassword: initial?.envPassword ?? "",
        password: "",
        // Remember by default: the cookie flow is what users expect — connect
        // once, and every later app start reconnects by itself. Uncheck for
        // machines that are not yours.
        rememberPassword: initial ? initial.hasPassword === true : true,
        ssl: initial?.ssl === true,
      }));
      const set = (field) => (event) => {
        const value = event?.target ? (event.target.type === "checkbox" ? event.target.checked : event.target.value) : event;
        setForm((prev) => ({ ...prev, [field]: value }));
      };
      const kindList = Object.entries(kinds || {});
      react.useEffect(() => {
        const def = kinds?.[form.kind]?.defaultPort;
        setForm((prev) => ({ ...prev, port: prev.port === "" && def != null ? String(def) : prev.port }));
      }, [form.kind]);
      const inputStyle = { width: "100%", boxSizing: "border-box", fontSize: 12, padding: "4px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" };
      const labelStyle = { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 6, display: "block" };
      const isSqlite = form.kind === "sqlite";
      const isMongo = form.kind === "mongodb";
      return jsx.jsxs("div", {
        style: { padding: 10, display: "flex", flexDirection: "column", gap: 2, borderBottom: "1px solid var(--dsw-alias-border-l2)" },
        children: [
          jsx.jsx("label", { style: labelStyle, children: t("conn.name") }),
          jsx.jsx("input", { style: inputStyle, value: form.name, onChange: set("name"), placeholder: "My DB" }),
          jsx.jsx("label", { style: labelStyle, children: t("conn.kind") }),
          jsx.jsx("select", { style: inputStyle, value: form.kind, onChange: set("kind"),
            children: kindList.map(([key, meta]) => jsx.jsx("option", { value: key, children: meta.label }, key)) }),
          !isSqlite && jsx.jsxs(react.Fragment, { children: [
            jsx.jsx("label", { style: labelStyle, children: t("conn.host") }),
            jsx.jsx("input", { style: inputStyle, value: form.host, onChange: set("host") }),
            jsx.jsx("label", { style: labelStyle, children: t("conn.port") }),
            jsx.jsx("input", { style: inputStyle, value: form.port, onChange: set("port"), inputMode: "numeric" }),
          ] }),
          jsx.jsx("label", { style: labelStyle, children: isSqlite ? t("conn.database") + " (路径)" : t("conn.database") }),
          jsx.jsx("input", { style: inputStyle, value: form.database, onChange: set("database"),
            placeholder: isSqlite ? "C:\\data\\app.db" : isMongo ? "admin" : form.kind === "redis" ? "0-15" : form.kind === "elasticsearch" ? "(可选) 留空 = 整个集群" : form.kind === "qdrant" ? "(可选)" : "" }),
          !isSqlite && jsx.jsxs(react.Fragment, { children: [
            jsx.jsx("label", { style: labelStyle, children: t("conn.user") }),
            jsx.jsx("input", { style: inputStyle, value: form.user, onChange: set("user"), autoComplete: "off" }),
            jsx.jsx("label", { style: labelStyle, children: t("conn.password") }),
            jsx.jsx("input", {
              style: inputStyle, type: "password", value: form.password, onChange: set("password"), autoComplete: "new-password",
              placeholder: initial?.hasPassword ? t("conn.passwordSaved") : "",
            }),
            jsx.jsx("label", { style: { ...labelStyle, display: "flex", alignItems: "center", gap: 6 }, children: jsx.jsxs(react.Fragment, { children: [
              jsx.jsx("input", { type: "checkbox", checked: form.rememberPassword, onChange: set("rememberPassword") }),
              t("conn.rememberPassword"),
            ] }) }),
            jsx.jsx("div", { style: { fontSize: 10.5, color: "var(--dsw-alias-label-caption)", marginTop: 2 }, children: t("conn.passwordHint") }),
            jsx.jsx("label", { style: labelStyle, children: t("conn.envPassword") }),
            jsx.jsx("input", { style: inputStyle, value: form.envPassword, onChange: set("envPassword"), autoComplete: "off", placeholder: "MYSQL_PWD" }),
            jsx.jsx("label", { style: { ...labelStyle, display: "flex", alignItems: "center", gap: 6 }, children: jsx.jsxs(react.Fragment, { children: [
              jsx.jsx("input", { type: "checkbox", checked: form.ssl, onChange: set("ssl") }),
              t("conn.ssl"),
            ] }) }),
          ] }),
          jsx.jsxs("div", { style: { display: "flex", gap: 6, marginTop: 10, alignItems: "center" }, children: [
            jsx.jsx("button", { type: "button", style: btnStyle(), onClick: () => onSaved(form), children: t("conn.save") }),
            jsx.jsx("button", { type: "button", style: btnStyle(), disabled: testing, onClick: () => onTest(form), children: testing ? t("conn.testing") : t("conn.test") }),
            jsx.jsx("button", { type: "button", style: btnStyle(), onClick: onCancel, children: t("conn.cancel") }),
          ] }),
        ],
      });
    }

    function ProfileRow({ profile, connected, active, onSelect, onConnect, onDisconnect, onDelete, onEdit, onPeek, t }) {
      return jsx.jsxs("div", {
        style: {
          padding: "6px 8px", cursor: "pointer", borderRadius: 6,
          background: active ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
          display: "flex", flexDirection: "column", gap: 2, marginBottom: 2,
        },
        // React hands the click EVENT to a bare handler; the profile has to be
        // bound explicitly, or the handler receives a MouseEvent and reads
        // `event.id` (undefined) as the connection id.
        onClick: () => onSelect(profile),
        children: [
          jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
            jsx.jsx("span", { style: { fontSize: 12 }, children: connected ? "🟢" : "⚪" }),
            jsx.jsx("span", { style: { fontSize: 12.5, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: profile.name }),
            jsx.jsx("button", { type: "button", title: t("conn.edit") || "edit", style: { ...btnStyle(), padding: "0 6px" }, onClick: (e) => { e.stopPropagation(); onEdit(profile); }, children: "✎" }),
            jsx.jsx("button", { type: "button", title: t("conn.delete"), style: { ...btnStyle(), padding: "0 6px" }, onClick: (e) => { e.stopPropagation(); onDelete(profile); }, children: "🗑" }),
          ] }),
          jsx.jsxs("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", display: "flex", gap: 6, alignItems: "center" }, children: [
            jsx.jsx("span", { children: profile.kind }),
            !isSqliteKind(profile.kind) && jsx.jsx("span", { children: `${profile.host}:${profile.port ?? ""}` }),
            isSqliteKind(profile.kind) && jsx.jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 }, children: profile.database }),
            jsx.jsx("span", { style: { marginLeft: "auto" }, children: connected
              ? jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: (e) => { e.stopPropagation(); onDisconnect(profile); }, children: t("conn.disconnect") })
              : jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: (e) => { e.stopPropagation(); onConnect(profile); }, children: t("conn.connect") }) }),
          ] }),
        ],
      });
    }

    function isSqliteKind(kind) { return kind === "sqlite"; }

    /** Indentation step per tree level, in pixels. */
    const INDENT = 14;

    /** Quote one identifier the way the target engine expects. */
    function quoteFor(engine, name) {
      if (engine === "mysql" || engine === "clickhouse") return `\`${String(name).replace(/`/g, '``')}\``;
      if (engine === "mssql") return `[${String(name).replace(/\]/g, ']]')}]`;
      if (engine === "postgres") return `"${String(name).replace(/"/g, '""')}"`;
      return String(name);
    }

    /** Fully qualified table reference for the peek query, per engine. */
    function qualifiedName(engine, database, table) {
      if (!database || engine === "sqlite") return quoteFor(engine, table);
      return `${quoteFor(engine, database)}.${quoteFor(engine, table)}`;
    }

    function hintStyle() {
      return { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary)", padding: "6px 2px", lineHeight: "17px" };
    }

    /** How long a cached schema tree is considered fresh, in milliseconds. */
    const SCHEMA_TTL_MS = 30000;

    /** One tree row: caret, glyph, label, optional trailing controls. */
    function TreeRow({ depth, open, hasChildren, glyph, label, trailing, onToggle, bold, tone, title }) {
      return jsx.jsxs("div", {
        title,
        style: {
          display: "flex", alignItems: "center", gap: 4, fontSize: 12,
          padding: "2px 4px", paddingLeft: 4 + depth * INDENT,
          borderRadius: 4, cursor: onToggle ? "pointer" : "default",
          color: tone ?? "var(--dsw-alias-label-primary)",
        },
        onClick: onToggle,
        children: [
          jsx.jsx("span", {
            style: { fontSize: 9, width: 10, flex: "none", display: "inline-block", color: "var(--dsw-alias-label-tertiary)" },
            children: hasChildren ? (open ? "▾" : "▸") : "",
          }),
          glyph ? jsx.jsx("span", { style: { flex: "none" }, children: glyph }) : null,
          jsx.jsx("span", {
            style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: bold ? 600 : 400 },
            children: label,
          }),
          trailing ?? null,
        ],
      });
    }

    /**
     * The unified tree the panel is built around (PyCharm-style):
     *
     *   connection  →  database/schema  →  table/view  →  column
     *
     * Each level expands on click; a connection's schema is fetched the first
     * time it is expanded, so a tree with many connections costs nothing until
     * the user looks inside one.
     */
    function ConnectionNode({ profile, connected, active, schema, error, loading, onSelect, onConnect, onDisconnect, onDelete, onEdit, onPeek, onNeedSchema, onNewTable, onEditTable, onEr, t }) {
      const [open, setOpen] = react.useState(false);
      const [openDatabases, setOpenDatabases] = react.useState({});

      const toggle = () => {
        const next = !open;
        setOpen(next);
        // 只在"展开"时切换活动连接：折叠/重新展开不应把 SQL 编辑器的目标静默
        // 换成另一个连接（审计 R6-M2：展开 B 浏览表后 Ctrl+Enter 会跑到 B 上）。
        if (next) onSelect(profile);
        if (next && connected) onNeedSchema(profile.id);
      };

      const databases = schema?.databases ?? [];
      const tableCount = databases.reduce((sum, db) => sum + (db.tables?.length ?? 0), 0);

      // The status line tells the truth: a failed read shows as a failure (never
      // as "0 databases"), and it stays one click away from a retry.
      const status = error
        ? jsx.jsx("span", { style: { color: "#e06c75" }, children: `⚠ ${error}` })
        : schema
          ? t("schema.counts").replace("{db}", String(databases.length)).replace("{table}", String(tableCount))
          : loading
            ? t("schema.loading")
            : connected ? t("schema.expandHint") : t("schema.notConnected");

      return jsx.jsxs("div", { children: [
        jsx.jsx(TreeRow, {
          depth: 0,
          open,
          hasChildren: true,
          glyph: connected ? "🟢" : "⚪",
          bold: active,
          label: profile.name,
          title: isSqliteKind(profile.kind) ? profile.database : `${profile.host}:${profile.port ?? ""}`,
          trailing: jsx.jsxs("span", { style: { display: "flex", gap: 2, flex: "none" }, children: [
            jsx.jsx("button", {
              type: "button", title: t("schema.refresh"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px" },
              onClick: (e) => {
                e.stopPropagation();
                if (!connected) { onConnect(profile); return; }
                setOpen(true);
                onNeedSchema(profile.id, true);
              },
              children: "⟳",
            }),
            jsx.jsx("button", {
              type: "button", title: connected ? t("conn.disconnect") : t("conn.connect"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px" },
              onClick: (e) => { e.stopPropagation(); connected ? onDisconnect(profile) : onConnect(profile); },
              children: connected ? "⏻" : "⚡",
            }),
            jsx.jsx("button", {
              type: "button", title: t("conn.edit"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px" },
              onClick: (e) => { e.stopPropagation(); onEdit(profile); },
              children: "✎",
            }),
            jsx.jsx("button", {
              type: "button", title: t("conn.delete"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px" },
              onClick: (e) => { e.stopPropagation(); onDelete(profile); },
              children: "🗑",
            }),
          ] }),
        }),
        jsx.jsx("div", {
          style: { fontSize: 10.5, color: "var(--dsw-alias-label-caption)", paddingLeft: 4 + INDENT, wordBreak: "break-word" },
          children: status,
        }),
        open && jsx.jsxs("div", { children: [
          loading && !schema ? jsx.jsx("div", { style: { ...hintStyle(), paddingLeft: 4 + INDENT * 2 }, children: t("schema.loading") }) : null,
          connected && schema && databases.length === 0
            ? jsx.jsx("div", { style: { ...hintStyle(), paddingLeft: 4 + INDENT * 2 }, children: t("schema.noDatabases") })
            : null,
          !connected ? jsx.jsx("div", { style: { ...hintStyle(), paddingLeft: 4 + INDENT * 2 }, children: t("schema.emptyHint") }) : null,
          databases.map((db) => jsx.jsx(DatabaseNode, {
            database: db,
            engine: schema?.engine,
            open: openDatabases[db.name] === true,
            onToggle: () => setOpenDatabases((prev) => ({ ...prev, [db.name]: !prev[db.name] })),
            onPeek: (table) => onPeek(table, db.name, profile.id),
            onNewTable: () => onNewTable(profile, db.name),
            onEditTable: (table) => onEditTable(table, db.name, profile.id),
            onEr: () => onEr(profile, db.name),
            t,
          }, db.name)),
        ] }),
      ] });
    }

    function DatabaseNode({ database, engine, open, onToggle, onPeek, onNewTable, onEditTable, onEr, t }) {
      const tables = database.tables ?? [];
      return jsx.jsxs("div", { children: [
        jsx.jsx(TreeRow, {
          depth: 1,
          open,
          hasChildren: tables.length > 0,
          glyph: "🗄",
          label: `${database.name} (${tables.length})`,
          onToggle: tables.length > 0 ? onToggle : undefined,
          bold: false,
          trailing: jsx.jsxs("span", { style: { display: "flex", gap: 2, flex: "none" }, children: [
            ER_ENGINES.includes(engine) && onEr ? jsx.jsx("button", {
              type: "button", title: t("er.button"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
              onClick: (e) => { e.stopPropagation(); onEr(); },
              children: "⛓",
            }) : null,
            onNewTable ? jsx.jsx("button", {
              type: "button", title: t("designer.newTable"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
              onClick: (e) => { e.stopPropagation(); onNewTable(); },
              children: "＋▦",
            }) : null,
          ] }),
        }),
        open && jsx.jsx("div", { children:
          tables.length === 0
            ? jsx.jsx("div", { style: { ...hintStyle(), paddingLeft: 4 + INDENT * 3 }, children: t("schema.emptyDatabase") })
            : tables.map((table) => jsx.jsx(TableNode, { table, engine, database: database.name, onPeek, onEditTable, t }, database.name + "/" + table.name)) }),
      ] });
    }

    function TableNode({ table, engine, database, onPeek, onEditTable, t }) {
      const [open, setOpen] = react.useState(false);
      const columns = table.columns ?? [];
      return jsx.jsxs("div", { children: [
        jsx.jsx(TreeRow, {
          depth: 2,
          open,
          hasChildren: columns.length > 0,
          glyph: table.kind === "view" ? "👁" : "▦",
          label: table.name,
          // Clicking a table does BOTH things a user expects: loads its rows
          // into the result grid (the whole point of the panel) and toggles
          // the column list. The old behavior — click expands columns only,
          // data hidden behind the tiny ⤚ button — read as "the table has no
          // data", which is exactly the report that led here.
          onToggle: () => { onPeek(table); setOpen((v) => !v); },
          trailing: jsx.jsxs("span", { style: { display: "flex", gap: 2, flex: "none" }, children: [
            jsx.jsx("button", {
              type: "button", title: t("select.table"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
              onClick: (e) => { e.stopPropagation(); onPeek(table); },
              children: "⤚",
            }),
            table.kind !== "view" && onEditTable ? jsx.jsx("button", {
              type: "button", title: t("designer.editTable"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
              onClick: (e) => { e.stopPropagation(); onEditTable(table); },
              children: "✎",
            }) : null,
          ] }),
        }),
        open && jsx.jsx("div", { children: columns.map((col) => jsx.jsx(TreeRow, {
          key: col.name,
          depth: 3,
          open: false,
          hasChildren: false,
          glyph: col.key ? "🔑" : "·",
          label: col.name,
          trailing: jsx.jsx("span", { style: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: 10.5 }, children: col.type ?? "" }),
          tone: "var(--dsw-alias-label-secondary)",
        }, col.name)) }),
      ] });
    }

    function SqlEditor({ onRun, t, history }) {
      const [value, setValue] = react.useState("");
      const run = react.useCallback(() => onRun(value), [value, onRun]);
      return jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
        jsx.jsx("textarea", {
          value, onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
            // 输入法选词中的回车不触发执行（中文用户打拼音按回车会直接跑 SQL）
            if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
          },
          placeholder: t("sql.placeholder"),
          spellCheck: false,
          style: {
            flex: 1, minHeight: 72, resize: "vertical", padding: 8, fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)",
            border: "none", outline: "none", boxSizing: "border-box",
          },
        }),
        jsx.jsxs("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, padding: "4px 8px", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
          jsx.jsxs("select", { value: "", title: t("history.title"), onChange: (e) => { if (e.target.value) setValue(e.target.value); }, style: { fontSize: 11, padding: "2px 4px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", maxWidth: 320 }, children: [
            jsx.jsx("option", { value: "", children: `⏱ ${t("history.title")}` }),
            (history ?? []).map((h, i) => jsx.jsx("option", { value: h, children: h.length > 70 ? h.slice(0, 70) + "…" : h }, i)),
          ] }),
          jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontWeight: 600 }, onClick: run, children: t("sql.run") }),
        ] }),
      ] });
    }

    /**
     * Local fallback for the designer type list. The host route is the source
     * of truth, but when it cannot be reached the dropdown must STILL offer
     * the full set — an empty list rendered every row as a blank select
     * (2026-10-01 screenshot: type column showed only "▾").
     */
    const FALLBACK_DESIGNER_TYPES = [
      { id: "integer", label: "INT 整数" },
      { id: "bigint", label: "BIGINT 长整数" },
      { id: "varchar", label: "VARCHAR 字符串", needsLength: true, lengthPlaceholder: "255" },
      { id: "text", label: "TEXT 长文本" },
      { id: "boolean", label: "BOOLEAN 布尔" },
      { id: "date", label: "DATE 日期" },
      { id: "datetime", label: "DATETIME 时间" },
      { id: "decimal", label: "DECIMAL 小数", needsLength: true, lengthPlaceholder: "10,2" },
      { id: "float", label: "FLOAT 浮点" },
      { id: "json", label: "JSON" },
      { id: "blob", label: "BLOB 二进制" },
    ];

    /** Shared column widths so the header row and the field rows line up. */
    const DESIGNER_COL_W = { name: 150, type: 180, len: 70, flag: 34, def: 118, fk: 150 };

    /**
     * The visual table designer — the "create a table by clicking" form.
     *
     * Renders INLINE (it replaces the panel body while open, exactly like the
     * connection form), NOT as an absolute overlay: themes that paint
     * translucent panel backgrounds (the wallpaper plugin) turned an overlay
     * with a var()-based background into transparent glass, stacking the form
     * on top of the tree and the SQL editor.
     *
     * Every property is picked with the mouse; the browser assembles NO SQL —
     * it posts a plain description and the host builds the engine DDL. "Show
     * SQL" previews through the same create route in dry-run form.
     *
     * EDIT MODE (editTable set): the designer becomes a structure editor —
     * existing columns are listed read-only with a drop checkbox, new columns
     * are added below, and Apply posts to /designer/alter-table. PK and
     * auto-increment are hidden: altering a primary key rewrites the table.
     */
    function TableDesigner({ engine, database, designerTypes, onClose, onCreated, onError, t, editTable, connectionId, fkOptions, ensureLive }) {
      const isEdit = editTable != null;
      const [tableName, setTableName] = react.useState(isEdit ? editTable : "");
      const blankColumn = () => ({ name: "", type: "varchar", length: "255", pk: false, notNull: false, autoIncrement: false, unique: false, hasDefault: false, default: "", fk: "" });
      const [columns, setColumns] = react.useState(() => (isEdit ? [] : [
        { name: "id", type: "integer", length: "", pk: true, notNull: true, autoIncrement: true, unique: false, hasDefault: false, default: "", fk: "" },
        blankColumn(),
      ]));
      const [existingColumns, setExistingColumns] = react.useState(() => (isEdit ? null : [])); // null = still loading
      const [dropSet, setDropSet] = react.useState({});
      const [showSql, setShowSql] = react.useState(false);
      const [sqlPreview, setSqlPreview] = react.useState("");
      const [submitting, setSubmitting] = react.useState(false);

      // Edit mode: fetch the table's real column names once.
      react.useEffect(() => {
        if (!isEdit) return;
        apiGet(`/dsh-database/api/designer/columns?id=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database ?? "")}&table=${encodeURIComponent(editTable)}`)
          .then((body) => setExistingColumns(body.columns ?? []))
          .catch((error) => { setExistingColumns([]); onError(t("designer.failed"), String(error.message || error)); });
      }, [isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

      const update = (index, field, value) => {
        setColumns((prev) => prev.map((col, i) => {
          if (i !== index) return col;
          const next = { ...col, [field]: value };
          // PK implies not-null; non-integer PKs cannot auto-increment.
          if (field === "pk") {
            next.notNull = value === true ? true : next.notNull;
            if (value === true && !["integer", "bigint"].includes(next.type)) next.autoIncrement = false;
          }
          if (field === "type" && value !== "integer" && value !== "bigint") next.autoIncrement = false;
          if (field === "type") {
            const meta = designerTypes?.find?.((x) => x.id === value);
            next.length = meta?.needsLength ? (next.length || meta.lengthPlaceholder || "") : "";
          }
          return next;
        }));
      };
      const addColumn = () => setColumns((prev) => [...prev, blankColumn()]);
      const removeColumn = (index) => setColumns((prev) => prev.filter((_, i) => i !== index));
      const move = (index, delta) => setColumns((prev) => {
        const next = [...prev];
        const to = index + delta;
        if (to < 0 || to >= next.length) return prev;
        [next[index], next[to]] = [next[to], next[index]];
        return next;
      });

      const draft = { table: tableName.trim(), columns };
      const refreshPreview = react.useCallback(async () => {
        if (isEdit) {
          // Edit mode preview: describe the pending ALTER operations.
          const drops = Object.keys(dropSet).filter((k) => dropSet[k]);
          const parts = [];
          for (const name of drops) parts.push(`ALTER TABLE ... DROP COLUMN ...`);
          const addable = columns.filter((c) => c.name.trim() !== "");
          for (const c of addable) parts.push(`ALTER TABLE ... ADD COLUMN ${c.name} ...`);
          setSqlPreview(parts.length > 0 ? parts.join(';\n') + ';' : '-- 无修改 / nothing to change');
          return;
        }
        try {
          // id: the host resolves the live connection from it — without it
          // every create/preview failed with "connection is not open" even
          // while connected (the alter-table path always carried it).
          const body = await apiPost("/dsh-database/api/designer/create-table", { id: connectionId, database, ...draft, dryRun: true });
          setSqlPreview(body.sql ?? "");
        } catch (error) {
          setSqlPreview(String(error.message || error));
        }
      }, [isEdit, connectionId, database, tableName, columns, dropSet]); // eslint-disable-line react-hooks/exhaustive-deps

      /**
       * Post a designer operation with dead-connection self-healing: a host
       * restart between opening the form and pressing Apply used to surface
       * "connection is not open" and lose the whole filled form. Now the
       * connection is force-rebuilt once and the SAME request retried.
       */
      const postWithHeal = async (path, payload) => {
        try {
          return await apiPost(path, payload);
        } catch (error) {
          const message = String(error?.message || error);
          if (!/连接未打开|connection is not open/i.test(message) || !ensureLive) throw error;
          const ok = await ensureLive(connectionId);
          if (!ok) throw error;
          return await apiPost(path, payload);
        }
      };

      const create = async () => {
        if (!tableName.trim()) { onError(t("designer.failed"), t("designer.tableName")); return; }
        if (isEdit) {
          setSubmitting(true);
          try {
            const drop = Object.keys(dropSet).filter((name) => dropSet[name]);
            const add = columns.filter((c) => c.name.trim() !== "");
            const body = await postWithHeal("/dsh-database/api/designer/alter-table", {
              id: connectionId, database, table: editTable, add, drop,
            });
            onCreated(body, true);
          } catch (error) {
            onError(t("designer.failed"), String(error.message || error));
          } finally { setSubmitting(false); }
          return;
        }
        setSubmitting(true);
        try {
          // id here too: same root cause as the dryRun preview above.
          const body = await postWithHeal("/dsh-database/api/designer/create-table", { id: connectionId, database, ...draft });
          onCreated(body);
        } catch (error) {
          onError(t("designer.failed"), String(error.message || error));
        } finally { setSubmitting(false); }
      };

      const types = (designerTypes?.length ?? 0) > 0 ? designerTypes : FALLBACK_DESIGNER_TYPES;
      const inputStyle = { boxSizing: "border-box", fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" };
      const headStyle = { fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)", fontWeight: 600 };
      const iconBtn = (title, onClick, glyph, disabled) => jsx.jsx("button", {
        type: "button", title, disabled, style: { ...btnStyle(), fontSize: 10.5, padding: "0 5px", flex: "none", opacity: disabled ? 0.4 : 1 }, onClick, children: glyph,
      });

      /** One grid row: header or a field. Same template → columns line up.
       *  A plain helper returning props (NOT an inline component): an inline
       *  component type is recreated every render and React REMOUNTS the row,
       *  which threw away focus after every keystroke — typing a column name
       *  died after the first character (2026-10-01 report). */
      const gridTemplate = `${DESIGNER_COL_W.name}px ${DESIGNER_COL_W.type}px ${DESIGNER_COL_W.len}px ${DESIGNER_COL_W.flag}px ${DESIGNER_COL_W.flag}px ${DESIGNER_COL_W.flag}px ${DESIGNER_COL_W.flag}px ${DESIGNER_COL_W.def}px ${DESIGNER_COL_W.fk}px 66px`;
      const Row = (children, key = undefined, style = undefined) => jsx.jsx("div", {
        key,
        style: { display: "grid", gridTemplateColumns: gridTemplate, gap: 4, alignItems: "center", ...style },
        children,
      });

      return jsx.jsxs("div", {
        style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
        children: [
          // header strip
          jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
            jsx.jsx("span", { style: { fontWeight: 700, fontSize: 13 }, children: `▦ ${isEdit ? t("designer.editTitle") : t("designer.title")}` }),
            jsx.jsx("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }, children: `${isEdit ? editTable : ""}${database ? " · " + database : ""} · ${engine ?? ""}` }),
          ] }),
          // scrollable body
          jsx.jsxs("div", { style: { flex: 1, overflow: "auto", padding: "10px 12px", minHeight: 0 }, children: [
            isEdit ? jsx.jsxs("div", { style: { fontSize: 11.5, color: "var(--dsw-alias-label-secondary)", marginBottom: 8 }, children: [t("designer.editHint")] }) : jsx.jsxs(react.Fragment, { children: [
              jsx.jsx("label", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", display: "block", marginBottom: 3 }, children: t("designer.tableName") }),
              jsx.jsx("input", { style: { ...inputStyle, width: 360, fontWeight: 600 }, value: tableName, onChange: (e) => setTableName(e.target.value), placeholder: t("designer.tableNamePlaceholder"), autoFocus: true }),
            ] }),
            isEdit ? jsx.jsxs(react.Fragment, { children: [
              jsx.jsx("div", { style: { ...headStyle, fontSize: 11, margin: "6px 0 4px", color: "var(--dsw-alias-label-secondary)" }, children: existingColumns === null ? t("schema.loading") : `${t("designer.existing")} (${existingColumns.length})` }),
              existingColumns === null ? null : existingColumns.map((name) => jsx.jsxs("div", {
                style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", borderBottom: "1px dashed var(--dsw-alias-border-l2)" },
                children: [
                  jsx.jsx("span", { style: { fontFamily: "ui-monospace, Menlo, Consolas, monospace", fontSize: 12, flex: 1 }, children: name }),
                  jsx.jsx("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, cursor: "pointer" }, children: jsx.jsxs(react.Fragment, { children: [
                    jsx.jsx("input", { type: "checkbox", checked: dropSet[name] === true, onChange: (e) => setDropSet((prev) => ({ ...prev, [name]: e.target.checked })) }),
                    dropSet[name] ? `🗑 ${t("designer.drop")}` : t("designer.keep"),
                  ] }) }),
                ],
              }, name)),
              jsx.jsx("div", { style: { ...headStyle, fontSize: 11, margin: "10px 0 4px", color: "var(--dsw-alias-label-secondary)" }, children: `${t("designer.addNew")} (${columns.filter((c) => c.name.trim() !== "").length})` }),
            ] }) : Row([
              jsx.jsx("span", { style: { ...headStyle, padding: "0 6px" }, children: t("designer.columnName") }),
              jsx.jsx("span", { style: { ...headStyle, padding: "0 6px" }, children: t("designer.columnType") }),
              jsx.jsx("span", { style: { ...headStyle, padding: "0 6px" }, children: t("designer.columnLength") }),
              jsx.jsx("span", { style: { ...headStyle, textAlign: "center" }, children: t("designer.columnPk") }),
              jsx.jsx("span", { style: { ...headStyle, textAlign: "center" }, children: t("designer.columnNotNull") }),
              jsx.jsx("span", { style: { ...headStyle, textAlign: "center" }, children: t("designer.columnAutoInc") }),
              jsx.jsx("span", { style: { ...headStyle, textAlign: "center" }, children: t("designer.columnUnique") }),
              jsx.jsx("span", { style: { ...headStyle, padding: "0 6px" }, children: t("designer.columnDefault") }),
              jsx.jsx("span", { style: { ...headStyle, padding: "0 6px" }, children: t("designer.columnFk") }),
              jsx.jsx("span", {}),
            ], undefined, { marginTop: 10, paddingBottom: 2 }),
            columns.map((col, index) => {
              const meta = types.find((x) => x.id === col.type);
              return Row([
                jsx.jsx("input", { style: { ...inputStyle, width: "100%" }, value: col.name, onChange: (e) => update(index, "name", e.target.value), placeholder: `field_${index + 1}` }),
                jsx.jsx("select", { style: { ...inputStyle, width: "100%" }, value: col.type, onChange: (e) => update(index, "type", e.target.value), children: types.map((tp) => jsx.jsx("option", { value: tp.id, children: tp.label }, tp.id)) }),
                (meta?.needsLength === true) ? jsx.jsx("input", { style: { ...inputStyle, width: "100%" }, value: col.length, onChange: (e) => update(index, "length", e.target.value), placeholder: meta.lengthPlaceholder || "" })
                  : jsx.jsx("span", {}),
                !isEdit ? jsx.jsx("span", { style: { textAlign: "center" }, children: jsx.jsx("input", { type: "checkbox", checked: col.pk === true, onChange: (e) => update(index, "pk", e.target.checked) }) }) : jsx.jsx("span", {}),
                jsx.jsx("span", { style: { textAlign: "center" }, children: jsx.jsx("input", { type: "checkbox", checked: col.notNull === true, onChange: (e) => update(index, "notNull", e.target.checked) }) }),
                !isEdit ? jsx.jsx("span", { style: { textAlign: "center" }, children: jsx.jsx("input", { type: "checkbox", checked: col.autoIncrement === true, disabled: !col.pk || !["integer", "bigint"].includes(col.type), onChange: (e) => update(index, "autoIncrement", e.target.checked) }) }) : jsx.jsx("span", {}),
                jsx.jsx("span", { style: { textAlign: "center" }, children: jsx.jsx("input", { type: "checkbox", checked: col.unique === true, onChange: (e) => update(index, "unique", e.target.checked) }) }),
                jsx.jsx("input", { style: { ...inputStyle, width: "100%", opacity: col.hasDefault === true ? 1 : 0.45 }, value: col.default, disabled: col.hasDefault !== true, onChange: (e) => update(index, "default", e.target.value), placeholder: "NULL / 0 / 'x'" }),
                jsx.jsxs("select", { style: { ...inputStyle, width: "100%", fontSize: 11 }, value: col.fk ?? "", onChange: (e) => update(index, "fk", e.target.value), title: t("designer.columnFk"), children: [
                  jsx.jsx("option", { value: "", children: t("designer.fkNone") }),
                  (fkOptions ?? []).map((ref) => jsx.jsx("option", { value: ref, children: ref }, ref)),
                ] }),
                jsx.jsxs("span", { style: { display: "flex", gap: 2, justifyContent: "flex-end" }, children: [
                  !isEdit ? jsx.jsxs(react.Fragment, { children: [
                    iconBtn(t("designer.moveUp"), () => move(index, -1), "↑", index === 0),
                    iconBtn(t("designer.moveDown"), () => move(index, 1), "↓", index === columns.length - 1),
                  ] }) : null,
                  iconBtn(t("designer.removeColumn"), () => removeColumn(index), "✕", !isEdit && columns.length <= 1),
                ] }),
              ], index);
            }),
            jsx.jsxs("div", { style: { marginTop: 10, display: "flex", gap: 8, alignItems: "center" }, children: [
              jsx.jsx("button", { type: "button", style: btnStyle(), onClick: addColumn, children: t("designer.addColumn") }),
              jsx.jsx("span", { style: { fontSize: 10.5, color: "var(--dsw-alias-label-caption)" }, children: isEdit ? t("designer.editHint") : t("designer.intHint") }),
            ] }),
            showSql ? jsx.jsxs("div", { style: { marginTop: 12 }, children: [
              jsx.jsxs("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginBottom: 3 }, children: [t("designer.sqlPreview"), " ", jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: refreshPreview, children: "⟳" })] }),
              jsx.jsx("pre", { style: { margin: 0, padding: 8, fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-secondary)" }, children: sqlPreview || "…" }),
            ] }) : null,
          ] }),
          // footer
          jsx.jsxs("div", { style: { display: "flex", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--dsw-alias-border-l2)", alignItems: "center" }, children: [
            jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontWeight: 700 }, disabled: submitting || (isEdit && existingColumns === null), onClick: create, children: submitting ? "…" : isEdit ? `✓ ${t("designer.apply")}` : `▦ ${t("designer.create")}` }),
            jsx.jsx("button", { type: "button", style: btnStyle(), onClick: showSql ? () => setShowSql(false) : () => { setShowSql(true); refreshPreview(); }, children: showSql ? t("designer.hideSql") : t("designer.showSql") }),
            jsx.jsx("button", { type: "button", style: btnStyle(), onClick: onClose, children: t("designer.cancel") }),
          ] }),
        ],
      });
    }

    /**
     * The ⤒ import control + inline form. Reads the picked file IN THE
     * BROWSER (FileReader), then posts the text to /import — the host parses
     * and batch-inserts. Format auto-detects from the extension, with a
     * manual override, because ".json" files holding CSV lines are common.
     */
    function ImportButton({ transfer, t, onImported }) {
      const [open, setOpen] = react.useState(false);
      const [format, setFormat] = react.useState("csv");
      const [fileName, setFileName] = react.useState("");
      const [fileText, setFileText] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const [mapping, setMapping] = react.useState(null);
      const fileRef = react.useRef(null);

      const pick = (event) => {
        const file = event.target?.files?.[0];
        if (!file) return;
        setError(null);
        if (file.size > 32 * 1024 * 1024) { setFileName(""); setFileText(""); setError(t("import.tooBig")); return; }
        setFileName(file.name);
        const lower = file.name.toLowerCase();
        if (lower.endsWith(".json")) setFormat("json");
        else if (lower.endsWith(".csv") || lower.endsWith(".txt")) setFormat("csv");
        const reader = new FileReader();
        reader.onload = () => { const txt = String(reader.result ?? ""); setFileText(txt); setMapping(null); preview(txt, null); };
        reader.onerror = () => setError(t("import.readFailed"));
        reader.readAsText(file, "utf-8");
      };

      const preview = async (text, fmtOverride) => {
        setMapping(null);
        if (!text) return;
        try {
          const body = await apiPost("/dsh-database/api/import", {
            id: transfer.connectionId, database: transfer.database, table: transfer.table,
            format: fmtOverride ?? format, content: text, dryRun: true,
          });
          setMapping(body);
        } catch (err) { setMapping({ error: String(err.message || err) }); }
      };

      const run = async () => {
        if (!fileText) { setError(t("import.noFile")); return; }
        setBusy(true); setError(null);
        try {
          const body = await apiPost("/dsh-database/api/import", {
            id: transfer.connectionId,
            database: transfer.database,
            table: transfer.table,
            format,
            content: fileText,
          });
          setOpen(false);
          setFileName(""); setFileText("");
          onImported?.(body);
        } catch (err) {
          setError(`${t("import.failed")}: ${err.message || err}`);
        } finally { setBusy(false); }
      };

      const inputStyle = { boxSizing: "border-box", fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" };
      if (!open) {
        return jsx.jsx("button", {
          type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: () => setOpen(true),
          children: `⤒ ${t("import.button")}`,
        });
      }
      return jsx.jsxs("span", { style: { display: "inline-flex", gap: 4, alignItems: "center" }, children: [
        jsx.jsxs("select", { style: { ...inputStyle, fontSize: 10.5 }, value: format, onChange: (e) => { setFormat(e.target.value); preview(fileText, e.target.value); }, children: [
          jsx.jsx("option", { value: "csv", children: "CSV" }),
          jsx.jsx("option", { value: "json", children: "JSON" }),
        ] }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: () => fileRef.current?.click(), title: t("import.pickFile"), children: fileName ? `📄 ${fileName}` : "📁…" }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5, fontWeight: 700 }, disabled: busy || !fileText, onClick: run, children: busy ? "…" : t("import.run") }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: () => setOpen(false), children: "✕" }),
        jsx.jsx("input", { ref: fileRef, type: "file", accept: ".csv,.txt,.json", style: { display: "none" }, onChange: pick }),
        error ? jsx.jsx("span", { style: { color: "#e06c75", fontSize: 10.5, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: error, children: error }) : null,
        mapping ? jsx.jsx("span", { style: { fontSize: 10.5, color: mapping.error ? "#e06c75" : "var(--dsw-alias-label-secondary)", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: JSON.stringify(mapping), children: mapping.error ? `预览失败: ${mapping.error}` : `${mapping.total} 行 · 匹配 ${mapping.matched?.length ?? 0} 列${(mapping.unmatchedFile?.length ?? 0) > 0 ? ` · 忽略 ${mapping.unmatchedFile.join(",")}` : ""}` }) : null,
      ] });
    }

    /**
     * The result grid. When the query came from a table peek (meta carries
     * table/database/column info), cells become double-click editable: an
     * inline input posts to /update, the host builds a PK-addressed
     * parameterized UPDATE, and the query re-runs so the grid shows the saved
     * state. Editing is refused for tables without a PK with a clear message.
     *
     * A peek grid also carries the data-transfer strip: ⤓ CSV / ⤓ JSON /
     * ⤓ SQL download the current table through the host, and ⤒ opens the
     * import form (CSV/JSON file → parameterized batch INSERT).
     */
    function ResultSet({ result, t, onCellEdit, viewMeta, onImported, peekState, onSort, onPage, onPageSize, onFilter, onViewer, onInsertRow, onRowDelete }) {
      // Hooks 必须在任何提前 return 之前调用——曾因放在分支后面，"错误结果↔成功结果"
      // 切换时 hook 数量变化使整个面板崩进错误边界（v0.7.x 审计 B-1）。
      const [exporting, setExporting] = react.useState(false);
      const [exportError, setExportError] = react.useState(null);
      const [filterDraft, setFilterDraft] = react.useState({ column: "", op: "like", value: "" });
      const ctrlStyle = { boxSizing: "border-box", padding: "2px 5px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", fontSize: 11 };
      if (!result) return null;
      if (result.error) {
        return jsx.jsx("div", { style: { padding: 8, color: "#e06c75", fontSize: 12, whiteSpace: "pre-wrap" }, children: `${t("sql.error")}: ${result.error}` });
      }
      if (!result.fields || result.fields.length === 0) {
        return jsx.jsxs("div", { style: { padding: 8, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }, children: [
          result.affectedRows != null ? `${t("sql.affected")}: ${result.affectedRows}` : "OK",
          ` · ${result.ms ?? "?"}${t("sql.ms")}`,
        ] });
      }
      const editable = result.meta?.editable === true;
      const pkColumns = result.meta?.pk ?? [];
      const pkOf = (row) => pkColumns.map((name) => ({ column: name, value: row[name] }));
      // Data-transfer actions only make sense on a real table peek (a raw SQL
      // result has no single target table to write into).
      const transfer = viewMeta ?? null;

      /**
       * Export via fetch + Blob, NEVER a form submit. A submitted form
       * NAVIGATES the whole app window to the action URL; when the host
       * answered an error (or Electron declined the download) the panel was
       * replaced by a blank white page — frozen, nothing clickable. fetch
       * keeps the page alive: success turns the bytes into a download, any
       * failure just shows inline red text.
       */
      const exportTable = async (format) => {
        if (!transfer || exporting) return;
        setExporting(true); setExportError(null);
        try {
          const response = await fetch(api("/dsh-database/api/export"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: transfer.connectionId, database: transfer.database ?? "", table: transfer.table, format }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${response.status}`);
          }
          const blob = await response.blob();
          const header = response.headers.get("content-disposition") ?? "";
          const match = header.match(/filename="([^"]+)"/);
          const name = match?.[1] ?? `${transfer.table}.${format}`;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        } catch (error) {
          setExportError(String(error.message || error));
        } finally { setExporting(false); }
      };

      return jsx.jsxs("div", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }, children: [
        jsx.jsxs("div", { style: { padding: "4px 8px", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", borderBottom: "1px solid var(--dsw-alias-border-l2)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }, children: [
          jsx.jsx("span", { children: result.paginated
            ? `${result.total ?? "?"} ${t("sql.rows")} · ${result.ms ?? "?"}${t("sql.ms")}`
            : `${result.rowCount} ${t("sql.rows")} · ${result.ms ?? "?"}${t("sql.ms")}${result.truncated ? " · " + t("sql.truncated") : ""}` }),
          editable ? jsx.jsx("span", { children: "✏️ " + t("cell.editHint") }) : null,
          transfer ? jsx.jsxs("span", { style: { display: "flex", gap: 4, marginLeft: "auto", alignItems: "center" }, children: [
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("csv"), children: "⤓ CSV" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("json"), children: "⤓ JSON" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("sql"), title: t("export.sql") + " (CREATE + INSERT)", children: "⤓ SQL" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("sql-structure"), title: t("export.structure"), children: "⤓ " + t("export.structure") }),
            ["sqlite", "mysql", "postgres", "mssql", "clickhouse"].includes(transfer?.engine) ? jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("md"), title: "Markdown", children: "⤓ MD" }) : null,
            jsx.jsx(ImportButton, { transfer, t, onImported }),
            ["sqlite", "mysql", "postgres", "mssql", "clickhouse"].includes(transfer?.engine) && result.paginated && onInsertRow
              ? jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, title: "新增一行（留空 = NULL）", onClick: () => onInsertRow(), children: "＋ 行" })
              : null,
          ] }) : null,
        ] }),
        result.paginated && peekState ? jsx.jsxs("div", { style: { padding: "4px 8px", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 11, borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
          jsx.jsx("button", { type: "button", style: btnStyle(), disabled: peekState.page <= 1, onClick: () => onPage(-1), children: "◀" }),
          jsx.jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: t("pager.page").replace("{p}", String(result.page ?? peekState.page)).replace("{t}", String(Math.max(1, Math.ceil((result.total ?? 0) / peekState.pageSize)))).replace("{n}", String(result.total ?? "?")) }),
          jsx.jsx("button", { type: "button", style: btnStyle(), disabled: peekState.page >= Math.max(1, Math.ceil((result.total ?? 0) / peekState.pageSize)), onClick: () => onPage(1), children: "▶" }),
          jsx.jsxs("select", { value: String(peekState.pageSize), onChange: (e) => onPageSize(Number(e.target.value)), style: ctrlStyle, children: [100, 200, 500, 1000].map((n) => jsx.jsx("option", { value: String(n), children: `${n}/页` }, n)) }),
          jsx.jsx("select", { value: filterDraft.column, onChange: (e) => setFilterDraft((p) => ({ ...p, column: e.target.value })), style: ctrlStyle, children: [jsx.jsx("option", { value: "", children: t("filter.column") }), ...(result.fields ?? []).map((f) => jsx.jsx("option", { value: f.name, children: f.name }, f.name))] }),
          jsx.jsx("select", { value: filterDraft.op, onChange: (e) => setFilterDraft((p) => ({ ...p, op: e.target.value })), style: ctrlStyle, children: [["like", "包含"], ["=", "="], ["!=", "≠"], [">", ">"], ["<", "<"], [">=", "≥"], ["<=", "≤"]].map(([v, label]) => jsx.jsx("option", { value: v, children: label }, v)) }),
          jsx.jsx("input", { value: filterDraft.value, placeholder: "值", onChange: (e) => setFilterDraft((p) => ({ ...p, value: e.target.value })), onKeyDown: (e) => { if (e.key === "Enter" && !e.nativeEvent?.isComposing) onFilter(filterDraft.column ? filterDraft : null); }, style: { ...ctrlStyle, width: 130 } }),
          jsx.jsx("button", { type: "button", style: btnStyle(), onClick: () => onFilter(filterDraft.column ? filterDraft : null), children: t("filter.apply") }),
          jsx.jsx("button", { type: "button", style: btnStyle(), onClick: () => { setFilterDraft({ column: "", op: "like", value: "" }); onFilter(null); }, children: t("filter.clear") }),
        ] }) : null,
        exportError ? jsx.jsx("div", { style: { padding: "4px 10px", fontSize: 11.5, color: "#e06c75", borderBottom: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "pre-wrap" }, children: `${t("export.failed")}: ${exportError}` }) : null,
        jsx.jsx("div", { style: { flex: 1, overflow: "auto" }, children: jsx.jsxs("table", {
          style: { borderCollapse: "collapse", fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
          children: [
            jsx.jsx("thead", { children: jsx.jsx("tr", { children: [
              onRowDelete && editable && transfer ? jsx.jsx("th", { key: "__del", style: { width: 26, borderBottom: "1px solid var(--dsw-alias-border-l2)", position: "sticky", top: 0, background: "var(--dsw-alias-bg-base)", zIndex: 1 } }) : null,
              ...result.fields.map((f, i) => jsx.jsx("th", {
              style: { textAlign: "left", padding: "3px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)", position: "sticky", top: 0, background: "var(--dsw-alias-bg-base)", zIndex: 1, fontWeight: 600, cursor: onSort ? "pointer" : "default", userSelect: "none" },
              onClick: onSort ? () => onSort(f.name) : undefined,
              title: onSort ? "点击排序 / click to sort" : undefined,
              children: f.name + (pkColumns.includes(f.name) ? " 🗝" : "") + (peekState?.sort?.column === f.name ? (peekState.sort.dir === "DESC" ? " ▼" : " ▲") : ""),
            }, `${f.name}-${i}`))] }) }),
            jsx.jsx("tbody", { children: result.rows.map((row, r) => jsx.jsx("tr", {
              children: [
                onRowDelete && editable && transfer ? jsx.jsx("td", { key: "__del", style: { textAlign: "center", borderBottom: "1px solid var(--dsw-alias-border-l3, transparent)", padding: "2px 2px" }, children: jsx.jsx("button", {
                  type: "button", title: "删除这一行 / delete this row",
                  style: { ...btnStyle(), fontSize: 9, padding: "0 4px", color: "#e06c75" },
                  onClick: () => onRowDelete({ pk: pkOf(row) }),
                  children: "✕",
                }) }) : null,
                ...result.fields.map((f, i) => jsx.jsx(EditableCell, {
                  value: row[f.name], column: f.name, row, pkOf, editable, onCellEdit, onViewer, t,
                }, `${r}-${i}`)),
              ],
            }, r)) }),
          ],
        }) }),
      ] });
    }

    function EditableCell({ value, column, row, pkOf, editable, onCellEdit, onViewer, t }) {
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(null);
      const display = formatCell(value);
      if (!editable) {
        const viewerWorthy = typeof value === "object" && value !== null || (typeof value === "string" && value.length > 120);
      return jsx.jsx("td", {
          style: { padding: "2px 8px", borderBottom: "1px solid var(--dsw-alias-border-l3, transparent)", whiteSpace: "nowrap", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", color: "var(--dsw-alias-label-secondary)", cursor: viewerWorthy ? "zoom-in" : undefined },
          onClick: viewerWorthy ? (e) => { e.stopPropagation(); onViewer?.(value); } : undefined,
          title: viewerWorthy ? "点击查看完整内容 / click to inspect" : undefined,
          children: display,
        });
      }
      const start = () => { setDraft(String(value ?? "")); setEditing(true); };
      const commit = () => {
        setEditing(false);
        const original = value === null || value === undefined ? "" : String(value);
        if (draft === original) return;
        onCellEdit({ column, pk: pkOf(row), value: draft === "" ? null : draft });
      };
      const viewerWorthy = typeof value === "object" && value !== null || (typeof value === "string" && value.length > 120);
      return jsx.jsx("td", {
        style: { padding: editing ? 0 : "2px 8px", borderBottom: "1px solid var(--dsw-alias-border-l3, transparent)", whiteSpace: "nowrap", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", color: "var(--dsw-alias-label-secondary)", cursor: "cell" },
        onClick: !editing && viewerWorthy ? (e) => { e.stopPropagation(); onViewer?.(value); } : undefined,
        onDoubleClick: editing ? undefined : start,
        children: editing ? jsx.jsx("input", {
          autoFocus: true,
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => {
            // 输入法选词中的回车不提交编辑
            if (e.nativeEvent?.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          },
          style: { width: "100%", minWidth: 120, boxSizing: "border-box", fontSize: 11.5, padding: "2px 6px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", fontFamily: "inherit" },
        }) : display,
      });
    }

    function formatCell(value) {
      if (value === null || value === undefined) return "NULL";
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
    }

    /**
     * Connection toast: a fixed overlay in the panel's top-right corner that
     * reports connect/disconnect/test outcomes. Auto-dismisses after 3.5 s
     * (2.5 s for failures so the error text gets a moment longer).
     */
    function ConnectionToast({ toast, t }) {
      if (!toast) return null;
      const tone = toast.kind === "ok" ? "#2ea44f" : toast.kind === "warn" ? "#d29922" : "#e06c75";
      const icon = toast.kind === "ok" ? "✓" : toast.kind === "warn" ? "⚠" : "✕";
      return jsx.jsx("div", {
        style: {
          position: "absolute", top: 44, right: 12, zIndex: 30,
          maxWidth: 360, padding: "8px 12px", borderRadius: 8,
          background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base))",
          border: `1px solid ${tone}`,
          boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.25))",
          color: "var(--dsw-alias-label-primary)", fontSize: 12,
          display: "flex", gap: 8, alignItems: "flex-start",
        },
        children: jsx.jsxs(react.Fragment, { children: [
          jsx.jsx("span", { style: { color: tone, fontWeight: 700 }, children: icon }),
          jsx.jsxs("div", { style: { minWidth: 0 }, children: [
            jsx.jsx("div", { style: { fontWeight: 600 }, children: toast.title }),
            toast.detail ? jsx.jsx("div", { style: { marginTop: 2, color: "var(--dsw-alias-label-secondary)", fontSize: 11, wordBreak: "break-all" }, children: toast.detail }) : null,
          ] }),
        ] }),
      });
    }

    /**
     * Error boundary around the panel body. A render error inside the panel
     * must degrade to a readable message — never to a blank tab (a temporal
     * dead zone slip once shipped exactly that way).
     */
    class PanelBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        console.error("[dsh-database] panel render failed:", error);
      }

      render() {
        if (this.state.error !== null) {
          const message = String(this.state.error?.message || this.state.error);
          return jsx.jsxs("div", {
            style: { padding: 16, fontSize: 12.5, color: "#e06c75" },
            children: [
              jsx.jsx("div", { style: { fontWeight: 700, marginBottom: 6 }, children: "数据库面板渲染失败 / Database panel failed to render" }),
              jsx.jsx("div", { style: { color: "var(--dsw-alias-label-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all" }, children: message }),
              jsx.jsx("button", {
                type: "button",
                style: { ...btnStyle(), marginTop: 10 },
                onClick: () => this.setState({ error: null }),
                children: "重试 / Retry",
              }),
            ],
          });
        }
        return this.props.children;
      }
    }

    /** ---- 0.9.6 E-R 模块化选择画板 --------------------------------------
     *  左侧模块栏：全部表按搜索 + 勾选决定哪些表上画布（不再是全库一锅端）。
     *  右侧画布：滚轮以光标为中心缩放、空白拖动平移、整表拖动（连线实时重算）、
     *  自动布局（外键方向分层）、适应画布、悬停高亮邻接。
     *  -------------------------------------------------------------------- */
    const ER_NODE_W = 190, ER_HEAD_H = 22, ER_ROW_H = 16, ER_GAP_X = 56, ER_GAP_Y = 40;
    /** 首次打开自动上画布的表数上限：小库全画，大库只画有外键关系的表。 */
    const ER_AUTO_MAX = 16;

    const erNodeH = (tb) => ER_HEAD_H + Math.min(tb?.columns?.length ?? 0, 40) * ER_ROW_H + 6;

    /** 分层自动布局：被引用的表在左，外键链向右展开（父表 → 子表从左到右）。
     *  对反向边做 Kahn 最长路径分层，环上的表留 0 列不死循环；
     *  同层按名字排序纵向堆叠（y 逐个累加，天然不重叠）。零依赖，确定性输出。
     *  Chen 模式传入更宽的 gap：属性椭圆扇形需要占位。 */
    function erLayout(tbs, edges, gapX = ER_GAP_X, gapY = ER_GAP_Y) {
      const byName = new Map(tbs.map((tb) => [tb.name, tb]));
      const names = [...byName.keys()];
      const nameSet = new Set(names);
      const dedup = new Set();
      const rev = new Map(names.map((n) => [n, []]));   // rev[被引用表] = 引用它的表们
      const refsOut = new Map(names.map((n) => [n, 0])); // 该表引用了多少张不同的表
      for (const e of edges) {
        if (!nameSet.has(e.fromTable) || !nameSet.has(e.toTable) || e.fromTable === e.toTable) continue;
        const key = `${e.fromTable}\u0000${e.toTable}`;
        if (dedup.has(key)) continue;
        dedup.add(key);
        rev.get(e.toTable).push(e.fromTable);
        refsOut.set(e.fromTable, refsOut.get(e.fromTable) + 1);
      }
      // 从「不引用任何表」的叶子开始（深度 0），被引用链向右推
      const depth = new Map(names.map((n) => [n, 0]));
      const pending = new Map(refsOut);
      const queue = names.filter((n) => refsOut.get(n) === 0);
      for (let qi = 0; qi < queue.length; qi++) {
        const cur = queue[qi];
        for (const parent of rev.get(cur)) {
          depth.set(parent, Math.max(depth.get(parent), depth.get(cur) + 1));
          pending.set(parent, pending.get(parent) - 1);
          if (pending.get(parent) === 0) queue.push(parent);
        }
      }
      const cols = new Map();
      for (const n of names) {
        const d = depth.get(n) ?? 0;
        if (!cols.has(d)) cols.set(d, []);
        cols.get(d).push(n);
      }
      const placed = new Map();
      const colW = ER_NODE_W + gapX;
      for (const [d, list] of [...cols].sort((a, b) => a[0] - b[0])) {
        list.sort((a, b) => String(a).localeCompare(String(b)));
        let y = 0;
        for (const n of list) {
          placed.set(n, { x: d * colW, y });
          y += erNodeH(byName.get(n)) + gapY;
        }
      }
      return placed;
    }

    /** 在 (cx,cy) 附近螺旋外扩，为新上画布的表找一个不压现有节点的空位。 */
    function erFreeSpot(posMap, heights, cx, cy, name) {
      const h = heights.get(name) ?? ER_HEAD_H;
      const free = (x, y) => {
        for (const [n, p] of Object.entries(posMap)) {
          if (n === name) continue;
          const h2 = heights.get(n) ?? ER_HEAD_H;
          if (x < p.x + ER_NODE_W + 12 && p.x < x + ER_NODE_W + 12 && y < p.y + h2 + 10 && p.y < y + h + 10) return false;
        }
        return true;
      };
      for (let ring = 0; ring < 24; ring++) {
        const r = ring * 48;
        const steps = ring === 0 ? 1 : 8;
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const x = Math.round(cx + Math.cos(a) * r - ER_NODE_W / 2);
          const y = Math.round(cy + Math.sin(a) * r - h / 2);
          if (free(x, y)) return { x, y };
        }
      }
      return { x: Math.round(cx), y: Math.round(cy) };
    }

    /** ---- 0.9.7 Chen 式概念图（教科书 E-R 画法）----------------------------
     *  实体 = 矩形，属性 = 椭圆（主键加下划线），外键联系 = 菱形 + 1/N 基数。
     *  与表视图共用同一份实体坐标（pos），切换画法不丢手工摆放。 */
    const ER_CHEN_H = 32;

    /** 显示宽度：CJK/全角字符按 2 个单位计（椭圆/矩形按单位长度定宽，避免中文名溢出）。 */
    const erTextW = (s) => [...String(s)].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
    /** 按显示宽度截断（超出部分以 … 结尾）。 */
    const erClip = (s, units) => {
      const str = String(s);
      let w = 0;
      for (let i = 0; i < str.length; i++) {
        w += str.codePointAt(i) > 0x2e80 ? 2 : 1;
        if (w > units) return str.slice(0, i) + "…";
      }
      return str;
    };

    // 比例基准（11px 粗体）：实体必须始终比属性椭圆醒目——教科书 Chen 图的主次关系
    const chenEntityW = (label) => Math.max(72, erTextW(label) * 6.8 + 30);
    const chenEntityLabel = (name) => erClip(name, 20);

    /** 实体的属性椭圆布局：关键属性（主键+外键）或全部属性，上/下两半扇形排开，
     *  每行最多 5 个，行内按椭圆宽度累计居中。返回相对实体原点的坐标。 */
    function chenAttrLayout(cols, scope) {
      const pool = scope === "all" ? cols : cols.filter((c) => c.pk || c.fk);
      const base = pool.length ? pool : cols.slice(0, 2);
      const cap = scope === "all" ? 14 : 8;
      const shown = base.slice(0, cap).map((c) => {
        const label = erClip(c.name, 14);
        return {
          name: label,
          pk: c.pk === true, extra: false,
          rx: Math.max(16, erTextW(label) * 2.7 + 11), ry: 10,
        };
      });
      if (base.length > cap) shown.push({ name: `+${base.length - cap}`, extra: true, rx: 16, ry: 9 });
      const halves = [[], []];
      shown.forEach((a, i) => halves[i < Math.ceil(shown.length / 2) ? 0 : 1].push(a));
      const out = [];
      halves.forEach((list, side) => {
        for (let r = 0; r * 5 < list.length; r++) {
          const chunk = list.slice(r * 5, r * 5 + 5);
          const width = chunk.reduce((s, a) => s + a.rx * 2, 0) + 14 * (chunk.length - 1);
          let x = -width / 2;
          const y = side === 0 ? -(30 + r * 30) : ER_CHEN_H + 30 + r * 30;
          for (const a of chunk) { out.push({ ...a, x: x + a.rx, y }); x += a.rx * 2 + 14; }
        }
      });
      return out;
    }

    function ErDiagram({ connectionId, engine, database, onClose, t }) {
      const [data, setData] = react.useState(null);
      const [error, setError] = react.useState(null);
      /** 0.9.9 可编辑模型：内省结果只是底稿——实体/属性/联系都能在这里增删改。
       *  rawRef 保留数据库原始内省，「还原」一键回到底稿。 */
      const [model, setModel] = react.useState(null);
      const rawRef = react.useRef(null);
      /** 画布上有哪些表（模块选择）。 */
      const [sel, setSel] = react.useState(() => new Set());
      /** name -> {x,y}：画布坐标，拖表/布局都在改它。 */
      const [pos, setPos] = react.useState({});
      const [hover, setHover] = react.useState(null);
      const [search, setSearch] = react.useState("");
      const [view, setView] = react.useState({ x: 0, y: 0, scale: 1 });
      const dragRef = react.useRef(null);
      const boardRef = react.useRef(null);
      /** 0.9.7 画法：table = 物理表节点；chen = 教科书概念图。两法共用实体坐标。 */
      const [notation, setNotation] = react.useState("table");
      const [attrScope, setAttrScope] = react.useState("key");
      /** 0.9.9 编辑态：选中的实体/自定义联系，以及「＋联系」连线模式。 */
      const [selEntity, setSelEntity] = react.useState(null);
      const [selRel, setSelRel] = react.useState(null);
      const [linking, setLinking] = react.useState(null); // null | { from: 表名 | null }
      const relSeq = react.useRef(0);
      const movedRef = react.useRef(false);
      /** 0.9.11 菱形手工位移：rid -> {x,y}（相对自动中点的偏移），拖菱形即改布局。 */
      const [dpos, setDpos] = react.useState({});
      /** 0.9.11 按钮反馈条（＋邻接表等操作的结果提示，2.5s 自动消失）。 */
      const [note, setNote] = react.useState(null);
      const noteTimer = react.useRef(null);
      const flashNote = (msg) => {
        setNote(msg);
        if (noteTimer.current) clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote(null), 2500);
      };

      react.useEffect(() => {
        apiGet(`/dsh-database/api/er?id=${encodeURIComponent(connectionId)}&database=${encodeURIComponent(database ?? "")}`)
          .then((body) => setData(body))
          .catch((e) => setError(String(e.message || e)));
      }, [connectionId, database]);

      const tables = model?.tables ?? [];
      const edges = model?.edges ?? [];
      const byName = react.useMemo(() => new Map(tables.map((tb) => [tb.name, tb])), [model]);
      const sorted = react.useMemo(() => tables.map((tb) => tb.name).sort((a, b) => String(a).localeCompare(String(b))), [model]);
      const heights = react.useMemo(() => new Map(tables.map((tb) => [tb.name, erNodeH(tb)])), [model]);
      const nbrs = react.useMemo(() => {
        const m = new Map(tables.map((tb) => [tb.name, new Set()]));
        for (const e of edges) {
          if (!m.has(e.fromTable) || !m.has(e.toTable) || e.fromTable === e.toTable) continue;
          m.get(e.fromTable).add(e.toTable);
          m.get(e.toTable).add(e.fromTable);
        }
        return m;
      }, [model]);

      // 玻璃主题下 bg-base 可能是半透明色——画布形状必须不透明，否则字会被
      // 桌面背景和连线穿透。按主题明暗把 bg-base 合成到对应底色上，得到确定
      // 不透明的填充色（亮字=暗主题→深底，暗字=浅主题→浅底）。
      const solidBgRef = react.useRef(null);
      const solidBg = (() => {
        if (solidBgRef.current) return solidBgRef.current;
        const el = boardRef.current;
        if (!el) return "var(--dsw-alias-bg-base,#161b22)"; // 首帧未挂载：先用主题变量占位
        const css = getComputedStyle(el); // 变量挂在挂载点上，:root 未必有
        const parse = (v) => {
          const s = String(v ?? "").trim().toLowerCase();
          let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
          if (m) {
            const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
            return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
          }
          m = s.match(/^rgba?\(([^)]+)\)$/);
          if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
          return null;
        };
        const fg = parse(css.getPropertyValue("--dsw-alias-label-primary")) ?? [230, 237, 243, 1];
        const lum = (0.299 * fg[0] + 0.587 * fg[1] + 0.114 * fg[2]) / 255;
        const backing = lum > 0.5 ? [13, 17, 23] : [248, 250, 252];
        const bg = parse(css.getPropertyValue("--dsw-alias-bg-base"));
        const a = bg ? (bg[3] ?? 1) : 0;
        const mix = bg ? bg.slice(0, 3).map((c, i) => Math.round(c * a + backing[i] * (1 - a))) : backing;
        const out = `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
        solidBgRef.current = out;
        return out;
      })();

      const fitTo = react.useCallback((posMap) => {
        const el = boardRef.current;
        if (!el || !Object.keys(posMap).length) return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [n, p] of Object.entries(posMap)) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x + ER_NODE_W); maxY = Math.max(maxY, p.y + (heights.get(n) ?? ER_HEAD_H));
        }
        const w = maxX - minX, h = maxY - minY;
        // Chen 模式的属性椭圆与菱形会伸出实体框外，预留一圈 padding
        const pad = notation === "chen" ? 110 : 0;
        const w2 = w + pad * 2, h2 = h + pad * 2;
        const scale = Math.min(1.4, Math.max(0.25, Math.min((rect.width - 36) / w2, (rect.height - 36) / h2)));
        setView({ scale, x: (rect.width - w2 * scale) / 2 - minX * scale + pad * scale, y: (rect.height - h2 * scale) / 2 - minY * scale + pad * scale });
      }, [heights, notation]);

      // 引导：把内省结果装进可编辑模型；小库全选，大库只上有外键关系的表；
      // 自动布局并适应画布。bootedRef 保证每份数据只引导一次（fitTo 依赖
      // notation，切画法会改变其引用，不能让它重放初始布局）。
      const bootedRef = react.useRef(null);
      const bootFrom = react.useCallback((src) => {
        rawRef.current = src;
        const names = src.tables.map((tb) => tb.name);
        let initial;
        if (names.length <= ER_AUTO_MAX) {
          initial = names.slice().sort((a, b) => String(a).localeCompare(String(b)));
        } else {
          const linked = new Set();
          for (const e of src.edges) { linked.add(e.fromTable); linked.add(e.toTable); }
          initial = [...linked].sort((a, b) => String(a).localeCompare(String(b))).slice(0, ER_AUTO_MAX);
          if (!initial.length) initial = names.slice(0, ER_AUTO_MAX);
        }
        setModel({
          tables: src.tables.map((tb) => ({ name: tb.name, custom: false, columns: (tb.columns ?? []).map((c) => ({ ...c })) })),
          // 每条联系都有 rid/label/card：数据库外键同样可改名、可调基数、可隐藏（还原即恢复）
          edges: src.edges.map((e, i) => ({ ...e, rid: "d" + i, label: e.fromCol, card: "N:1", custom: false })),
        });
        setSel(new Set(initial));
        setSelEntity(null); setSelRel(null); setLinking(null);
        setDpos({});
        const layout = erLayout(initial.map((n) => src.tables.find((tb) => tb.name === n)).filter(Boolean), src.edges);
        setPos(Object.fromEntries(layout));
        requestAnimationFrame(() => fitTo(Object.fromEntries(layout)));
      }, [fitTo]);
      react.useEffect(() => {
        if (!data || bootedRef.current === data) return;
        bootedRef.current = data;
        bootFrom(data);
      }, [data, bootFrom]);

      const toggle = (name) => {
        const next = new Set(sel);
        const removing = next.has(name);
        if (removing) next.delete(name); else next.add(name);
        setSel(next);
        if (removing) {
          if (hover === name) setHover(null); // 被移除的表不再持有悬停态，避免邻接残留半透明
          setPos((p) => {
            if (!(name in p)) return p;
            const q = { ...p }; delete q[name]; return q;
          });
        } else {
          const rect = boardRef.current?.getBoundingClientRect() ?? { width: 800, height: 520 };
          const cx = (rect.width / 2 - view.x) / view.scale;
          const cy = (rect.height / 2 - view.y) / view.scale;
          setPos((p) => ({ ...p, [name]: erFreeSpot(p, heights, cx, cy, name) }));
        }
      };

      // 搜索框为空时全选 = 全部表并整体布局；搜索过滤时只把「可见的表」加进来，
      // 画布上已有的表保持位置不动（新加的找空位），与 ＋关联 行为一致。
      const chenGaps = () => (notation === "chen" ? [ER_GAP_X + 130, ER_GAP_Y + 72] : [ER_GAP_X, ER_GAP_Y]);
      const placeAdded = (adding) => {
        setPos((p) => {
          const rect = boardRef.current?.getBoundingClientRect() ?? { width: 800, height: 520 };
          const cx0 = (rect.width / 2 - view.x) / view.scale;
          const cy0 = (rect.height / 2 - view.y) / view.scale;
          const q = { ...p };
          for (const n of adding) q[n] = erFreeSpot(q, heights, cx0, cy0, n);
          return q;
        });
      };
      const selectAll = () => {
        const adding = filtered.filter((n) => !sel.has(n));
        if (!adding.length) return;
        const next = new Set(sel);
        for (const n of adding) next.add(n);
        setSel(next);
        if (sel.size === 0) {
          const [gx, gy] = chenGaps();
          const layout = erLayout([...next].map((n) => byName.get(n)).filter(Boolean), edges, gx, gy);
          setPos(Object.fromEntries(layout));
          requestAnimationFrame(() => fitTo(Object.fromEntries(layout)));
        } else {
          placeAdded(adding);
        }
      };
      const clearAll = () => { setSel(new Set()); setPos({}); };
      const addRelated = () => {
        const added = [];
        const next = new Set(sel);
        for (const n of sel) for (const nb of nbrs.get(n) ?? []) if (!next.has(nb)) { next.add(nb); added.push([nb, n]); }
        if (!added.length) { flashNote(t("er.noneToAdd")); return; }
        setSel(next);
        placeAdded(added);
        flashNote(t("er.addedNeighbors").replace("{n}", String(added.length)));
      };
      const autoLayout = () => {
        const tbs = [...sel].map((n) => byName.get(n)).filter(Boolean);
        const [gx, gy] = chenGaps();
        const layout = erLayout(tbs, edges, gx, gy);
        setPos(Object.fromEntries(layout));
        setDpos({}); // 重新布局后手工位移已无意义，全部归零
        requestAnimationFrame(() => fitTo(Object.fromEntries(layout)));
      };

      // ---- 0.9.9 编辑操作：内省只是底稿，实体/属性/联系都可改 ----
      const renameEntity = (oldName, raw) => {
        const newName = String(raw ?? "").trim();
        if (!newName || newName === oldName || byName.has(newName)) return;
        setModel((m) => ({
          ...m,
          tables: m.tables.map((tb) => (tb.name === oldName ? { ...tb, name: newName } : tb)),
          edges: m.edges.map((e) => ({ ...e, fromTable: e.fromTable === oldName ? newName : e.fromTable, toTable: e.toTable === oldName ? newName : e.toTable })),
        }));
        setSel((s) => { if (!s.has(oldName)) return s; const n = new Set(s); n.delete(oldName); n.add(newName); return n; });
        setPos((p) => { if (!(oldName in p)) return p; const q = { ...p }; q[newName] = q[oldName]; delete q[oldName]; return q; });
        setSelEntity((v) => (v === oldName ? newName : v));
        setHover((v) => (v === oldName ? newName : v));
        if (linking?.from === oldName) setLinking({ from: newName });
      };
      const mutateTable = (name, fn) => setModel((m) => ({ ...m, tables: m.tables.map((tb) => (tb.name === name ? fn(tb) : tb)) }));
      const addAttr = (tbName) => {
        const tb = byName.get(tbName);
        if (!tb) return;
        let i = tb.columns.length;
        let name = `attr_${i + 1}`;
        while (tb.columns.some((c) => c.name === name)) name = `attr_${++i + 1}`;
        mutateTable(tbName, (t) => ({ ...t, columns: [...t.columns, { name, type: "", pk: false, fk: false, custom: true }] }));
      };
      const renameAttr = (tbName, oldName, raw) => {
        const newName = String(raw ?? "").trim();
        if (!newName || newName === oldName) return;
        setModel((m) => ({
          ...m,
          tables: m.tables.map((tb) => (tb.name === tbName ? { ...tb, columns: tb.columns.map((c) => (c.name === oldName ? { ...c, name: newName } : c)) } : tb)),
          edges: m.edges.map((e) => (e.fromTable === tbName && e.fromCol === oldName ? { ...e, fromCol: newName } : e)),
        }));
      };
      const delAttr = (tbName, attrName) => setModel((m) => ({ ...m, tables: m.tables.map((tb) => (tb.name === tbName ? { ...tb, columns: tb.columns.filter((c) => c.name !== attrName) } : tb)) }));
      const togglePk = (tbName, attrName) => setModel((m) => ({ ...m, tables: m.tables.map((tb) => (tb.name === tbName ? { ...tb, columns: tb.columns.map((c) => (c.name === attrName ? { ...c, pk: !c.pk } : c)) } : tb)) }));
      const createEntity = () => {
        let i = 1;
        let name = "新实体";
        while (byName.has(name)) name = `新实体${++i}`;
        setModel((m) => ({ ...m, tables: [...m.tables, { name, custom: true, columns: [{ name: "id", type: "", pk: true, fk: false, custom: true }] }] }));
        setSel((s) => new Set([...s, name]));
        placeAdded([name]);
        setSelEntity(name);
        setSelRel(null);
      };
      const startLink = () => setLinking((v) => (v ? null : { from: null }));
      const handleEntityClick = (name) => {
        if (linking) {
          if (linking.from == null) setLinking({ from: name });
          else if (linking.from !== name) {
            const rid = `r${++relSeq.current}`;
            const relName = `联系${relSeq.current}`;
            setModel((m) => ({ ...m, edges: [...m.edges, { rid, fromTable: linking.from, fromCol: relName, label: relName, toTable: name, toCol: "", card: "1:N", custom: true }] }));
            setSelRel(rid);
            setSelEntity(null);
            setLinking(null);
          } else setLinking(null); // 点自己 = 取消
          return;
        }
        setSelEntity((v) => (v === name ? null : name));
        setSelRel(null);
      };
      const renameRel = (rid, raw) => {
        const name = String(raw ?? "").trim() || "联系";
        setModel((m) => ({ ...m, edges: m.edges.map((e) => (e.rid === rid ? { ...e, label: name } : e)) }));
      };
      const setRelCard = (rid, card) => setModel((m) => ({ ...m, edges: m.edges.map((e) => (e.rid === rid ? { ...e, card } : e)) }));
      const delRel = (rid) => {
        setModel((m) => ({ ...m, edges: m.edges.filter((e) => e.rid !== rid) }));
        setSelRel(null);
      };
      // 从画布移除：数据库表只是下画布（清单里保留，随时可加回）；
      // 自定义实体是用户手画的，移除 = 从模型里彻底删除（连带它的联系）。
      const removeEntity = (name) => {
        const tb = byName.get(name);
        setSelEntity(null);
        if (linking?.from === name) setLinking(null); // 连线起点被删，取消连线模式
        toggle(name);
        if (tb?.custom) {
          setModel((m) => ({ ...m, tables: m.tables.filter((t) => t.name !== name), edges: m.edges.filter((e) => e.fromTable !== name && e.toTable !== name) }));
        }
      };

      // 滚轮缩放必须用非 passive 原生监听（React 的 onWheel 是 passive 的），
      // 且以光标为不动点：缩放前后光标指向的画布坐标保持一致。
      react.useEffect(() => {
        const el = boardRef.current;
        if (!el) return;
        const handler = (e) => {
          e.preventDefault();
          const rect = el.getBoundingClientRect();
          const mx = e.clientX - rect.left, my = e.clientY - rect.top;
          const f = e.deltaY < 0 ? 1.12 : 0.9;
          setView((v) => {
            const scale = Math.min(2.5, Math.max(0.25, v.scale * f));
            const k = scale / v.scale;
            return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
          });
        };
        el.addEventListener("wheel", handler, { passive: false });
        return () => el.removeEventListener("wheel", handler);
      }, []);

      // 空白处按下 = 平移画布；表节点上按下 = 拖表（在节点处 stopPropagation）。
      // setPointerCapture 让指针移出画布也持续收到 move/up，拖到一半出界不卡死。
      // 只响应主键（左键）：右键/中键拖动不做任何事，也不拦住上下文菜单。
      // 注意：开启捕获后 click 事件会被重定向到画布容器，所以「点一下选中」
      // 统一放在 endDrag 里按 pointerup 处理，而不是 onClick。
      const beginDrag = (e) => {
        if (e.button != null && e.button !== 0) return false;
        movedRef.current = false;
        dragRef.current = { sx: e.clientX, sy: e.clientY, scale: view.scale };
        try { boardRef.current?.setPointerCapture(e.pointerId); } catch { /* 老内核没有捕获也能用 */ }
        return true;
      };
      const onPointerDown = (e) => { if (beginDrag(e)) dragRef.current = { ...dragRef.current, type: "pan", vx: view.x, vy: view.y }; };
      const onNodeDown = (name) => (e) => {
        if (!beginDrag(e)) return;
        e.stopPropagation();
        dragRef.current = { ...dragRef.current, type: "node", name, ox: pos[name]?.x ?? 0, oy: pos[name]?.y ?? 0 };
      };
      const onDiamondDown = (ed) => (e) => {
        if (!beginDrag(e)) return;
        e.stopPropagation();
        dragRef.current = { ...dragRef.current, type: "diamond", rid: ed.rid, custom: true, base: dpos[ed.rid] ?? { x: 0, y: 0 } };
      };
      const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.sx) > 3 || Math.abs(e.clientY - d.sy) > 3) movedRef.current = true;
        if (d.type === "pan") setView((v) => ({ ...v, x: d.vx + (e.clientX - d.sx), y: d.vy + (e.clientY - d.sy) }));
        else if (d.type === "node") setPos((p) => ({ ...p, [d.name]: { x: d.ox + (e.clientX - d.sx) / d.scale, y: d.oy + (e.clientY - d.sy) / d.scale } }));
        else if (d.type === "diamond") setDpos((p) => ({ ...p, [d.rid]: { x: d.base.x + (e.clientX - d.sx) / d.scale, y: d.base.y + (e.clientY - d.sy) / d.scale } }));
      };
      const endDrag = () => {
        const d = dragRef.current;
        dragRef.current = null;
        if (!d || movedRef.current) return; // 拖动过 = 不是点击
        if (d.type === "node") handleEntityClick(d.name);
        else if (d.type === "pan") { setSelEntity(null); setSelRel(null); }
        else if (d.type === "diamond") { setSelRel(d.rid); setSelEntity(null); }
      };

      const colY = (tbName, colName) => {
        const p = pos[tbName];
        const tb = byName.get(tbName);
        if (!p || !tb) return null;
        const idx = (tb.columns ?? []).findIndex((c) => c.name === colName);
        return idx >= 0 ? p.y + ER_HEAD_H + idx * ER_ROW_H + ER_ROW_H / 2 : p.y + ER_HEAD_H / 2;
      };
      const edgePath = (e) => {
        const a = pos[e.fromTable], b = pos[e.toTable];
        if (!a || !b) return null;
        const y1 = colY(e.fromTable, e.fromCol), y2 = colY(e.toTable, e.toCol);
        if (y1 == null || y2 == null) return null;
        if (e.fromTable === e.toTable) {
          const x = a.x + ER_NODE_W;
          return `M ${x} ${y1} C ${x + 46} ${y1}, ${x + 46} ${y2}, ${x} ${y2}`;
        }
        if (a.x <= b.x) {
          const x1 = a.x + ER_NODE_W, x2 = b.x, dx = Math.max(28, (x2 - x1) / 2);
          return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        }
        const x1 = a.x, x2 = b.x + ER_NODE_W, dx = Math.max(28, (x1 - x2) / 2);
        return `M ${x1} ${y1} C ${x1 - dx} ${y1}, ${x2 + dx} ${y2}, ${x2} ${y2}`;
      };

      const filtered = search ? sorted.filter((n) => String(n).toLowerCase().includes(search.toLowerCase())) : sorted;
      const drawnEdges = edges.filter((e) => pos[e.fromTable] && pos[e.toTable]).length;

      // --- Chen 层：连线→菱形→基数标签→实体→属性椭圆（按此顺序叠放） ---
      const chenSize = (n) => {
        // 实体宽度至少要压得住自己最宽的属性椭圆（教科书 Chen 图的主次关系）
        const tb = byName.get(n);
        const attrs = tb ? chenAttrLayout(tb.columns ?? [], attrScope) : [];
        const spread = attrs.length ? Math.max(...attrs.map((a) => Math.abs(a.x) + a.rx)) : 0;
        return { w: Math.max(chenEntityW(chenEntityLabel(n)), spread * 2 + 20), h: ER_CHEN_H };
      };
      const chenCenter = (n) => { const p = pos[n]; const s = chenSize(n); return p ? { x: p.x + s.w / 2, y: p.y + s.h / 2 } : null; };
      // 线从实体边框出发而不是圆心——连线不再从框底下穿出来
      const borderPoint = (center, size, toward) => {
        const dx = toward.x - center.x, dy = toward.y - center.y;
        if (!dx && !dy) return { ...center };
        const t = Math.min(dx !== 0 ? size.w / 2 / Math.abs(dx) : Infinity, dy !== 0 ? size.h / 2 / Math.abs(dy) : Infinity);
        return { x: center.x + dx * t, y: center.y + dy * t };
      };
      const chenLayer = () => {
        const out = [];
        const cards = [];
        const hits = [];
        let ci = 0;
        const k = (p) => "k" + ci++ + p;
        const groups = new Map();
        for (const e of edges) {
          if (!pos[e.fromTable] || !pos[e.toTable]) continue;
          const key = e.fromTable === e.toTable ? "self\u0000" + e.fromTable : [e.fromTable, e.toTable].sort().join("\u0000");
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        }
        for (const group of groups.values()) {
          group.forEach((e, gi) => {
            const a = chenCenter(e.fromTable), b = chenCenter(e.toTable);
            if (!a || !b) return;
            const label = erClip(e.label ?? e.fromCol, 10);
            const dw = Math.max(30, erTextW(label) * 4.4 + 14), dh = 20;
            const self = e.fromTable === e.toTable;
            const dOff = dpos[e.rid] ?? { x: 0, y: 0 };
            let dc;
            if (self) {
              const p = pos[e.fromTable], s = chenSize(e.fromTable);
              dc = { x: p.x + s.w + dw / 2 + 24 + dOff.x, y: p.y + s.h / 2 + dOff.y };
            } else {
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              const dx = b.x - a.x, dy = b.y - a.y;
              const len = Math.hypot(dx, dy) || 1;
              const off = (gi - (group.length - 1) / 2) * 38;
              dc = { x: mx + (-dy / len) * off + dOff.x, y: my + (dx / len) * off + dOff.y };
            }
            const hl = !hover || hover === e.fromTable || hover === e.toTable || selRel === e.rid;
            const stroke = selRel === e.rid ? "#b088f7" : hl ? "#d29922" : "#8899aa";
            const dPath = self
              ? `M ${a.x} ${a.y - 9} L ${dc.x} ${dc.y - dh / 2} M ${a.x} ${a.y + 9} L ${dc.x - dw / 2} ${dc.y}`
              : `M ${borderPoint(a, chenSize(e.fromTable), dc).x} ${borderPoint(a, chenSize(e.fromTable), dc).y} L ${dc.x} ${dc.y} L ${borderPoint(b, chenSize(e.toTable), dc).x} ${borderPoint(b, chenSize(e.toTable), dc).y}`;
            out.push(jsx.jsx("path", { d: dPath, fill: "none", stroke, strokeOpacity: hl ? 0.9 : 0.3, strokeWidth: hl ? 1.4 : 1 }, k("p")));
            out.push(jsx.jsx("polygon", {
              points: `${dc.x - dw / 2},${dc.y} ${dc.x},${dc.y - dh / 2} ${dc.x + dw / 2},${dc.y} ${dc.x},${dc.y + dh / 2}`,
              fill: solidBg, stroke, strokeOpacity: hl ? 1 : 0.55, strokeWidth: selRel === e.rid ? 2 : 1,
              style: { cursor: "pointer" },
              onPointerDown: onDiamondDown(e),
            }, k("d")));
            out.push(jsx.jsx("text", { x: dc.x, y: dc.y + 3, fontSize: 8.5, textAnchor: "middle", fill: hl ? "var(--dsw-alias-label-secondary,#8b949e)" : "var(--dsw-alias-label-tertiary,#8b949e)", children: label }, k("dl")));
            // 基数：数据库外键默认 引用方 N / 被引用方 1（可在编辑面板改）；自定义联系用用户选的左右基数。
            // 标签统一最后画（最顶层），永远不会被实体框盖住。
            const [cardFrom, cardTo] = String(e.card || "N:1").split(":");
            const card = (pt, txt, key2) => cards.push(jsx.jsx("text", { x: pt.x, y: pt.y - 5, fontSize: 10, textAnchor: "middle", fill: hl ? "var(--dsw-alias-label-primary,#e6edf3)" : "var(--dsw-alias-label-tertiary)", style: { pointerEvents: "none" }, children: txt }, key2));
            if (self) {
              // 自环的基数标在实体框右侧，避免压在框上
              const p = pos[e.fromTable], s = chenSize(e.fromTable);
              card({ x: p.x + s.w + 10, y: p.y + s.h / 2 - 12 }, cardFrom, k("cn"));
              card({ x: p.x + s.w + 10, y: p.y + s.h / 2 + 18 }, cardTo, k("c1"));
            } else {
              // 从菱形向两端量 28%，落在边框锚点与菱形之间的空当里
              card({ x: dc.x + (a.x - dc.x) * 0.28, y: dc.y + (a.y - dc.y) * 0.28 }, cardFrom, k("cn"));
              card({ x: dc.x + (b.x - dc.x) * 0.28, y: dc.y + (b.y - dc.y) * 0.28 }, cardTo, k("c1"));
            }
            hits.push({ e, dc, dw, dh }); // 菱形命中区最后统一铺在最顶层，避免被属性椭圆挡住点不到
          });
        }
        // 拖动中的实体排到最后（SVG 里后画者在上）
        const order = [...sel];
        const dragging = dragRef.current?.type === "node" ? dragRef.current.name : null;
        if (dragging && order.includes(dragging)) { order.splice(order.indexOf(dragging), 1); order.push(dragging); }
        for (const n of order) {
          const p = pos[n];
          const tb = byName.get(n);
          if (!p || !tb) continue;
          const s = chenSize(n);
          const dim = hover && hover !== n && !nbrs.get(hover)?.has(n);
          const attrs = chenAttrLayout(tb.columns ?? [], attrScope);
          out.push(jsx.jsxs("g", {
            transform: `translate(${p.x},${p.y})`,
            onPointerDown: onNodeDown(n),
            onMouseEnter: () => setHover(n),
            onMouseLeave: () => setHover(null),
            style: { cursor: "move", opacity: dim ? 0.35 : 1 },
            children: [
              attrs.map((a) => jsx.jsxs("g", { children: [
                jsx.jsx("line", { x1: s.w / 2, y1: ER_CHEN_H / 2, x2: s.w / 2 + a.x, y2: a.y, stroke: "var(--dsw-alias-border-l2,#30363d)", strokeWidth: 1, strokeOpacity: 0.8 }),
                jsx.jsx("ellipse", { cx: s.w / 2 + a.x, cy: a.y, rx: a.rx, ry: a.ry, fill: solidBg, stroke: a.extra ? "var(--dsw-alias-border-l2,#30363d)" : hover === n ? "#7aa2f7" : "var(--dsw-alias-label-tertiary,#8b949e)", strokeWidth: 1, strokeDasharray: a.extra ? "3,2" : undefined }),
                jsx.jsx("text", { x: s.w / 2 + a.x, y: a.y + 3, fontSize: 9.5, textAnchor: "middle", fill: a.extra ? "var(--dsw-alias-label-tertiary,#8b949e)" : a.pk ? "var(--dsw-alias-label-primary,#e6edf3)" : "var(--dsw-alias-label-secondary,#8b949e)", textDecoration: a.pk ? "underline" : "none", children: a.name }),
              ] }, "a" + a.name)),
              jsx.jsx("rect", { width: s.w, height: ER_CHEN_H, rx: 2, fill: solidBg, stroke: selEntity === n ? "#b088f7" : hover === n ? "#7aa2f7" : "var(--dsw-alias-label-primary,#e6edf3)", strokeWidth: selEntity === n || hover === n ? 2 : 1.2 }),
              jsx.jsx("text", { x: s.w / 2, y: ER_CHEN_H / 2 + 4, fontSize: 11, fontWeight: 700, textAnchor: "middle", fill: "var(--dsw-alias-label-primary,#e6edf3)", children: chenEntityLabel(n) }),
              jsx.jsx("text", { x: s.w - 9, y: ER_CHEN_H / 2 + 4, fontSize: 10, textAnchor: "middle", fill: "var(--dsw-alias-label-tertiary,#8b949e)", style: { cursor: "pointer" }, onPointerDown: (e) => e.stopPropagation(), onClick: () => removeEntity(n), children: "✕" }),
            ],
          }, n));
        }
        for (const h of hits) {
          // 透明命中圆：菱形视觉层留在底层，但点击/拖动永远命中最上层
          out.push(jsx.jsx("circle", {
            cx: h.dc.x, cy: h.dc.y, r: Math.max(h.dw, h.dh) / 2 + 6,
            fill: "none", pointerEvents: "all", style: { cursor: "pointer" },
            onPointerDown: onDiamondDown(h.e),
          }, k("hit")));
        }
        out.push(...cards); // 基数标签最顶层：不被实体框遮挡
        return out;
      };

      // ---- 0.9.9 侧栏编辑器：选中实体/自定义联系时替换清单区 ----
      const editorInputStyle = { flex: 1, minWidth: 0, boxSizing: "border-box", fontSize: 11, padding: "2px 5px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", fontFamily: "ui-monospace, Menlo, Consolas, monospace" };
      const backRow = () => jsx.jsx("div", { style: { display: "flex", padding: "0 6px 6px" }, children: jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5, padding: "1px 6px" }, onClick: () => { setSelEntity(null); setSelRel(null); }, children: t("er.backToList") }) });
      const entityEditor = (name) => {
        const tb = byName.get(name);
        if (!tb) return [];
        const rows = [
          jsx.jsx("input", { key: "nm", value: name, onChange: (e) => renameEntity(name, e.target.value), placeholder: t("er.entityName"), style: { ...editorInputStyle, width: "calc(100% - 12px)", margin: "0 6px 4px", fontWeight: 700 } }),
          jsx.jsx("div", { key: "ah", style: { padding: "2px 6px", fontSize: 10, color: "var(--dsw-alias-label-tertiary)" }, children: t("er.attrs") }),
          ...tb.columns.map((c, i) => jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "1px 6px" }, children: [
            jsx.jsx("input", { type: "checkbox", checked: !!c.pk, title: "PK", onChange: () => togglePk(name, c.name) }),
            jsx.jsx("input", { value: c.name, onChange: (e) => renameAttr(name, c.name, e.target.value), style: editorInputStyle }),
            jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10, padding: "0 4px", flex: "none" }, onClick: () => delAttr(name, c.name), children: "✕" }),
          ] }, "a" + i + c.name)),
          jsx.jsx("button", { key: "aa", type: "button", style: { ...btnStyle(), fontSize: 10.5, margin: "4px 6px" }, onClick: () => addAttr(name), children: t("er.addAttr") }),
          jsx.jsx("button", { key: "rm", type: "button", style: { ...btnStyle(), fontSize: 10.5, margin: "0 6px" }, onClick: () => removeEntity(name), children: tb.custom ? t("er.deleteEntity") : t("er.removeFromCanvas") }),
        ];
        return rows;
      };
      const relEditor = (rid) => {
        const rel = (model?.edges ?? []).find((e) => e.rid === rid);
        if (!rel) return [];
        return [
          jsx.jsx("input", { key: "rn", value: rel.label ?? rel.fromCol, onChange: (e) => renameRel(rid, e.target.value), placeholder: t("er.relName"), style: { ...editorInputStyle, width: "calc(100% - 12px)", margin: "0 6px 4px", fontWeight: 700 } }),
          jsx.jsxs("div", { key: "ep", style: { padding: "2px 6px", fontSize: 10.5, color: "var(--dsw-alias-label-secondary)", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }, children: [`${rel.fromTable} ⛓ ${rel.toTable}`] }),
          !rel.custom ? jsx.jsxs("div", { key: "fk", style: { padding: "0 6px 2px", fontSize: 10, color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }, children: [`${t("er.fkCol")}: ${rel.fromCol}`] }) : null,
          jsx.jsxs("label", { key: "cd", style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 6px", fontSize: 11, color: "var(--dsw-alias-label-secondary)" }, children: [
            t("er.card"),
            jsx.jsxs("select", { value: rel.card || "N:1", onChange: (e) => setRelCard(rid, e.target.value), style: { fontSize: 11, padding: "1px 4px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" }, children: ["1:1", "1:N", "N:1", "M:N"].map((o) => jsx.jsx("option", { value: o, children: o }, o)) }),
          ] }),
          jsx.jsx("button", { key: "dl", type: "button", style: { ...btnStyle(), fontSize: 10.5, margin: "4px 6px" }, onClick: () => delRel(rid), children: rel.custom ? t("er.delRel") : t("er.hideRel") }),
        ];
      };

      return jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }, children: [
        jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
          jsx.jsx("span", { style: { fontWeight: 700, fontSize: 13 }, children: `⛓ ${t("er.title")}` }),
          jsx.jsx("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }, children: `${database ?? ""} · ${engine ?? ""}` }),
          jsx.jsx("button", { type: "button", style: { ...btnStyle(), marginLeft: "auto" }, onClick: onClose, children: t("er.back") }),
        ] }),
        jsx.jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0 }, children: [
          // --- 左：模块栏（选哪些表上画布） ---
          jsx.jsxs("div", { style: { width: 188, flex: "none", display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--dsw-alias-border-l2)" }, children: [
            jsx.jsx("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: t("er.search"), style: { margin: "8px 8px 4px", padding: "3px 6px", fontSize: 11.5, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", boxSizing: "border-box", width: "calc(100% - 16px)" } }),
            (selEntity || selRel) ? jsx.jsx("div", { style: { display: "flex", padding: "0 8px 6px" }, children: backRow() }) : jsx.jsxs("div", { style: { display: "flex", gap: 4, padding: "0 8px 6px" }, children: [
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: selectAll, children: t("er.all") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: clearAll, children: t("er.clear") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: addRelated, title: t("er.relatedHint"), children: t("er.related") }),
            ] }),
            !selEntity && !selRel && note ? jsx.jsx("div", { style: { padding: "0 8px 4px", fontSize: 10.5, color: "var(--dsw-alias-label-secondary)" }, children: note }) : null,
            jsx.jsx("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 4px 6px" }, children: selEntity && byName.has(selEntity) ? entityEditor(selEntity)
              : selRel && (model?.edges ?? []).some((e) => e.rid === selRel) ? relEditor(selRel)
              : filtered.map((n) => {
              const d = nbrs.get(n)?.size ?? 0;
              return jsx.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 6, padding: "2px 4px", borderRadius: 4, cursor: "pointer", fontSize: 11.5, color: "var(--dsw-alias-label-primary)" }, children: [
                jsx.jsx("input", { type: "checkbox", checked: sel.has(n), onChange: () => toggle(n) }),
                jsx.jsx("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, Menlo, Consolas, monospace" }, children: n }),
                d > 0 ? jsx.jsx("span", { title: t("er.links").replace("{n}", String(d)), style: { flex: "none", fontSize: 9.5, lineHeight: "14px", padding: "0 5px", borderRadius: 8, background: "var(--dsw-alias-interactive-bg-hover)", color: "var(--dsw-alias-label-tertiary)" }, children: d }) : null,
              ] }, n);
            }) }),
            jsx.jsx("div", { style: { padding: "4px 8px", fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: t("er.onboard").replace("{n}", String(sel.size)) }),
          ] }),
          // --- 右：画板 ---
          jsx.jsxs("div", { style: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }, children: [
            jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: autoLayout, children: t("er.autoLayout") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: () => fitTo(pos), children: t("er.fit") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: createEntity, children: t("er.newEntity") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px", fontWeight: linking ? 700 : 400, color: linking ? "#d29922" : "var(--dsw-alias-label-secondary)" }, onClick: startLink, children: linking ? t("er.cancelLink") : t("er.newRel") }),
              jsx.jsx("button", { type: "button", title: t("er.resetTitle"), style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: () => { if (rawRef.current) bootFrom(rawRef.current); }, children: t("er.resetModel") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px", fontWeight: notation === "table" ? 700 : 400, color: notation === "table" ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" }, onClick: () => setNotation("table"), children: t("er.viewTable") }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px", fontWeight: notation === "chen" ? 700 : 400, color: notation === "chen" ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" }, onClick: () => setNotation("chen"), children: t("er.viewChen") }),
              notation === "chen" ? jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 11, padding: "1px 7px" }, onClick: () => setAttrScope((s) => (s === "key" ? "all" : "key")), children: attrScope === "key" ? t("er.attrsKey") : t("er.attrsAll") }) : null,
              jsx.jsx("span", { style: { marginLeft: "auto", fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)" }, children: t("er.hint") }),
            ] }),
            jsx.jsxs("div", {
              ref: boardRef,
              style: { flex: 1, minHeight: 0, overflow: "hidden", cursor: "grab", position: "relative", userSelect: "none", touchAction: "none" },
              onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
              children: [
                error ? jsx.jsx("div", { style: { position: "absolute", top: 8, left: 12, right: 12, zIndex: 5, color: "#e06c75", fontSize: 12 }, children: `${t("er.failed")}: ${error}` }) : null,
                !error && !data ? jsx.jsx("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: t("er.loading") }) : null,
                !error && data?.tooMany ? jsx.jsx("div", { style: { position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 5, fontSize: 11, color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, padding: "2px 10px", pointerEvents: "none", maxWidth: "90%" }, children: t("er.tooMany").replace("{n}", String(data.tooMany)) }) : null,
                linking ? jsx.jsx("div", { style: { position: "absolute", top: data?.tooMany ? 36 : 8, left: "50%", transform: "translateX(-50%)", zIndex: 5, fontSize: 11, color: "#d29922", background: "var(--dsw-alias-bg-base)", border: "1px solid #d29922", borderRadius: 6, padding: "2px 10px", pointerEvents: "none", maxWidth: "90%" }, children: linking.from == null ? t("er.linkHint1") : t("er.linkHint2").replace("{n}", linking.from) }) : null,
                data && !error && sorted.length === 0 ? jsx.jsx("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: t("er.noTables") }) : null,
                data && !error && sorted.length > 0 && sel.size === 0 ? jsx.jsx("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", fontSize: 12.5, color: "var(--dsw-alias-label-tertiary)" }, children: t("er.empty") }) : null,
                data && !error && sel.size > 0 && drawnEdges === 0 ? jsx.jsx("div", { style: { position: "absolute", left: 0, right: 0, bottom: 10, display: "flex", justifyContent: "center", pointerEvents: "none" }, children: jsx.jsx("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", background: "var(--dsw-alias-bg-base)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, padding: "2px 10px" }, children: t("er.noEdges") }) }) : null,
                jsx.jsxs("svg", { width: "100%", height: "100%", style: { display: "block" }, children: [
                  jsx.jsxs("g", { transform: `translate(${view.x},${view.y}) scale(${view.scale})`, children: notation === "chen" ? chenLayer() : [
                    edges.map((e, i) => {
                      const d = edgePath(e);
                      if (!d) return null;
                      const hl = !hover || hover === e.fromTable || hover === e.toTable || selRel === e.rid;
                      return jsx.jsx("path", { d, fill: "none", stroke: selRel === e.rid ? "#b088f7" : hl ? "#7aa2f7" : "#8899aa", strokeOpacity: hl ? 0.9 : 0.25, strokeWidth: hl ? 1.6 : 1 }, "e" + i);
                    }),
                    edges.filter((e) => e.custom && pos[e.fromTable] && pos[e.toTable]).map((e, i) => {
                      // 自定义联系在表视图下用紫色虚线 + 关系名，区别于数据库真实外键
                      const a = pos[e.fromTable], b = pos[e.toTable];
                      const d = edgePath(e);
                      if (!d) return null;
                      const hl = selRel === e.rid || hover === e.fromTable || hover === e.toTable;
                      const dOff = dpos[e.rid] ?? { x: 0, y: 0 };
                      const mid = { x: (a.x + b.x + ER_NODE_W) / 2 + dOff.x, y: (a.y + b.y) / 2 + dOff.y };
                      return jsx.jsxs("g", { onPointerDown: onDiamondDown(e), style: { cursor: "pointer" }, children: [
                        jsx.jsx("path", { d, fill: "none", stroke: selRel === e.rid ? "#b088f7" : "#b088f7aa", strokeOpacity: hl ? 0.95 : 0.5, strokeWidth: hl ? 1.8 : 1.2, strokeDasharray: "5,3" }, "ce" + i),
                        jsx.jsx("text", { x: mid.x, y: mid.y - 5, fontSize: 9, textAnchor: "middle", fill: selRel === e.rid ? "#b088f7" : "var(--dsw-alias-label-secondary,#8b949e)", children: erClip(e.label ?? e.fromCol, 12) }, "cl" + i),
                      ] }, "cg" + i);
                    }),
                    (() => {
                      // 拖动中的实体排到最后（SVG 里后画者在上）
                      const order = [...sel];
                      const dragging = dragRef.current?.type === "node" ? dragRef.current.name : null;
                      if (dragging && order.includes(dragging)) { order.splice(order.indexOf(dragging), 1); order.push(dragging); }
                      return order;
                    })().map((n) => {
                      const tb = byName.get(n);
                      const p = pos[n];
                      if (!tb || !p) return null;
                      const h = heights.get(n) ?? erNodeH(tb);
                      const dim = hover && hover !== n && !nbrs.get(hover)?.has(n);
                      return jsx.jsxs("g", {
                        transform: `translate(${p.x},${p.y})`,
                        onPointerDown: onNodeDown(n),
                        onMouseEnter: () => setHover(n),
                        onMouseLeave: () => setHover(null),
                        style: { cursor: "move", opacity: dim ? 0.35 : 1 },
                        children: [
                          jsx.jsx("rect", { width: ER_NODE_W, height: h, rx: 6, fill: solidBg, stroke: selEntity === n ? "#b088f7" : hover === n ? "#7aa2f7" : "var(--dsw-alias-border-l2,#30363d)", strokeWidth: selEntity === n || hover === n ? 2 : 1 }),
                          jsx.jsx("rect", { width: ER_NODE_W, height: ER_HEAD_H, rx: 6, fill: "#1f6feb", fillOpacity: 0.25 }),
                          jsx.jsx("text", { x: 8, y: 15, fontSize: 11, fontWeight: 700, fill: "var(--dsw-alias-label-primary,#e6edf3)", children: erClip(n, 16) }),
                          jsx.jsx("text", { x: ER_NODE_W - 12, y: 15, fontSize: 11, fill: "var(--dsw-alias-label-tertiary,#8b949e)", style: { cursor: "pointer" }, onPointerDown: (e) => e.stopPropagation(), onClick: () => removeEntity(n), children: "✕" }),
                          (tb.columns ?? []).map((c, i) => jsx.jsx("text", { x: 8, y: ER_HEAD_H + i * ER_ROW_H + 11, fontSize: 10, fill: c.pk ? "var(--dsw-alias-label-primary,#e6edf3)" : "var(--dsw-alias-label-secondary,#8b949e)", children: (c.pk ? "🔑 " : c.fk ? "↗ " : "· ") + (String(c.name).length > 16 ? String(c.name).slice(0, 15) + "…" : c.name) }, "c" + i)),
                        ],
                      }, n);
                    }),
                  ] }),
                ] }),
              ],
            }),
          ] }),
        ] }),
      ] });
    }

  /** 0.9.1 单元格内容查看器：JSON 格式化 / 图片预览 / Buffer hex / 长文本换行。 */
  function CellViewer({ value, onClose, t }) {
    const [copied, setCopied] = react.useState(false);
    const info = react.useMemo(() => {
      // mysql2/pg 的二进制通常序列化成 { type: "Buffer", data: [...] }
      if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
        const head = value.data.slice(0, 4);
        const isPng = head[0] === 0x89 && head[1] === 0x50;
        const isJpg = head[0] === 0xff && head[1] === 0xd8;
        if ((isPng || isJpg) && value.data.length <= 2 * 1024 * 1024) {
          let binary = "";
          const chunk = 8192;
          for (let i = 0; i < value.data.length; i += chunk) binary += String.fromCharCode(...value.data.slice(i, i + chunk));
          try { return { kind: "image", src: `data:image/${isPng ? "png" : "jpeg"};base64,${btoa(binary)}`, size: value.data.length }; } catch { /* fallthrough */ }
        }
        const hex = value.data.slice(0, 2048).map((b) => b.toString(16).padStart(2, "0")).join(" ");
        return { kind: "buffer", size: value.data.length, hex: hex + (value.data.length > 2048 ? "\n…" : "") };
      }
      if (typeof value === "object" && value !== null) {
        try { return { kind: "json", text: JSON.stringify(value, null, 2) }; } catch { /* fallthrough */ }
      }
      if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
        try { return { kind: "json", text: JSON.stringify(JSON.parse(value), null, 2) }; } catch { /* fallthrough */ }
      }
      return { kind: "text", text: String(value ?? "") };
    }, [value]);
    const copy = async () => {
      const text = info.kind === "image" ? info.src : info.text ?? info.hex ?? "";
      try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* 剪贴板不可用 */ }
    };
    return jsx.jsxs("div", { style: { position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onClose, children: [
      jsx.jsxs("div", { style: { background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base))", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, maxWidth: "80%", maxHeight: "80%", width: 640, display: "flex", flexDirection: "column", boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.35))" }, onClick: (e) => e.stopPropagation(), children: [
        jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
          jsx.jsx("span", { style: { fontWeight: 700, fontSize: 12 }, children: `🔍 ${info.kind === "image" ? "图片" : info.kind === "buffer" ? `二进制 (${info.size} 字节)` : info.kind === "json" ? "JSON" : "文本"}` }),
          jsx.jsx("button", { type: "button", style: { ...btnStyle(), marginLeft: "auto" }, onClick: copy, children: copied ? (t("viewer.copied") ?? "已复制") : (t("viewer.copy") ?? "复制") }),
          jsx.jsx("button", { type: "button", style: btnStyle(), onClick: onClose, children: "✕" }),
        ] }),
        jsx.jsx("div", { style: { overflow: "auto", padding: 10 }, children: info.kind === "image"
          ? jsx.jsx("img", { src: info.src, style: { maxWidth: "100%", maxHeight: "60vh" } })
          : jsx.jsx("pre", { style: { margin: 0, fontSize: 11.5, fontFamily: "ui-monospace, Menlo, Consolas, monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--dsw-alias-label-primary)", lineHeight: "17px" }, children: info.kind === "buffer" ? info.hex : info.text }) }),
      ] }),
    ] });
  }

    /** 0.9.3 新增行：按当前结果集的列生成表单，留空 = NULL。 */
    function InsertRowDialog({ fields, onSubmit, onClose }) {
      const [values, setValues] = react.useState({});
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const submit = async () => {
        setBusy(true); setError(null);
        try { await onSubmit(values); } catch (e) { setError(String(e.message || e)); } finally { setBusy(false); }
      };
      return jsx.jsxs("div", { style: { position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }, onClick: onClose, children: [
        jsx.jsxs("div", { style: { background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base))", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, width: 520, maxHeight: "80%", display: "flex", flexDirection: "column", boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.35))" }, onClick: (e) => e.stopPropagation(), children: [
          jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l2)" }, children: [
            jsx.jsx("span", { style: { fontWeight: 700, fontSize: 12 }, children: "➕ 新增行" }),
            jsx.jsx("span", { style: { fontSize: 10.5, color: "var(--dsw-alias-label-tertiary)" }, children: "留空 = NULL；自增主键可留空" }),
            jsx.jsx("button", { type: "button", style: { ...btnStyle(), marginLeft: "auto" }, onClick: onClose, children: "✕" }),
          ] }),
          jsx.jsx("div", { style: { overflow: "auto", padding: "8px 12px", flex: 1 }, children: (fields ?? []).map((f) => jsx.jsxs("label", { style: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }, children: [
            jsx.jsx("span", { style: { width: 150, flex: "none", fontSize: 11.5, fontFamily: "ui-monospace, Menlo, Consolas, monospace", overflow: "hidden", textOverflow: "ellipsis" }, children: f.name }),
            jsx.jsx("input", { value: values[f.name] ?? "", onChange: (e) => setValues((p) => ({ ...p, [f.name]: e.target.value })), onKeyDown: (e) => { if (e.key === "Enter" && !e.nativeEvent?.isComposing) submit(); }, style: { flex: 1, boxSizing: "border-box", fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" }, placeholder: "NULL" }),
          ] }, f.name)) }),
          error ? jsx.jsx("div", { style: { padding: "4px 12px", color: "#e06c75", fontSize: 11.5 }, children: error }) : null,
          jsx.jsxs("div", { style: { display: "flex", gap: 8, padding: "8px 12px", borderTop: "1px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end" }, children: [
            jsx.jsx("button", { type: "button", style: btnStyle(), onClick: onClose, children: "取消" }),
            jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontWeight: 700 }, disabled: busy, onClick: submit, children: busy ? "…" : "➕ 插入" }),
          ] }),
        ] }),
      ] });
    }

    function DatabasePanel() {
      return jsx.jsx(PanelBoundary, { children: jsx.jsx(DatabaseView, {}) });
    }

    // ---------------------------------------------------------------------
    // The main Database view (one Conversation tab body)
    // ---------------------------------------------------------------------
    function DatabaseView() {
      const t = react.useCallback((key) => zh[key] ?? en[key] ?? key, []);
      const [kinds, setKinds] = react.useState(null);
      const [profiles, setProfiles] = react.useState([]);
      const [connected, setConnected] = react.useState([]);
      const [editing, setEditing] = react.useState(null); // null | 'new' | profile
      const [activeId, setActiveId] = react.useState(null);
      /** profileId -> { schema, loadedAt }: a connection's own tree, kept only
       *  while the read succeeded, so a failure is never cached as "empty". */
      const [schemas, setSchemas] = react.useState({});
      /** profileId -> message: the last failed schema read, shown inline. */
      const [schemaErrors, setSchemaErrors] = react.useState({});
      /** profileId -> true while that connection's schema is being read. */
      const [loadingSchema, setLoadingSchema] = react.useState({});
      const [result, setResult] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      /** Info about the table behind the current result grid, when it came
       *  from a peek: { connectionId, engine, database, table, pk[] }. */
      const [viewMeta, setViewMeta] = react.useState(null);
      const [notice, setNotice] = react.useState(null);
      const [toast, setToast] = react.useState(null); // { kind: 'ok'|'warn'|'error', title, detail }
      const [testing, setTesting] = react.useState(false);
      /** Visual table designer state: null = closed; else { connectionId,
       *  database, engine } — database may be null until a db row picks one. */
      const [designer, setDesigner] = react.useState(null);
      const [designerTypes, setDesignerTypes] = react.useState([]);
      /** 0.9.0 分页浏览状态：{ connectionId, engine, database, table, page, pageSize, sort, filter } */
      const [peekState, setPeekState] = react.useState(null);
      /** 0.9.0 E-R 图状态：{ connectionId, engine, database } */
      const [er, setEr] = react.useState(null);
      /** 0.9.1 单元格查看器：被点击单元格的值 */
      const [cellViewer, setCellViewer] = react.useState(null);
      /** 0.9.3 新增行：{ connectionId, database, table, fields } */
      const [insertRow, setInsertRow] = react.useState(null);
      /** 0.9.4 版本握手：后端（DSH 进程里注册的路由）的版本 */
      const [backendVersion, setBackendVersion] = react.useState(null);
      /** 0.9.0 查询历史（localStorage 持久化） */
      const [sqlHistory, setSqlHistory] = react.useState(() => { try { return JSON.parse(localStorage.getItem("dsh-database:history") ?? "[]"); } catch { return []; } });
      /** Foreign-key reference options "table.column" built from the cached
       *  schema trees of the active connection — the same list the tree shows. */
      const designerFkOptions = react.useMemo(() => {
        const profileId = designer?.connectionId;
        const schema = schemas[profileId]?.schema;
        if (!schema) return [];
        const refs = [];
        for (const db of schema.databases ?? []) {
          if (designer?.database && db.name !== designer.database) continue;
          for (const tb of db.tables ?? []) {
            if (designer?.editTable && tb.name === designer.editTable) continue; // no self-reference
            for (const col of tb.columns ?? []) refs.push(`${tb.name}.${col.name}`);
          }
        }
        return refs.slice(0, 500);
      }, [schemas, designer]);
      /** profileId -> password typed this session. Memory only: never persisted
       *  by the browser half (the host stores an opted-in password instead). */
      const [passwords, setPasswords] = react.useState({});
      /** Password prompt state: { profileId } while waiting for input. */
      const [askPassword, setAskPassword] = react.useState(null);
      const askTextRef = react.useRef("");
      const askResolveRef = react.useRef(null);
      const toastTimer = react.useRef(null);
      /** Guards the one-time "pre-select a connection" on panel mount. */
      const autoSelectedRef = react.useRef(false);

      /** Show the connection toast; auto-dismiss (shorter hold for failures). */
      const showToast = react.useCallback((kind, title, detail) => {
        setToast({ kind, title, detail });
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), kind === "error" ? 4500 : 3000);
      }, []);
      react.useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

      const refreshProfiles = react.useCallback(() => {
        apiGet("/dsh-database/api/profiles").then((body) => {
          const list = body.profiles || [];
          const live = body.connected || [];
          setProfiles(list);
          setConnected(live);
          // First load only: pre-select a connection (a connected one if any)
          // so the panel never starts in the "请先在左侧选择一个连接" dead end
          // while the tree clearly shows an open server.
          if (!autoSelectedRef.current && list.length > 0) {
            autoSelectedRef.current = true;
            setActiveId((prev) => prev ?? (list.find((p) => live.includes(p.id)) ?? list[0]).id);
          }
        }).catch(() => {});
      }, []);

      react.useEffect(() => { refreshProfiles(); }, [refreshProfiles]);
      react.useEffect(() => {
        apiGet("/dsh-database/api/kinds").then((body) => { setKinds(body.kinds); setBackendVersion(body.version ?? "未知（重启前的旧版）"); }).catch(() => setKinds({ sqlite: { label: "SQLite", defaultPort: null }, mysql: { label: "MySQL", defaultPort: 3306 }, postgres: { label: "PostgreSQL", defaultPort: 5432 }, redis: { label: "Redis", defaultPort: 6379 }, elasticsearch: { label: "Elasticsearch", defaultPort: 9200 }, qdrant: { label: "Qdrant（向量）", defaultPort: 6333 } }));
        // The designer's type dropdown comes from the host, so browser and host
        // always agree on the supported set.
        apiGet("/dsh-database/api/designer/types").then((body) => setDesignerTypes(body.types ?? [])).catch(() => {});
      }, []);

      const ensureConnected = react.useCallback(async (profile) => {
        if (connected.includes(profile.id)) return true;
        setBusy(true);
        try {
          await apiPost("/dsh-database/api/connect", { id: profile.id });
          setConnected((prev) => prev.includes(profile.id) ? prev : [...prev, profile.id]);
          return true;
        } catch (error) {
          setNotice(String(error.message || error));
          return false;
        } finally { setBusy(false); }
      }, [connected]);

      // NOTE: every useCallback below must be declared AFTER the callbacks it
      // references in its dependency array. `const` bindings are in the
      // temporal dead zone until initialized, and a dependency array is
      // evaluated at once — referencing a later callback throws during render
      // and leaves the whole panel blank (that is exactly what shipped once).
      const loadSchema = react.useCallback(async (profileId) => {
        const id = profileId ?? activeId;
        if (!id) return;
        if (loadingSchema[id] === true) return; // one in-flight read per connection
        setLoadingSchema((prev) => ({ ...prev, [id]: true }));
        try {
          const body = await apiGet(`/dsh-database/api/schema?id=${encodeURIComponent(id)}`);
          setSchemas((prev) => ({ ...prev, [id]: { schema: body, loadedAt: Date.now() } }));
          setSchemaErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
        } catch (error) {
          // A failed read must NOT be cached as an empty database list — that
          // once showed "0 databases" for a perfectly healthy server. Drop the
          // cache, keep the reason, and leave the node retryable.
          setSchemas((prev) => { const next = { ...prev }; delete next[id]; return next; });
          setSchemaErrors((prev) => ({ ...prev, [id]: String(error.message || error) }));
          showToast("error", t("schema.readFailed"), String(error.message || error));
        } finally {
          setLoadingSchema((prev) => ({ ...prev, [id]: false }));
        }
      }, [activeId, loadingSchema, showToast, t]);

      /** Refresh a connection's tree unless a fresh copy is already cached. */
      const needSchema = react.useCallback((id, force = false) => {
        if (!id) return;
        const cached = schemas[id];
        const stale = cached === undefined
          || schemaErrors[id] !== undefined
          || Date.now() - (cached.loadedAt ?? 0) > SCHEMA_TTL_MS;
        if (force || stale) loadSchema(id);
      }, [schemas, schemaErrors, loadSchema]);

      /**
       * Ask for a password inline (the panel-top prompt bar) and remember it.
       * Resolves with the typed password, or null on cancel.
       *
       * Informed consent: this prompt shows the "typed once, remembered"
       * hint, so a password entered here opts back into persistence — the
       * user was told. The CONNECTION FORM path (no such hint) must not
       * auto-save, which is handled by the rememberPassword guard in
       * doConnect's attempt().
       */
      const askForPassword = react.useCallback((profileId) => new Promise((resolve) => {
        askTextRef.current = "";
        askResolveRef.current = { resolve, profileId };
        setAskPassword({ profileId });
      }), []);

      const submitAskedPassword = react.useCallback(() => {
        const value = askTextRef.current;
        const pending = askResolveRef.current;
        setAskPassword(null);
        askResolveRef.current = null;
        // The prompt's own hint makes this an explicit opt-in: restore the
        // remembered-password flag so the auto-save in attempt() may run.
        if (pending?.profileId != null) {
          setProfiles((prev) => prev.map((p) => (p.id === pending.profileId ? { ...p, rememberPassword: true } : p)));
        }
        if (pending) pending.resolve(value);
      }, [ ]);

      const cancelAskedPassword = react.useCallback(() => {
        const pending = askResolveRef.current;
        setAskPassword(null);
        askResolveRef.current = null;
        if (pending) pending.resolve(null);
      }, [ ]);

      const doConnect = react.useCallback(async (profile, { force = false, silent = false } = {}) => {
        setBusy(true); setNotice(null);
        const started = Date.now();
        /** One connect attempt with an explicit password (may be undefined). */
        const attempt = async (password) => {
          const body = await apiPost("/dsh-database/api/connect", { id: profile.id, password, force });
          const typedNow = typeof password === 'string' && password.length > 0;
          setConnected((prev) => prev.includes(profile.id) ? prev : [...prev, profile.id]);
          setActiveId(profile.id);
          if (typedNow) setPasswords((prev) => ({ ...prev, [profile.id]: password }));
          loadSchema(profile.id);
          // Cookie behavior: a password that just worked is remembered for the
          // next app start — but ONLY when the user opted in. Without the
          // rememberPassword guard, unchecking "remember password" got
          // silently overridden: the next successful connect re-persisted the
          // session-memory password to disk.
          if (!body.passwordSaved && typedNow && profile.hasPassword !== true && profile.rememberPassword === true) {
            await apiPost("/dsh-database/api/passwords/save", { id: profile.id, password }).catch(() => {});
            setProfiles((prev) => prev.map((p) => (p.id === profile.id ? { ...p, hasPassword: true } : p)));
          }
          return body;
        };
        try {
          let body = await attempt(passwords[profile.id]);
          if (!silent) {
            showToast("ok", `${t("toast.connected")} · ${profile.name}`,
              `${body.server ? body.server + " · " : ""}${Date.now() - started}${t("sql.ms")}${body.reused ? " · (cached)" : ""}`);
          }
          return true;
        } catch (error) {
          const message = String(error?.message || error);
          // No usable password (not stored / env var missing) and the user has
          // not typed one this session: prompt once, then retry with it.
          const needsPassword = /未设置|environment variable|using password|Access denied|密码/.test(message)
            || (!profile.hasPassword && !passwords[profile.id] && !silent && force);
          if (!silent && needsPassword && !askPassword) {
            const typed = await askForPassword(profile.id);
            if (typed !== null && typed !== "") {
              setBusy(true);
              try {
                await attempt(typed);
                if (!silent) showToast("ok", `${t("toast.connected")} · ${profile.name}`, `${Date.now() - started}${t("sql.ms")} · ${t("ask.hint")}`);
                return true;
              } catch (retryError) {
                if (!silent) showToast("error", `${t("toast.connectFailed")} · ${profile.name}`, String(retryError.message || retryError));
                return false;
              } finally { setBusy(false); }
            }
          }
          if (force) setConnected((prev) => prev.filter((id) => id !== profile.id));
          if (!silent) showToast("error", `${t("toast.connectFailed")} · ${profile.name}`, message);
          return false;
        } finally { setBusy(false); }
      }, [loadSchema, passwords, showToast, t, askPassword, askForPassword]);

      /**
       * Run one data operation with dead-connection self-healing: when the
       * host answers "connection is not open" (a host restart or dropped
       * socket outlived the browser state), force-rebuild the pooled handle
       * once and retry — the user just sees it work.
       */

      const doDisconnect = react.useCallback(async (profile) => {
        await apiPost("/dsh-database/api/disconnect", { id: profile.id }).catch(() => {});
        setConnected((prev) => prev.filter((id) => id !== profile.id));
        setSchemas((prev) => { const next = { ...prev }; delete next[profile.id]; return next; });
        setSchemaErrors((prev) => { const next = { ...prev }; delete next[profile.id]; return next; });
        if (activeId === profile.id) { setResult(null); setViewMeta(null); setPeekState(null); }
        showToast("warn", `${t("toast.disconnected")} · ${profile.name}`);
      }, [activeId, showToast, t]);

      /** Test a form's settings WITHOUT saving: one-shot connect + schema probe. */
      const doTest = react.useCallback(async (form) => {
        setTesting(true);
        const started = Date.now();
        try {
          const body = await apiPost("/dsh-database/api/test", {
            kind: form.kind, host: form.host, port: form.port === "" ? null : Number(form.port),
            database: form.database, user: form.user, ssl: form.ssl === true,
            envPassword: form.envPassword || null,
            password: form.password || undefined,
          });
          if (form.password) setPasswords((prev) => ({ ...prev, [form.id ?? "__pending__"]: form.password }));
          showToast("ok", `${t("conn.test")} ✓`, `${body.server ? body.server + " · " : ""}${Date.now() - started}${t("sql.ms")}`);
        } catch (error) {
          showToast("error", `${t("toast.connectFailed")}`, String(error.message || error));
        } finally { setTesting(false); }
      }, [showToast, t]);

      const doDelete = react.useCallback(async (profile) => {
        if (!window.confirm(`删除连接 "${profile.name}"?`)) return;
        await apiPost("/dsh-database/api/profiles/delete", { id: profile.id }).catch(() => {});
        refreshProfiles();
      }, [refreshProfiles]);

      const selectProfile = react.useCallback(async (profile) => {
        if (!profile || typeof profile.id !== "string") return;
        setActiveId(profile.id);
        setResult(null);
        setViewMeta(null);
        setPeekState(null);
        if (connected.includes(profile.id) && schemas[profile.id] === undefined) await loadSchema(profile.id);
      }, [connected, loadSchema, schemas]);

      /** 查询历史（0.9.0）：最近 100 条，localStorage 持久化。 */
      const pushHistory = react.useCallback((sql) => {
        const text = String(sql ?? "").trim();
        if (!text) return;
        try {
          const list = JSON.parse(localStorage.getItem("dsh-database:history") ?? "[]");
          const next = [text, ...list.filter((h) => h !== text)].slice(0, 100);
          localStorage.setItem("dsh-database:history", JSON.stringify(next));
          setSqlHistory(next);
        } catch { /* 存储不可用时静默 */ }
      }, []);

      const runSql = react.useCallback(async (sql, targetId = undefined) => {
        const id = targetId ?? activeId;
        if (!id) { setNotice("请先选择并连接一个数据库"); return false; }
        setBusy(true); setNotice(null);
        const attempt = () => apiPost("/dsh-database/api/query", { id, sql });
        pushHistory(sql);
        // R7-H1：SQL 结果一律只读。viewMeta 若残留自上一次点表，网格会把别的表
        // 的主键元数据套在本次结果上，单元格编辑会 UPDATE 到错误的表。
        setViewMeta(null);
        setPeekState(null);
        try {
          try {
            setResult(await attempt());
            return true;
          } catch (error) {
            // R6-M1 自愈：主机重启/掉线后，树的"点表"能自愈而 SQL 编辑器不能——
            // 现在统一：检测到"连接未打开"就 force 重建句柄并重试一次。
            const message = String(error?.message || error);
            if (!/连接未打开|connection is not open/i.test(message)) throw error;
            const profile = profiles.find((p) => p.id === id);
            if (!profile) throw error;
            const ok = await doConnect(profile, { force: true, silent: true });
            if (!ok) throw error;
            setResult(await attempt());
            return true;
          }
        } catch (error) {
          setResult({ error: String(error.message || error) });
          return false;
        } finally { setBusy(false); }
      }, [activeId, profiles, doConnect, pushHistory]);

      /** 0.9.0 服务端分页：按 peekState 拉一页并写入结果区。 */
      const loadPeekPage = react.useCallback(async (state) => {
        setBusy(true); setNotice(null);
        try {
          const started = Date.now();
          const body = await apiPost("/dsh-database/api/peek", {
            id: state.connectionId, database: state.database ?? "", table: state.table,
            page: state.page, pageSize: state.pageSize, sort: state.sort ?? null, filter: state.filter ?? null,
          });
          setResult({ ...body, ms: Date.now() - started });
        } catch (error) {
          setResult({ error: String(error.message || error) });
        } finally { setBusy(false); }
      }, []);

      const changePeek = react.useCallback((patch) => {
        if (!peekState) return;
        const next = { ...peekState, ...patch };
        setPeekState(next);
        loadPeekPage(next);
      }, [peekState, loadPeekPage]);

      const onSort = react.useCallback((column) => {
        if (!peekState) return;
        const dir = !peekState.sort || peekState.sort.column !== column ? "ASC" : (peekState.sort.dir === "ASC" ? "DESC" : null);
        changePeek({ sort: dir ? { column, dir } : null, page: 1 });
      }, [peekState, changePeek]);

      const onPage = react.useCallback((delta) => changePeek({ page: Math.max(1, (peekState?.page ?? 1) + delta) }), [peekState, changePeek]);

      const onPageSize = react.useCallback((n) => changePeek({ pageSize: n, page: 1 }), [changePeek]);

      const onFilter = react.useCallback((filter) => changePeek({ filter, page: 1 }), [changePeek]);

      /** 0.9.0 E-R 图入口。 */
      const openEr = react.useCallback(async (profile, database) => {
        const ok = await doConnect(profile);
        if (!ok) return;
        setEr({ connectionId: profile.id, engine: schemas[profile.id]?.schema?.engine ?? profile.kind, database });
      }, [doConnect, schemas]);

      /** Peek a table: build a SELECT for the engine and the owning database.
       *  Carries the table's own connection (tree row click → peek must work
       *  even when the click did not change the active selection first), and
       *  auto-connects a saved profile that is still offline. */
      const peekTable = react.useCallback(async (table, database, profileId = undefined) => {
        let id = profileId ?? activeId;
        if (!id) { setNotice("请先选择并连接一个数据库"); return; }
        // Always verify through the host, same as the designer entries: the
        // browser-side `connected` array goes stale after a host restart.
        // Reuse wins when the pool is actually alive, so a connected profile
        // does NOT refetch the whole schema tree on every table click (it
        // used to bypass the 30s TTL and toast "(cached)" each time).
        {
          const profile = profiles.find((p) => p.id === id);
          if (profile && !(await doConnect(profile, { silent: true }))) {
            // 静默连接失败也要给反馈：点表没反应比报错更困惑（审计 R6-L1）
            showToast("error", `${t("toast.connectFailed")} · ${profile.name}`, "服务器不可达或密码有误 — 点连接按钮查看详情");
            return;
          }
          needSchema(id);
        }
        setActiveId(id);
        const engine = schemas[id]?.schema?.engine;
        const pk = (table.columns ?? []).filter((c) => c.key === "PRI" || c.key === "PK").map((c) => c.name);
        const meta = { connectionId: id, engine, database, table: table.name, pk };
        // 0.9.0：SQL 引擎 + Mongo + ES 走服务端分页（LIMIT/OFFSET + 排序 + 过滤），
        // Redis/Qdrant 维持 peek 全量采样路径。
        if (PEEK_PAGINATED_ENGINES.includes(engine)) {
          const state = { connectionId: id, engine, database, table: table.name, page: 1, pageSize: 200, sort: null, filter: null };
          setViewMeta(meta);
          setPeekState(state);
          await loadPeekPage(state);
          return;
        }
        setViewMeta(engine === "redis" ? null : meta);
        const qualified = qualifiedName(engine, database, table.name);
        const sql = `SELECT * FROM ${qualified}`;
        const isPeekEngine = engine === "redis" || engine === "qdrant";
        let okRun;
        if (isPeekEngine) {
          // Redis/Qdrant 不拼查询文本，交给主机端 handle.peek
          setBusy(true); setNotice(null);
          try {
            const body = await apiPost("/dsh-database/api/query", { id, peek: { table: table.name } });
            setResult(body); okRun = true;
          } catch (error) { setResult({ error: String(error.message || error) }); okRun = false; }
          finally { setBusy(false); }
        } else {
          okRun = await runSql(sql, id);
        }
        if (!okRun) setViewMeta(null);
      }, [schemas, activeId, profiles, runSql, doConnect, needSchema, loadPeekPage]);

      /** Double-click cell edit: host builds a PK-addressed parameterized
       *  UPDATE, then the grid re-queries so it shows the saved state. */
      const handleCellEdit = react.useCallback(async ({ column, pk, value }) => {        if (!viewMeta) return;
        if (!viewMeta.pk || viewMeta.pk.length === 0) { showToast("warn", t("edit.failed"), "该表没有主键，无法定位行 / no primary key"); return; }
        setBusy(true);
        try {
          await apiPost("/dsh-database/api/update", {
            id: viewMeta.connectionId,
            table: viewMeta.table,
            database: viewMeta.database,
            column,
            pk,
            value,
          });
          showToast("ok", t("edit.done"), `${column} → ${value === null ? "NULL" : value}`);
          // Re-run the peek so the grid reflects what the server actually stored.
          if (peekState && peekState.table === viewMeta.table) {
            await loadPeekPage(peekState);
          } else {
            const qualified = qualifiedName(viewMeta.engine, viewMeta.database, viewMeta.table);
            await apiPost("/dsh-database/api/query", { id: viewMeta.connectionId, sql: `SELECT * FROM ${qualified}` })
              .then((body) => setResult(body))
              .catch(() => {});
          }
        } catch (error) {
          showToast("error", t("edit.failed"), String(error.message || error));
        } finally { setBusy(false); }
      }, [viewMeta, showToast, t, peekState, loadPeekPage]);

      /** 0.9.5 删除一行：主键定位 DELETE，删后刷新当前页。 */
      const handleRowDelete = react.useCallback(async ({ pk }) => {
        if (!viewMeta) return;
        if (!viewMeta.pk || viewMeta.pk.length === 0) { showToast("warn", t("edit.failed"), "该表没有主键，无法定位行"); return; }
        if (!window.confirm("确认删除这一行？此操作不可撤销 / delete this row?")) return;
        setBusy(true);
        try {
          await apiPost("/dsh-database/api/delete", { id: viewMeta.connectionId, table: viewMeta.table, database: viewMeta.database, pk });
          showToast("ok", "已删除 1 行", viewMeta.table);
          if (peekState && peekState.table === viewMeta.table) {
            await loadPeekPage(peekState);
          } else {
            const qualified = qualifiedName(viewMeta.engine, viewMeta.database, viewMeta.table);
            await apiPost("/dsh-database/api/query", { id: viewMeta.connectionId, sql: `SELECT * FROM ${qualified}` })
              .then((body) => setResult(body))
              .catch(() => {});
          }
        } catch (error) {
          showToast("error", "删除失败", String(error.message || error));
        } finally { setBusy(false); }
      }, [viewMeta, showToast, t, peekState, loadPeekPage]);

      /** Import finished: toast the count, then reload the table grid and the
       *  tree row counts so what the user sees matches the server. */
      const handleImported = react.useCallback(async (body) => {
        const meta = viewMeta;
        // total counts every row the FILE carried; a truncated import says so.
        const detail = body?.truncated === true
          ? `${body?.inserted ?? "?"} / ${body?.total ?? "?"} · ${t("import.truncated")}`
          : `${body?.inserted ?? "?"} / ${body?.total ?? "?"}`;
        showToast(body?.truncated === true ? "warn" : "ok", t("import.done"), detail);
        if (!meta) return;
        if (peekState && peekState.table === meta.table) {
          await loadPeekPage(peekState);
        } else {
          const qualified = qualifiedName(meta.engine, meta.database, meta.table);
          await apiPost("/dsh-database/api/query", { id: meta.connectionId, sql: `SELECT * FROM ${qualified}` })
            .then((res) => setResult(res))
            .catch(() => {});
        }
        loadSchema(meta.connectionId);
      }, [viewMeta, showToast, t, loadSchema, peekState, loadPeekPage]);

      /** Open the visual table designer for one connection (+ database). */
      const ensureLiveById = react.useCallback(async (profileId) => {
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile) return false;
        // NOT silent: if the stored password is missing/wrong the user gets
        // the password prompt and the retry runs with what they typed.
        return doConnect(profile, { force: true });
      }, [profiles, doConnect]);

      const openDesigner = react.useCallback(async (profile, database = null) => {
        // ALWAYS re-verify through the host: the `connected` array is a
        // browser-side guess. After a host restart / plugin reload the pooled
        // connection is gone while the UI still shows 已连接, and the first
        // CREATE failed with "connection is not open" (2026-10-01 report).
        // apiPost("/connect") is idempotent — the host reuses a live handle.
        const ok = await doConnect(profile);
        if (!ok) return;
        setActiveId(profile.id);
        setDesigner({
          connectionId: profile.id,
          database,
          engine: database === "sqlite-file" || profile.kind === "sqlite"
            ? "sqlite"
            : schemas[profile.id]?.schema?.engine ?? profile.kind,
        });
      }, [doConnect, schemas]);

      /** Designer finished: refresh the tree and open the new table. */
      const designerCreated = react.useCallback(async (body, wasEdit = false) => {
        const meta = designer;
        setDesigner(null);
        if (!meta) return;
        showToast("ok", wasEdit ? `${t("designer.edited")} · ${body.table}` : `${t("designer.created")} · ${body.table}`, body.sql);
        await loadSchema(meta.connectionId);
        // Open the fresh table right away. loadSchema updates state
        // asynchronously, so read the refreshed tree from the host response
        // shape instead of the stale `schemas` closure.
        const fresh = await apiGet(`/dsh-database/api/schema?id=${encodeURIComponent(meta.connectionId)}`).catch(() => null);
        const dbName = meta.database ?? fresh?.databases?.[0]?.name;
        const table = (fresh?.databases ?? []).find((d) => d.name === dbName)?.tables?.find((tb) => tb.name === body.table)
          // Fallback: a minimal pseudo-table so peekTable still runs.
          ?? { name: body.table, columns: [] };
        peekTable(table, dbName, meta.connectionId);
      }, [designer, loadSchema, peekTable, showToast, t]);

      /** Open the structure editor for one existing table. */
      const openTableEditor = react.useCallback(async (table, database, profileId) => {
        // Same rule as openDesigner: verify the live connection through the
        // host instead of trusting the browser-side `connected` array.
        const profile = profiles.find((p) => p.id === profileId);
        if (!profile) return;
        if (!(await doConnect(profile))) return;
        setActiveId(profileId);
        setDesigner({
          connectionId: profileId,
          database,
          engine: schemas[profileId]?.schema?.engine ?? profiles.find((p) => p.id === profileId)?.kind,
          editTable: table.name,
        });
      }, [profiles, doConnect, schemas]);

      const saveProfile = react.useCallback(async (form) => {
        setBusy(true);
        try {
          const payload = {
            ...form,
            port: form.port === "" ? null : Number(form.port),
            password: form.password || undefined,
            rememberPassword: form.rememberPassword === true,
          };
          const body = editing && editing !== "new"
            ? await apiPost("/dsh-database/api/profiles/update", { id: editing.id, ...payload })
            : await apiPost("/dsh-database/api/profiles", payload);
          // Keep the typed password usable for this session, even when the
          // user chose not to persist it.
          const savedId = body?.profile?.id ?? (editing && editing !== "new" ? editing.id : undefined);
          if (form.password && savedId) setPasswords((prev) => ({ ...prev, [savedId]: form.password }));
          setEditing(null);
          refreshProfiles();
        } catch (error) { setNotice(String(error.message || error)); }
        finally { setBusy(false); }
      }, [editing, refreshProfiles]);

      const panelStyle = {
        display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
        color: "var(--dsw-alias-label-primary)", fontSize: 13,
      };

      return jsx.jsxs("div", { style: { ...panelStyle, height: "100%", position: "relative" }, children: [
        jsx.jsx(ConnectionToast, { toast, t }),
        askPassword ? jsx.jsxs("div", {
          style: {
            position: "absolute", top: 44, right: 12, zIndex: 50, maxWidth: 380,
            padding: "10px 12px", borderRadius: 8,
            background: "var(--dsw-specific-menu, var(--dsw-alias-bg-base))",
            border: "1px solid var(--dsw-alias-border-l2)",
            boxShadow: "var(--dsw-elevation-prominent, 0 4px 16px rgba(0,0,0,.25))",
            display: "flex", flexDirection: "column", gap: 6,
            color: "var(--dsw-alias-label-primary)", fontSize: 12,
          }, children: [
            jsx.jsx("div", { style: { fontWeight: 600 }, children: `🔑 ${t("ask.title")}` }),
            jsx.jsxs("div", { style: { display: "flex", gap: 6 }, children: [
              jsx.jsx("input", {
                type: "password", autoFocus: true, placeholder: t("ask.placeholder"),
                onChange: (e) => { askTextRef.current = e.target.value; },
                onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); submitAskedPassword(); } },
                style: { flex: 1, boxSizing: "border-box", fontSize: 12, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" },
              }),
              jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontWeight: 700 }, onClick: submitAskedPassword, children: t("ask.connect") }),
              jsx.jsx("button", { type: "button", style: btnStyle(), onClick: cancelAskedPassword, children: t("ask.cancel") }),
            ] }),
            jsx.jsx("div", { style: { fontSize: 10.5, color: "var(--dsw-alias-label-caption)" }, children: t("ask.hint") }),
          ],
        }) : null,
        // The designer REPLACES the panel body while open (inline, like the
        // connection form) — an absolute overlay went transparent-glass under
        // translucent theme backgrounds (wallpaper plugin) and visually fused
        // with the tree and SQL editor underneath.
        cellViewer !== null ? jsx.jsx(CellViewer, { value: cellViewer, onClose: () => setCellViewer(null), t }) : null,
        insertRow ? jsx.jsx(InsertRowDialog, { fields: insertRow.fields, onClose: () => setInsertRow(null), onSubmit: async (values) => {
          await apiPost("/dsh-database/api/insert", { id: insertRow.connectionId, database: insertRow.database ?? "", table: insertRow.table, values });
          showToast("ok", "已插入 1 行", insertRow.table);
          setInsertRow(null);
          if (peekState) loadPeekPage(peekState);
        } }) : null,
        er ? jsx.jsx(ErDiagram, { connectionId: er.connectionId, engine: er.engine, database: er.database, onClose: () => setEr(null), t }) : designer ? jsx.jsx(TableDesigner, {
          engine: designer.engine,
          database: designer.database,
          designerTypes,
          editTable: designer.editTable ?? null,
          connectionId: designer.connectionId,
          fkOptions: designerFkOptions,
          ensureLive: ensureLiveById,
          onClose: () => setDesigner(null),
          onCreated: designerCreated,
          onError: (title, detail) => showToast("error", title, detail),
          t,
        }) : jsx.jsxs(react.Fragment, { children: [
        jsx.jsx(Toolbar, {
          t,
          onAdd: () => setEditing("new"),
          onNewTable: () => {
            // Toolbar entry: pre-select the active (or first connected)
            // connection; for engines with several databases the user still
            // picks the exact database via the ＋▦ on its row.
            let profile = profiles.find((p) => p.id === activeId) ?? profiles.find((p) => connected.includes(p.id)) ?? profiles[0];
            if (!profile) { showToast("warn", t("panel.empty")); return; }
            if (!connected.includes(profile.id)) { showToast("warn", t("designer.needConnect")); return; }
            const engine = schemas[profile.id]?.schema?.engine ?? profile.kind;
            const dbs = schemas[profile.id]?.schema?.databases ?? [];
            const single = dbs.length === 1 ? dbs[0].name : (engine === "sqlite" ? "(file)" : null);
            if (engine === "mongodb") { showToast("warn", "MongoDB 无需建表 / MongoDB needs no CREATE TABLE"); return; }
            if (single === null) { showToast("warn", t("designer.pickDatabase")); return; }
            setDesigner({ connectionId: profile.id, database: single, engine });
          },
          onRefresh: () => {
            // Fall back to a connected (then the first) profile instead of
            // nagging "请先在左侧选择一个连接" while a server is visibly open.
            let id = activeId;
            if (!id) id = (profiles.find((p) => connected.includes(p.id)) ?? profiles[0])?.id ?? null;
            if (!id) { showToast("warn", t("schema.noSelection")); return; }
            if (!connected.includes(id)) { showToast("warn", t("schema.notConnected")); return; }
            setActiveId(id);
            loadSchema(id);
          },
        }),
        backendVersion !== null && backendVersion !== CLIENT_VERSION ? jsx.jsx("div", { style: { margin: "6px 8px", padding: "7px 10px", borderRadius: 6, background: "#5a1d1d", color: "#ffc0c0", fontSize: 11.5, lineHeight: "17px" }, children: `⚠ 插件前端已是 ${CLIENT_VERSION}，但 DSH 进程里的后端是 ${backendVersion || "更旧的版本"} — 请完全退出 DSH Desktop 并重新打开，否则新功能会报 405/404` }) : null,
        notice && jsx.jsx("div", { style: { padding: "4px 10px", fontSize: 11.5, color: "#e06c75" }, children: notice }),
        editing && jsx.jsx(ProfileForm, { kinds, initial: editing === "new" ? null : editing, onSaved: saveProfile, onCancel: () => setEditing(null), onTest: doTest, testing, t }),
        jsx.jsxs("div", { style: { display: "flex", flex: 1, minHeight: 0 }, children: [
          // --- left column: ONE tree — connection > database > table > column
          jsx.jsxs("div", { style: { width: 300, flex: "none", display: "flex", flexDirection: "column", borderRight: "1px solid var(--dsw-alias-border-l2)", minHeight: 0 }, children: [
            jsx.jsxs("div", {
              style: {
                flex: "none", display: "flex", alignItems: "center", gap: 6,
                padding: "5px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)",
                fontSize: 11, color: "var(--dsw-alias-label-tertiary)",
              },
              children: [
                jsx.jsx("span", { style: { fontWeight: 700, color: "var(--dsw-alias-label-secondary)" }, children: t("schema.title") }),
                jsx.jsx("span", { children: t("schema.hintExpand") }),
              ],
            }),
            jsx.jsx("div", {
              style: { flex: 1, minHeight: 0, overflow: "auto", padding: "4px 6px" },
              children: profiles.length === 0
                ? jsx.jsx("div", { style: hintStyle(), children: t("panel.empty") })
                : profiles.map((profile) => jsx.jsx(ConnectionNode, {
                    profile,
                    connected: connected.includes(profile.id),
                    active: activeId === profile.id,
                    schema: schemas[profile.id]?.schema,
                    error: schemaErrors[profile.id],
                    loading: loadingSchema[profile.id] === true,
                    onSelect: selectProfile,
                    onConnect: doConnect,
                    onDisconnect: doDisconnect,
                    onDelete: doDelete,
                    onEdit: (p) => setEditing(p),
                    onPeek: peekTable,
                    onNeedSchema: needSchema,
                    onNewTable: openDesigner,
                    onEditTable: openTableEditor,
                    onEr: openEr,
                    t,
                  }, profile.id)),
            }),
          ] }),
          // --- right column: editor + results
          jsx.jsxs("div", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }, children: [
            jsx.jsx(SqlEditor, { onRun: runSql, t, history: sqlHistory }),
            busy && jsx.jsx("div", { style: { padding: 6, fontSize: 11, color: "var(--dsw-alias-label-tertiary)" }, children: "…" }),
            result === null
              ? jsx.jsx("div", { style: { ...hintStyle(), padding: "16px 12px" }, children: t("result.hint") })
              : jsx.jsx(ResultSet, {
                  result: viewMeta && result && !result.error
                    ? { ...result, meta: { editable: viewMeta.pk.length > 0, pk: viewMeta.pk } }
                    : result,
                  t,
                  onCellEdit: handleCellEdit,
                  viewMeta: viewMeta && result && !result.error ? viewMeta : null,
                  onImported: handleImported,
                  peekState: peekState && viewMeta && viewMeta.table === peekState.table ? peekState : null,
                  onSort, onPage, onPageSize, onFilter,
                  onViewer: setCellViewer,
                  onRowDelete: handleRowDelete,
                  onInsertRow: () => { if (viewMeta && result && !result.error) setInsertRow({ connectionId: viewMeta.connectionId, database: viewMeta.database, table: viewMeta.table, fields: result.fields ?? [] }); },
                }),
          ] }),
        ] }),
        ] }),
      ] });
    }

    // ---------------------------------------------------------------------
    // Plugin application: register the third Conversation view.
    //
    // Fault isolation: NOTHING here may throw. A plugin failure inside the
    // client boot degrades to a console warning — it must never wedge the
    // page (that is what took the Desktop app down on 2026-09-30).
    // ---------------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-database: dictionaries");
      const t = ctx.locale.bind(NS);

      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: VIEW_ID,
        order: VIEW_ORDER,
        locale: NS,
        label: () => t("view.database"),
      }, DatabasePanel));
    }

    /** apply() guarded: log and continue instead of rejecting the boot. */
    exports.apply = function applyGuarded(ctx) {
      try {
        apply(ctx);
      } catch (error) {
        console.warn("[dsh-database] activation failed — the Database tab stays unavailable, the app is unaffected:", error);
      }
    };
    // Service keys ONLY (see package.json `dsh.client.inject` for packages).
    exports.inject = ["slots", "locale"];
    exports.name = "dsh-database-explorer";
    // Sub-components exposed for the offline render test, which executes these
    // bodies with a hook shim to catch render-time failures (a temporal-dead-zone
    // dependency array once shipped a blank panel). Not consumed by the host.
    exports.__test__ = { DatabaseView, DatabasePanel, PanelBoundary, ProfileForm, ProfileRow, ConnectionToast, ResultSet, ConnectionNode, DatabaseNode, TableNode, TreeRow, TableDesigner, ImportButton, qualifiedName, quoteFor, api };
    return module.exports;
  },
});
