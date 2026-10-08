/**
 * dsh-database — host entry.
 *
 * Mounts the connection manager and the `/dsh-database/api/*` HTTP routes the
 * browser half talks to. The webServer service is injected lazily so this
 * bundle also composes on hosts without a web layer (the routes just never
 * appear there).
 */
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConnectionManager, DATABASE_KINDS, DESIGNER_COLUMN_TYPES } from './connections.js';

export const name = 'dsh-database-explorer';

export const inject = [];

const MAX_BODY = 2 * 1024 * 1024; // 2 MiB is plenty for a SQL text
/** Import files are allowed to be much bigger than a SQL text — the browser
 *  side caps them at 32 MB, so the host limit sits just above that. */
const MAX_IMPORT_BODY = 34 * 1024 * 1024;
/** Rows sent to the panel per query; `truncated` reports the cut. Was 500,
 *  which made a table peek look like the data ended at 500. */
const QUERY_ROW_CAP = 10000;

// 0.9.4 版本握手：后端把自己的版本带给前端，前端不一致就提示重启
// （否则升级后"前端新、后端旧"只会表现为莫名其妙的 405/404）。
let pluginVersion = 'unknown';
try {
  pluginVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version ?? 'unknown';
} catch { /* 读不到版本号不影响功能 */ }

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJsonBody(request, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function apply(ctx) {
  // Fault isolation: the host half must never reject activation — a plugin
  // failure here used to wedge the whole Desktop startup (2026-09-30 incident).
  try {
    applyInner(ctx);
  } catch (error) {
    console.warn('[dsh-database] host activation failed — the plugin stays unavailable, the app is unaffected:', error?.message || error);
  }
}

function applyInner(ctx) {
  let dataDir;
  try {
    // Follow the harness home, not the OS home: official path helpers resolve
    // DSH_HOME first and ~/.dsh only as the default. Hardcoding homedir()
    // breaks DSH_HOME-isolated setups by writing profiles + remembered
    // passwords into the real ~/.dsh regardless.
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh');
    dataDir = join(home, 'plugin-data', 'dsh-database-explorer');
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    console.warn('[dsh-database] cannot create data dir, using a temp dir:', error?.message || error);
    dataDir = join(tmpdir(), 'dsh-database-explorer');
    mkdirSync(dataDir, { recursive: true });
  }
  const manager = createConnectionManager(dataDir);

  // One-time migration: profiles saved under the old hardcoded path
  // (~/.dsh/plugin-data/dsh-database) move to the new home-aware location.
  try {
    const legacyDir = join(homedir(), '.dsh', 'plugin-data', 'dsh-database');
    const legacyFile = join(legacyDir, 'connections.json');
    const newFile = join(dataDir, 'connections.json');
    if (!existsSync(newFile) && existsSync(legacyFile)) {
      copyFileSync(legacyFile, newFile);
    }
  } catch { /* migration is best-effort */ }

  ctx.effect(() => async () => {
    await manager.closeAll();
  }, 'dsh-database: dispose pooled connections');

  // Restart-proof connections: right after activation, silently reopen every
  // profile that has a remembered password (or an env-var password). Failures
  // are collected, never thrown — an offline server at boot must not stop the
  // plugin from serving everything else.
  // cordis effect semantics: the factory runs NOW; a function it RETURNS is
  // collected as the disposer and runs at teardown. The timer must therefore
  // be started in the factory body itself — writing the setTimeout callback
  // as the factory's return value made it a disposer, so auto-reconnect only
  // fired 1.5s AFTER host shutdown (dead code at startup, zombie pool rebuild
  // right after closeAll).
  ctx.effect(() => {
    const timer = setTimeout(() => {
      manager.autoReconnect().then((results) => {
        const failed = results.filter((r) => !r.ok);
        if (results.length > 0) {
          console.log(`[dsh-database] auto-reconnect: ${results.length - failed.length}/${results.length} connection(s) restored` +
            (failed.length > 0 ? ` — failed: ${failed.map((f) => `${f.name}: ${f.error}`).join('; ')}` : ''));
        }
      }).catch(() => {});
    }, 1500);
    if (typeof timer.unref === 'function') timer.unref();
    // Real cleanup: cancel a still-pending timer when the host stops within
    // the 1.5s window, so shutdown is never followed by a surprise reconnect.
    return () => clearTimeout(timer);
  }, 'dsh-database: startup auto-reconnect');

  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.webServer;
    // A host without a web layer (headless/ACP/SDK) composes this bundle too:
    // skip the routes quietly instead of crashing on a missing service.
    if (webServer === undefined || typeof webServer.register !== 'function') {
      console.warn('[dsh-database] no webServer service on this host — HTTP routes skipped');
      return;
    }

    /**
     * Same-origin fence for mutating routes.
     *
     * These routes register as `exact` paths on the bare web server, so they sit
     * outside DSH's own /api browser-trust fence. Two checks, because either
     * alone has a hole:
     *
     *  1. HOST ALLOWLIST — the request's Host must name this machine
     *     (loopback IP or *.localhost). This is the actual DNS-rebinding
     *     defense: an attacker page at evil.example can make the browser send
     *     Host: evil.example through a rebound DNS name, and it used to pass
     *     the old Origin===Host comparison when both were forged together.
     *  2. ORIGIN ECHO — when the browser attaches an Origin (it always does
     *     on cross-site writes), it must equal the Host. Non-browser clients
     *     (curl, scripts, the offline test harness) send no Origin at all and
     *     stay allowed by rule 1 alone; an unparseable or `null` origin does
     *     not.
     */
    /**
     * Parse a Host header into its hostname (no brackets, no port).
     * `lastIndexOf(':')` alone breaks on bare IPv6 ("::1" has no port), so:
     * bracketed form takes what is inside the brackets; a single colon splits
     * host:port; multiple colons mean a bare IPv6 literal with no port.
     */
    function hostNameOf(hostHeader) {
      if (typeof hostHeader !== 'string' || hostHeader === '') return '';
      if (hostHeader.startsWith('[')) {
        const end = hostHeader.indexOf(']');
        return end === -1 ? hostHeader.slice(1) : hostHeader.slice(1, end);
      }
      const at = hostHeader.lastIndexOf(':');
      if (at === -1) return hostHeader;
      // A bare IPv6 literal ("::1", "fe80::1") contains colons but no port.
      return hostHeader.includes(':', at + 1) || (hostHeader.match(/:/g) || []).length > 1
        ? hostHeader
        : hostHeader.slice(0, at);
    }

    /**
     * The Host must name THIS machine, and only by its canonical loopback
     * names. The `*.localhost` wildcard is gone on purpose: browsers resolve
     * the whole zone to loopback anyway, so the exact names cover real use,
     * while the wildcard handed every `evil.localhost` a free pass.
     */
    function hostAllowed(hostHeader) {
      const name = hostNameOf(hostHeader).toLowerCase();
      return name === '127.0.0.1' || name === '::1' || name === 'localhost';
    }

    function sameOrigin(request) {
      if (!hostAllowed(request.headers.host)) return false;
      const origin = request.headers.origin;
      if (origin === undefined) return true; // non-browser client; Host check above already passed
      try {
        return new URL(origin).host === request.headers.host;
      } catch {
        return false;
      }
    }

    /** One route registration helper so every handler reports errors the same way. */
    function route(path, handler) {
      return webServer.register({
        kind: 'exact',
        path,
        handler: async (request, response) => {
          try {
            // EVERY method goes through the fence, GET/HEAD included: with the
            // old exemption a rebinding attacker page (same port, rebound DNS
            // → same origin) could silently read connection metadata and the
            // full schema tree via GET. Same-origin browser GETs carry no
            // Origin header and stay allowed by the Host rule alone.
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: '拒绝跨站请求 / cross-site request refused' });
              return;
            }
            await handler(request, response);
          } catch (error) {
            // R-ROB2（v0.9.14）：handler 已写出响应头时二次 writeHead 会再抛——
            // 兜底成销毁连接，绝不让错误从这里漏成 uncaught
            try {
              sendJson(response, 500, { error: String(error?.message || error) });
            } catch {
              try { response.destroy(); } catch { /* 连接已消失 */ }
            }
          }
        },
      });
    }

    /**
     * Server version banner for connect/test feedback. A cheap SELECT that
     * every supported engine answers; anything that fails just omits the banner.
     */
    async function serverBanner(handle) {
      try {
        if (typeof handle.adminPing === 'function') return await handle.adminPing();
        switch (handle.kind) {
          case 'sqlite': { const r = await handle.query("SELECT sqlite_version() AS v"); return `SQLite ${r.rows[0]?.v ?? ''}`; }
          case 'mysql': { const r = await handle.query('SELECT VERSION() AS v'); return `MySQL ${r.rows[0]?.v ?? ''}`; }
          case 'postgres': { const r = await handle.query('SELECT version() AS v'); return String(r.rows[0]?.v ?? '').split(' ').slice(0, 2).join(' '); }
          case 'mssql': { const r = await handle.query('SELECT @@VERSION AS v'); return String(r.rows[0]?.v ?? '').split(' \n')[0]; }
          case 'clickhouse': { const r = await handle.query('SELECT version() AS v'); return `ClickHouse ${r.rows[0]?.v ?? ''}`; }
          case 'mongodb': { const meta = await handle.adminPing(); return meta; }
          default: return undefined;
        }
      } catch {
        return undefined;
      }
    }

    const disposers = [
      // --- meta ------------------------------------------------------------
      route('/dsh-database/api/kinds', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        sendJson(response, 200, { kinds: DATABASE_KINDS, version: pluginVersion });
      }),

      // --- profiles --------------------------------------------------------
      route('/dsh-database/api/profiles', (request, response) => {
        if (request.method === 'GET') {
          sendJson(response, 200, { profiles: manager.listProfiles(), connected: manager.connectedIds() });
          return;
        }
        if (request.method === 'POST') {
          readJsonBody(request).then((body) => {
            const profile = manager.createProfile(body);
            sendJson(response, 200, { profile });
          }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
          return;
        }
        response.writeHead(405, { allow: 'GET, POST' }); response.end();
      }),

      route('/dsh-database/api/profiles/update', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ id, ...patch }) => {
          if (!id) throw new Error('id required');
          return manager.updateProfile(id, patch);
        }).then((profile) => sendJson(response, 200, { profile }))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      route('/dsh-database/api/profiles/delete', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ id }) => manager.deleteProfile(id))
          .then((deleted) => sendJson(response, 200, { deleted }))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 档案迁移（v0.9.19，安全产品化 ④）：导出永远脱敏，导入一律新建 id ---
      route('/dsh-database/api/profiles/export', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        sendJson(response, 200, manager.exportProfiles());
      }),

      route('/dsh-database/api/profiles/import', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ profiles }) => sendJson(response, 200, manager.importProfiles(profiles)))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 写操作审计日志（v0.9.19，安全产品化 ②）：面板「📜 审计」查看 ---
      route('/dsh-database/api/audit', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const url = new URL(request.url, 'http://localhost');
        sendJson(response, 200, { entries: manager.readAudit(url.searchParams.get('limit')) });
      }),

      // --- 审计记录删除（v0.9.19 面板按钮）：mode=one 按 id（或旧记录的 t）删单条 / mode=all 清空主日志 ---
      route('/dsh-database/api/audit/delete', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ mode, id, timestamp }) => sendJson(response, 200, manager.deleteAudit({ mode, id, timestamp })))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 删表（v0.9.20 面板 🗑）：confirm 必须与表名一致；只读连接 / NoSQL / ClickHouse 由宿主拒绝并入账 ---
      route('/dsh-database/api/designer/drop-table', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ id, database, table, confirm }) => sendJson(response, 200, manager.dropTable({ id, database, table, confirm })))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 单表列结构（v0.9.19，AI 原生 ⑥）：agent db_describe_table 的通道 ---
      route('/dsh-database/api/describe', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const url = new URL(request.url, 'http://localhost');
        manager.describeTable({
          id: url.searchParams.get('id'),
          database: url.searchParams.get('database') || undefined,
          table: url.searchParams.get('table') || '',
        })
          .then((info) => sendJson(response, 200, info))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- live connection ---------------------------------------------------
      route('/dsh-database/api/connect', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        // force: true rebuilds the pooled handle — the panel calls this after
        // a "connection is not open" failure, when a host restart or dropped
        // socket left the browser state pointing at a dead connection.
        // rememberPassword: the auto-cookie flow — the browser sends the
        // password that JUST WORKED and opts to persist it, so the next app
        // start reconnects by itself. No plaintext ever comes back out.
        readJsonBody(request).then(async ({ id, password, force, rememberPassword }) => {
          const { reused } = await manager.connect(id, password, { force: force === true });
          let saved = false;
          if (rememberPassword === true && typeof password === 'string' && password.length > 0) {
            try { manager.savePassword(id, password); saved = true; } catch { /* keep the connection anyway */ }
          }
          const server = await serverBanner(manager.liveHandle(id));
          sendJson(response, 200, { ok: true, reused, server, passwordSaved: saved });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // Persist (or clear) a stored password for one profile. The auto-cookie
      // flow uses /connect's rememberPassword; this route is the manual form.
      route('/dsh-database/api/passwords/save', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, password }) => {
          const profile = manager.savePassword(id, password);
          sendJson(response, 200, { ok: true, profile });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // One-shot connect + version probe + close. Persists NOTHING, so the
      // form's 测试连接 button can validate settings before a save.
      route('/dsh-database/api/test', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async (settings) => {
          // S1 (v0.9.13): the env-var → private-host guard moved INTO
          // resolvePassword (connections.js) with exact, both-ends-anchored
          // address matching. This route used to carry a prefix-regex version
          // that `10.0.0.1.attacker.net` walked through, and /connect plus
          // autoReconnect — which reach the same password resolution — had no
          // guard at all. resolvePassword now rejects for every caller.
          const probe = manager.ephemeralProfile(settings);
          const handle = await manager.openHandle(probe, manager.resolvePassword(probe, settings.password));
          try {
            const server = await serverBanner(handle);
            sendJson(response, 200, { ok: true, server });
          } finally {
            await handle.close().catch(() => {});
          }
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      route('/dsh-database/api/disconnect', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ id }) => manager.closeProfile(id))
          .then((closed) => sendJson(response, 200, { closed }))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- schema tree -------------------------------------------------------
      route('/dsh-database/api/schema', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const url = new URL(request.url, 'http://localhost');
        const id = url.searchParams.get('id');
        // A missing or "null" id used to surface as "connection null is not
        // open", which tells the user nothing. Say what to do instead.
        if (id === null || id === '' || id === 'null' || id === 'undefined') {
          sendJson(response, 400, { error: '没有指定要查看的连接，请先在左侧选择一个 / no connection selected — pick one on the left first' });
          return;
        }
        manager.schema(id)
          .then((schema) => sendJson(response, 200, schema))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- query execution ---------------------------------------------------
      route('/dsh-database/api/query', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, sql, params, peek }) => {
          // R-ROB2（v0.9.14）：params 只接受数组（对象此前以裸 TypeError 爆 500）
          if (params !== undefined && !Array.isArray(params)) throw new Error('params 必须是数组 / params must be an array');
          const handle = manager.liveHandle(id);
          if (!handle) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
          const started = Date.now();
          // NoSQL/向量引擎的"点表看数据"：走 handle.peek（Redis 类型采样 / ES match_all / Qdrant scroll），
          // 客户端不为这些引擎拼查询文本。
          if (peek !== undefined && typeof handle.peek === 'function') {
            const r = await handle.peek(String(peek?.table ?? ''));
            const rows = r.rows ?? [];
            const capped = rows.slice(0, QUERY_ROW_CAP);
            sendJson(response, 200, { fields: r.fields ?? [], rows: capped, rowCount: rows.length, truncated: rows.length > capped.length, affectedRows: undefined, ms: Date.now() - started, meta: r.meta ?? undefined });
            return;
          }
          // v0.9.18：SQL 一律走 manager.runQuery 收口——只读连接在出口处
          // 按语句预检拒绝写（agent db_query 走同一个收口，语义一致）
          return manager.runQuery(id, String(sql || ''), params).then((result) => {
            // Cap rows for the wire so a huge table cannot freeze the tab;
            // `truncated` lets the panel say so.
            const rows = result.rows ?? [];
            const capped = rows.slice(0, QUERY_ROW_CAP);
            sendJson(response, 200, {
              fields: result.fields ?? [],
              rows: capped,
              rowCount: rows.length,
              truncated: rows.length > capped.length,
              affectedRows: result.affectedRows,
              insertId: result.insertId,
              ms: Date.now() - started,
              meta: result.meta ?? undefined,
            });
          });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- visual table designer ---------------------------------------------
      // The designer's type dropdown (shared list, host-validated).
      route('/dsh-database/api/designer/types', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        sendJson(response, 200, { types: DESIGNER_COLUMN_TYPES });
      }),

      // Visual CREATE TABLE: the browser posts a plain description (table name
      // + column rows); the host assembles and runs the engine-specific DDL.
      // dryRun: true only builds the SQL and returns it — the designer's
      // "Show SQL" preview goes through this same route, so the preview is
      // exactly what a real create would run.
      route('/dsh-database/api/designer/create-table', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, database, table, columns, dryRun }) => {
          if (dryRun === true) {
            const handle = manager.liveHandle(id);
            if (!handle) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
            const sql = manager.buildDdl({ kind: handle.kind, table, columns }, { database });
            sendJson(response, 200, { ok: true, sql });
            return;
          }
          const result = await manager.createTable({ id, database, table, columns });
          sendJson(response, 200, { ...result, table });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // Table editor: read a table's existing columns (edit-mode fill).
      route('/dsh-database/api/designer/columns', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const url = new URL(request.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const database = url.searchParams.get('database');
        const table = url.searchParams.get('table');
        const handle = manager.liveHandle(id);
        if (!handle) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
        manager.actualColumns(handle.kind, handle, database, table)
          .then((names) => sendJson(response, 200, { columns: names }))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // Table editor: add / drop columns on an existing table.
      route('/dsh-database/api/designer/alter-table', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, database, table, add, drop }) => {
          const result = await manager.alterTable({ id, database, table, add, drop });
          sendJson(response, 200, { ...result, table });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- data transfer (export / import) ------------------------------------
      // Export: the host streams the generated file as a download (Content-
      // Disposition), so a big table never has to fit in a fetch body twice.
      route('/dsh-database/api/export', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, database, table, format }) => {
          const out = await manager.exportTable({ id, database, table, format });
          const stamp = new Date().toISOString().slice(0, 10);
          const safeTable = String(table || 'data').replace(/[^\p{L}\p{N}._-]+/gu, '_');
          const filename = `${safeTable}_${stamp}.${out.ext}`;
          const body = Buffer.from(out.content, 'utf8');
          response.writeHead(200, {
            'content-type': `${out.contentType}; charset=utf-8`,
            'content-length': body.length,
            'content-disposition': `attachment; filename="${filename}"`,
            'x-export-rows': String(out.rowCount),
            'x-export-truncated': out.truncated ? '1' : '0',
            'cache-control': 'no-store',
          });
          response.end(body);
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // Import: CSV (header row + data) or JSON (object / array of objects).
      // Body cap matches the browser's own 32 MB pre-check (plus headroom for
      // JSON escaping), so a valid upload never dies at the host fence.
      route('/dsh-database/api/import', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        // N3（v0.9.18 审计）：dryRun 此前在路由处被丢弃——面板「预览」一直在
        // 执行真实导入。转发后预览只回列映射，不触库
        readJsonBody(request, MAX_IMPORT_BODY).then(async ({ id, database, table, format, content, dryRun }) => {
          const result = await manager.importTable({ id, database, table, format, content, dryRun: dryRun === true });
          sendJson(response, 200, { ok: true, ...result });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- in-grid cell edit ---------------------------------------------------
      // The panel's double-click edit posts here. The host (not the browser)
      // builds the UPDATE with parameter binding so values are never spliced
      // into SQL text, and PK columns are required to address exactly one row.
      route('/dsh-database/api/update', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, table, database, column, pk, value }) => {
          const result = await manager.updateCell({ id, table, database, column, pk, value });
          sendJson(response, 200, { ok: true, ...result });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),
      // --- E-R 关系图（0.9.0）：按库内省表/列/外键 ---
      route('/dsh-database/api/er', (request, response) => {
        if (request.method !== 'GET') { response.writeHead(405); response.end(); return; }
        const url = new URL(request.url, 'http://localhost');
        const id = url.searchParams.get('id');
        const database = url.searchParams.get('database');
        manager.erGraph({ id, database })
          .then((data) => sendJson(response, 200, data))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 分页浏览（0.9.0）：服务端 LIMIT/OFFSET + 排序 + 过滤 ---
      route('/dsh-database/api/peek', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async (body) => {
          const result = await manager.peekPage(body);
          sendJson(response, 200, result);
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 新增行（0.9.3）：参数化 INSERT，列名白名单校验 ---
      route('/dsh-database/api/insert', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async (body) => {
          const result = await manager.insertRow(body);
          sendJson(response, 200, result);
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- 删除行（0.9.5）：主键定位的参数化 DELETE ---
      route('/dsh-database/api/delete', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async (body) => {
          const result = await manager.deleteRow(body);
          sendJson(response, 200, result);
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),
    ];

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose();
    }, 'dsh-database: http routes');
  });

  // Agent 工具（v0.9.17）：把连接管理器暴露为模型可调用的原生工具，聊天会话
  // 中由宿主工具展示层渲染调用流程。条件注入——没有 agent/tools 服务的宿主
  // （headless/ACP）静默跳过；defineTool 解析失败也只告警，面板不受影响。
  // 写入类工具默认关闭：需在 plugin-data 目录创建 agent-write-tools 标记文件。
  ctx.inject(['tools'], (toolCtx) => {
    import('./tools.js')
      .then((m) => m.registerAgentTools(toolCtx, manager, dataDir))
      .then((r) => r && console.log(`[dsh-database] agent 工具已注册：${r.registered.join(', ')}${r.writeTools ? '（含写入工具）' : '（只读——创建 agent-write-tools 文件可开启写入工具）'}`))
      .catch((error) => console.warn('[dsh-database] agent 工具注册失败（面板不受影响）:', error?.message || error));
  });
}
