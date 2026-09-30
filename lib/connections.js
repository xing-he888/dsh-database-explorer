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

  /** Open (or reuse) the live connection for one profile. */
  async connect(profileId, password) {
    const profile = this.getProfile(profileId);
    if (!profile) throw new Error(`unknown connection: ${profileId}`);
    const existing = this.live.get(profileId);
    if (existing) return { reused: true, profile };
    const handle = await this.openHandle(profile, this.resolvePassword(profile, password));
    this.live.set(profileId, { kind: profile.kind, handle, profile });
    return { reused: false, profile };
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
   * Reconnect every profile that has a remembered password at host startup.
   * Called by the route layer shortly after activation so a desktop restart
   * no longer drops every connection — the complaint that led here: every
   * restart demanded a fresh password for each saved connection.
   */
  async autoReconnect() {
    const results = [];
    for (const profile of this.profiles) {
      const hasSecret = (typeof profile.savedPassword === 'string' && profile.savedPassword.length > 0)
        || (typeof profile.envPassword === 'string' && profile.envPassword.length > 0);
      if (!hasSecret) continue;
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
