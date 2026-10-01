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
    const VIEW_ID = "database";
    const VIEW_ORDER = 20; // chat=0, trajectory=10, database=20

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
            placeholder: isSqlite ? "C:\\data\\app.db" : isMongo ? "admin" : "" }),
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
    function ConnectionNode({ profile, connected, active, schema, error, loading, onSelect, onConnect, onDisconnect, onDelete, onEdit, onPeek, onNeedSchema, onNewTable, onEditTable, t }) {
      const [open, setOpen] = react.useState(false);
      const [openDatabases, setOpenDatabases] = react.useState({});

      const toggle = () => {
        const next = !open;
        setOpen(next);
        onSelect(profile);
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
            t,
          }, db.name)),
        ] }),
      ] });
    }

    function DatabaseNode({ database, engine, open, onToggle, onPeek, onNewTable, onEditTable, t }) {
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
          trailing: onNewTable ? jsx.jsx("button", {
            type: "button", title: t("designer.newTable"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
            onClick: (e) => { e.stopPropagation(); onNewTable(); },
            children: "＋▦",
          }) : null,
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

    function SqlEditor({ onRun, t }) {
      const [value, setValue] = react.useState("");
      const run = react.useCallback(() => onRun(value), [value, onRun]);
      return jsx.jsxs("div", { style: { display: "flex", flexDirection: "column", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children: [
        jsx.jsx("textarea", {
          value, onChange: (e) => setValue(e.target.value),
          onKeyDown: (e) => {
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
        jsx.jsx("div", { style: { display: "flex", justifyContent: "flex-end", padding: "4px 8px", borderTop: "1px solid var(--dsw-alias-border-l2)" }, children:
          jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontWeight: 600 }, onClick: run, children: t("sql.run") }) }),
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
          const body = await apiPost("/dsh-database/api/designer/create-table", { database, ...draft, dryRun: true });
          setSqlPreview(body.sql ?? "");
        } catch (error) {
          setSqlPreview(String(error.message || error));
        }
      }, [isEdit, database, tableName, columns, dropSet]); // eslint-disable-line react-hooks/exhaustive-deps

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
          const body = await postWithHeal("/dsh-database/api/designer/create-table", { database, ...draft });
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
        reader.onload = () => setFileText(String(reader.result ?? ""));
        reader.onerror = () => setError(t("import.readFailed"));
        reader.readAsText(file, "utf-8");
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
        jsx.jsxs("select", { style: { ...inputStyle, fontSize: 10.5 }, value: format, onChange: (e) => setFormat(e.target.value), children: [
          jsx.jsx("option", { value: "csv", children: "CSV" }),
          jsx.jsx("option", { value: "json", children: "JSON" }),
        ] }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: () => fileRef.current?.click(), title: t("import.pickFile"), children: fileName ? `📄 ${fileName}` : "📁…" }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5, fontWeight: 700 }, disabled: busy || !fileText, onClick: run, children: busy ? "…" : t("import.run") }),
        jsx.jsx("button", { type: "button", style: { ...btnStyle(), fontSize: 10.5 }, onClick: () => setOpen(false), children: "✕" }),
        jsx.jsx("input", { ref: fileRef, type: "file", accept: ".csv,.txt,.json", style: { display: "none" }, onChange: pick }),
        error ? jsx.jsx("span", { style: { color: "#e06c75", fontSize: 10.5, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: error, children: error }) : null,
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
    function ResultSet({ result, t, onCellEdit, viewMeta, onImported }) {
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
      const [exporting, setExporting] = react.useState(false);
      const [exportError, setExportError] = react.useState(null);

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
          jsx.jsx("span", { children: `${result.rowCount} ${t("sql.rows")} · ${result.ms ?? "?"}${t("sql.ms")}${result.truncated ? " · " + t("sql.truncated") : ""}` }),
          editable ? jsx.jsx("span", { children: "✏️ " + t("cell.editHint") }) : null,
          transfer ? jsx.jsxs("span", { style: { display: "flex", gap: 4, marginLeft: "auto", alignItems: "center" }, children: [
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("csv"), children: "⤓ CSV" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("json"), children: "⤓ JSON" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("sql"), title: t("export.sql") + " (CREATE + INSERT)", children: "⤓ SQL" }),
            jsx.jsx("button", { type: "button", disabled: exporting, style: { ...btnStyle(), fontSize: 10.5, opacity: exporting ? 0.5 : 1 }, onClick: () => exportTable("sql-structure"), title: t("export.structure"), children: "⤓ " + t("export.structure") }),
            jsx.jsx(ImportButton, { transfer, t, onImported }),
          ] }) : null,
        ] }),
        exportError ? jsx.jsx("div", { style: { padding: "4px 10px", fontSize: 11.5, color: "#e06c75", borderBottom: "1px solid var(--dsw-alias-border-l2)", whiteSpace: "pre-wrap" }, children: `${t("export.failed")}: ${exportError}` }) : null,
        jsx.jsx("div", { style: { flex: 1, overflow: "auto" }, children: jsx.jsxs("table", {
          style: { borderCollapse: "collapse", fontSize: 11.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
          children: [
            jsx.jsx("thead", { children: jsx.jsx("tr", { children: result.fields.map((f, i) => jsx.jsx("th", {
              style: { textAlign: "left", padding: "3px 8px", borderBottom: "1px solid var(--dsw-alias-border-l2)", position: "sticky", top: 0, background: "var(--dsw-alias-bg-base)", zIndex: 1, fontWeight: 600 },
              children: f.name + (pkColumns.includes(f.name) ? " 🗝" : ""),
            }, `${f.name}-${i}`)) }) }),
            jsx.jsx("tbody", { children: result.rows.map((row, r) => jsx.jsx("tr", {
              children: result.fields.map((f, i) => jsx.jsx(EditableCell, {
                value: row[f.name], column: f.name, row, pkOf, editable, onCellEdit, t,
              }, `${r}-${i}`)),
            }, r)) }),
          ],
        }) }),
      ] });
    }

    function EditableCell({ value, column, row, pkOf, editable, onCellEdit, t }) {
      const [editing, setEditing] = react.useState(false);
      const [draft, setDraft] = react.useState(null);
      const display = formatCell(value);
      if (!editable) {
        return jsx.jsx("td", {
          style: { padding: "2px 8px", borderBottom: "1px solid var(--dsw-alias-border-l3, transparent)", whiteSpace: "nowrap", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", color: "var(--dsw-alias-label-secondary)" },
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
      return jsx.jsx("td", {
        style: { padding: editing ? 0 : "2px 8px", borderBottom: "1px solid var(--dsw-alias-border-l3, transparent)", whiteSpace: "nowrap", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", color: "var(--dsw-alias-label-secondary)", cursor: "cell" },
        onDoubleClick: editing ? undefined : start,
        children: editing ? jsx.jsx("input", {
          autoFocus: true,
          value: draft,
          onChange: (e) => setDraft(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => {
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
        apiGet("/dsh-database/api/kinds").then((body) => setKinds(body.kinds)).catch(() => setKinds({ sqlite: { label: "SQLite", defaultPort: null }, mysql: { label: "MySQL", defaultPort: 3306 }, postgres: { label: "PostgreSQL", defaultPort: 5432 } }));
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
       */
      const askForPassword = react.useCallback((profileId) => new Promise((resolve) => {
        askTextRef.current = "";
        askResolveRef.current = resolve;
        setAskPassword({ profileId });
      }), []);

      const submitAskedPassword = react.useCallback(() => {
        const value = askTextRef.current;
        const resolver = askResolveRef.current;
        setAskPassword(null);
        askResolveRef.current = null;
        if (resolver) resolver(value);
      }, [ ]);

      const cancelAskedPassword = react.useCallback(() => {
        const resolver = askResolveRef.current;
        setAskPassword(null);
        askResolveRef.current = null;
        if (resolver) resolver(null);
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
          // next app start (the stored value wins until edited in the form).
          if (!body.passwordSaved && typedNow && !profile.hasPassword) {
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
      const withReconnect = react.useCallback(async (profileId, operation) => {
        const runOp = () => operation();
        try {
          return await runOp();
        } catch (error) {
          const message = String(error?.message || error);
          if (!/连接未打开|connection is not open/i.test(message)) throw error;
          const profile = profiles.find((p) => p.id === profileId);
          if (!profile) throw error;
          const ok = await doConnect(profile, { force: true, silent: true });
          if (!ok) throw error;
          return await runOp();
        }
      }, [profiles, doConnect]);

      const doDisconnect = react.useCallback(async (profile) => {
        await apiPost("/dsh-database/api/disconnect", { id: profile.id }).catch(() => {});
        setConnected((prev) => prev.filter((id) => id !== profile.id));
        setSchemas((prev) => { const next = { ...prev }; delete next[profile.id]; return next; });
        setSchemaErrors((prev) => { const next = { ...prev }; delete next[profile.id]; return next; });
        if (activeId === profile.id) setResult(null);
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
        if (connected.includes(profile.id) && schemas[profile.id] === undefined) await loadSchema(profile.id);
      }, [connected, loadSchema, schemas]);

      const runSql = react.useCallback(async (sql, targetId = undefined) => {
        const id = targetId ?? activeId;
        if (!id) { setNotice("请先选择并连接一个数据库"); return false; }
        setBusy(true); setNotice(null);
        try {
          const body = await apiPost("/dsh-database/api/query", { id, sql });
          setResult(body);
          return true;
        } catch (error) {
          setResult({ error: String(error.message || error) });
          return false;
        } finally { setBusy(false); }
      }, [activeId]);

      /** Peek a table: build a SELECT for the engine and the owning database.
       *  Carries the table's own connection (tree row click → peek must work
       *  even when the click did not change the active selection first), and
       *  auto-connects a saved profile that is still offline. */
      const peekTable = react.useCallback(async (table, database, profileId = undefined) => {
        let id = profileId ?? activeId;
        if (!id) { setNotice("请先选择并连接一个数据库"); return; }
        // Always verify through the host, same as the designer entries: the
        // browser-side `connected` array goes stale after a host restart.
        {
          const profile = profiles.find((p) => p.id === id);
          if (profile && !(await doConnect(profile))) return;
        }
        setActiveId(id);
        const engine = schemas[id]?.schema?.engine;
        const qualified = qualifiedName(engine, database, table.name);
        // PK columns make the grid editable: the host addresses the exact row
        // through them. No PK → read-only grid (the host would refuse anyway).
        const pk = (table.columns ?? []).filter((c) => c.key === "PRI" || c.key === "PK").map((c) => c.name);
        setViewMeta(engine === "mongodb" ? null : { connectionId: id, engine, database, table: table.name, pk });
        // No LIMIT on the peek: clicking a table means "show me the data".
        // The host still caps the wire payload (QUERY_ROW_CAP) and reports the
        // cut via `truncated`, so a huge table cannot freeze the tab.
        const sql = engine === "mssql" ? `SELECT * FROM ${qualified}`
          : engine === "mongodb" ? JSON.stringify({ database, collection: table.name, command: "find", limit: 10000 })
            : `SELECT * FROM ${qualified}`;
        const okRun = await runSql(sql, id);
        if (!okRun) setViewMeta(null);
      }, [schemas, activeId, profiles, runSql, doConnect]);

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
          const qualified = qualifiedName(viewMeta.engine, viewMeta.database, viewMeta.table);
          await apiPost("/dsh-database/api/query", { id: viewMeta.connectionId, sql: `SELECT * FROM ${qualified}` })
            .then((body) => setResult(body))
            .catch(() => {});
        } catch (error) {
          showToast("error", t("edit.failed"), String(error.message || error));
        } finally { setBusy(false); }
      }, [viewMeta, showToast, t]);

      /** Import finished: toast the count, then reload the table grid and the
       *  tree row counts so what the user sees matches the server. */
      const handleImported = react.useCallback(async (body) => {
        const meta = viewMeta;
        showToast("ok", t("import.done"), `${body?.inserted ?? "?"} / ${body?.total ?? "?"}`);
        if (!meta) return;
        const qualified = qualifiedName(meta.engine, meta.database, meta.table);
        await apiPost("/dsh-database/api/query", { id: meta.connectionId, sql: `SELECT * FROM ${qualified}` })
          .then((res) => setResult(res))
          .catch(() => {});
        loadSchema(meta.connectionId);
      }, [viewMeta, showToast, t, loadSchema]);

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
        designer ? jsx.jsx(TableDesigner, {
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
                    t,
                  }, profile.id)),
            }),
          ] }),
          // --- right column: editor + results
          jsx.jsxs("div", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }, children: [
            jsx.jsx(SqlEditor, { onRun: runSql, t }),
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
