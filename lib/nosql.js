/**
 * dsh-database v0.8.0 — NoSQL / 向量数据库引擎集（零依赖）。
 *
 * 三个引擎全部实现与 SQL 引擎相同的 handle 接口：
 *   { kind, query(text), close(), adminPing?(), exportAll?() }
 * 因此可以原样插入既有的 /query、/schema、/export 路由，不需要任何新依赖：
 *
 *   redis          RESP2 直连（node:net 自实现协议），查询框输入 Redis 命令行
 *   elasticsearch  原生 fetch（HTTP/HTTPS），查询框输入 ES DSL JSON
 *   qdrant         原生 fetch（HTTP/HTTPS），查询框输入向量搜索/scroll JSON —— 向量库
 *
 * 安全约定：HTTPS 一律校验证书（fetch 默认行为，纠正旧引擎 rejectUnauthorized:false 的
 * 问题）；所有超时用 AbortController；Redis 密码走 AUTH、ES 走 Basic、Qdrant 走 api-key 头。
 */
import net from 'node:net';

/** 三个引擎的公共元数据（DATABASE_KINDS 之外的注册表）。 */
export const NOSQL_KINDS = new Set(['redis', 'elasticsearch', 'qdrant']);

const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 20000;
/** 单次 schema 扫描的 key 上限（防大库拖垮面板）。 */
const REDIS_SCAN_KEY_CAP = 3000;
/** 列表值/向量在表格单元格里的截断长度。 */
const CELL_PREVIEW = 160;

function trunc(value, max = CELL_PREVIEW) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return 'null';
  return s.length > max ? s.slice(0, max) + `…(${s.length})` : s;
}

class TimeoutError extends Error {}

/** fetch + 超时 + 统一错误消息。返回解析后的 JSON（或 text）。 */
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = QUERY_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 应答按原文返回 */ }
    if (!response.ok) {
      const reason = json?.error?.reason || json?.error || json?.status?.error || text.slice(0, 200) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    }
    return json ?? text;
  } catch (error) {
    if (error.name === 'AbortError') throw new TimeoutError(`请求超时 (${timeoutMs}ms): ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function httpBase(profile) {
  const host = String(profile.host || 'localhost').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const proto = profile.ssl ? 'https' : 'http';
  return `${proto}://${host}:${profile.port || ''}`;
}

// ---------------------------------------------------------------------------
// Redis — 自实现 RESP2 客户端（node:net），零依赖
// ---------------------------------------------------------------------------

/** 把一行 Redis 命令文本切成 argv（支持 "双引号转义" 与 '单引号字面'）。 */
export function splitRedisArgs(line) {
  const args = [];
  let cur = '';
  let started = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"') {
      if (ch === '\\') {
        const next = line[++i];
        cur += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      } else if (ch === '"') { quote = null; }
      else cur += ch;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started || cur !== '') { args.push(cur); cur = ''; started = false; }
    } else { cur += ch; started = true; }
  }
  if (started || cur !== '') args.push(cur);
  return args;
}

