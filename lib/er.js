/**
 * dsh-database v0.9.6 — E-R 关系图内省（零依赖）。
 *
 * introspectEr(handle, kind, database) →
 *   { tables: [{ name, columns: [{ name, type, pk, fk }] }],
 *     edges:  [{ fromTable, fromCol, toTable, toCol }], tooMany? }
 *
 * 支持 sqlite / mysql / postgres / mssql（有外键元数据的引擎）；
 * mongo/redis/es/qdrant/clickhouse 明确拒绝。全部值走参数绑定，标识符不出现在值位。
 *
 * 0.9.6：前端画板改为「按表勾选」，清单不再卡在 60 张就整库拒绝——
 * 最多返回 ER_LIST_MAX 张（tooMany 报告全库总数，前端提示手动勾选）。
 */
export const ER_ENGINES = new Set(['sqlite', 'mysql', 'postgres', 'mssql']);
const MAX_TABLES = 60;
const ER_LIST_MAX = 300;
const MAX_EDGES = 400;

export async function introspectEr(handle, kind, database) {
  if (!ER_ENGINES.has(kind)) throw new Error(`${kind} 不支持 E-R 图（没有外键元数据） (ER diagram is not available for ${kind})`);
  if (kind === 'sqlite') return erSqlite(handle);
  if (kind === 'mysql') return erMysql(handle, database);
  if (kind === 'postgres') return erPostgres(handle, database);
  return erMssql(handle, database);
}

const qSq = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** 驱动返回的行键大小写不保证：MariaDB 的 information_schema 会把列标签返回成
 *  大写（TABLE_NAME），Oracle MySQL 按查询原样（小写），mssql 驱动按别名原样。
 *  归一成小写再取值，内省不再因服务器分支而整体塌成 undefined。 */
const lowerRow = (row) => {
  const out = {};
  for (const k of Object.keys(row ?? {})) out[k.toLowerCase()] = row[k];
  return out;
};

/** 列行 + 外键行 → {tables, edges}，并为参与外键的列打 fk 标记。
 *  totalTables：调用方已知的全库表数（sqlite 从 sqlite_master 统计）；
 *  缺省时用实际组装出的表数。超过 ER_LIST_MAX 的表不进清单，但计入 tooMany。 */
function assemble(colRows, fkRows, totalTables) {
  const tables = new Map();
  let total = 0;
  for (const c of colRows) {
    if (!c.table) continue; // 无表名的行直接跳过，绝不塌成 undefined 表
    if (!tables.has(c.table)) {
      total++;
      if (tables.size >= ER_LIST_MAX) continue;
      tables.set(c.table, { name: c.table, columns: [] });
    }
    if (tables.get(c.table).columns.length < 40) {
      tables.get(c.table).columns.push({ name: c.name, type: c.type ?? '', pk: c.pk === true });
    }
  }
  const edges = [];
  for (const f of fkRows) {
    if (edges.length >= MAX_EDGES) break;
    if (!tables.has(f.table) || !tables.has(f.refTable)) continue; // 指向本库之外的引用不画
    edges.push({ fromTable: f.table, fromCol: f.col, toTable: f.refTable, toCol: f.refCol });
  }
  for (const tb of tables.values()) {
    for (const col of tb.columns) col.fk = edges.some((e) => e.fromTable === tb.name && e.fromCol === col.name);
  }
  const count = totalTables ?? total;
  return { tables: [...tables.values()], edges, tooMany: count > MAX_TABLES ? count : undefined };
}

async function erSqlite(handle) {
  const { rows: tableRows } = await handle.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const listed = tableRows.slice(0, ER_LIST_MAX);
  const tables = [];
  const fkRows = [];
  for (const t of listed) {
    const { rows: cols } = await handle.query(`PRAGMA table_info(${qSq(t.name)})`);
    tables.push({
      name: t.name,
      columns: cols.slice(0, 40).map((c) => ({ name: c.name, type: c.type ?? '', pk: c.pk > 0 })),
    });
    const { rows: fks } = await handle.query(`PRAGMA foreign_key_list(${qSq(t.name)})`);
    for (const f of fks) fkRows.push({ table: t.name, col: f.from, refTable: f.table, refCol: f.to, seq: f.seq });
  }
  // `REFERENCES parent` 不带列名（隐式引用父表主键）时 PRAGMA 的 to 为 null：
  // 按外键内序号 seq 对齐父表主键列，让连线锚到具体列。
  const pkColsCache = new Map();
  for (const f of fkRows) {
    if (f.refCol) continue;
    if (!pkColsCache.has(f.refTable)) {
      try {
        const { rows: pc } = await handle.query(`PRAGMA table_info(${qSq(f.refTable)})`);
        pkColsCache.set(f.refTable, pc.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name));
      } catch { pkColsCache.set(f.refTable, []); }
    }
    const pkCols = pkColsCache.get(f.refTable);
    f.refCol = pkCols[f.seq] ?? pkCols[0] ?? null;
  }
  return assemble(
    tables.flatMap((t) => t.columns.map((c) => ({ table: t.name, name: c.name, type: c.type, pk: c.pk }))),
    fkRows,
    tableRows.length
  );
}

