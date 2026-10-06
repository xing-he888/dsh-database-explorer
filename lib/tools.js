/**
 * dsh-database — agent 工具注册（v0.9.17）。
 *
 * 把连接管理器的操作以宿主原生工具（ctx.tools.register + defineTool）暴露给
 * DSH 的 agent：聊天会话里模型直接调用，dsh-agent-tool-presentation 渲染调用
 * 流程。这是官方 user-actions.md 的「一个操作、两个调用方」模式——工具与面板
 * 共用同一套 manager 方法，不另立业务逻辑。
 *
 * 分级（授权类动作保持 user-only 的官方原则）：
 *   只读层（始终注册） list_connections / connect / schema / peek_page / er_graph
 *   写入层（默认关闭）  query / update_cell / insert_row / delete_row
 * 写入层仅当 plugin-data 目录存在 agent-write-tools 标记文件时注册——写权限
 * 由用户显式授予，模型不可自授。
 *
 * defineTool 解析：优先裸说明符（插件加载器的 internal.import 通常解析到宿主
 * 安装目录）；失败后从 process.execPath 旁的 app.asar require(esm) 兜底
 * （Electron 支持读 asar，Node 24 支持 require(esm)）。两者都失败则跳过注册
 * ——面板功能不受影响，仅告警。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 工具结果进入模型上下文：超长应答截断，防止撑爆会话。 */
const MAX_OUTPUT_CHARS = 20000;
/** 工具层单次返回的行数上限（分页服务端白名单之上再收紧）。 */
const TOOL_PAGE_SIZE_CAP = 100;

/** 超长 JSON 截断为预览，同时保留类型标记方便模型理解。 */
function capOutput(value) {
  const s = JSON.stringify(value);
  if (s.length <= MAX_OUTPUT_CHARS) return value;
  return { truncated: true, note: `结果超长（${s.length} 字符），仅返回预览`, preview: s.slice(0, MAX_OUTPUT_CHARS) + '…' };
}

function capRows(rows, cap = 1000) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length > cap ? { truncated: true, rows: list.slice(0, cap) } : { rows: list };
}

/** 写工具开关：plugin-data 目录下的标记文件（用户显式创建 = 授予写权限）。 */
function writeToolsEnabled(dataDir) {
  return existsSync(join(dataDir, 'agent-write-tools'));
}

