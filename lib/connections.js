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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

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

/** Database kinds this plugin understands, with their default ports. */
export const DATABASE_KINDS = {
  sqlite: { label: 'SQLite', defaultPort: null, icon: 'sqlite' },
  mysql: { label: 'MySQL / MariaDB', defaultPort: 3306, icon: 'mysql' },
  postgres: { label: 'PostgreSQL', defaultPort: 5432, icon: 'postgres' },
  mssql: { label: 'SQL Server', defaultPort: 1433, icon: 'mssql' },
  mongodb: { label: 'MongoDB', defaultPort: 27017, icon: 'mongodb' },
  clickhouse: { label: 'ClickHouse', defaultPort: 8123, icon: 'clickhouse' },
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
      this.profiles = [];
    }
  }

  saveProfiles() {
    mkdirSync(dirname(this.profilesPath), { recursive: true });
    // 0o600: the file can contain an opted-in remembered password, so keep it
    // owner-only where the OS honors the mode (POSIX; ignored on Windows).
    writeFileSync(this.profilesPath, JSON.stringify({ profiles: this.profiles }, null, 2), { encoding: 'utf8', mode: 0o600 });
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
   */
  async connect(profileId, password, { force = false } = {}) {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error(`unknown connection: ${profileId}`);
    const existing = this.live.get(profileId);
    if (existing && !force) return { reused: true, profile };
    if (existing) await this.closeProfile(profileId);
    const handle = await this.openHandle(profile, this.resolvePassword(profile, password));
    this.live.set(profileId, { kind: profile.kind, handle, profile });
    return { reused: Boolean(existing), profile };
  }

  async openHandle(profile, password) {
    switch (profile.kind) {
      case 'sqlite': return this.openSqlite(profile);
      case 'mysql': return this.openMysql(profile, password);
      case 'postgres': return this.openPostgres(profile, password);
      case 'mssql': return this.openMssql(profile, password);
      case 'mongodb': return this.openMongo(profile, password);
      case 'clickhouse': return this.openClickHouse(profile, password);
      default: throw new Error(`unsupported kind: ${profile.kind}`);
    }
  }

  openSqlite(profile) {
    // Node >= 22.5 ships node:sqlite (DatabaseSync). DSH Desktop runs Node 24.
    const { DatabaseSync } = this.require('node:sqlite');
    const file = profile.database; // for sqlite, `database` holds the file path
    if (!file) throw new Error('SQLite 需要提供数据库文件路径 (database file path required)');
    const db = new DatabaseSync(file);
    return {
      kind: 'sqlite',
      async query(sql, params) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT') || trimmed.startsWith('PRAGMA') || trimmed.startsWith('WITH') || trimmed.startsWith('EXPLAIN')) {
          const stmt = db.prepare(sql);
          return { rows: stmt.all(...(params || [])), fields: stmt.columns().map((c) => ({ name: c.name, type: c.type ?? null })) };
        }
        const stmt = db.prepare(sql);
        const info = stmt.run(...(params || []));
        return { rows: [], fields: [], affectedRows: Number(info.changes ?? 0), insertId: Number(info.lastInsertRowid ?? 0) };
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
      async query(sql) {
        const request = pool.request();
        const result = await request.query(sql);
        return { rows: result.recordset, fields: Object.keys(result.recordset[0] || {}).map((name) => ({ name, type: null })), rowCount: result.rowsAffected?.[0] };
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
    await client.connect();
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

    const setSql = `${this.quoteIdentFor(kind, column)} = ?`;
    // Build WHERE from pk entries in order: every PK column must match the
    // value the caller saw, so the statement can only hit that one row.
    const where = pk.map((part) => `${this.quoteIdentFor(kind, part.column)} = ?`).join(' AND ');
    const sql = `UPDATE ${target} SET ${setSql} WHERE ${where}`;

    // Parameter order: new value first, then each pk value in order.
    const params = [value, ...pk.map((part) => part.value)];

    // ClickHouse has no UPDATE; refuse with a clear message instead of a
    // driver-level syntax error.
    if (kind === 'clickhouse') throw new Error('ClickHouse 不支持直接 UPDATE (ClickHouse does not support in-place UPDATE)');
    if (kind === 'mongodb') throw new Error('MongoDB 请在查询框用 updateMany 命令修改数据 (use an updateMany command for MongoDB)');

    const result = await handle.query(sql, params);
    const affected = Number(result.affectedRows ?? result.rowCount ?? 0);
    if (affected === 0) throw new Error('没有匹配的行，数据可能已被他人修改 (no matching row — it may have changed)');
    if (affected > 1) throw new Error(`意外更新了 ${affected} 行，已要求回滚条件检查 (updated ${affected} rows — PK addressing failed)`);
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
          if (!/^[A-Za-z0-9_ .,:+\-']*$/.test(raw)) throw new Error(`字段 ${cname}: 默认值含不允许的字符 (default value has unsupported characters)`);
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
        if (col.hasDefault) line += ` DEFAULT ${col.defaultValue}`;
        return line;
      });
      lines.push(`PRIMARY KEY (${pkCols.map((c) => q(c.name)).join(', ')})`);
      for (const fk of fkLines) lines.push(fk);
      body = lines.join(',\n  ');
      return `CREATE TABLE ${target} (\n  ${body}\n)`;
    }
    // ClickHouse: MergeTree needs an ORDER BY expression; the PK serves.
    const lines = cols.map((col) => `${q(col.name)} ${typeSql(col)}`);
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
        if (!/^[A-Za-z0-9_ .,:+\-']*$/.test(raw)) throw new Error(`字段 ${cname}: 默认值含不允许的字符 (default value has unsupported characters)`);
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
    if (entry.kind === 'mongodb') throw new Error('MongoDB 无需建表 (MongoDB needs no CREATE TABLE)');
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
    if (kind === 'mongodb') throw new Error('MongoDB 无表结构可改 (MongoDB has no schema to alter)');
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
        if (col.unique && kind !== 'mssql') line += ' UNIQUE';
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
    // MySQL interprets backslash escapes; the rest only need quote doubling.
    const escaped = kind === 'mysql'
      ? s.replace(/\\/g, '\\\\').replace(/'/g, "''")
      : s.replace(/'/g, "''");
    return `'${escaped}'`;
  }

  /** CSV field encoding: NULL stays empty, an empty string becomes "". */
  csvField(value) {
    if (value === null || value === undefined) return '';
    let s;
    if (typeof value === 'string') s = value;
    else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
    else if (value instanceof Date) s = value.toISOString();
    else s = JSON.stringify(value);
    if (s === '') return '""'; // quoted-empty survives the round trip as ""
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
    if (kind === 'mongodb') throw new Error('MongoDB 无建表语句 (MongoDB has no CREATE TABLE)');
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
        if (c.column_default && /nextval\(/.test(c.column_default)) line += ' GENERATED ALWAYS AS IDENTITY';
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
    const fmt = ['csv', 'json', 'sql', 'sql-structure'].includes(format) ? format : 'csv';
    if (kind === 'mongodb' && fmt !== 'json') throw new Error('MongoDB 仅支持 JSON 导出 (MongoDB exports JSON only)');

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
  async importTable({ id, database, table, format, content }) {
    const entry = this.live.get(id);
    if (!entry) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
    const kind = entry.kind;
    if (kind === 'mongodb') throw new Error('MongoDB 请在查询框用 insertMany 命令导入 (use an insertMany command for MongoDB)');
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
    if (objects.length > IMPORT_ROW_CAP) objects = objects.slice(0, IMPORT_ROW_CAP);

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
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
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
        ? `INSERT INTO ${target} (${colList}) VALUES ${batch.map(() => placeholders).join(', ')}`
        : `INSERT INTO ${target} (${colList}) VALUES ${batch.map((row) => `(${columns.map((_c, i) => this.sqlLiteral(kind, toParam(getValue(row, matched[i].fileKey)))).join(', ')})`).join(', ')}`;
      const params = useParams ? batch.flatMap((row) => columns.map((_c, i) => toParam(getValue(row, matched[i].fileKey)))) : undefined;
      try {
        const result = await entry.handle.query(sql, params);
        inserted += Number(result.affectedRows ?? result.rowCount ?? batch.length);
      } catch (error) {
        throw new Error(`第 ${start + 1}-${end} 行导入失败: ${error?.message || error}` + skippedNote);
      }
    }
    return { inserted, total: objects.length, note: skippedNote || undefined };
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
      const { rows: columns } = await handle.query(`PRAGMA table_info(${quoteIdent(table.name)})`);
      out.push({
        name: table.name, kind: 'table',
        columns: columns.map((c) => ({ name: c.name, type: c.type, nullable: c.notnull === 0, key: c.pk ? 'PK' : null })),
      });
    }
    for (const view of views) {
      const { rows: columns } = await handle.query(`PRAGMA table_info(${quoteIdent(view.name)})`);
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
      const { rows: tables } = await handle.query(`SHOW FULL TABLES FROM ${quoteIdent(name)}`);
      const tableNodes = [];
      for (const t of tables) {
        const tname = t[`Tables_in_${name}`] || Object.values(t)[0];
        const kind = Object.values(t)[1] === 'VIEW' ? 'view' : 'table';
        const { rows: columns } = await handle.query(`SHOW COLUMNS FROM ${quoteIdent(name)}.${quoteIdent(tname)}`);
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
    const byTable = new Map();
    for (const c of columns) {
      const key = `${c.table_schema}.${c.table_name}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push({ name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES', key: null });
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
    const byTable = new Map();
    for (const c of columns) {
      const key = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`;
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push({ name: c.COLUMN_NAME, type: c.DATA_TYPE, nullable: c.IS_NULLABLE === 'YES', key: null });
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
}

function quoteIdent(name) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) return String(name);
  return `"${String(name).replace(/"/g, '""')}"`;
}

export function createConnectionManager(dataDir) {
  return new ConnectionManager(dataDir);
}