async function erMysql(handle, database) {
  const db = database && database !== '(file)' ? database : null;
  if (!db) throw new Error('需要在库节点上打开 E-R 图（未指定 database） (open the ER diagram on a database node)');
  const { rows: cols } = await handle.query(
    `SELECT table_name, column_name, column_type, column_key
     FROM information_schema.columns WHERE table_schema = ?
     ORDER BY table_name, ordinal_position`, [db]);
  const { rows: fks } = await handle.query(
    `SELECT table_name, column_name, referenced_table_name, referenced_column_name
     FROM information_schema.key_column_usage
     WHERE table_schema = ? AND referenced_table_name IS NOT NULL`, [db]);
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.column_type, pk: c.column_key === 'PRI' }; }),
    fks.map((raw) => { const f = lowerRow(raw); return { table: f.table_name, col: f.column_name, refTable: f.referenced_table_name, refCol: f.referenced_column_name }; })
  );
}

async function erPostgres(handle, schema) {
  const s = schema && schema !== '(file)' ? schema : 'public';
  const { rows: cols } = await handle.query(
    `SELECT table_name, column_name, data_type
     FROM information_schema.columns WHERE table_schema = $1
     ORDER BY table_name, ordinal_position`, [s]);
  const { rows: pks } = await handle.query(
    `SELECT kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1`, [s]);
  // 复合外键必须按列序一一配对：information_schema.constraint_column_usage 没有
  // 序号，直接 join 会产生 (a→y, b→x) 的错误边——改用 pg_catalog 的 conkey/confkey
  // 数组按 WITH ORDINALITY 对齐。
  const { rows: fks } = await handle.query(
    `SELECT tp.relname AS table_name, pa.attname AS column_name,
            tr.relname AS ref_table, pb.attname AS ref_col
     FROM pg_constraint c
     JOIN pg_class tp ON tp.oid = c.conrelid
     JOIN pg_class tr ON tr.oid = c.confrelid
     JOIN pg_namespace sn ON sn.oid = tp.relnamespace
     JOIN unnest(c.conkey) WITH ORDINALITY AS uk(attnum, ord) ON true
     JOIN unnest(c.confkey) WITH ORDINALITY AS uf(attnum, ord) ON uf.ord = uk.ord
     JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = uk.attnum
     JOIN pg_attribute pb ON pb.attrelid = c.confrelid AND pb.attnum = uf.attnum
     WHERE c.contype = 'f' AND sn.nspname = $1`, [s]);
  const pkSet = new Set(pks.map((raw) => { const r = lowerRow(raw); return `${r.table_name}.${r.column_name}`; }));
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.data_type, pk: pkSet.has(`${c.table_name}.${c.column_name}`) }; }),
    fks.map((raw) => { const f = lowerRow(raw); return { table: f.table_name, col: f.column_name, refTable: f.ref_table, refCol: f.ref_col }; })
  );
}

async function erMssql(handle, schema) {
  const s = schema && schema !== '(file)' ? schema : 'dbo';
  const { rows: cols } = await handle.query(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @p1
     ORDER BY TABLE_NAME, ORDINAL_POSITION`, [s]);
  const { rows: pks } = await handle.query(
    `SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
     WHERE kcu.TABLE_SCHEMA = @p1 AND kcu.CONSTRAINT_NAME IN (
       SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = @p1)`, [s]);
  const { rows: fks } = await handle.query(
    `SELECT tp.name AS from_table, cp.name AS from_col, tr.name AS to_table, cr.name AS to_col
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
     JOIN sys.tables tp ON fkc.parent_object_id = tp.object_id
     JOIN sys.schemas sp ON tp.schema_id = sp.schema_id
     JOIN sys.columns cp ON fkc.parent_object_id = cp.object_id AND fkc.parent_column_id = cp.column_id
     JOIN sys.tables tr ON fkc.referenced_object_id = tr.object_id
     JOIN sys.columns cr ON fkc.referenced_object_id = cr.object_id AND fkc.referenced_column_id = cr.column_id
     WHERE sp.name = @p1`, [s]);
  const pkSet = new Set(pks.map((raw) => { const r = lowerRow(raw); return `${r.table_name}.${r.column_name}`; }));
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.data_type, pk: pkSet.has(`${c.table_name}.${c.column_name}`) }; }),
    fks.map((raw) => { const f = lowerRow(raw); return { table: f.from_table, col: f.from_col, refTable: f.to_table, refCol: f.to_col }; })
  );
}