async function loadDefineTool() {
  try {
    const m = await import('@deepseek-ai/dsh-tools');
    if (typeof m.defineTool === 'function') return m;
  } catch { /* 裸说明符解析失败：走宿主安装目录兜底 */ }
  // 兜底序列：宿主进程内（Electron fs 能读 asar、Node 24 能 require(esm)）
  // 依次尝试 asar 与 asar.unpacked；全失败则抛错——调用方（index.js）只告警
  // 降级，面板不受影响。普通 Node 下 asar 不可读属预期，等真实宿主环境验证。
  const exeDir = dirname(process.execPath);
  const roots = [
    join(exeDir, 'resources', 'app.asar', 'dsh', 'node_modules'),
    join(exeDir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules'),
  ];
  const require = createRequire(import.meta.url);
  let lastError;
  for (const root of roots) {
    try {
      const m = require(join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'));
      if (typeof m.defineTool === 'function') return m;
    } catch (e) { lastError = e; }
  }
  throw new Error(`dsh-tools 加载失败（裸说明符与宿主目录兜底均失败）：${lastError?.message || '未知错误'}`);
}

/** 简洁的会话渲染：只报计数与定位，不把数据值重复铺进聊天流。 */
const renderText = (fn) => ({ output: { schema: { type: 'json' }, render: fn } });

/**
 * 注册全部 agent 工具。ctx 需提供 tools 服务（ctx.inject(['tools']) 后传入）；
 * deps.defineTool 可注入替身（回归测试用）。
 */
export async function registerAgentTools(ctx, manager, dataDir, deps = {}) {
  const defineTool = deps.defineTool ?? (await loadDefineTool()).defineTool;
  const write = deps.writeToolsEnabled ?? writeToolsEnabled(dataDir);
  const registered = [];

  const tool = (def) => defineTool(def);

  // ---- 只读层 ----------------------------------------------------------
  registered.push(tool({
    name: 'db_list_connections',
    description: '列出数据库面板中已保存的连接（含连接状态、引擎、主机；不含任何密码）。先用它拿到 connectionId。',
    parameters: {},
    ...renderText((_args, v) => (v?.truncated ? '结果已截断' : `${v.profiles.length} 个连接，其中 ${v.connected.length} 个已连接`)),
    execute: async () => capOutput({ profiles: manager.listProfiles(), connected: manager.connectedIds() }),
  }));

  registered.push(tool({
    name: 'db_connect',
    description: '打开一个已保存的数据库连接（使用面板已记住的密码，不需要也不能传密码）。',
    parameters: { id: { type: 'string', required: true, description: 'db_list_connections 返回的 connectionId' } },
    ...renderText((_args, v) => `已连接 ${v.name ?? v.id}`),
    execute: async ({ id }) => {
      const { profile, reused } = await manager.connect(id);
      return capOutput({ ok: true, id: profile.id, name: profile.name, kind: profile.kind, reused: reused === true });
    },
  }));

  registered.push(tool({
    name: 'db_schema',
    description: '读取一个连接的库/表/列结构树。depth=tables 只列库和表名（大库先用它），depth=columns 返回完整列定义。',
    parameters: {
      id: { type: 'string', required: true, description: 'connectionId' },
      depth: { type: 'string', description: '"columns"（默认，含列）或 "tables"（仅表清单）' },
    },
    ...renderText((_args, v) => {
      if (v?.truncated) return '结果已截断';
      const t = (v.databases ?? []).reduce((n, d) => n + (d.tables?.length ?? 0), 0);
      return `${(v.databases ?? []).length} 个库 · ${t} 张表`;
    }),
    execute: async ({ id, depth }) => {
      const tree = await manager.schema(id);
      if (depth === 'tables') {
        return capOutput({ engine: tree.engine, databases: (tree.databases ?? []).map((d) => ({ name: d.name, tables: (d.tables ?? []).map((t) => t.name) })) });
      }
      return capOutput(tree);
    },
  }));

  registered.push(tool({
    name: 'db_peek_page',
    description: '分页读取一张表的数据（服务端 LIMIT/OFFSET + 排序 + 过滤，值全部参数化）。pageSize 上限 100。',
    parameters: {
      id: { type: 'string', required: true, description: 'connectionId' },
      database: { type: 'string', description: '库名/schema（sqlite 留空）' },
      table: { type: 'string', required: true, description: '表名' },
      page: { type: 'number', description: '页码，从 1 开始' },
      pageSize: { type: 'number', description: '每页行数（≤100，默认 20）' },
    },
    ...renderText((_args, v) => (v?.truncated ? '结果已截断' : `第 ${v.page} 页 · 共 ${v.total} 行`)),
    execute: async ({ id, database, table, page, pageSize }) => {
      // 服务端分页白名单为 [10,50,100,200,500,1000]——工具层取 ≥ 请求值的最小档，
      // 封顶 100（模型上下文有限），避免白名单回落到 200
      const requested = Math.min(Math.max(Number(pageSize) || 20, 1), TOOL_PAGE_SIZE_CAP);
      const sized = [10, 50, 100].find((v) => v >= requested) ?? 100;
      const r = await manager.peekPage({
        id, database: database || '', table,
        page: Math.max(1, Math.min(Number(page) || 1, 100000)),
        pageSize: sized,
      });
      const capped = capRows(r.rows);
      return capOutput({ ...r, rows: capped.rows, rowsTruncated: capped.truncated || undefined });
    },
  }));

  registered.push(tool({
    name: 'db_er_graph',
    description: '读取一个库的 E-R 关系数据（表/列/主键/外键边 + 命名推断关系），用于回答数据模型问题。',
    parameters: {
      id: { type: 'string', required: true, description: 'connectionId' },
      database: { type: 'string', description: '库名/schema（sqlite 留空）' },
    },
    ...renderText((_args, v) => (v?.truncated ? '结果已截断' : `${v.tables.length} 张表 · ${v.edges.length} 条关系线`)),
    execute: async ({ id, database }) => capOutput(await manager.erGraph({ id, database })),
  }));

  // ---- 写入层（标记文件存在才注册）--------------------------------------
  if (write) {
    registered.push(tool({
      name: 'db_query',
      description: '在指定连接上执行任意 SQL（含 UPDATE/DELETE/DDL！）。先 db_schema 了解结构；结果行数超 1000 会截断。',
      parameters: {
        id: { type: 'string', required: true, description: 'connectionId' },
        sql: { type: 'string', required: true, description: '要执行的 SQL（多语句按引擎语义支持）' },
      },
      ...renderText((_args, v) => (v.rows?.length ? `${v.rows.length} 行结果` : `${v.affectedRows ?? 0} 行受影响`)),
      execute: async ({ id, sql }) => {
        const handle = manager.liveHandle(id);
        if (!handle) throw new Error('连接未打开：请先 db_connect');
        const r = await handle.query(String(sql || ''));
        const capped = capRows(r.rows);
        return capOutput({ ...r, rows: capped.rows, rowsTruncated: capped.truncated || undefined });
      },
    }));

    registered.push(tool({
      name: 'db_update_cell',
      description: '按主键更新一个单元格（参数化 UPDATE，必须精确定位一行）。',
      parameters: {
        id: { type: 'string', required: true, description: 'connectionId' },
        table: { type: 'string', required: true, description: '表名' },
        database: { type: 'string', description: '库名/schema（sqlite 留空）' },
        column: { type: 'string', required: true, description: '要更新的列名' },
        pk: { type: 'string', required: true, description: '主键定位 JSON，如 [{"column":"id","value":3}]' },
        value: { type: 'string', description: '新值（null 表示清空）' },
      },
      ...renderText((args, v) => `${args.column} 已更新（${v.affectedRows} 行）`),
      execute: async ({ id, table, database, column, pk, value }) => {
        let parsedPk;
        try { parsedPk = JSON.parse(pk); } catch { throw new Error('pk 不是合法 JSON：需要 [{"column":"id","value":3}]'); }
        const r = await manager.updateCell({ id, table, database: database || undefined, column, pk: parsedPk, value: value === null ? null : value });
        return capOutput(r);
      },
    }));

    registered.push(tool({
      name: 'db_insert_row',
      description: '向表插入一行（列名经表结构白名单校验，值全部参数化；空串视为 NULL）。',
      parameters: {
        id: { type: 'string', required: true, description: 'connectionId' },
        table: { type: 'string', required: true, description: '表名' },
        database: { type: 'string', description: '库名/schema（sqlite 留空）' },
        values: { type: 'string', required: true, description: '行数据 JSON，如 {"name":"alice","score":9}' },
      },
      ...renderText((_args, v) => `已插入 ${v.inserted} 列`),
      execute: async ({ id, table, database, values }) => {
        let parsed;
        try { parsed = JSON.parse(values); } catch { throw new Error('values 不是合法 JSON 对象'); }
        return capOutput(await manager.insertRow({ id, table, database: database || undefined, values: parsed }));
      },
    }));

    registered.push(tool({
      name: 'db_delete_row',
      description: '按主键删除一行（参数化 DELETE，影响行数必须恰为 1）。',
      parameters: {
        id: { type: 'string', required: true, description: 'connectionId' },
        table: { type: 'string', required: true, description: '表名' },
        database: { type: 'string', description: '库名/schema（sqlite 留空）' },
        pk: { type: 'string', required: true, description: '主键定位 JSON，如 [{"column":"id","value":3}]' },
      },
      ...renderText((_args, v) => `已删除 ${v.deleted} 行`),
      execute: async ({ id, table, database, pk }) => {
        let parsedPk;
        try { parsedPk = JSON.parse(pk); } catch { throw new Error('pk 不是合法 JSON：需要 [{"column":"id","value":3}]'); }
        return capOutput(await manager.deleteRow({ id, table, database: database || undefined, pk: parsedPk }));
      },
    }));
  }

  ctx.effect(function* () {
    for (const def of registered) yield ctx.tools.register(def);
  }, 'dsh-database.agentTools');

  return { registered: registered.map((d) => d.name), writeTools: write };
}
