/**
 * dsh-database — connection manager (host side).
 *
 * Owns every named database connection: a small profile document (which
 * database, host, port, user, database name — never a password) persisted in
 * the plugin's config area, and live driver connections opened lazily and
 * disposed on profile changes or host shutdown.
 *
 * Drivers are optional dependencies resolved at connect time so the bundle
 * stays light: SQLite ships with Node (`node:sqlite`), everything else is
 * loaded from the profile's node_modules on first use.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { NOSQL_KINDS, openNoSqlHandle, schemaNoSql } from './nosql.js';
import { introspectEr } from './er.js';

/**
 * Stop a driver's background `error` event from becoming an uncaught exception.
 *
 * Node treats an `error` event with no listener as a thrown exception; DSH's
 * own policy is that an uncaught exception is fatal, so a database connection
 * dropping in the background would otherwise shut the entire application down.
 * Every driver object that can emit `error` gets a listener that only logs.
 * @param emitter - driver pool/client/topology object.
 * @param label - name used in the log line.
 */
function guardEmitter(emitter, label) {
  if (emitter === null || typeof emitter !== 'object' || typeof emitter.on !== 'function') return;
  emitter.on('error', (error) => {
    console.warn(`[dsh-database] ${label} emitted a background error (ignored):`, error?.message || error);
  });
}

/**
 * Split a multi-statement script on TOP-LEVEL semicolons.
 *
 * String literals ('', ""), quoted identifiers (""``, []), comments (-- and
 * block) and are all respected, so a `;` inside any of them never splits.
 * `node:sqlite`'s prepare() compiles only the FIRST statement — pasting
 * "INSERT; INSERT;" used to answer 200 while silently dropping the second.
 */
function splitStatements(sql) {
  const out = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    // -- line comment: swallow to end of line (kept in text; classification
    // strips comments separately).
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // block comment
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // string literal / quoted identifier / bracket identifier
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      let segment = ch;
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { segment += close + close; j += 2; continue; } // doubled quote escape
          segment += close; j += 1; break;
        }
        segment += sql[j]; j += 1;
      }
      current += segment;
      i = j;
      continue;
    }
    if (ch === ';') {
      if (current.trim() !== '') out.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/** Strip comments so a statement CLASSIFIES by its real first keyword. */
function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end + 1;
      out += ' ';
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += ' ';
      i = stop;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      out += ch;
      while (j < n) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) { out += close + close; j += 2; continue; }
          out += close; j += 1; break;
        }
        out += sql[j]; j += 1;
      }
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Database kinds this plugin understands, with their default ports. */
export const DATABASE_KINDS = {
  sqlite: { label: 'SQLite', defaultPort: null, icon: 'sqlite' },
  mysql: { label: 'MySQL / MariaDB', defaultPort: 3306, icon: 'mysql' },
  postgres: { label: 'PostgreSQL', defaultPort: 5432, icon: 'postgres' },
  mssql: { label: 'SQL Server', defaultPort: 1433, icon: 'mssql' },
  mongodb: { label: 'MongoDB', defaultPort: 27017, icon: 'mongodb' },
  clickhouse: { label: 'ClickHouse', defaultPort: 8123, icon: 'clickhouse' },
  redis: { label: 'Redis', defaultPort: 6379, icon: 'redis' },
  elasticsearch: { label: 'Elasticsearch', defaultPort: 9200, icon: 'elasticsearch' },
  qdrant: { label: 'Qdrant（向量数据库）', defaultPort: 6333, icon: 'qdrant' },
};

/**
 * Column types the visual table designer offers. The browser renders this
 * list as a <select> (plus the length box when needsLength); the host
 * validates against the SAME list and renders the engine-specific SQL type,
 * so the browser never assembles SQL text itself.
 */
export const DESIGNER_COLUMN_TYPES = [
  { id: 'integer', label: 'INT 整数' },
  { id: 'bigint', label: 'BIGINT 长整数' },
  { id: 'varchar', label: 'VARCHAR 字符串', needsLength: true, lengthPlaceholder: '255' },
  { id: 'text', label: 'TEXT 长文本' },
  { id: 'boolean', label: 'BOOLEAN 布尔' },
  { id: 'date', label: 'DATE 日期' },
  { id: 'datetime', label: 'DATETIME 时间' },
  { id: 'decimal', label: 'DECIMAL 小数', needsLength: true, lengthPlaceholder: '10,2' },
  { id: 'float', label: 'FLOAT 浮点' },
  { id: 'json', label: 'JSON' },
  { id: 'blob', label: 'BLOB 二进制' },
];

const DRIVER_PACKAGES = {
  // The PROMISE entry point matters for MySQL: the callback API reports a
  // failed connection as an `error` event on an object nobody listens to, and
  // an unlistened `error` event is an uncaught exception — which DSH turns into
  // a fatal shutdown of the whole application (2026-09-30 crashes).
  mysql: 'mysql2/promise',
  postgres: 'pg',
  mssql: 'mssql',
  mongodb: 'mongodb',
  clickhouse: '@clickhouse/client',
};

/** Export cap: the panel warns when a bigger table is cut at this size. */
const EXPORT_ROW_CAP = 100000;
/** Import cap: one file may carry at most this many data rows. */
const IMPORT_ROW_CAP = 50000;

/**
 * The live connection registry. Keyed by profile id; every entry carries its
 * driver handle plus the metadata needed to render a tree.
 */
class ConnectionManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.profilesPath = join(dataDir, 'connections.json');
    this.live = new Map(); // id -> { kind, handle, meta }
    this.connecting = new Map(); // id -> in-flight connect promise (concurrency dedupe)
    this.nextId = 1;
    this.require = createRequire(import.meta.url);
    this.loadProfiles();
  }

  /** Profiles live in one JSON document; missing file = empty registry. */
  loadProfiles() {
    try {
      if (existsSync(this.profilesPath)) {
        const raw = JSON.parse(readFileSync(this.profilesPath, 'utf8'));
        this.profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
      } else {
        this.profiles = [];
      }
    } catch {
      // Corrupt file: keep it for inspection instead of letting the next
      // saveProfiles() overwrite the user's only copy with an empty registry.
      try { copyFileSync(this.profilesPath, `${this.profilesPath}.bak`); } catch { /* best effort */ }
      this.profiles = [];
    }
  }

  saveProfiles() {
    mkdirSync(dirname(this.profilesPath), { recursive: true });
    const body = JSON.stringify({ profiles: this.profiles }, null, 2);
    // Atomic write: a crash mid-write used to truncate connections.json and
    // the next start silently reset every saved connection. Write to a temp
    // file, then rename over the target (same volume → atomic on POSIX and
    // effectively atomic on NTFS). 0o600: the file can contain an opted-in
    // remembered password, so keep it owner-only where the OS honors the mode.
    const tmpPath = `${this.profilesPath}.tmp`;
    writeFileSync(tmpPath, body, { encoding: 'utf8', mode: 0o600, flag: 'w' });
    try {
      renameSync(tmpPath, this.profilesPath);
    } catch {
      // Some filesystems (and an open handle on Windows) can refuse the
      // rename; fall back to the direct write rather than losing the save.
      writeFileSync(this.profilesPath, body, { encoding: 'utf8', mode: 0o600, flag: 'w' });
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
    }
  }

  /**
   * The client-facing projection of one profile — identical to what
   * listProfiles returns. Mutating routes must answer with THIS shape, never
   * the stored document: a raw return hands the browser `savedPassword` in
   * plaintext even though the listing route redacts it.
   */
  redactProfile(profile) {
    return {
      id: profile.id,
      name: profile.name,
      kind: profile.kind,
      host: profile.host,
      port: profile.port,
      database: profile.database,
      user: profile.user,
      ssl: profile.ssl === true,
      envPassword: profile.envPassword ?? null,
      hasPassword: typeof profile.savedPassword === 'string' && profile.savedPassword.length > 0,
      // The user's own opt-in, echoed back so the panel's auto-remember flow
      // can respect a turned-off "remember password" checkbox.
      rememberPassword: profile.savedPassword !== undefined,
      createdAt: profile.createdAt,
    };
  }

  listProfiles() {
    return this.profiles.map((p) => this.redactProfile(p));
  }

  getProfile(id) {
    return this.profiles.find((p) => p.id === id);
  }

  /** Apply the secret fields shared by create and update. */
  applySecrets(profile, input) {
    if (input.envPassword !== undefined) {
      profile.envPassword = typeof input.envPassword === 'string' && input.envPassword !== '' ? input.envPassword : null;
    }
    if (typeof input.password === 'string' && input.password.length > 0) {
      // Only when the caller explicitly opted in; otherwise the password stays
      // in the browser session's memory and is never written to disk.
      if (input.rememberPassword === true) profile.savedPassword = input.password;
      else delete profile.savedPassword;
    } else if (input.rememberPassword === false) {
      delete profile.savedPassword;
    }
  }

  createProfile(input) {
    const kind = String(input.kind || 'sqlite').toLowerCase();
    if (!DATABASE_KINDS[kind]) throw new Error(`unknown database kind: ${kind}`);
    const id = `conn-${Date.now().toString(36)}-${this.nextId++}`;
    const profile = {
      id,
      name: String(input.name || `${DATABASE_KINDS[kind].label} ${this.profiles.length + 1}`),
      kind,
      host: input.host || 'localhost',
      port: input.port ?? DATABASE_KINDS[kind].defaultPort,
      database: input.database || '',
      user: input.user || '',
      ssl: input.ssl === true,
      envPassword: typeof input.envPassword === 'string' && input.envPassword !== '' ? input.envPassword : null,
      createdAt: Date.now(),
    };
    this.applySecrets(profile, input);
    this.profiles.push(profile);
    this.saveProfiles();
    // Redacted: a raw return would echo `savedPassword` back to the browser.
    return this.redactProfile(profile);
  }

  updateProfile(id, patch) {
    const profile = this.getProfile(id);
    if (!profile) throw new Error(`unknown connection: ${id}`);
    for (const field of ['name', 'host', 'port', 'database', 'user', 'ssl']) {
      if (patch[field] !== undefined) profile[field] = patch[field];
    }
    this.applySecrets(profile, patch);
    this.saveProfiles();
    // A changed profile invalidates the pooled connection.
    return this.closeProfile(id).then(() => this.redactProfile(profile));
  }

  deleteProfile(id) {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => p.id !== id);
    this.saveProfiles();
    return this.closeProfile(id).then(() => this.profiles.length !== before);
  }

  /** Resolve the password for one connect request: explicit > env reference. */
  resolvePassword(profile, explicit) {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    if (typeof profile.savedPassword === 'string' && profile.savedPassword.length > 0) return profile.savedPassword;
    if (profile.envPassword) {
      const fromEnv = process.env[profile.envPassword];
      if (typeof fromEnv === 'string') return fromEnv;
      // Name the miss instead of letting the driver fail with "using password: NO".
      const looksLikeVarName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.envPassword);
      if (!looksLikeVarName) {
        throw new Error(
          `「密码环境变量名」里填的不是环境变量名。密码请填在「密码」字段；` +
          `环境变量名要写成 MYSQL_PWD 这样的标识符。/ The password-env-var field does not hold an environment variable name.`
        );
      }
      throw new Error(`环境变量 ${profile.envPassword} 未设置 / environment variable ${profile.envPassword} is not set`);
    }
    return undefined;
  }

  /**
   * A throwaway profile-shaped object for the one-shot /test route: the same
   * settings shape a saved profile has, but never persisted anywhere.
   */
  ephemeralProfile(settings) {
    const kind = String(settings.kind || '').toLowerCase();
    if (!DATABASE_KINDS[kind]) throw new Error(`unknown database kind: ${kind}`);
    return {
      id: 'test-once', kind,
      name: 'test-once', host: settings.host || 'localhost',
      port: settings.port ?? DATABASE_KINDS[kind].defaultPort,
      database: settings.database || '',
      user: settings.user || '',
      ssl: settings.ssl === true,
      envPassword: typeof settings.envPassword === 'string' && settings.envPassword !== '' ? settings.envPassword : null,
      savedPassword: typeof settings.password === 'string' && settings.password !== '' ? settings.password : undefined,
    };
  }

  /** Load an optional driver package, failing with an actionable message. */
  loadDriver(kind) {
    const pkg = DRIVER_PACKAGES[kind];
    if (!pkg) throw new Error(`no driver mapping for ${kind}`);
    try {
      return this.require(pkg);
    } catch (error) {
      throw new Error(
        `缺少驱动 ${pkg}。请在 DSH profile 目录执行: pnpm add ${pkg}` +
        ` (missing driver ${pkg}; install it into the DSH profile: pnpm add ${pkg})` +
        ` — 原始错误: ${error.message}`
      );
    }
  }

  /**
   * Open (or reuse) the live connection for one profile.
   *
   * force: rebuild the pooled connection even when one exists. The panel's
   * designer/peek flows call with force after a "connection is not open"
   * failure — a browser UI can outlive a host restart or a dropped MySQL
   * socket, and reusing a dead cached handle would fail forever.
   *
   * Concurrent dedupe: check→await→set has an await in the middle, so two
   * parallel connects to the same profile used to both open a driver handle
   * and leak one. In-flight promises are shared instead.
   */
  async connect(profileId, password, { force = false } = {}) {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error(`unknown connection: ${profileId}`);
    const existing = this.live.get(profileId);
    if (existing && !force) return { reused: true, profile };
    const inFlight = this.connecting.get(profileId);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      if (this.live.has(profileId)) await this.closeProfile(profileId);
      const handle = await this.openHandle(profile, this.resolvePassword(profile, password));
      this.live.set(profileId, { kind: profile.kind, handle, profile });
      return { reused: existing !== undefined, profile };
    })().finally(() => this.connecting.delete(profileId));
    this.connecting.set(profileId, attempt);
    return attempt;
  }

  async openHandle(profile, password) {
    switch (profile.kind) {
      case 'sqlite': return this.openSqlite(profile);
      case 'mysql': return this.openMysql(profile, password);
      case 'postgres': return this.openPostgres(profile, password);
      case 'mssql': return this.openMssql(profile, password);
      case 'mongodb': return this.openMongo(profile, password);
      case 'clickhouse': return this.openClickHouse(profile, password);
      case 'redis':
      case 'elasticsearch':
      case 'qdrant': return openNoSqlHandle(profile, password);
      default: throw new Error(`unsupported kind: ${profile.kind}`);
    }
  }

  openSqlite(profile) {
    // Node >= 22.5 ships node:sqlite (DatabaseSync). DSH Desktop runs Node 24.
    const { DatabaseSync } = this.require('node:sqlite');
    const file = profile.database; // for sqlite, `database` holds the file path
    if (!file) throw new Error('SQLite 需要提供数据库文件路径 (database file path required)');
    // DatabaseSync silently CREATES an empty file for a missing path — check
    // first so a typo cannot leave an anonymous blank database behind.
    if (!existsSync(file)) throw new Error(`SQLite 数据库文件不存在: ${file} (database file does not exist)`);
    const db = new DatabaseSync(file);
    return {
      kind: 'sqlite',
      async query(sql, params) {
        // Multi-statement scripts: node:sqlite's prepare() compiles only the
        // FIRST statement, so pasting "INSERT; INSERT;" used to 200 while
        // silently dropping the rest. Split, execute each, aggregate.
        const statements = splitStatements(String(sql || ''));
        if (statements.length === 0) return { rows: [], fields: [], affectedRows: 0 };
        let totalAffected = 0;
        let lastResult = { rows: [], fields: [] };
        for (const statement of statements) {
          // Classify by the first keyword AFTER comments — "-- note\nSELECT"
          // used to fall into the run() branch and silently lose its rows.
          const head = stripComments(statement).trim().toUpperCase();
          const isRead = head.startsWith('SELECT') || head.startsWith('PRAGMA')
            || head.startsWith('WITH') || head.startsWith('EXPLAIN');
          const stmt = db.prepare(statement);
          if (isRead) {
            const rows = stmt.all(...(params || []));
            lastResult = { rows, fields: stmt.columns().map((c) => ({ name: c.name, type: c.type ?? null })) };
          } else {
            const info = stmt.run(...(params || []));
            totalAffected += Number(info.changes ?? 0);
            lastResult = { rows: [], fields: [], insertId: Number(info.lastInsertRowid ?? 0) };
          }
        }
        return {
          ...lastResult,
          // Always present for write paths (callers read affectedRows on
          // single statements too).
          affectedRows: (lastResult.affectedRows ?? 0) + totalAffected,
        };
      },
      async close() { db.close(); },
    };
  }

  /**
   * MySQL / MariaDB.
   *
   * Two rules this follows, both learned the hard way (the 2026-09-30 crashes):
   *
   *  1. Use the PROMISE API (`mysql2/promise`). The callback API turns a failed
   *     connection into `query.emit('error', err)` on an object nobody listens
   *     to, and an unlistened `error` event is an uncaught exception in Node —
   *     which DSH treats as fatal, taking the whole application down.
   *  2. Attach an `error` listener to the pool anyway: a pooled connection that
   *     dies later (server restart, timeout) must degrade to a log line.
   *
   * The connection is verified eagerly so a bad password is reported to the
   * caller as an ordinary connect error instead of "connecting" successfully.
   */
  async openMysql(profile, password) {
    const mysql = this.loadDriver('mysql');
    const pool = mysql.createPool({
      host: profile.host, port: profile.port || 3306,
      user: profile.user || 'root', password,
      database: profile.database || undefined,
      ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
      connectionLimit: 4, connectTimeout: 8000, waitForConnections: true,
    });
    guardEmitter(pool, 'mysql pool');
    try {
      await pool.query('SELECT 1');
    } catch (error) {
      await pool.end().catch(() => {});
      throw error;
    }
    return {
      kind: 'mysql',
      async query(sql, params) {
        const [rows, fields] = await pool.query({ sql, values: params || [], timeout: 20000 });
        const fieldList = (fields || []).map((f) => ({ name: f.name, type: f.typeName || String(f.type ?? '') }));
        if (Array.isArray(rows) && Array.isArray(rows[0]) && Array.isArray(fields) && Array.isArray(fields[0])) {
          // multi-statement result
          return { rows: rows[0], fields: (fields[0] || []).map((f) => ({ name: f.name, type: String(f.type ?? '') })) };
        }
        const isRows = Array.isArray(rows) && (rows.length === 0 || typeof rows[0] === 'object');
        return isRows
          ? { rows, fields: fieldList }
          : { rows: [], fields: [], affectedRows: Number(rows?.affectedRows ?? 0), insertId: Number(rows?.insertId ?? 0) };
      },
      async close() { await pool.end().catch(() => {}); },
    };
  }

  async openPostgres(profile, password) {
    const { Client } = this.loadDriver('postgres');
    const client = new Client({
      host: profile.host, port: profile.port || 5432,
      user: profile.user || 'postgres', password,
      database: profile.database || 'postgres',
      ssl: profile.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 8000,
    });
    // pg emits 'error' on the client when an established connection drops; with
    // no listener that is an uncaught exception.
    guardEmitter(client, 'postgres client');
    await client.connect();
    return {
      kind: 'postgres',
      async query(sql, params) {
        const result = await client.query({ text: sql, values: params || [], rowMode: 'array' });
        if (Array.isArray(result)) {
          // multiple result sets from multiple statements
          const first = result[0];
          return { rows: first.rows.map((r) => Object.fromEntries(first.fields.map((f, i) => [f.name, r[i]]))), fields: first.fields.map((f) => ({ name: f.name, type: f.dataTypeID != null ? String(f.dataTypeID) : null })), rowCount: first.rowCount };
        }
        const fields = result.fields.map((f) => ({ name: f.name, type: f.dataTypeID != null ? String(f.dataTypeID) : null }));
        const rows = result.rows.map((r) => Object.fromEntries(result.fields.map((f, i) => [f.name, r[i]])));
        return { rows, fields, rowCount: result.rowCount, affectedRows: result.command === 'INSERT' || result.command === 'UPDATE' || result.command === 'DELETE' ? result.rowCount : undefined };
      },
      async close() { await client.end().catch(() => {}); },
    };
  }

  async openMssql(profile, password) {
    const mssql = this.loadDriver('mssql');
    const config = {
      server: profile.host,
      port: profile.port || 1433,
      user: profile.user || 'sa',
      password,
      database: profile.database || 'master',
      options: { encrypt: profile.ssl === true, trustServerCertificate: true, connectTimeout: 8000 },
      connectionTimeout: 8000, requestTimeout: 20000,
    };
    const pool = new mssql.ConnectionPool(config);
    guardEmitter(pool, 'mssql pool');
    await pool.connect();
    return {
      kind: 'mssql',
      async query(sql, params) {
        const request = pool.request();
        // Bind @p1..@pN: the handle used to be `query(sql)` and silently
        // discarded params, so every parameterized UPDATE/INSERT failed.
        (params || []).forEach((value, i) => request.input(`p${i + 1}`, value));
        const result = await request.query(sql);
        // DDL / non-SELECT answers carry no recordset at all — reading
        // result.recordset[0] used to throw a TypeError after a successful
        // CREATE/ALTER.
        const rows = Array.isArray(result?.recordset) ? result.recordset : [];
        return {
          rows,
          fields: rows.length > 0 ? Object.keys(rows[0] || {}).map((name) => ({ name, type: null })) : [],
          rowCount: result?.rowsAffected?.[0] ?? rows.length,
        };
      },
      async close() { await pool.close().catch(() => {}); },
    };
  }

  async openMongo(profile, password) {
    const { MongoClient } = this.loadDriver('mongodb');
    const auth = profile.user ? `${encodeURIComponent(profile.user)}:${encodeURIComponent(password || '')}@` : '';
    const url = `mongodb://${auth}${profile.host}:${profile.port || 27017}/${profile.database || 'admin'}${profile.ssl ? '?tls=true' : ''}`;
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
    guardEmitter(client, 'mongodb client');
    try {
      await client.connect();
    } catch (error) {
      // The topology monitor keeps running until close(): a failed connect
      // used to leak background monitoring for the rest of the process.
      await client.close().catch(() => {});
      throw error;
    }
    return {
      kind: 'mongodb',
      /** Server banner for the connect toast (buildInfo is cheap and safe). */
      async adminPing() {
        try {
          const info = await client.db('admin').command({ buildInfo: 1 });
          return `MongoDB ${info.version ?? ''}`;
        } catch { return 'MongoDB'; }
      },
      async query(sql) {
        // Accept a JSON "command" document: {"find":"users","filter":{},"limit":20}
        let parsed;
        try { parsed = JSON.parse(sql); } catch { throw new Error('MongoDB 查询需要一个 JSON 命令文档，例如 {"find":"users","filter":{},"limit":20}'); }
        const { database = profile.database || 'admin', collection, command, ...rest } = parsed;
        if (!collection || !command) throw new Error('需要 collection 和 command 字段 (need "collection" and "command")');
        const coll = client.db(database).collection(collection);
        if (command === 'find') {
          const filter = rest.filter || {};
          const limit = Math.min(Number(rest.limit || 50), 10000);
          const projection = rest.projection;
          const sort = rest.sort;
          let cursor = coll.find(filter, { projection, limit });
          if (sort) cursor = cursor.sort(sort);
          if (rest.skip) cursor = cursor.skip(Number(rest.skip) || 0);
          const rows = await cursor.toArray();
          return { rows, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name, type: null })) : [] };
        }
        if (command === 'count') return { rows: [{ count: await coll.countDocuments(rest.filter || {}) }], fields: [{ name: 'count', type: 'number' }] };
        if (command === 'aggregate') {
          const rows = await coll.aggregate(rest.pipeline || [], { allowDiskUse: true }).limit(500).toArray();
          return { rows, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name, type: null })) : [] };
        }
        if (command === 'insertMany') { const r = await coll.insertMany(rest.documents || []); return { rows: [], fields: [], affectedRows: r.insertedCount }; }
        if (command === 'updateMany') { const r = await coll.updateMany(rest.filter || {}, rest.update || {}); return { rows: [], fields: [], affectedRows: r.modifiedCount }; }
        if (command === 'deleteMany') { const r = await coll.deleteMany(rest.filter || {}); return { rows: [], fields: [], affectedRows: r.deletedCount }; }
        throw new Error(`不支持的 MongoDB 命令: ${command} (unsupported command)`);
      },
      async close() { await client.close().catch(() => {}); },
    };
  }

  async openClickHouse(profile, password) {
    const { ClickHouseClient } = this.loadDriver('clickhouse');
    const client = new ClickHouseClient({
      url: `http://${profile.host}:${profile.port || 8123}`,
      database: profile.database || 'default',
      username: profile.user || 'default',
      password: password || '',
      request_timeout: 10000,
    });
    guardEmitter(client, 'clickhouse client');
    // Verify eagerly: the HTTP client is lazy, so a bad credential would
    // otherwise look like a successful connect.
    await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
    return {
      kind: 'clickhouse',
      async query(sql) {
        const resultSet = await client.query({ query: sql, format: 'JSONEachRow' });
        const rows = await resultSet.json();
        return { rows, fields: rows.length ? Object.keys(rows[0]).map((name) => ({ name, type: null })) : [] };
      },
      async close() { await client.close().catch(() => {}); },
    };
  }

  /** Live handle for a profile, or undefined when not connected. */
  liveHandle(id) {
    const entry = this.live.get(id);
    return entry ? entry.handle : undefined;
  }

  async closeProfile(id) {
    const entry = this.live.get(id);
    if (!entry) return false;
    this.live.delete(id);
    await entry.handle.close().catch(() => {});
    return true;
  }

  async closeAll() {
    const ids = [...this.live.keys()];
    for (const id of ids) await this.closeProfile(id);
  }

  /** Connected profile ids for status display. */
  connectedIds() {
    return [...this.live.keys()];
  }

  /**
   * Reconnect saved profiles at host startup. EVERY profile gets an attempt —
   * not only ones with a remembered password: passwordless servers and SQLite
   * files should simply be connected when the app opens (the cookie behavior
   * the panel promises). A profile that needs a password and has none fails
   * quietly here; the tree shows it offline for one manual connect.
   */
  async autoReconnect() {
    const results = [];
    for (const profile of this.profiles) {
      try {
        await this.connect(profile.id);
        results.push({ id: profile.id, name: profile.name, ok: true });
      } catch (error) {
        results.push({ id: profile.id, name: profile.name, ok: false, error: String(error?.message || error) });
      }
    }
    return results;
  }

  /**
   * Persist a password for an existing profile WITHOUT touching the live
   * connection — updateProfile closes the pool, and the auto-remember flow
   * runs right after a successful connect, which must stay open.
   */
  savePassword(id, password) {
    const profile = this.getProfile(id);
    if (!profile) throw new Error(`unknown connection: ${id}`);
    if (typeof password === 'string' && password.length > 0) profile.savedPassword = password;
    else delete profile.savedPassword;
    this.saveProfiles();
    return this.redactProfile(profile);
  }

  /**
   * Quote one identifier per engine. MySQL/ClickHouse use backticks, SQL Server
   * brackets, PostgreSQL double quotes, SQLite falls back to double quotes.
   */
  quoteIdentFor(kind, name) {
    const n = String(name);
    if (kind === 'mysql' || kind === 'clickhouse') return '`' + n.replace(/`/g, '``') + '`';
    if (kind === 'mssql') return '[' + n.replace(/\]/g, ']]') + ']';
    return '"' + n.replace(/"/g, '""') + '"';
  }

  /**
   * One bind placeholder per engine. `?` is only understood by mysql2 and
   * node:sqlite: PostgreSQL wants $1..$n and SQL Server wants @p1..@pN, so
   * generating `?` for them made every import and cell update fail at 400.
   * MongoDB/ClickHouse never reach this (no in-place UPDATE / inline
   * literals), but they default to `?` to stay harmless.
   */
  placeholder(kind, index) {
    const i = Number(index) + 1;
    if (kind === 'postgres') return `$${i}`;
    if (kind === 'mssql') return `@p${i}`;
    return '?';
  }

  /**
   * Update one cell: the host builds a parameterized UPDATE addressed by the
   * table's primary key, so values are bound — never spliced into SQL text —
   * and the WHERE clause can only match rows the caller actually saw.
   *
   * pk: [{ column, value }] — every PK column of the row being edited.
   * Returns { affectedRows } so the UI can prove exactly one row changed.
   */
  async updateCell({ id, table, database, column, pk, value }) {
    const handle = this.liveHandle(id);
    if (!handle) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    if (typeof table !== 'string' || !table) throw new Error('缺少表名 (missing table)');
    if (typeof column !== 'string' || !column) throw new Error('缺少列名 (missing column)');
    if (!Array.isArray(pk) || pk.length === 0) throw new Error('该表没有主键，无法定位要修改的行 (no primary key — cannot address a row)');

    const kind = handle.kind;
    const engine = kind === 'sqlite' ? 'sqlite' : kind;

    // Identifier safety: quote through the engine-specific quoter; the values
    // themselves go in as bind parameters.
    const target = database && kind !== 'sqlite' && kind !== 'clickhouse'
      ? `${this.quoteIdentFor(kind, database)}.${this.quoteIdentFor(kind, table)}`
      : this.quoteIdentFor(kind, table);

    // Placeholders follow the engine's dialect ($n for pg, @pN for mssql);
    // values stay bound, never spliced into the SQL text.
    const setSql = `${this.quoteIdentFor(kind, column)} = ${this.placeholder(kind, 0)}`;
    // Build WHERE from pk entries in order: every PK column must match the
    // value the caller saw, so the statement can only hit that one row.
    const where = pk.map((part, i) => `${this.quoteIdentFor(kind, part.column)} = ${this.placeholder(kind, i + 1)}`).join(' AND ');
    const sql = `UPDATE ${target} SET ${setSql} WHERE ${where}`;

    // Parameter order: new value first, then each pk value in order.
    const params = [value, ...pk.map((part) => part.value)];

    // ClickHouse has no UPDATE; refuse with a clear message instead of a
    // driver-level syntax error.
    if (kind === 'clickhouse') throw new Error('ClickHouse 不支持直接 UPDATE (ClickHouse does not support in-place UPDATE)');
    if (kind === 'mongodb') throw new Error('MongoDB 请在查询框用 updateMany 命令修改数据 (use an updateMany command for MongoDB)');
    if (NOSQL_KINDS.has(kind)) throw new Error(`${kind} 不支持 SQL UPDATE：请在查询框用原生命令修改数据 (${kind} has no SQL UPDATE — use the query box)`);

    const result = await handle.query(sql, params);
    const affected = Number(result.affectedRows ?? result.rowCount ?? 0);
    if (affected === 0) throw new Error('没有匹配的行，数据可能已被他人修改 (no matching row — it may have changed)');
    // Say what actually happened: the UPDATE already auto-committed, so the
    // old "rollback requested" wording was a lie. The PK guard is meant to
    // make >1 impossible; if it still happens, tell the user the truth.
    if (affected > 1) {
      throw new Error(`意外更新了 ${affected} 行，该语句已提交，请检查主键定位条件 (updated ${affected} rows — the statement committed; check the PK addressing)`);
    }
    return { affectedRows: affected, sql };
  }

  /**
   * Build the CREATE TABLE statement for the visual designer.
   *
   * The browser sends a plain description (table name + column list); ALL SQL
   * text is assembled here, engine by engine, with identifiers quoted through
   * quoteIdentFor and never any user value spliced raw. Default values are the
   * one literal that has to land in the DDL text (DDL does not take bind
   * parameters), so they are restricted to the validated charset below.
   */
  buildDdl({ kind, table, columns }, { database } = {}) {
    if (!DATABASE_KINDS[kind]) throw new Error(`unknown database kind: ${kind}`);
    if (kind === 'mongodb') throw new Error('MongoDB 无需建表，直接插入文档即可 (MongoDB creates collections implicitly)');
    if (NOSQL_KINDS.has(kind)) throw new Error(`${kind} 无表结构可建 (${kind} needs no CREATE TABLE)`);
    const name = String(table || '').trim();
    if (!name) throw new Error('缺少表名 (missing table name)');
    if (!Array.isArray(columns) || columns.length === 0) throw new Error('至少需要一个字段 (at least one column required)');

    // Pass 1 — normalize and validate every column against the shared list.
    const cols = columns.map((col, index) => {
      const def = DESIGNER_COLUMN_TYPES.find((t) => t.id === col.type);
      if (!def) throw new Error(`字段 ${index + 1}: 不支持的类型 "${col.type}" (unsupported column type)`);
      const cname = String(col.name || '').trim();
      if (!cname) throw new Error(`字段 ${index + 1}: 缺少字段名 (missing column name)`);
      let length = null;
      if (def.needsLength) {
        const raw = String(col.length ?? '').trim();
        if (raw !== '') {
          if (!/^\d+(,\d+)?$/.test(raw)) throw new Error(`字段 ${cname}: 长度只能是数字或 "总长,小数位"，如 255 / 10,2 (invalid length)`);
          length = raw;
        }
      }
      let hasDefault = false;
      let defaultValue = null;
      if (col.hasDefault === true) {
        const raw = String(col.default ?? '').trim();
        if (raw !== '') {
          // Three safe shapes only: a signed numeric literal, a single-quoted
          // string ('' escaped inside), or a bare keyword/identifier
          // (CURRENT_TIMESTAMP, NULL, now()...). The old charset whitelist
          // admitted `'` and `--` anywhere, so `'a' -- ` ate the rest of the
          // DDL line as a comment and pointed the syntax error at FOREIGN.
          const numeric = /^[+-]?\d+(\.\d+)?$/;
          const quotedString = /^'(?:[^']|'')*'$/;
          const keyword = /^[A-Za-z_][A-Za-z0-9_]*(\(\))?$/;
          if (!numeric.test(raw) && !quotedString.test(raw) && !keyword.test(raw)) {
            throw new Error(
              `字段 ${cname}: 默认值只支持 数字 / '字符串' / 关键字(如 CURRENT_TIMESTAMP、NULL) ` +
              `(default must be a number, a 'quoted string', or a keyword like CURRENT_TIMESTAMP)`
            );
          }
          hasDefault = true;
          defaultValue = raw;
        }
      }
      return {
        name: cname,
        type: def.id,
        length,
        pk: col.pk === true,
        notNull: col.notNull === true || col.pk === true,
        autoIncrement: col.autoIncrement === true,
        unique: col.unique === true,
        hasDefault,
        defaultValue,
        // Foreign key reference, "table.column" (both validated identifiers).
        fk: ConnectionManager.normalizeFkRef(col.fk),
      };
    });

    const pkCols = cols.filter((c) => c.pk);
    if (pkCols.length === 0) throw new Error('请勾选一个主键字段 (pick a primary key column)');
    const autoCols = cols.filter((c) => c.autoIncrement);
    if (autoCols.length > 1) throw new Error('自增字段只能有一个 (only one auto-increment column)');
    for (const col of autoCols) {
      if (!['integer', 'bigint'].includes(col.type)) throw new Error(`字段 ${col.name}: 只有整型字段才能自增 (only integer columns can auto-increment)`);
      if (!col.pk) throw new Error(`字段 ${col.name}: 自增字段必须同时是主键 (an auto-increment column must be the primary key)`);
    }
    const q = (n) => this.quoteIdentFor(kind, n);
    /** FOREIGN KEY clauses for every column carrying a reference. */
    const fkLines = cols
      .filter((c) => c.fk)
      .map((c) => `FOREIGN KEY (${q(c.name)}) REFERENCES ${q(c.fk.table)} (${q(c.fk.column)})`);
    /** Engine SQL for one logical type. */
    const typeSql = (col) => this.columnTypeSql(kind, col.type, col.length);

    const engine = kind === 'sqlite' ? 'sqlite' : kind;
    const target = database && kind !== 'sqlite' && kind !== 'clickhouse'
      ? `${q(database)}.${q(name)}`
      : q(name);

    let body;
    if (kind === 'mysql') {
      const lines = cols.map((col) => {
        let line = `${q(col.name)} ${typeSql(col)}`;
        if (col.autoIncrement) line += ' AUTO_INCREMENT';
        if (col.notNull) line += ' NOT NULL';
        if (col.unique && !col.pk) line += ' UNIQUE';
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        return line;
      });
      lines.push(`PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
      for (const fk of fkLines) lines.push(fk);
      body = lines.join(',\n  ');
      return `CREATE TABLE ${target} (\n  ${body}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
    }
    if (kind === 'sqlite') {
      const lines = cols.map((col) => {
        // AUTOINCREMENT demands the literal type name INTEGER ("INT PRIMARY
        // KEY AUTOINCREMENT" is a syntax error in SQLite).
        const type = col.pk && pkCols.length === 1 && col.autoIncrement ? 'INTEGER' : typeSql(col);
        let line = `${q(col.name)} ${type}`;
        if (col.pk && cols.filter((c) => c.pk).length === 1 && col.autoIncrement) line += ' PRIMARY KEY AUTOINCREMENT';
        else if (col.pk && pkCols.length === 1) line += ' PRIMARY KEY';
        if (col.notNull && !(col.pk && pkCols.length === 1)) line += ' NOT NULL';
        if (col.unique && !(col.pk && pkCols.length === 1)) line += ' UNIQUE';
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        return line;
      });
      if (pkCols.length > 1) lines.push(`PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
      for (const fk of fkLines) lines.push(fk);
      body = lines.join(',\n  ');
      return `CREATE TABLE ${q(name)} (\n  ${body}\n)`;
    }
    if (kind === 'postgres') {
      const lines = cols.map((col) => {
        // Postgres' native identity column beats a serial+sequence dance.
        let base = col.autoIncrement ? (col.type === 'bigint' ? 'BIGINT GENERATED ALWAYS AS IDENTITY' : 'INTEGER GENERATED ALWAYS AS IDENTITY') : typeSql(col);
        let line = `${q(col.name)} ${base}`;
        if (col.notNull) line += ' NOT NULL';
        if (col.unique && !col.pk) line += ' UNIQUE';
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        return line;
      });
      lines.push(`PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
      for (const fk of fkLines) lines.push(fk);
      body = lines.join(',\n  ');
      return `CREATE TABLE ${target} (\n  ${body}\n)`;
    }
    if (kind === 'mssql') {
      const lines = cols.map((col) => {
        let line = `${q(col.name)} ${typeSql(col)}`;
        if (col.autoIncrement) line += ' IDENTITY(1,1)';
        if (col.notNull) line += ' NOT NULL';
        if (col.unique && !col.pk) line += ' UNIQUE';
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        return line;
      });
      lines.push(`PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
      for (const fk of fkLines) lines.push(fk);
      body = lines.join(',\n  ');
      return `CREATE TABLE ${target} (\n  ${body}\n)`;
    }
    // ClickHouse: MergeTree needs an ORDER BY expression; the PK serves.
    // R3-3 修复：DEFAULT 之前被静默丢弃（UNIQUE 引擎不支持，前端仍会隐藏该项）。
    const lines = cols.map((col) => {
      let line = `${q(col.name)} ${typeSql(col)}`;
      if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
      return line;
    });
    body = lines.join(',\n  ');
    return `CREATE TABLE ${q(name)} (\n  ${body}\n) ENGINE = MergeTree ORDER BY (${pkCols.map((c) => q(c.name)).join(', ')})`;
  }

  /**
   * Engine SQL for one logical designer type. Shared by the CREATE builder
   * and the ALTER builder so both always agree on type rendering.
   */
  columnTypeSql(kind, typeId, length) {
    const col = { type: typeId, length };
    switch (typeId) {
      case 'integer': return kind === 'postgres' ? 'INTEGER' : 'INT';
      case 'bigint': return 'BIGINT';
      case 'varchar': return `VARCHAR(${length ?? '255'})`;
      case 'text': return kind === 'mssql' ? 'NVARCHAR(MAX)' : 'TEXT';
      case 'boolean': return kind === 'mssql' ? 'BIT' : kind === 'clickhouse' ? 'UInt8' : 'BOOLEAN';
      case 'date': return 'DATE';
      case 'datetime': return kind === 'mssql' ? 'DATETIME2' : kind === 'postgres' ? 'TIMESTAMP' : kind === 'sqlite' ? 'TEXT' : 'DATETIME';
      case 'decimal': return `NUMERIC(${length ?? '10,2'})`;
      case 'float': return kind === 'clickhouse' ? 'Float64' : 'FLOAT';
      case 'json': return kind === 'postgres' ? 'JSONB' : kind === 'mssql' ? 'NVARCHAR(MAX)' : kind === 'sqlite' ? 'TEXT' : 'JSON';
      case 'blob': return kind === 'mssql' ? 'VARBINARY(MAX)' : kind === 'postgres' ? 'BYTEA' : 'BLOB';
      default: throw new Error(`unsupported type: ${typeId}`);
    }
  }

  /** Normalize one designer column (name/type/length/flags) or throw. Shared by CREATE and ALTER. */
  normalizeColumn(col, index, kind) {
    const def = DESIGNER_COLUMN_TYPES.find((t) => t.id === col.type);
    if (!def) throw new Error(`字段 ${index + 1}: 不支持的类型 "${col.type}" (unsupported column type)`);
    const cname = String(col.name || '').trim();
    if (!cname) throw new Error(`字段 ${index + 1}: 缺少字段名 (missing column name)`);
    let length = null;
    if (def.needsLength) {
      const raw = String(col.length ?? '').trim();
      if (raw !== '') {
        if (!/^\d+(,\d+)?$/.test(raw)) throw new Error(`字段 ${cname}: 长度只能是数字或 "总长,小数位"，如 255 / 10,2 (invalid length)`);
        length = raw;
      }
    }
    let hasDefault = false;
    let defaultValue = null;
    if (col.hasDefault === true) {
      const raw = String(col.default ?? '').trim();
      if (raw !== '') {
        // Same three safe shapes as buildDdl (numeric / quoted string / keyword).
        const numeric = /^[+-]?\d+(\.\d+)?$/;
        const quotedString = /^'(?:[^']|'')*'$/;
        const keyword = /^[A-Za-z_][A-Za-z0-9_]*(\(\))?$/;
        if (!numeric.test(raw) && !quotedString.test(raw) && !keyword.test(raw)) {
          throw new Error(
            `字段 ${cname}: 默认值只支持 数字 / '字符串' / 关键字(如 CURRENT_TIMESTAMP、NULL) ` +
            `(default must be a number, a 'quoted string', or a keyword like CURRENT_TIMESTAMP)`
          );
        }
        hasDefault = true;
        defaultValue = raw;
      }
    }
    return {
      name: cname,
      type: def.id,
      length,
      pk: col.pk === true,
      notNull: col.notNull === true || col.pk === true,
      autoIncrement: col.autoIncrement === true && ['integer', 'bigint'].includes(def.id),
      unique: col.unique === true,
      hasDefault,
      defaultValue,
    };
  }

  /** Names of the columns an existing table actually has, engine-native. */
  async actualColumns(kind, handle, database, table) {
    if (kind === 'sqlite') {
      const { rows } = await handle.query(`PRAGMA table_info(${this.quoteIdentFor(kind, table)})`);
      return rows.map((r) => r.name);
    }
    if (kind === 'mysql') {
      const { rows } = await handle.query(`SHOW COLUMNS FROM ${this.qualifiedTable(kind, database, table)}`);
      return rows.map((r) => r.Field);
    }
    if (kind === 'postgres') {
      const schema = database && database !== '(file)' ? database : 'public';
      const { rows } = await handle.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table]
      );
      return rows.map((r) => r.column_name);
    }
    if (kind === 'mssql') {
      const { rows } = await handle.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = '${String(table).replace(/'/g, "''")}' ORDER BY ORDINAL_POSITION`
      );
      return rows.map((r) => r.COLUMN_NAME);
    }
    if (kind === 'clickhouse') {
      const { rows } = await handle.query(`DESCRIBE TABLE ${this.qualifiedTable(kind, database, table)}`);
      return rows.map((r) => Object.values(r)[0]);
    }
    return [];
  }

  /**
   * Visual table creation: build the DDL on the host and run it against the
   * live connection. Returns the generated SQL so the panel can show what
   * happened (and the user can learn from it).
   */
  async createTable({ id, database, table, columns }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    if (entry.kind === 'mongodb' || NOSQL_KINDS.has(entry.kind)) throw new Error('该引擎无需建表 (this engine needs no CREATE TABLE)');
    const sql = this.buildDdl({ kind: entry.kind, table, columns }, { database });
    await entry.handle.query(sql);
    return { ok: true, sql };
  }

  /**
   * Change an existing table's columns from the table editor.
   *
   * add: name/type/length/notNull/default/unique (per engine support); drop:
   * by name. PK / auto-increment changes are refused on purpose — altering a
   * primary key rewrites the table and silently breaks every foreign key
   * pointing at it; the UI hides those controls in edit mode. SQLite has no
   * DROP COLUMN before 3.35 (DSH ships Node 24 → SQLite 3.45+, so DROP works,
   * but ADDing a NOT NULL column needs a DEFAULT — enforced here).
   */
  async alterTable({ id, database, table, add, drop }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (kind === 'mongodb' || NOSQL_KINDS.has(kind)) throw new Error('该引擎无表结构可改 (this engine has no schema to alter)');
    if (kind === 'clickhouse') throw new Error('ClickHouse 请用 ALTER TABLE ... ADD COLUMN 手工执行 (not supported in the designer yet)');
    const target = this.qualifiedTable(kind, database, table);
    const existing = new Set((await this.actualColumns(kind, entry.handle, database, table)).map((c) => c.toLowerCase()));
    const statements = [];

    const dropList = Array.isArray(drop) ? drop.filter((d) => typeof d === 'string' && d) : [];
    const addList = Array.isArray(add) ? add : [];
    if (dropList.length === 0 && addList.length === 0) throw new Error('没有要修改的内容 (nothing to change)');
    // Guard: dropping every column is never what anyone wants.
    if (dropList.length > 0 && addList.length === 0 && existing.size === dropList.length) {
      throw new Error('不能删除表的全部字段 (cannot drop every column)');
    }
    for (const name of dropList) {
      if (!existing.has(String(name).toLowerCase())) throw new Error(`字段 ${name} 不存在 (column does not exist)`);
      statements.push(`ALTER TABLE ${target} DROP COLUMN ${this.quoteIdentFor(kind, name)}`);
    }
    for (const raw of addList) {
      const col = this.normalizeColumn(raw, statements.length, kind);
      if (col.pk) throw new Error('编辑模式不能改主键 (primary key cannot be changed here)');
      if (col.autoIncrement) throw new Error('编辑模式不能加自增字段 (auto-increment cannot be added here)');
      if (existing.has(col.name.toLowerCase())) throw new Error(`字段 ${col.name} 已存在 (column already exists)`);
      // SQLite: ADD COLUMN with NOT NULL requires a non-null default.
      if (kind === 'sqlite' && col.notNull && !col.hasDefault) {
        throw new Error(`字段 ${col.name}: SQLite 加非空字段必须同时给默认值 (SQLite needs a DEFAULT for NOT NULL columns)`);
      }
      let line = `${this.quoteIdentFor(kind, col.name)} ${this.columnTypeSql(kind, col.type, col.length)}`;
      if (kind === 'mysql') {
        if (col.notNull) line += ' NOT NULL';
        if (col.unique) line += ' UNIQUE';
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
      } else {
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        if (col.notNull) line += ' NOT NULL';
        if (col.unique && kind === 'sqlite') throw new Error(`字段 ${col.name}: SQLite 的 ADD COLUMN 不支持 UNIQUE，请去掉勾选 (SQLite cannot ADD a UNIQUE column)`);
        if (col.unique && kind !== 'mssql' && kind !== 'sqlite') line += ' UNIQUE';
      }
      statements.push(`ALTER TABLE ${target} ADD COLUMN ${line}`);
    }
    for (const sql of statements) {
      await entry.handle.query(sql);
    }
    return { ok: true, sql: statements.join(';\n'), changed: statements.length };
  }

  // ---------------------------------------------------------------------
  // Export / import (Navicat-style data transfer)
  // ---------------------------------------------------------------------

  /** Fully qualified table reference for export/import, per engine. */
  qualifiedTable(kind, database, table) {
    const q = (n) => this.quoteIdentFor(kind, n);
    if (database && kind !== 'sqlite' && kind !== 'clickhouse') return `${q(database)}.${q(table)}`;
    return q(table);
  }

  /** One value as a SQL literal for INSERT text (export format "sql"). */
  sqlLiteral(kind, value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'boolean') return kind === 'sqlite' ? (value ? '1' : '0') : (value ? 'TRUE' : 'FALSE');
    let s;
    if (typeof value === 'string') s = value;
    else if (value instanceof Date) s = value.toISOString();
    else s = JSON.stringify(value);
    // MySQL and ClickHouse interpret backslash escapes inside literals, so a
    // literal backslash must be doubled there (a `\` in the data used to eat
    // the closing quote and corrupt the generated statement); the rest only
    // need quote doubling.
    const escaped = kind === 'mysql' || kind === 'clickhouse'
      ? s.replace(/\\/g, '\\\\').replace(/'/g, "''")
      : s.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  /** CSV field encoding: NULL stays empty, an empty string becomes "". */
  csvField(value) {
    if (value === null || value === undefined) return '';
    let s;
    let isString = false;
    if (typeof value === 'string') { s = value; isString = true; }
    else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
    else if (value instanceof Date) s = value.toISOString();
    else s = JSON.stringify(value);
    if (s === '') return '""'; // quoted-empty survives the round trip as ""
    // CSV formula injection: a cell that Excel/LibreOffice evaluates when the
    // file opens (=cmd | @SUM | +... tabs...). Only TEXT cells get the guard —
    // real numbers (the number branch above) can never carry these prefixes.
    // Applied BEFORE the quoting rule so the defusing apostrophe stays the
    // first character of the decoded value.
    if (isString && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  /** "table.column" → { table, column }, or null; rejects bad characters. */
  static normalizeFkRef(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '') return null;
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!m) throw new Error(`外键引用要写成 表名.字段名，如 users.id (foreign key reference must be "table.column")`);
    return { table: m[1], column: m[2] };
  }

  /** Minimal RFC4180-ish CSV reader: quoted fields, "" escapes, CRLF. */
  static parseCsv(text) {
    const clean = String(text).replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* \r\n and bare \r both end nothing here; \n terminates */ }
      else field += ch;
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter((r) => !(r.length === 1 && r[0] === ''));
  }

  /**
   * The live CREATE TABLE statement of an existing table — the "structure
   * export". Engines with a native SHOW CREATE return it verbatim; the rest
   * get a faithful DDL assembled from information_schema. A structure-only
   * export must also carry indexes, so MySQL keeps KEY lines and Postgres
   * appends CREATE INDEX statements.
   */
  async showCreateTable({ id, database, table }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (kind === 'mongodb' || NOSQL_KINDS.has(kind)) throw new Error('该引擎无建表语句 (this engine has no CREATE TABLE)');
    const target = this.qualifiedTable(kind, database, table);

    if (kind === 'sqlite') {
      const { rows } = await entry.handle.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table]
      );
      const ddl = rows[0]?.sql;
      if (!ddl) throw new Error(`找不到表 ${table} (table not found)`);
      return ddl + ';';
    }
    if (kind === 'mysql') {
      const { rows } = await entry.handle.query(`SHOW CREATE TABLE ${target}`);
      const row = rows[0] ?? {};
      const ddl = row['Create Table'] ?? Object.values(row)[1] ?? Object.values(row)[0];
      if (!ddl) throw new Error(`找不到表 ${table} (table not found)`);
      return ddl + ';';
    }
    if (kind === 'clickhouse') {
      const { rows } = await entry.handle.query(`SHOW CREATE TABLE ${target}`);
      const ddl = Object.values(rows[0] ?? {})[0];
      if (!ddl) throw new Error(`找不到表 ${table} (table not found)`);
      return ddl;
    }
    if (kind === 'postgres') {
      // information_schema → assembled DDL. pg's catalog (pg_get_schemadef)
      // is not exposed over plain SQL without superuser helpers, so build it.
      const schema = database && database !== '(file)' ? database : 'public';
      const { rows: cols } = await entry.handle.query(
        `SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table]
      );
      if (cols.length === 0) throw new Error(`找不到表 ${schema}.${table} (table not found)`);
      const { rows: tcs } = await entry.handle.query(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'`,
        [schema, table]
      );
      const pkSet = new Set(tcs.map((r) => r.column_name));
      const lines = cols.map((c) => {
        let type = c.data_type;
        if (type === 'character varying') type = c.character_maximum_length ? `VARCHAR(${c.character_maximum_length})` : 'VARCHAR';
        else if (type === 'numeric') type = c.numeric_precision ? `NUMERIC(${c.numeric_precision},${c.numeric_scale ?? 0})` : 'NUMERIC';
        else type = type.toUpperCase();
        let line = `${this.quoteIdentFor('postgres', c.column_name)} ${type}`;
        // serial 列的 nextval 默认值不能还原成 IDENTITY（重新执行会失败）——输出 SERIAL 语义
        if (c.column_default && /nextval\(/.test(c.column_default)) line += ' SERIAL';
        else if (c.column_default) line += ` DEFAULT ${c.column_default}`;
        if (c.is_nullable === 'NO' && !pkSet.has(c.column_name)) line += ' NOT NULL';
        return line;
      });
      if (pkSet.size > 0) lines.push(`PRIMARY KEY (${[...pkSet].map((c) => this.quoteIdentFor('postgres', c)).join(', ')})`);
      let ddl = `CREATE TABLE ${this.quoteIdentFor('postgres', schema)}.${this.quoteIdentFor('postgres', table)} (\n  ${lines.join(',\n  ')}\n);`;
      // Indexes beyond the PK keep round-tripping.
      const { rows: idx } = await entry.handle.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef NOT LIKE '%_pkey%'`,
        [schema, table]
      );
      if (idx.length > 0) ddl += '\n' + idx.map((r) => r.indexdef + ';').join('\n');
      return ddl;
    }
    // mssql
    const { rows: cols } = await entry.handle.query(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE, COLUMN_DEFAULT
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = '${String(table).replace(/'/g, "''")}' ORDER BY ORDINAL_POSITION`
    );
    if (cols.length === 0) throw new Error(`找不到表 dbo.${table} (table not found)`);
    const { rows: tcs } = await entry.handle.query(
      `SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
       WHERE tc.TABLE_SCHEMA = 'dbo' AND tc.TABLE_NAME = '${String(table).replace(/'/g, "''")}' AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`
    );
    const pkSet = new Set(tcs.map((r) => r.COLUMN_NAME));
    const lines = cols.map((c) => {
      let type = c.DATA_TYPE;
      if (['varchar', 'nvarchar', 'char', 'nchar'].includes(type)) type = `${type.toUpperCase()}(${c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : c.CHARACTER_MAXIMUM_LENGTH})`;
      else if (['decimal', 'numeric'].includes(type)) type = `${type.toUpperCase()}(${c.NUMERIC_PRECISION},${c.NUMERIC_SCALE ?? 0})`;
      else type = type.toUpperCase();
      let line = `[${c.COLUMN_NAME}] ${type}`;
      if (c.IS_NULLABLE === 'NO') line += ' NOT NULL';
      return line;
    });
    if (pkSet.size > 0) lines.push(`PRIMARY KEY (${[...pkSet].map((c) => `[${c}]`).join(', ')})`);
    return `CREATE TABLE ${database ? `[${database}].` : ''}[dbo].[${table}] (\n  ${lines.join(',\n  ')}\n);`;
  }

  /** Read one table (or collection) fully for export. */
  async exportTable({ id, database, table, format }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    const fmt = ['csv', 'json', 'sql', 'sql-structure', 'md'].includes(format) ? format : 'csv';
    if (kind === 'mongodb' && fmt !== 'json') throw new Error('MongoDB 仅支持 JSON 导出 (MongoDB exports JSON only)');
    if (kind === 'redis') throw new Error('Redis 暂不支持面板导出，请在查询框用 SCAN / DUMP 自行保存 (Redis export is not supported yet)');
    if (kind === 'elasticsearch' || kind === 'qdrant') {
      if (fmt !== 'json') throw new Error('Elasticsearch / Qdrant 仅支持 JSON 导出 (JSON export only)');
      const all = (await entry.handle.exportAll(table)).slice(0, EXPORT_ROW_CAP);
      const columns = all.length ? Object.keys(all[0]) : [];
      return { content: JSON.stringify(all, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2), contentType: 'application/json', ext: 'json', rowCount: all.length, truncated: all.length >= EXPORT_ROW_CAP, columns };
    }

    // Structure export: just the DDL, no rows.
    if (fmt === 'sql-structure') {
      const ddl = await this.showCreateTable({ id, database, table });
      const header = `-- dsh-database structure export\n-- table: ${table} · ${new Date().toISOString()}\n\n`;
      return { content: header + ddl, contentType: 'application/sql', ext: 'sql', rowCount: 0, truncated: false, columns: [] };
    }

    let rows;
    if (kind === 'mongodb') {
      const r = await entry.handle.query(JSON.stringify({ database, collection: table, command: 'find', limit: EXPORT_ROW_CAP + 1 }));
      rows = r.rows ?? [];
    } else {
      const target = this.qualifiedTable(kind, database, table);
      const r = await entry.handle.query(`SELECT * FROM ${target}`);
      rows = r.rows ?? [];
    }
    const truncated = rows.length > EXPORT_ROW_CAP;
    rows = rows.slice(0, EXPORT_ROW_CAP);

    let columns = [];
    if (kind === 'mongodb') {
      for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    } else {
      const r = await entry.handle.query(`SELECT * FROM ${this.qualifiedTable(kind, database, table)} WHERE 1 = 0`);
      columns = (r.fields ?? []).map((f) => f.name);
      if (columns.length === 0 && rows.length > 0) columns = Object.keys(rows[0]);
    }

    if (fmt === 'json') {
      const content = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2);
      return { content, contentType: 'application/json', ext: 'json', rowCount: rows.length, truncated, columns };
    }
    if (fmt === 'csv') {
      const lines = [columns.map((c) => this.csvField(c)).join(',')];
      for (const row of rows) lines.push(columns.map((c) => this.csvField(row[c])).join(','));
      // BOM so Excel reads UTF-8 Chinese correctly on double-click.
      return { content: '\uFEFF' + lines.join('\r\n'), contentType: 'text/csv', ext: 'csv', rowCount: rows.length, truncated, columns };
    }
    if (fmt === 'md') {
      // Markdown 表格导出（0.9.0）：竖线转义、换行压平
      const esc = (v) => String(v ?? '').replace(/\|/g, '\|').replace(/\r?\n/g, ' ');
      const lines = [`| ${columns.map((c) => esc(c)).join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`];
      for (const row of rows) lines.push(`| ${columns.map((c) => esc(row[c])).join(' | ')} |`);
      return { content: lines.join('\n'), contentType: 'text/markdown', ext: 'md', rowCount: rows.length, truncated, columns };
    }
    // SQL INSERTs, batched so one statement never explodes in size. The data
    // export leads with the CREATE TABLE (mysqldump style) so the file can
    // rebuild the table elsewhere before loading rows into it.
    const ddl = await this.showCreateTable({ id, database, table }).catch(() => null);
    const target = kind === 'sqlite' || kind === 'clickhouse'
      ? this.quoteIdentFor(kind, table)
      : this.qualifiedTable(kind, database, table);
    const colList = columns.map((c) => this.quoteIdentFor(kind, c)).join(', ');
    const batchRows = Math.min(100, Math.max(1, Math.floor(900 / Math.max(1, columns.length))));
    const parts = [];
    for (let i = 0; i < rows.length; i += batchRows) {
      const batch = rows.slice(i, i + batchRows);
      const values = batch.map((row) => `(${columns.map((c) => this.sqlLiteral(kind, row[c])).join(', ')})`).join(',\n  ');
      parts.push(`INSERT INTO ${target} (${colList}) VALUES\n  ${values};`);
    }
    const header = ddl ? `${ddl}\n\n` : '';
    return { content: header + parts.join('\n\n'), contentType: 'application/sql', ext: 'sql', rowCount: rows.length, truncated, columns };
  }

  /**
   * Import rows into an existing table. CSV: first line = column names,
   * empty cells become NULL. JSON: an object or array of objects keyed by
   * column name. Inserts run in parameterized batches (inline literals only
   * for ClickHouse, whose HTTP wrapper takes no bind parameters).
   */
  async importTable({ id, database, table, format, content, dryRun }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (kind === 'mongodb') throw new Error('MongoDB 请在查询框用 insertMany 命令导入 (use an insertMany command for MongoDB)');
    if (NOSQL_KINDS.has(kind)) throw new Error(`${kind} 暂不支持文件导入，请在查询框用原生命令批量写入 (${kind} file import is not supported yet — use the query box)`);
    if (typeof content !== 'string' || content.trim() === '') throw new Error('没有可导入的内容 (nothing to import)');

    let objects;
    if (format === 'json') {
      let parsed;
      try { parsed = JSON.parse(content); } catch (error) { throw new Error(`JSON 解析失败: ${error.message}`); }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      objects = list.filter((o) => o !== null && typeof o === 'object' && !Array.isArray(o));
      if (objects.length === 0) throw new Error('JSON 需要是对象或对象数组 (expected an object or an array of objects)');
    } else {
      const grid = ConnectionManager.parseCsv(content);
      if (grid.length < 2 && grid[0]?.every((c) => c.trim() === '')) throw new Error('CSV 需要首行列名 + 至少一行数据 (header row plus at least one data row)');
      const header = (grid.shift() ?? []).map((name, i) => String(name).trim() || `col_${i + 1}`);
      const seen = new Set();
      const columns = header.map((name) => {
        let unique = name; let n = 2;
        while (seen.has(unique)) unique = `${name}_${n++}`;
        seen.add(unique);
        return unique;
      });
      objects = grid.map((cells) => Object.fromEntries(columns.map((c, i) => [c, cells[i] ?? ''])));
    }
    if (objects.length === 0) return { inserted: 0 };
    // Remember the ORIGINAL count before capping: `total` must tell the user
    // how many rows the file carried, and `truncated` must flag the cut — the
    // old slice-then-count answered total:50000 for a 50001-row file and the
    // missing row was undetectable.
    const originalTotal = objects.length;
    let truncated = false;
    if (objects.length > IMPORT_ROW_CAP) { objects = objects.slice(0, IMPORT_ROW_CAP); truncated = true; }

    // File columns (CSV header order; JSON union of keys, capped).
    const fileColumns = format === 'json'
      ? (() => { const keys = []; for (const o of objects) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k); return keys.slice(0, 256); })()
      : Object.keys(objects[0]);

    // Match file columns to the TABLE's real columns (case-insensitive): a
    // CSV headed "ID,name" imports into a table with "id,name", extra file
    // columns are ignored with a notice, and a total mismatch fails with
    // BOTH column lists instead of a driver-level "Unknown column" from row
    // 180 (the 2026-10-01 city table incident).
    const tableColumns = await this.actualColumns(kind, entry.handle, database, table);
    if (tableColumns.length === 0) throw new Error(`找不到目标表或表没有字段: ${table} (target table missing or has no columns)`);
    const tableLookup = new Map(tableColumns.map((c) => [c.toLowerCase(), c]));
    const matched = []; // { fileKey, tableCol }
    const unmatchedFile = [];
    for (const key of fileColumns) {
      const hit = tableLookup.get(String(key).toLowerCase());
      if (hit) matched.push({ fileKey: key, tableCol: hit });
      else unmatchedFile.push(key);
    }
    if (matched.length === 0) {
      throw new Error(
        `文件列与表列完全不匹配。文件列: [${fileColumns.join(', ')}]；表 ${table} 的列: [${tableColumns.join(', ')}]` +
        ` (file columns match none of the table's columns)`
      );
    }
    if (dryRun === true) {
      // 映射预览（0.9.0）：不写库，把列匹配结果回给前端确认
      return { dryRun: true, total: objects.length, fileColumns, tableColumns, matched: matched.map((m) => ({ file: m.fileKey, column: m.tableCol })), unmatchedFile, sample: objects.slice(0, 3).map((o) => matched.map((m) => o[m.fileKey] ?? null)) };
    }
    const columns = matched.map((m) => m.tableCol); // canonical, engine-quoted safely
    const getValue = (row, fileKey) => row[fileKey];
    const skippedNote = unmatchedFile.length > 0 ? `；已忽略文件中的多余列: [${unmatchedFile.join(', ')}]` : '';

    const toParam = (value) => {
      if (value === null || value === undefined || value === '') return null; // empty cell → NULL
      if (typeof value === 'string' && value === 'NULL') return null;
      if (typeof value === 'object') return JSON.stringify(value);
      return value;
    };

    const target = this.qualifiedTable(kind, database, table);
    const colList = columns.map((c) => this.quoteIdentFor(kind, c)).join(', ');
    // Engine dialect placeholders ($n / @pN / ?) — a bare `?` is only valid
    // for mysql2 and node:sqlite; pg and mssql imports used to fail at 400.
    const oneRow = (base) => `(${columns.map((_c, i) => this.placeholder(kind, base + i)).join(', ')})`;
    const batchRows = Math.max(1, Math.floor(900 / Math.max(1, columns.length)));
    // ClickHouse's HTTP wrapper takes no bind parameters — inline literals
    // there (values pass through sqlLiteral, same as the SQL export path);
    // every other engine uses parameterized inserts.
    const useParams = kind !== 'clickhouse';
    let inserted = 0;
    for (let start = 0; start < objects.length; start += batchRows) {
      const batch = objects.slice(start, start + batchRows);
      const end = start + batch.length;
      const sql = useParams
        ? `INSERT INTO ${target} (${colList}) VALUES ${batch.map((_row, r) => oneRow(r * columns.length)).join(', ')}`
        : `INSERT INTO ${target} (${colList}) VALUES ${batch.map((row) => `(${columns.map((_c, i) => this.sqlLiteral(kind, toParam(getValue(row, matched[i].fileKey)))).join(', ')})`).join(', ')}`;
      const params = useParams ? batch.flatMap((row) => columns.map((_c, i) => toParam(getValue(row, matched[i].fileKey)))) : undefined;
      try {
        const result = await entry.handle.query(sql, params);
        inserted += Number(result.affectedRows ?? result.rowCount ?? batch.length);
      } catch (error) {
        throw new Error(`第 ${start + 1}-${end} 行导入失败: ${error?.message || error}` + skippedNote);
      }
    }
    return { inserted, total: originalTotal, truncated, note: skippedNote || undefined };
  }

  /** Schema tree for one live connection (databases > tables > columns). */
  async schema(profileId) {
    const handle = this.liveHandle(profileId);
    if (!handle) throw new Error(`连接未打开：${profileId ?? '未指定'}，请先点「连接」/ connection is not open — press Connect first`);
    switch (handle.kind) {
      case 'sqlite': return this.schemaSqlite(handle);
      case 'mysql': return this.schemaMysql(handle);
      case 'postgres': return this.schemaPostgres(handle);
      case 'mssql': return this.schemaMssql(handle);
      case 'mongodb': return this.schemaMongo(handle);
      case 'clickhouse': return this.schemaClickHouse(handle);
      case 'redis':
      case 'elasticsearch':
      case 'qdrant': return schemaNoSql(handle);
      default: throw new Error(`schema unsupported for ${handle.kind}`);
    }
  }

  async schemaSqlite(handle) {
    const { rows: tables } = await handle.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const { rows: views } = await handle.query(
      "SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const out = [];
    for (const table of tables) {
      const { rows: columns } = await handle.query(`PRAGMA table_info(${this.quoteIdentFor('sqlite', table.name)})`);
      out.push({
        name: table.name, kind: 'table',
        columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.notnull === 0, key: c.pk ? 'PK' : null })),
      });
    }
    for (const view of views) {
      const { rows: columns } = await handle.query(`PRAGMA table_info(${this.quoteIdentFor('sqlite', view.name)})`);
      out.push({
        name: view.name, kind: 'view',
        columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: true, key: null })),
      });
    }
    return { engine: 'sqlite', databases: [{ name: '(file)', tables: out }] };
  }

  async schemaMysql(handle) {
    const { rows: dbs } = await handle.query('SHOW DATABASES');
    const skip = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
    const databases = [];
    for (const row of dbs) {
      const name = row.Database || Object.values(row)[0];
      if (skip.has(name)) continue;
      const { rows: tables } = await handle.query(`SHOW FULL TABLES FROM ${this.quoteIdentFor('mysql', name)}`);
      const tableNodes = [];
      for (const t of tables) {
        const tname = t[`Tables_in_${name}`] || Object.values(t)[0];
        const kind = Object.values(t)[1] === 'VIEW' ? 'view' : 'table';
        const { rows: columns } = await handle.query(`SHOW COLUMNS FROM ${this.quoteIdentFor('mysql', name)}.${this.quoteIdentFor('mysql', tname)}`);
        tableNodes.push({
          name: tname, kind,
          columns: columns.map((c) => ({ name: c.Field, type: c.Type, nullable: c.Null === 'YES', key: c.Key || null })),
        });
      }
      databases.push({ name, tables: tableNodes });
    }
    return { engine: 'mysql', databases };
  }

  async schemaPostgres(handle) {
    const { rows } = await handle.query(
      `SELECT table_schema, table_name, table_type FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_schema, table_name`
    );
    const { rows: columns } = await handle.query(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY ordinal_position`
    );
    // B-3 修复：查主键列，让 Postgres 的表格可编辑（此前 key 恒为 null → 永远只读）
    const { rows: pgPks } = await handle.query(
      `SELECT kcu.table_schema, kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema NOT IN ('pg_catalog','information_schema')`
    );
    const pgPkSet = new Set(pgPks.map((r) => `${r.table_schema}.${r.table_name}.${r.column_name}`));
    const byTable = new Map();
    for (const c of columns) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', key: pgPkSet.has(`${c.table_schema}.${c.table_name}.${c.column_name}`) ? 'PRI' : null });
    }
    const byDb = new Map();
    for (const t of rows) {
      const schema = t.table_schema;
      if (!byDb.has(schema)) byDb.set(schema, []);
      byDb.get(schema).push({
        name: t.table_name,
        kind: t.table_type === 'VIEW' ? 'view' : 'table',
        columns: byTable.get(`${t.table_schema}.${t.table_name}`) || [],
      });
    }
    return { engine: 'postgres', databases: [...byDb.entries()].map(([name, tables]) => ({ name, tables })) };
  }

  async schemaMssql(handle) {
    const { rows } = await handle.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA','guest')
       ORDER BY TABLE_SCHEMA, TABLE_NAME`
    );
    const { rows: columns } = await handle.query(
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA','guest')
       ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`
    );
    // B-3 修复：MSSQL 同样补 PK 检测
    const { rows: msPks } = await handle.query(
      `SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
         ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
         AND tc.TABLE_SCHEMA NOT IN ('sys','INFORMATION_SCHEMA','guest')`
    );
    const msPkSet = new Set(msPks.map((r) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}.${r.COLUMN_NAME}`));
    const byTable = new Map();
    for (const c of columns) {
      const key = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push({ name: c.COLUMN_NAME, type: c.DATA_TYPE, nullable: c.IS_NULLABLE === 'YES', key: msPkSet.has(`${c.TABLE_SCHEMA}.${c.TABLE_NAME}.${c.COLUMN_NAME}`) ? 'PRI' : null });
    }
    const byDb = new Map();
    for (const t of rows) {
      const schema = t.TABLE_SCHEMA;
      if (!byDb.has(schema)) byDb.set(schema, []);
      byDb.get(schema).push({
        name: t.TABLE_NAME,
        kind: t.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
        columns: byTable.get(`${t.TABLE_SCHEMA}.${t.TABLE_NAME}`) || [],
      });
    }
    return { engine: 'mssql', databases: [...byDb.entries()].map(([name, tables]) => ({ name, tables })) };
  }

  async schemaMongo(handle) {
    // Filled by the route layer, which has the client handle for listDatabases.
    return { engine: 'mongodb', databases: [{ name: '(use query)', tables: [] }] };
  }

  async schemaClickHouse(handle) {
    const { rows } = await handle.query('SHOW TABLES');
    const tables = rows.map((r) => ({ name: Object.values(r)[0], kind: 'table', columns: [] }));
    return { engine: 'clickhouse', databases: [{ name: 'default', tables }] };
  }
  /**
   * 0.9.0 E-R 关系图数据：库内表/列/外键，前端以 SVG 渲染。
   * sqlite/mysql/postgres/mssql 支持；其余引擎明确拒绝。
   */
  async erGraph({ id, database }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    if (database && database !== '(file)') return introspectEr(entry.handle, entry.kind, database);
    // sqlite：database 参数是文件路径，忽略即可
    return introspectEr(entry.handle, entry.kind, entry.kind === 'sqlite' ? null : (database || null));
  }

  /**
   * 0.9.0 服务端分页浏览：LIMIT/OFFSET + 排序 + 过滤（值全部绑定），附 COUNT。
   * redis/qdrant 无分页语义，回落 handle.peek 全量采样。
   */
  async peekPage({ id, database, table, page = 1, pageSize = 200, sort, filter }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    page = Math.min(100000, Math.max(1, Number(page) || 1));
    pageSize = [10, 50, 100, 200, 500, 1000].includes(Number(pageSize)) ? Number(pageSize) : 200;
    const paginatedKinds = ['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse', 'mongodb', 'elasticsearch'];
    if (!paginatedKinds.includes(kind)) {
      const r = await entry.handle.peek(table);
      const rows = r.rows ?? [];
      return { rows, fields: r.fields ?? [], rowCount: rows.length, total: rows.length, page: 1, pageSize: rows.length || 1, paginated: false };
    }
    let whereSql = '', whereParams = [], mongoFilter = null;
    if (filter && filter.column && filter.value != null && String(filter.value) !== '') {
      const col = String(filter.column);
      const op = ['=', '!=', '>', '<', '>=', '<=', 'like'].includes(filter.op) ? filter.op : 'like';
      const val = String(filter.value);
      if (kind === 'mongodb') {
        if (op === 'like') mongoFilter = { [col]: { $regex: val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
        else if (op === '!=') mongoFilter = { [col]: { $ne: val } };
        else if (op === '=') mongoFilter = { [col]: val };
        else mongoFilter = { [col]: { [op === '>=' ? '$gte' : op === '<=' ? '$lte' : op]: val } };
      } else if (kind !== 'elasticsearch') {
        const qc = this.quoteIdentFor(kind, col);
        if (kind === 'clickhouse') {
          // ClickHouse 的 HTTP 通道无绑定参数 → 内联字面量（与导入同策略）；
          // LIKE 对数字列需 toString（R8）
          const lit = this.sqlLiteral('clickhouse', op === 'like' ? `%${val}%` : val);
          const likeCol = op === 'like' ? `toString(${qc})` : qc;
          whereSql = ` WHERE ${likeCol} ${op === 'like' ? 'LIKE' : op === '!=' ? '<>' : op} ${lit}`;
        } else {
          // R8：LIKE 在 PG/ClickHouse 对数字列会报类型错——CAST 成文本再比
          // （mysql/mssql/sqlite 有隐式转换，保持原样）
          const likeCol = kind === 'postgres' ? `CAST(${qc} AS TEXT)` : kind === 'clickhouse' ? `toString(${qc})` : qc;
          if (op === 'like') { whereSql = ` WHERE ${likeCol} LIKE ${this.placeholder(kind, 0)}`; whereParams = [`%${val}%`]; }
          else { whereSql = ` WHERE ${qc} ${op === '!=' ? '<>' : op} ${this.placeholder(kind, 0)}`; whereParams = [val]; }
        }
      }
    }
    const sortDir = sort && String(sort.dir).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const sortCol = sort && sort.column ? this.quoteIdentFor(kind, String(sort.column)) : null;
    const off = (page - 1) * pageSize;
    if (kind === 'elasticsearch') return entry.handle.peekPage({ index: table, page, pageSize, sort, filter });
    if (kind === 'mongodb') {
      const cmd = { database, collection: table, command: 'find', skip: off, limit: pageSize };
      if (sortCol) cmd.sort = { [String(sort.column)]: sortDir === 'DESC' ? -1 : 1 };
      if (mongoFilter) cmd.filter = mongoFilter;
      const r = await entry.handle.query(JSON.stringify(cmd));
      const c = await entry.handle.query(JSON.stringify({ database, collection: table, command: 'count', filter: mongoFilter ?? {} }));
      return { rows: r.rows ?? [], fields: r.fields ?? [], rowCount: r.rows?.length ?? 0, total: Number(c.rows?.[0]?.count ?? 0), page, pageSize, paginated: true };
    }
    const target = this.qualifiedTable(kind, database, table);
    const countR = await entry.handle.query(`SELECT COUNT(*) AS c FROM ${target}${whereSql}`, kind === 'clickhouse' ? undefined : whereParams);
    const total = Number(Object.values(countR.rows?.[0] ?? {})[0] ?? 0);
    let sql;
    if (kind === 'mssql') {
      sql = `SELECT * FROM ${target}${whereSql} ORDER BY ${sortCol ? `${sortCol} ${sortDir}` : '(SELECT NULL)'} OFFSET ${off} ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
    } else {
      sql = `SELECT * FROM ${target}${whereSql}${sortCol ? ` ORDER BY ${sortCol} ${sortDir}` : ''} LIMIT ${pageSize} OFFSET ${off}`;
    }
    const r = await entry.handle.query(sql, kind === 'clickhouse' ? undefined : whereParams);
    return { rows: r.rows ?? [], fields: r.fields ?? [], rowCount: r.rows?.length ?? 0, total, page, pageSize, paginated: true };
  }

  /**
   * 0.9.3 新增一行：列名对照 actualColumns 白名单，值全部绑定（ClickHouse 内联）。
   * values: { 列名: 值 }；'' 视为 NULL；自增主键留空即可。
   */
  async insertRow({ id, database, table, values }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (!['sqlite', 'mysql', 'postgres', 'mssql', 'clickhouse'].includes(kind)) {
      throw new Error(`${kind} 请在查询框用原生命令插入数据 (use the query box for ${kind})`);
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('缺少要插入的值 (missing values)');
    const cols = await this.actualColumns(kind, entry.handle, database, table);
    if (cols.length === 0) throw new Error(`找不到目标表或表没有字段: ${table} (target table missing)`);
    const lookup = new Map(cols.map((c) => [c.toLowerCase(), c]));
    const names = [];
    const params = [];
    for (const [k, v] of Object.entries(values)) {
      const real = lookup.get(String(k).toLowerCase());
      if (!real) throw new Error(`表 ${table} 没有字段「${k}」 (unknown column)`);
      if (v === undefined) continue;
      names.push(real);
      params.push(v === '' ? null : v);
    }
    if (names.length === 0) throw new Error('没有可插入的值：所有字段都为空 (nothing to insert — all fields empty)');
    const target = this.qualifiedTable(kind, database, table);
    const colSql = names.map((c) => this.quoteIdentFor(kind, c)).join(', ');
    if (kind === 'clickhouse') {
      const lits = names.map((_, i) => this.sqlLiteral('clickhouse', params[i]));
      await entry.handle.query(`INSERT INTO ${target} (${colSql}) VALUES (${lits.join(', ')})`);
    } else {
      const ph = names.map((_, i) => this.placeholder(kind, i));
      await entry.handle.query(`INSERT INTO ${target} (${colSql}) VALUES (${ph.join(', ')})`, params);
    }
    return { ok: true, inserted: names.length };
  }

  /**
   * 0.9.5 删除一行：与 updateCell 同款的主键定位 + 参数化 DELETE。
   * pk: [{ column, value }]；影响行数必须恰好为 1。
   */
  async deleteRow({ id, database, table, pk }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (kind === 'mongodb') throw new Error('MongoDB 请在查询框用 deleteMany 命令删除 (use deleteMany in the query box)');
    if (NOSQL_KINDS.has(kind) || kind === 'clickhouse') {
      throw new Error(`${kind} 请在查询框用原生命令删除数据 (use the query box for deletes on ${kind})`);
    }
    if (typeof table !== 'string' || !table) throw new Error('缺少表名 (missing table)');
    if (!Array.isArray(pk) || pk.length === 0) throw new Error('该表没有主键，无法定位要删除的行 (no primary key)');
    const target = database && kind !== 'sqlite'
      ? `${this.quoteIdentFor(kind, database)}.${this.quoteIdentFor(kind, table)}`
      : this.quoteIdentFor(kind, table);
    const params = [];
    const where = pk.map((part) => {
      params.push(part.value);
      return `${this.quoteIdentFor(kind, part.column)} = ${this.placeholder(kind, params.length - 1)}`;
    }).join(' AND ');
    const result = await entry.handle.query(`DELETE FROM ${target} WHERE ${where}`, params);
    const affected = Number(result.affectedRows ?? result.rowCount ?? 0);
    if (affected === 0) throw new Error('没有匹配的行，数据可能已被他人删除 (no matching row)');
    if (affected > 1) throw new Error(`意外删除了 ${affected} 行 (deleted ${affected} rows — PK addressing failed)`);
    return { ok: true, deleted: affected };
  }
}

export function createConnectionManager(dataDir) {
  return new ConnectionManager(dataDir);
}
