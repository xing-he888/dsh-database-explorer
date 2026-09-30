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
  id: "dsh-database",
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
    };

    // ---------------------------------------------------------------------
    // Small components
    // ---------------------------------------------------------------------
    function Toolbar({ onAdd, onRefresh, t }) {
      return jsx.jsxs("div", {
        style: { display: "flex", gap: 6, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--dsw-alias-border-l2)" },
        children: [
          jsx.jsx("button", {
            type: "button", onClick: onAdd, title: t("conn.add"),
            style: btnStyle(),
            children: "+",
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
        rememberPassword: false,
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
    function ConnectionNode({ profile, connected, active, schema, error, loading, onSelect, onConnect, onDisconnect, onDelete, onEdit, onPeek, onNeedSchema, t }) {
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
            t,
          }, db.name)),
        ] }),
      ] });
    }

    function DatabaseNode({ database, engine, open, onToggle, onPeek, t }) {
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
        }),
        open && jsx.jsx("div", { children:
          tables.length === 0
            ? jsx.jsx("div", { style: { ...hintStyle(), paddingLeft: 4 + INDENT * 3 }, children: t("schema.emptyDatabase") })
            : tables.map((table) => jsx.jsx(TableNode, { table, engine, database: database.name, onPeek, t }, database.name + "/" + table.name)) }),
      ] });
    }

    function TableNode({ table, engine, database, onPeek, t }) {
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
          trailing: jsx.jsx("button", {
            type: "button", title: t("select.table"), style: { ...btnStyle(), fontSize: 10, padding: "0 5px", flex: "none" },
            onClick: (e) => { e.stopPropagation(); onPeek(table); },
            children: "⤚",
          }),
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
     * The result grid. When the query came from a table peek (meta carries
     * table/database/column info), cells become double-click editable: an
     * inline input posts to /update, the host builds a PK-addressed
     * parameterized UPDATE, and the query re-runs so the grid shows the saved
     * state. Editing is refused for tables without a PK with a clear message.
     */
    function ResultSet({ result, t, onCellEdit }) {
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
      return jsx.jsxs("div", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }, children: [
        jsx.jsxs("div", { style: { padding: "4px 8px", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", borderBottom: "1px solid var(--dsw-alias-border-l2)", display: "flex", gap: 10 }, children: [
          jsx.jsx("span", { children: `${result.rowCount} ${t("sql.rows")} · ${result.ms ?? "?"}${t("sql.ms")}${result.truncated ? " · " + t("sql.truncated") : ""}` }),
          editable ? jsx.jsx("span", { children: "✏️ " + t("cell.editHint") }) : null,
        ] }),
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
      /** profileId -> password typed this session. Memory only: never persisted
       *  by the browser half (the host stores an opted-in password instead). */
      const [passwords, setPasswords] = react.useState({});
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

      const doConnect = react.useCallback(async (profile) => {
        setBusy(true); setNotice(null);
        const started = Date.now();
        try {
          const body = await apiPost("/dsh-database/api/connect", { id: profile.id, password: passwords[profile.id] });
          setConnected((prev) => prev.includes(profile.id) ? prev : [...prev, profile.id]);
          setActiveId(profile.id);
          loadSchema(profile.id);
          showToast("ok", `${t("toast.connected")} · ${profile.name}`,
            `${body.server ? body.server + " · " : ""}${Date.now() - started}${t("sql.ms")}${body.reused ? " · (cached)" : ""}`);
          return true;
        } catch (error) {
          showToast("error", `${t("toast.connectFailed")} · ${profile.name}`, String(error.message || error));
          return false;
        } finally { setBusy(false); }
      }, [loadSchema, passwords, showToast, t]);

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
        if (!connected.includes(id)) {
          const profile = profiles.find((p) => p.id === id);
          if (profile) {
            const ok = await doConnect(profile);
            if (!ok) return;
          }
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
      }, [schemas, activeId, connected, profiles, runSql, doConnect]);

      /** Double-click cell edit: host builds a PK-addressed parameterized
       *  UPDATE, then the grid re-queries so it shows the saved state. */
      const handleCellEdit = react.useCallback(async ({ column, pk, value }) => {
        if (!viewMeta) return;
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
        jsx.jsx(Toolbar, {
          t,
          onAdd: () => setEditing("new"),
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
                }),
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
    exports.name = "dsh-database";
    // Sub-components exposed for the offline render test, which executes these
    // bodies with a hook shim to catch render-time failures (a temporal-dead-zone
    // dependency array once shipped a blank panel). Not consumed by the host.
    exports.__test__ = { DatabaseView, DatabasePanel, PanelBoundary, ProfileForm, ProfileRow, ConnectionToast, ResultSet, ConnectionNode, DatabaseNode, TableNode, TreeRow, qualifiedName, quoteFor, api };
    return module.exports;
  },
});
