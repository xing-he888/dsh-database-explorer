/**
 * dsh-database v0.9.0 — E-R 关系图内省（零依赖）。
 *
 * introspectEr(handle, kind, database) →
 *   { tables: [{ name, columns: [{ name, type, pk, fk }] }],
 *     edges:  [{ fromTable, fromCol, toTable, toCol }], tooMany? }
 *
 * 支持 sqlite / mysql / postgres / mssql（有外键元数据的引擎）；
 * mongo/redis/es/qdrant/clickhouse 明确拒绝。全部值走参数绑定，标识符不出现在值位。
 */
export const ER_ENGINES = new Set(['sqlite', 'mysql', 'postgres', 'mssql']);
const MAX_TABLES = 60;
const MAX_EDGES = 400;

export async function introspectEr(handle, kind, database) {
  if (!ER_ENGINES.has(kind)) throw new Error(`${kind} 不支持 E-R 图（没有外键元数据） (ER diagram is not available for ${kind})`);
  if (kind === 'sqlite') return erSqlite(handle);
  if (kind === 'mysql') return erMysql(handle, database);
  if (kind === 'postgres') return erPostgres(handle, database);
  return erMssql(handle, database);
}

const qSq = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** 列行 + 外键行 → {tables, edges}，并为参与外键的列打 fk 标记。 */
function assemble(colRows, fkRows) {
  const tables = new Map();
  for (const c of colRows) {
    if (!tables.has(c.table)) tables.set(c.table, { name: c.table, columns: [] });
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
  return { tables: [...tables.values()], edges, tooMany: tables.size > MAX_TABLES ? tables.size : undefined };
}

async function erSqlite(handle) {
  const { rows: tableRows } = await handle.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  if (tableRows.length > MAX_TABLES) return { tables: [], edges: [], tooMany: tableRows.length };
  const tables = [];
  const fkRows = [];
  for (const t of tableRows) {
    const { rows: cols } = await handle.query(`PRAGMA table_info(${qSq(t.name)})`);
    tables.push({
      name: t.name,
      columns: cols.slice(0, 40).map((c) => ({ name: c.name, type: c.type ?? '', pk: c.pk > 0 })),
    });
    const { rows: fks } = await handle.query(`PRAGMA foreign_key_list(${qSq(t.name)})`);
    for (const f of fks) fkRows.push({ table: t.name, col: f.from, refTable: f.table, refCol: f.to });
  }
  return assemble(tables.flatMap((t) => t.columns.map((c) => ({ table: t.name, name: c.name, type: c.type, pk: c.pk }))), fkRows);
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
    cols.map((c) => ({ table: c.table_name, name: c.column_name, type: c.column_type, pk: c.column_key === 'PRI' })),
    fks.map((f) => ({ table: f.table_name, col: f.column_name, refTable: f.referenced_table_name, refCol: f.referenced_column_name }))
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
  const { rows: fks } = await handle.query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu
       ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`, [s]);
  const pkSet = new Set(pks.map((r) => `${r.table_name}.${r.column_name}`));
  return assemble(
    cols.map((c) => ({ table: c.table_name, name: c.column_name, type: c.data_type, pk: pkSet.has(`${c.table_name}.${c.column_name}`) })),
    fks.map((f) => ({ table: f.table_name, col: f.column_name, refTable: f.ref_table, refCol: f.ref_col }))
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
  const pkSet = new Set(pks.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));
  return assemble(
    cols.map((c) => ({ table: c.TABLE_NAME, name: c.COLUMN_NAME, type: c.DATA_TYPE, pk: pkSet.has(`${c.TABLE_NAME}.${c.COLUMN_NAME}`) })),
    fks.map((f) => ({ table: f.from_table, col: f.from_col, refTable: f.to_table, refCol: f.to_col }))
  );
}
