#!/usr/bin/env node
/**
 * dsh-database — MCP stdio server（v0.9.21，AI 原生 ⑦）。
 *
 * 把连接管理器以 MCP（Model Context Protocol）工具的形式暴露给任意外部
 * AI 客户端（Claude Desktop / Cursor / 任何支持 MCP 的宿主）——与面板、
 * agent 工具共用同一个 ConnectionManager 和同一份 connections.json，
 * 不另立业务逻辑。零依赖：stdio 上按行分隔的 JSON-RPC 2.0，MCP 协议子集
 * （initialize / tools/list / tools/call / ping）。
 *
 * 用法：在 MCP 客户端里注册
 *   { "command": "node", "args": ["<本文件绝对路径>"], "env": { "DSH_HOME": "可选" } }
 * 连接档案与 DSH 面板共享（DSH_HOME 或 ~/.dsh）。
 *
 * 安全模型与面板 agent 工具一致：
 *   - 只读工具常驻：list_connections / connect / schema / describe_table /
 *     peek_page / er_graph
 *   - 写工具（query / update_cell / insert_row / delete_row）仅当 plugin-data
 *     目录存在 agent-write-tools 标记文件时暴露——模型不可自授
 *   - 只读连接（readOnly）的语句预检在 manager.runQuery 内同样生效
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createConnectionManager } from './connections.js';

const SERVER = { name: 'dsh-database-explorer', version: '0.9.21' };
const MAX_OUTPUT_CHARS = 20000;
const TOOL_PAGE_SIZE_CAP = 100;
const MAX_ROWS = 1000;

function dataDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const dir = join(home, 'plugin-data', 'dsh-database-explorer');
  mkdirSync(dir, { recursive: true });
  return dir;
}

let manager = null;
function getManager() {
  if (!manager) manager = createConnectionManager(dataDir());
  return manager;
}

function writeEnabled() {
  return existsSync(join(dataDir(), 'agent-write-tools'));
}

/** 超长 JSON 截断（与 agent 工具同策略）。 */
function capOutput(value) {
  const s = JSON.stringify(value);
  if (s.length <= MAX_OUTPUT_CHARS) return value;
  return { truncated: true, note: `结果超长（${s.length} 字符），仅返回预览`, preview: s.slice(0, MAX_OUTPUT_CHARS) + '…' };
}

function capRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.length > MAX_ROWS ? { truncated: true, rows: list.slice(0, MAX_ROWS) } : { rows: list };
}

// ---------------------------------------------------------------------------
// 工具定义：inputSchema 用 MCP 要求的 JSON Schema 形态
// ---------------------------------------------------------------------------

const READ_TOOLS = [
  {
    name: 'db_list_connections',
    description: '列出数据库面板中已保存的连接（含连接状态、引擎、主机；不含任何密码）。先用它拿到 connectionId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => capOutput({ profiles: getManager().listProfiles(), connected: getManager().connectedIds() }),
  },
  {
    name: 'db_connect',
    description: '打开一个已保存的数据库连接（使用面板已记住的密码，不能传密码）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'connectionId' } }, required: ['id'], additionalProperties: false },
    execute: async ({ id }) => {
      const { profile, reused } = await getManager().connect(id);
      return { ok: true, id: profile.id, name: profile.name, kind: profile.kind, readOnly: profile.readOnly === true, reused: reused === true };
    },
  },
  {
    name: 'db_schema',
    description: '读取一个连接的库/表/列结构树。depth=tables 只列库和表名（大库先用它），depth=columns 返回完整列定义。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'connectionId' }, depth: { type: 'string', description: '"tables" 或 "columns"（默认）' } },
      required: ['id'], additionalProperties: false,
    },
    execute: async ({ id, depth }) => {
      const tree = await getManager().schema(id);
      if (depth === 'tables') {
        return capOutput({ engine: tree.engine, databases: (tree.databases ?? []).map((d) => ({ name: d.name, tables: (d.tables ?? []).map((t) => t.name) })) });
      }
      return capOutput(tree);
    },
  },
  {
    name: 'db_describe_table',
    description: '读取一张表的列结构（列名/类型/可空/主键/默认值）。大库请先 db_schema depth=tables。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'connectionId' }, table: { type: 'string', description: '表名' }, database: { type: 'string', description: '库名/schema' } },
      required: ['id', 'table'], additionalProperties: false,
    },
    execute: async ({ id, table, database }) => capOutput(await getManager().describeTable({ id, table, database })),
  },
  {
    name: 'db_peek_page',
    description: '分页读取一张表的数据（服务端 LIMIT/OFFSET + 排序 + 过滤，值全部参数化）。pageSize 上限 100。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'connectionId' },
        table: { type: 'string', description: '表名' },
        database: { type: 'string', description: '库名/schema（sqlite 留空）' },
        page: { type: 'number', description: '页码，从 1 开始' },
        pageSize: { type: 'number', description: '每页行数（≤100，默认 20）' },
      },
      required: ['id', 'table'], additionalProperties: false,
    },
    execute: async ({ id, table, database, page, pageSize }) => {
      const requested = Math.min(Math.max(Number(pageSize) || 20, 1), TOOL_PAGE_SIZE_CAP);
      const sized = [10, 50, 100].find((v) => v >= requested) ?? 100;
      const r = await getManager().peekPage({ id, database: database || '', table, page: Math.max(1, Math.min(Number(page) || 1, 100000)), pageSize: sized });
      const capped = capRows(r.rows);
      return capOutput({ ...r, rows: capped.rows, rowsTruncated: capped.truncated || undefined });
    },
  },
  {
    name: 'db_er_graph',
    description: '读取一个库的 E-R 关系数据（表/列/主键/外键边 + 命名推断关系）。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'connectionId' }, database: { type: 'string', description: '库名/schema（sqlite 留空）' } },
      required: ['id'], additionalProperties: false,
    },
    execute: async ({ id, database }) => capOutput(await getManager().erGraph({ id, database })),
  },
];

