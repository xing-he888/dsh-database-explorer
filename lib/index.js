/**
 * dsh-database — host entry.
 *
 * Mounts the connection manager and the `/dsh-database/api/*` HTTP routes the
 * browser half talks to. The webServer service is injected lazily so this
 * bundle also composes on hosts without a web layer (the routes just never
 * appear there).
 */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createConnectionManager, DATABASE_KINDS } from './connections.js';

export const name = 'dsh-database';

export const inject = [];

const MAX_BODY = 2 * 1024 * 1024; // 2 MiB is plenty for a SQL text
/** Rows sent to the panel per query; `truncated` reports the cut. Was 500,
 *  which made a table peek look like the data ended at 500. */
const QUERY_ROW_CAP = 10000;

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
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
    dataDir = join(homedir(), '.dsh', 'plugin-data', 'dsh-database');
    mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    console.warn('[dsh-database] cannot create data dir, using a temp dir:', error?.message || error);
    dataDir = join(tmpdir(), 'dsh-database');
    mkdirSync(dataDir, { recursive: true });
  }
  const manager = createConnectionManager(dataDir);

  ctx.effect(() => async () => {
    await manager.closeAll();
  }, 'dsh-database: dispose pooled connections');

  // Restart-proof connections: right after activation, silently reopen every
  // profile that has a remembered password (or an env-var password). Failures
  // are collected, never thrown — an offline server at boot must not stop the
  // plugin from serving everything else.
  ctx.effect(() => (dispatch) => {
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
     * outside DSH's own /api browser-trust fence. A browser always attaches
     * `Origin` to a cross-site write (including a form POST and a no-cors
     * fetch), so requiring a same-origin value stops another page in the user's
     * browser from driving their databases (CSRF / DNS rebinding).
     *
     * Non-browser clients — curl, scripts, the offline test harness — send no
     * Origin at all and stay allowed; an unparseable or `null` origin does not.
     */
    function sameOrigin(request) {
      const origin = request.headers.origin;
      if (origin === undefined) return true;
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
            if (request.method !== 'GET' && request.method !== 'HEAD' && !sameOrigin(request)) {
              sendJson(response, 403, { error: '拒绝跨站请求 / cross-origin request refused' });
              return;
            }
            await handler(request, response);
          } catch (error) {
            sendJson(response, 500, { error: String(error?.message || error) });
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
        sendJson(response, 200, { kinds: DATABASE_KINDS });
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

      // --- live connection ---------------------------------------------------
      route('/dsh-database/api/connect', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async ({ id, password }) => {
          const { reused } = await manager.connect(id, password);
          const server = await serverBanner(manager.liveHandle(id));
          sendJson(response, 200, { ok: true, reused, server });
        }).catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // One-shot connect + version probe + close. Persists NOTHING, so the
      // form's 测试连接 button can validate settings before a save.
      route('/dsh-database/api/test', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(async (settings) => {
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
          sendJson(response, 400, { error: '没有指定要查看的连接，请先在左侧选择一个连接 / no connection selected — pick one on the left first' });
          return;
        }
        manager.schema(id)
          .then((schema) => sendJson(response, 200, schema))
          .catch((error) => sendJson(response, 400, { error: String(error?.message || error) }));
      }),

      // --- query execution ---------------------------------------------------
      route('/dsh-database/api/query', (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
        readJsonBody(request).then(({ id, sql, params }) => {
          const handle = manager.liveHandle(id);
          if (!handle) throw new Error('连接未打开，请先点「连接」/ connection is not open — press Connect first');
          const started = Date.now();
          return handle.query(String(sql || ''), params).then((result) => {
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
            });
          });
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
    ];

    ctx.effect(() => () => {
      for (const dispose of disposers) dispose();
    }, 'dsh-database: http routes');
  });
}