/** RESP2: 编码一条命令为数组参数的字节流。 */
function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`];
  for (const arg of args) {
    const buf = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    parts.push(`$${buf.length}\r\n`, buf, '\r\n');
  }
  return parts;
}

/** RESP2 增量解析器：喂字节，吐完整 reply（递归数组）。 */
class RespParser {
  constructor() { this.chunks = []; this.length = 0; }
  push(buf) { this.chunks.push(buf); this.length += buf.length; }
  /** 返回首个完整 reply（或 null），并从缓冲消费掉对应字节。 */
  take() {
    const all = Buffer.concat(this.chunks);
    const [reply, consumed] = RespParser.parseAt(all, 0);
    if (reply === undefined) return null;
    this.chunks = consumed < all.length ? [all.subarray(consumed)] : [];
    this.length = all.length - consumed;
    return reply;
  }
  static parseAt(buf, pos) {
    if (pos >= buf.length) return [undefined, pos];
    const type = String.fromCharCode(buf[pos]);
    const eol = buf.indexOf('\r\n', pos);
    if (eol === -1) return [undefined, pos];
    const head = buf.toString('utf8', pos + 1, eol);
    const after = eol + 2;
    switch (type) {
      case '+': return [{ __t: 'status', v: head }, after];
      case '-': return [{ __t: 'error', v: head }, after];
      case ':': return [{ __t: 'int', v: Number(head) }, after];
      case '$': {
        const len = Number(head);
        if (len === -1) return [null, after];
        if (buf.length < after + len + 2) return [undefined, pos];
        return [buf.toString('utf8', after, after + len), after + len + 2];
      }
      case '*': {
        const n = Number(head);
        if (n === -1) return [null, after];
        const out = [];
        let p = after;
        for (let i = 0; i < n; i++) {
          const [item, next] = RespParser.parseAt(buf, p);
          if (item === undefined) return [undefined, pos];
          out.push(item);
          p = next;
        }
        return [out, p];
      }
      default: throw new Error(`RESP 协议错误：未知类型 ${JSON.stringify(type)}`);
    }
  }
}

class RedisClient {
  constructor() { this.socket = null; this.parser = new RespParser(); this.queue = []; this.buffer = []; }
  connect(profile) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: profile.host || '127.0.0.1', port: profile.port || 6379 });
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.on('connect', () => { socket.setTimeout(0); this.socket = socket; resolve(this); });
      socket.on('timeout', () => { socket.destroy(); reject(new TimeoutError(`Redis 连接超时 ${profile.host}:${profile.port || 6379}`)); });
      socket.on('error', (e) => reject(e));
      socket.on('data', (buf) => {
        this.parser.push(buf);
        for (;;) {
          const reply = this.parser.take();
          if (reply === null) break;
          const next = this.queue.shift();
          if (next) next(reply);
        }
      });
      socket.on('close', () => {
        this.socket = null;
        for (const settle of this.queue.splice(0)) settle({ __t: 'error', v: '连接已关闭' });
      });
    });
  }
  /** 单条命令（顺序执行）。 */
  exec(args) {
    if (!this.socket) return Promise.reject(new Error('Redis 连接未打开'));
    return new Promise((resolve) => {
      this.queue.push((reply) => {
        if (reply && reply.__t === 'error') resolve({ __t: 'error', v: reply.v });
        else resolve(reply);
      });
      for (const part of encodeCommand(args)) this.socket.write(part);
    });
  }
  /** 管线：一次写出全部命令，按序收 N 个应答。 */
  async execMany(batch) {
    if (!this.socket) throw new Error('Redis 连接未打开');
    const waiters = batch.map(() => new Promise((resolve) => this.queue.push(resolve)));
    for (const args of batch) for (const part of encodeCommand(args)) this.socket.write(part);
    return Promise.all(waiters);
  }
  async close() {
    if (!this.socket) return;
    const s = this.socket;
    this.socket = null;
    for (const settle of this.queue.splice(0)) settle({ __t: 'error', v: '连接已关闭' });
    await new Promise((r) => { s.once('close', r); s.end(); setTimeout(r, 50).unref?.(); });
  }
}

function redisThrow(reply, cmd) {
  throw new Error(`Redis ${cmd} 失败: ${reply?.v ?? '空应答'}`);
}

/** SCAN 全量迭代，累计至 cap 个 key。 */
async function redisScanKeys(redis, { match = '*', cap = REDIS_SCAN_KEY_CAP } = {}) {
  const keys = [];
  let cursor = '0';
  do {
    const reply = await redis.exec(['SCAN', cursor, 'MATCH', match, 'COUNT', '200']);
    if (reply?.__t === 'error') redisThrow(reply, 'SCAN');
    const [next, batch] = reply;
    cursor = String(next);
    for (const k of batch || []) if (keys.length < cap) keys.push(k);
  } while (cursor !== '0' && keys.length < cap);
  return keys;
}

const REDIS_TYPE_TABLES = ['string', 'hash', 'list', 'set', 'zset', 'stream', 'other'];

export async function openRedis(profile, password) {
  const redis = new RedisClient();
  try { await redis.connect(profile); } catch (error) { throw new Error(`Redis 连接失败: ${error.message}`); }
  const guard = (r, cmd) => { if (r?.__t === 'error') redisThrow(r, cmd); return r; };
  if (password) guard(await redis.exec(['AUTH', password]), 'AUTH');
  const dbIndex = /^\d+$/.test(String(profile.database ?? '').trim()) ? Number(profile.database) : 0;
  if (dbIndex > 0) guard(await redis.exec(['SELECT', String(dbIndex)]), 'SELECT');
  const pong = await redis.exec(['PING']);
  if (pong?.__t === 'error' || pong !== 'PONG') throw new Error(`Redis 握手失败: ${JSON.stringify(pong)}`);

  const preview = (v) => (v === null ? 'NULL' : trunc(v, 200));

  return {
    kind: 'redis',
    async adminPing() {
      const info = await redis.exec(['INFO', 'server']);
      const version = info?.__t !== 'error' && typeof info === 'string'
        ? (info.match(/^redis_version:(.+)$/m)?.[1] ?? '').trim() : '';
      return `Redis ${version}`;
    },
    async query(text) {
      const args = splitRedisArgs(String(text || ''));
      if (args.length === 0) throw new Error('Redis 查询框输入命令行，例如: GET mykey / SCAN 0 MATCH user:* COUNT 100 / HGETALL user:1');
      const cmd = args[0].toUpperCase();
      const reply = await redis.exec(args);
      if (reply?.__t === 'error') redisThrow(reply, cmd);
      // SCAN → 两段结果展示
      if (cmd === 'SCAN') {
        const [cursor, keys] = reply;
        return { rows: (keys || []).map((k) => ({ cursor: String(cursor), key: k })), fields: [{ name: 'cursor' }, { name: 'key' }], rowCount: (keys || []).length };
      }
      // HGETALL（RESP2 扁平 [f1,v1,f2,v2…]）→ field/value 两列
      if (cmd === 'HGETALL' && Array.isArray(reply)) {
        const rows = [];
        for (let i = 0; i < reply.length; i += 2) rows.push({ field: reply[i], value: preview(reply[i + 1]) });
        return { rows, fields: [{ name: 'field' }, { name: 'value' }], rowCount: rows.length };
      }
      if (cmd === 'ZRANGE' || cmd === 'ZRANGEBYSCORE') {
        const rows = [];
        for (let i = 0; i < reply.length; i += 2) rows.push({ member: reply[i], score: reply[i + 1] ?? '' });
        return { rows, fields: [{ name: 'member' }, { name: 'score' }], rowCount: rows.length };
      }
      // 数组 → 一列 value；标量 → 一行 result
      if (Array.isArray(reply)) {
        const rows = reply.map((v, i) => ({ index: i, value: preview(v) }));
        return { rows, fields: [{ name: 'index' }, { name: 'value' }], rowCount: rows.length };
      }
      return { rows: [{ result: preview(reply) }], fields: [{ name: 'result' }], rowCount: 1 };
    },
    async schema() {
      const keys = await redisScanKeys(redis);
      const types = await redis.execMany(keys.map((k) => ['TYPE', k]));
      const byType = new Map(REDIS_TYPE_TABLES.map((t) => [t, 0]));
      for (const r of types) {
        const ty = r?.__t === 'status' ? r.v : 'other';
        byType.set(ty, (byType.get(ty) ?? 0) + 1);
      }
      const tables = REDIS_TYPE_TABLES
        .filter((t) => (byType.get(t) ?? 0) > 0)
        .map((t) => ({
          name: t, kind: 'table',
          columns: t === 'hash' ? [{ name: 'field' }, { name: 'value' }]
            : t === 'zset' ? [{ name: 'member' }, { name: 'score' }]
              : t === 'list' || t === 'set' ? [{ name: 'index' }, { name: 'value' }]
                : [{ name: 'key' }, { name: 'value' }],
        }));
      return { engine: 'redis', databases: [{ name: `db${dbIndex}`, tables }] };
    },
    async peek(table) {
      // “表”= Redis 数据类型：按类型采样 key
      const type = String(table);
      const keys = await redisScanKeys(redis);
      const typed = await redis.execMany(keys.map((k) => ['TYPE', k]));
      const matched = keys.filter((_, i) => typed[i]?.__t === 'status' && typed[i].v === type).slice(0, 100);
      if (matched.length === 0) return { rows: [], fields: [{ name: 'key' }], rowCount: 0 };
      const fields = type === 'hash' ? [{ name: 'key' }, { name: 'field' }, { name: 'value' }]
        : type === 'zset' ? [{ name: 'key' }, { name: 'member' }, { name: 'score' }]
          : type === 'list' || type === 'set' ? [{ name: 'key' }, { name: 'index' }, { name: 'value' }]
            : [{ name: 'key' }, { name: 'value' }];
      const rows = [];
      for (const key of matched) {
        if (type === 'string') rows.push({ key, value: preview(await redis.exec(['GET', key])) });
        else if (type === 'hash') {
          const flat = await redis.exec(['HGETALL', key]);
          for (let i = 0; i < (flat?.length ?? 0) && rows.length < 1000; i += 2) rows.push({ key, field: flat[i], value: preview(flat[i + 1]) });
        } else if (type === 'list' || type === 'set') {
          // 只取前 1000 个元素：LRANGE 0 -1 在大列表上会先撑爆内存再谈截断
          const items = type === 'list' ? await redis.exec(['LRANGE', key, '0', '999']) : await redis.exec(['SMEMBERS', key]);
          (items || []).forEach((v, i) => rows.push({ key, index: i, value: preview(v) }));
        } else if (type === 'zset') {
          const pairs = await redis.exec(['ZRANGE', key, '0', '-1', 'WITHSCORES']);
          for (let i = 0; i < (pairs?.length ?? 0) && rows.length < 1000; i += 2) rows.push({ key, member: pairs[i], score: pairs[i + 1] });
        } else rows.push({ key, value: `(${type})` });
        if (rows.length >= 1000) break;
      }
      return { rows, fields, rowCount: rows.length };
    },
    async exportAll() {
      const keys = await redisScanKeys(redis, { cap: 100000 });
      const types = await redis.execMany(keys.map((k) => ['TYPE', k]));
      const rows = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], ty = types[i]?.__t === 'status' ? types[i].v : 'other';
        if (ty !== 'string') { rows.push({ key, type: ty, value: `(${ty})` }); continue; }
        const value = await redis.exec(['GET', key]);
        rows.push({ key, type: ty, value });
      }
      return rows;
    },
    async close() { await redis.close(); },
  };
}

// ---------------------------------------------------------------------------
// Elasticsearch — 原生 fetch，零依赖（HTTPS 默认校验证书）
// ---------------------------------------------------------------------------

export async function openElasticsearch(profile, password) {
  const base = httpBase(profile);
  const headers = {};
  if (profile.user || profile.password) {
    headers.authorization = `Basic ${Buffer.from(`${profile.user || ''}:${password || ''}`).toString('base64')}`;
  }
  const root = await fetchJson(base + '/', { headers, timeoutMs: CONNECT_TIMEOUT_MS });
  const version = root?.version?.number ?? '';

  const parseQuery = (text) => {
    let doc;
    try { doc = JSON.parse(text); } catch (e) { throw new Error(`Elasticsearch 查询需要 JSON。两种形式：{"index":"idx", ...searchBody} 或 {"method":"POST","path":"_bulk","body":{…}} — 解析失败: ${e.message}`); }
    if (doc.method && doc.path) return { method: doc.method, path: doc.path, body: doc.body };
    if (doc.index !== undefined) {
      const { index, ...search } = doc;
      return { method: 'POST', path: `${String(index)}/_search`, body: search };
    }
    throw new Error('Elasticsearch 查询需要 {"index":"idx", ...searchBody} 或 {"method","path","body"} 形式');
  };

  return {
    kind: 'elasticsearch',
    async adminPing() { return `Elasticsearch ${version}`; },
    async query(text) {
      const { method, path, body } = parseQuery(text);
      const clean = String(path).replace(/^\/+/, '');
      const result = await fetchJson(`${base}/${clean}`, { method, body, headers });
      const hits = result?.hits?.hits;
      if (Array.isArray(hits)) {
        const rows = hits.map((h) => ({ _id: h._id, _index: h._index, ...(h._source ?? {}) }));
        const keys = [];
        for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
        return { rows, fields: keys.map((name) => ({ name })), rowCount: rows.length, meta: { took: result.took, total: result?.hits?.total?.value } };
      }
      if (result?.acknowledged !== undefined || result?._shards) {
        return { rows: [trunc(result, 400)], fields: [{ name: 'result' }], rowCount: 1 };
      }
      return { rows: [trunc(result, 400)], fields: [{ name: 'result' }], rowCount: 1 };
    },
    async schema() {
      const cat = await fetchJson(`${base}/_cat/indices?format=json&h=index,docs.count,store.size`, { headers });
      const indices = (Array.isArray(cat) ? cat : []).filter((r) => !String(r.index).startsWith('.'));
      const databases = [];
      for (const idx of indices.slice(0, 200)) {
        let columns = [];
        try {
          const mapping = await fetchJson(`${base}/${encodeURIComponent(idx.index)}/_mapping`, { headers });
          const props = Object.values(mapping ?? {})[0]?.mappings?.properties ?? {};
          columns = Object.entries(props).map(([name, def]) => ({ name, type: def.type ?? 'object', nullable: true, key: null }));
        } catch { columns = []; }
        databases.push({
          name: '(cluster)',
          tables: [{
            name: idx.index, kind: 'table',
            columns: [{ name: '_id', type: '_id' }, ...columns],
            meta: { docs: idx['docs.count'], size: idx['store.size'] },
          }],
        });
      }
      // 一个索引一行“库”会让树重复 (cluster)——改为单库多表
      const tables = databases.flatMap((d) => d.tables);
      return { engine: 'elasticsearch', databases: [{ name: '(cluster)', tables }] };
    },
    async peek(index) {
      const result = await fetchJson(`${base}/${encodeURIComponent(String(index))}/_search`, {
        method: 'POST', headers, body: { size: 10000, query: { match_all: {} } },
      });
      const hits = result?.hits?.hits ?? [];
      const rows = hits.map((h) => ({ _id: h._id, ...(h._source ?? {}) }));
      const keys = [];
      for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      return { rows, fields: keys.map((name) => ({ name })), rowCount: rows.length };
    },
    async peekPage({ index, page = 1, pageSize = 200, sort, filter }) {
      const body = { from: (Math.max(1, page) - 1) * pageSize, size: pageSize };
      if (filter && filter.column && filter.value != null && String(filter.value) !== '') {
        const col = String(filter.column), val = String(filter.value), op = filter.op || 'like';
        if (op === 'like') body.query = { match: { [col]: val } };
        else if (op === '=') body.query = { term: { [col]: val } };
        else if (op === '!=') body.query = { bool: { must_not: { term: { [col]: val } } } };
        else body.query = { range: { [col]: { [op === '>=' ? 'gte' : op === '<=' ? 'lte' : op]: val } } };
      }
      if (sort?.column) body.sort = [{ [String(sort.column)]: String(sort.dir).toLowerCase() === 'desc' ? 'desc' : 'asc' }];
      const result = await fetchJson(`${base}/${encodeURIComponent(String(index))}/_search`, { method: 'POST', headers, body });
      const hits = result?.hits?.hits ?? [];
      const rows = hits.map((h) => ({ _id: h._id, ...(h._source ?? {}) }));
      const keys = [];
      for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      return { rows, fields: keys.map((name) => ({ name })), rowCount: rows.length, total: result?.hits?.total?.value ?? rows.length, page: Math.max(1, page), pageSize, paginated: true };
    },
    async exportAll(index) {
      const result = await fetchJson(`${base}/${encodeURIComponent(String(index))}/_search`, {
        method: 'POST', headers, body: { size: 10000, query: { match_all: {} } },
      });
      return (result?.hits?.hits ?? []).map((h) => ({ _id: h._id, ...(h._source ?? {}) }));
    },
    async close() { /* HTTP 无状态 */ },
  };
}

// ---------------------------------------------------------------------------
// Qdrant — 向量数据库，原生 fetch，零依赖
// ---------------------------------------------------------------------------

export async function openQdrant(profile, password) {
  const base = httpBase(profile);
  const headers = {};
  if (password) headers['api-key'] = password;
  const root = await fetchJson(base + '/', { headers, timeoutMs: CONNECT_TIMEOUT_MS });
  const version = root?.version ?? '';

  const dim = (v) => (Array.isArray(v) ? `${v.length}维` : v?.size != null ? `${v.size}维` : typeof v);
  const pointRow = (p, { withVector = false } = {}) => {
    const row = { id: p.id, ...(p.payload ?? {}) };
    if (withVector && p.vector != null) row._vector = trunc(p.vector, 80);
    return row;
  };

  return {
    kind: 'qdrant',
    async adminPing() { return `Qdrant ${version}`; },
    async query(text) {
      let doc;
      try { doc = JSON.parse(text); } catch (e) { throw new Error(`Qdrant 查询需要 JSON 命令，例如 {"collection":"cols","command":"search","vector":[0.1,0.2],"limit":10} / {"command":"scroll","collection":"cols","limit":50} / {"method":"GET","path":"collections"} — ${e.message}`); }
      const { collection, command, ...rest } = doc ?? {};
      if (doc.method && doc.path) return this._raw(doc.method, doc.path, doc.body);
      if (!collection) throw new Error('需要 "collection" 字段 (missing "collection")');
      const enc = encodeURIComponent(String(collection));
      if (command === 'search' || command === 'search_points') {
        const body = {
          vector: rest.vector, limit: Math.min(Number(rest.limit ?? 10), 1000),
          with_payload: rest.with_payload ?? true, with_vector: rest.with_vector ?? false,
          ...(rest.filter ? { filter: rest.filter } : {}),
        };
        const result = await fetchJson(`${base}/collections/${enc}/points/search`, { method: 'POST', headers, body });
        const rows = (result?.result ?? []).map((p) => ({ score: p.score, ...pointRow(p, { withVector: body.with_vector }) }));
        return { rows, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [], rowCount: rows.length };
      }
      if (command === 'scroll') {
        const body = { limit: Math.min(Number(rest.limit ?? 50), 10000), with_payload: rest.with_payload ?? true, with_vector: rest.with_vector ?? false, ...(rest.offset ? { offset: rest.offset } : {}) };
        const result = await fetchJson(`${base}/collections/${enc}/points/scroll`, { method: 'POST', headers, body });
        const rows = (result?.result?.points ?? []).map((p) => pointRow(p, { withVector: body.with_vector }));
        return { rows, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [], rowCount: rows.length, meta: { next_page_offset: result?.result?.next_page_offset } };
      }
      if (command === 'count') {
        const result = await fetchJson(`${base}/collections/${enc}/points/count`, { method: 'POST', headers, body: { exact: true } });
        return { rows: [{ count: result?.result?.count }], fields: [{ name: 'count' }], rowCount: 1 };
      }
      if (command === 'recommend' || command === 'upsert' || command === 'delete') {
        throw new Error(`Qdrant ${command} 请用原始 REST 形式：{"method":"POST","path":"collections/${collection}/points/…","body":{…}}`);
      }
      throw new Error(`不支持的 Qdrant 命令: ${command}（支持 search / scroll / count 或 {"method","path","body"} 原始 REST）`);
    },
    async _raw(method, path, body) {
      const result = await fetchJson(`${base}/${String(path).replace(/^\/+/, '')}`, { method, headers, body });
      const rows = Array.isArray(result?.result) ? result.result.map((p) => (p && typeof p === 'object' ? pointRow(p) : { result: trunc(p) })) : [trunc(result, 400)];
      return { rows, fields: rows.length && typeof rows[0] === 'object' ? Object.keys(rows[0]).map((name) => ({ name })) : [{ name: 'result' }], rowCount: rows.length };
    },
    async schema() {
      const list = await fetchJson(`${base}/collections`, { headers });
      const names = list?.result?.collections?.map((c) => c.name) ?? [];
      const tables = [];
      for (const name of names.slice(0, 200)) {
        const info = await fetchJson(`${base}/collections/${encodeURIComponent(name)}`, { headers });
        const cfg = info?.result?.config?.params?.vectors ?? {};
        // Qdrant 三种向量配置形态：单向量 {size,distance} / 命名 {name:{size,…}} / 数组
        const vectors = Array.isArray(cfg) ? { _: cfg } : (cfg && cfg.size != null ? { _: cfg } : (cfg ?? {}));
        const vecCols = Object.entries(vectors).map(([seg, v]) => ({ name: seg === '_' ? '_vector' : `vector:${seg}`, type: `vector ${dim(v)}` }));
        // 采样 payload 键作为列
        const sample = await fetchJson(`${base}/collections/${encodeURIComponent(name)}/points/scroll`, {
          method: 'POST', headers, body: { limit: 20, with_payload: true, with_vector: false },
        }).catch(() => null);
        const payloadKeys = [];
        for (const p of sample?.result?.points ?? []) for (const k of Object.keys(p.payload ?? {})) if (!payloadKeys.includes(k)) payloadKeys.push(k);
        tables.push({
          name, kind: 'table',
          columns: [{ name: 'id', type: 'point id' }, ...payloadKeys.map((k) => ({ name: k, type: 'payload' })), ...vecCols, { name: '_vectors_count', type: 'meta' }],
          meta: { points: info?.result?.points_count, status: info?.result?.status },
        });
      }
      return { engine: 'qdrant', databases: [{ name: '(collections)', tables }] };
    },
    async peek(collection) {
      const enc = encodeURIComponent(String(collection));
      const result = await fetchJson(`${base}/collections/${enc}/points/scroll`, {
        method: 'POST', headers, body: { limit: 10000, with_payload: true, with_vector: false },
      });
      const rows = (result?.result?.points ?? []).map((p) => pointRow(p));
      const keys = [];
      for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
      return { rows, fields: keys.map((name) => ({ name })), rowCount: rows.length };
    },
    async exportAll(collection) {
      const enc = encodeURIComponent(String(collection));
      const rows = [];
      let offset;
      for (let page = 0; page < 100; page++) {
        const result = await fetchJson(`${base}/collections/${enc}/points/scroll`, {
          method: 'POST', headers, body: { limit: 1000, with_payload: true, with_vector: false, ...(offset !== undefined ? { offset } : {}) },
        });
        const points = result?.result?.points ?? [];
        rows.push(...points.map((p) => ({ id: p.id, ...(p.payload ?? {}) })));
        offset = result?.result?.next_page_offset;
        if (offset === undefined || offset === null || rows.length >= 100000) break;
      }
      return rows;
    },
    async close() { /* HTTP 无状态 */ },
  };
}

/** 统一入口：按 kind 打开 NoSQL/向量引擎句柄（connections.js 的 openHandle 调用）。 */
export async function openNoSqlHandle(profile, password) {
  switch (profile.kind) {
    case 'redis': return openRedis(profile, password);
    case 'elasticsearch': return openElasticsearch(profile, password);
    case 'qdrant': return openQdrant(profile, password);
    default: throw new Error(`unsupported nosql kind: ${profile.kind}`);
  }
}

/** 统一入口：NoSQL/向量引擎的结构树（connections.js 的 schema() 调用）。 */
export async function schemaNoSql(handle) {
  if (typeof handle.schema !== 'function') throw new Error(`schema unsupported for ${handle.kind}`);
  return handle.schema();
}