const WRITE_TOOLS = [
  {
    name: 'db_query',
    description: '在指定连接上执行 SQL（含 UPDATE/DELETE/DDL！）。只读连接（readOnly）仅允许读语句。写语句建议先 dryRun。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'connectionId' }, sql: { type: 'string', description: '要执行的 SQL' }, dryRun: { type: 'boolean', description: '仅解释/编译不执行（EXPLAIN / SET NOEXEC）' } },
      required: ['id', 'sql'], additionalProperties: false,
    },
    execute: async ({ id, sql, dryRun }) => {
      const r = await getManager().runQuery(id, String(sql || ''), undefined, { source: 'mcp', dryRun: dryRun === true });
      if (dryRun === true) return capOutput({ dryRun: true, plan: r.rows ?? [] });
      const capped = capRows(r.rows);
      return capOutput({ ...r, rows: capped.rows, rowsTruncated: capped.truncated || undefined });
    },
  },
  {
    name: 'db_update_cell',
    description: '按主键更新一个单元格（参数化 UPDATE，必须精确定位一行）。value 传 null 表示清空。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'connectionId' },
        table: { type: 'string', description: '表名' },
        database: { type: 'string', description: '库名/schema' },
        column: { type: 'string', description: '列名' },
        pk: { type: 'array', description: '主键定位，如 [{"column":"id","value":3}]', items: { type: 'object', properties: { column: { type: 'string' }, value: {} }, required: ['column', 'value'] } },
        value: { type: ['string', 'null'], description: '新值；null 表示清空' },
      },
      required: ['id', 'table', 'column', 'pk', 'value'], additionalProperties: false,
    },
    execute: async ({ id, table, database, column, pk, value }) => capOutput(await getManager().updateCell({ id, table, database, column, pk, value, source: 'mcp' })),
  },
  {
    name: 'db_insert_row',
    description: '向表插入一行（列名白名单校验，值全部参数化；空串视为 NULL）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'connectionId' },
        table: { type: 'string', description: '表名' },
        database: { type: 'string', description: '库名/schema' },
        values: { type: 'object', description: '行数据，如 {"name":"alice","score":9}' },
      },
      required: ['id', 'table', 'values'], additionalProperties: false,
    },
    execute: async ({ id, table, database, values }) => capOutput(await getManager().insertRow({ id, table, database, values, source: 'mcp' })),
  },
  {
    name: 'db_delete_row',
    description: '按主键删除一行（参数化 DELETE，影响行数必须恰为 1）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'connectionId' },
        table: { type: 'string', description: '表名' },
        database: { type: 'string', description: '库名/schema' },
        pk: { type: 'array', description: '主键定位，如 [{"column":"id","value":3}]', items: { type: 'object', properties: { column: { type: 'string' }, value: {} }, required: ['column', 'value'] } },
      },
      required: ['id', 'table', 'pk'], additionalProperties: false,
    },
    execute: async ({ id, table, database, pk }) => capOutput(await getManager().deleteRow({ id, table, database, pk, source: 'mcp' })),
  },
];

function toolList() {
  return writeEnabled() ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
}

/** 单条 JSON-RPC 的处理：返回响应对象；通知返回 null。 */
async function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isRequest = msg.id !== undefined;
  try {
    if (msg.method === 'initialize') {
      return { jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      } };
    }
    if (msg.method === 'notifications/initialized' || String(msg.method ?? '').startsWith('notifications/')) {
      return null;
    }
    if (msg.method === 'ping') {
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    }
    if (msg.method === 'tools/list') {
      return { jsonrpc: '2.0', id: msg.id, result: { tools: toolList().map(({ execute, ...def }) => def) } };
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name || '');
      const tool = toolList().find((t) => t.name === name);
      if (!tool) {
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `未知工具: ${name}${writeEnabled() ? '' : '（写入工具未授权：在 plugin-data 目录创建 agent-write-tools 文件）'}` }], isError: true } };
      }
      try {
        const result = await tool.execute(msg.params?.arguments ?? {});
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
      } catch (error) {
        return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(error?.message || error) }], isError: true } };
      }
    }
    if (isRequest) {
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
    return null;
  } catch (error) {
    if (!isRequest) return null;
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(error?.message || error).slice(0, 300) } };
  }
}

/** 导出以便回归测试在进程内驱动协议层。 */
export async function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  return handleMessage(msg);
}

/** 仅在直接运行时启动 stdio 循环（被测试 import 时不接管 stdin）。 */
export function startStdio() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    if (line.trim() === '') return;
    const response = await handleLine(line);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  });
  rl.on('close', async () => {
    if (manager) await manager.closeAll().catch(() => {});
    process.exit(0);
  });
  process.on('SIGINT', () => { manager?.closeAll().catch(() => {}); process.exit(0); });
  process.on('SIGTERM', () => { manager?.closeAll().catch(() => {}); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdio();
}
