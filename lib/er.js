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

/** 粗粒度单复数归一（SchemaSpy 式推断用）：categories→category、boxes→box、users→user。 */
function singular(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith('ies')) return n.slice(0, -3) + 'y';
  if (/(ses|xes|zes|ches|shes)$/.test(n)) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss')) return n.slice(0, -1);
  return n;
}

/**
 * SchemaSpy 式「推断关系」（v0.9.16）：数据库没有外键约束时（多数生产库的常态），
 * 按命名约定补边——列名 <表名(单复数归一)>_id/_no/_key/_code/_uuid → 该表主键。
 * 保守规则保精确率：只接受唯一候选表（两表同名不猜）、只指向单列主键、
 * 已有显式外键的列不再推断；推断边带 inferred: true（前端画虚线、可开关）。
 */
function inferEdges(tables, explicitEdges, uniqueFrom) {
  const explicitKeys = new Set(explicitEdges.map((e) => `${e.fromTable}.${e.fromCol}`));
  const nameBy = new Map(); // 归一表名 → 表名（多表同名时置 null，歧义不猜）
  for (const tb of tables.values()) {
    for (const key of [String(tb.name).toLowerCase(), singular(tb.name)]) {
      nameBy.set(key, nameBy.has(key) ? null : tb.name);
    }
  }
  const pkByTable = new Map();
  for (const tb of tables.values()) {
    const pks = tb.columns.filter((c) => c.pk);
    pkByTable.set(tb.name, pks.length === 1 ? pks[0].name : null); // 复合主键不参与推断
  }
  const out = [];
  for (const tb of tables.values()) {
    for (const col of tb.columns) {
      if (col.pk) continue;
      const key = `${tb.name}.${col.name}`;
      if (explicitKeys.has(key)) continue;
      const m = /^(.+)_(id|no|key|code|uuid)$/.exec(String(col.name).toLowerCase());
      if (!m) continue;
      const base = m[1];
      if (!nameBy.has(base)) continue;
      const cand = nameBy.get(base);
      if (!cand) continue; // 歧义：多张表同名
      const refCol = pkByTable.get(cand);
      if (!refCol) continue;
      out.push({
        fromTable: tb.name, fromCol: col.name, toTable: cand, toCol: refCol,
        card: uniqueFrom?.has(key) ? '1:1' : 'N:1',
        inferred: true,
      });
      if (explicitEdges.length + out.length >= MAX_EDGES) return out; // 总量仍受上限约束
    }
  }
  return out;
}

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
 *  缺省时用实际组装出的表数。超过 ER_LIST_MAX 的表不进清单，但计入 tooMany。
 *  uniqueFrom（v0.9.15）：单列唯一（主键/唯一索引/唯一约束）的 "表.列" 集合——
 *  从这种列出发的外键，每个父行至多被一个子行引用 → 基数推导为 1:1，其余 N:1。
 *  R-EDGE1（v0.9.15）：超 MAX_EDGES 的边不再静默丢弃——edgesTruncated 上报总数。 */
function assemble(colRows, fkRows, totalTables, uniqueFrom) {
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
  let edgeTotal = 0;
  for (const f of fkRows) {
    if (!tables.has(f.table) || !tables.has(f.refTable)) continue; // 指向本库之外的引用不画
    edgeTotal++;
    if (edges.length >= MAX_EDGES) continue;
    edges.push({
      fromTable: f.table, fromCol: f.col, toTable: f.refTable, toCol: f.refCol,
      card: uniqueFrom?.has(`${f.table}.${f.col}`) ? '1:1' : 'N:1',
    });
  }
  // SchemaSpy 式推断关系：显式外键不足时按命名约定补边（虚线展示、可开关），
  // 与显式边共享 400 上限
  const inferred = inferEdges(tables, edges, uniqueFrom);
  edges.push(...inferred);
  for (const tb of tables.values()) {
    for (const col of tb.columns) col.fk = edges.some((e) => e.fromTable === tb.name && e.fromCol === col.name);
  }
  const count = totalTables ?? total;
  return {
    tables: [...tables.values()],
    edges,
    tooMany: count > MAX_TABLES ? count : undefined,
    edgesTruncated: edgeTotal > MAX_EDGES ? edgeTotal : undefined,
  };
}

async function erSqlite(handle) {
  const { rows: tableRows } = await handle.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const listed = tableRows.slice(0, ER_LIST_MAX);
  const tables = [];
  const fkRows = [];
  const uniqueFrom = new Set();
  for (const t of listed) {
    const { rows: cols } = await handle.query(`PRAGMA table_info(${qSq(t.name)})`);
    tables.push({
      name: t.name,
      columns: cols.slice(0, 40).map((c) => ({ name: c.name, type: c.type ?? '', pk: c.pk > 0 })),
    });
    const { rows: fks } = await handle.query(`PRAGMA foreign_key_list(${qSq(t.name)})`);
    for (const f of fks) fkRows.push({ table: t.name, col: f.from, refTable: f.table, refCol: f.to, seq: f.seq });
    // 基数推导（v0.9.15）：单列主键 + 单列唯一索引的列
    const pkCols = cols.filter((c) => c.pk > 0);
    if (pkCols.length === 1) uniqueFrom.add(`${t.name}.${pkCols[0].name}`);
    const { rows: idx } = await handle.query(`PRAGMA index_list(${qSq(t.name)})`);
    for (const ix of idx) {
      if (!ix.unique) continue;
      const { rows: ixCols } = await handle.query(`PRAGMA index_info(${qSq(ix.name)})`);
      if (ixCols.length === 1 && ixCols[0].name) uniqueFrom.add(`${t.name}.${ixCols[0].name}`);
    }
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
    tableRows.length,
    uniqueFrom
  );
}

async function erMysql(handle, database) {
  const db = database && database !== '(file)' ? database : null;
  if (!db) throw new Error('需要在库节点上打开 E-R 图（未指定 database） (open the ER diagram on a database node)');
  // v0.9.15：join tables 过滤视图（此前视图会以无连线实体出现在图上）
  const { rows: cols } = await handle.query(
    `SELECT c.table_name, c.column_name, c.column_type, c.column_key
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = ? AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`, [db]);
  const { rows: fks } = await handle.query(
    `SELECT table_name, column_name, referenced_table_name, referenced_column_name
     FROM information_schema.key_column_usage
     WHERE table_schema = ? AND referenced_table_name IS NOT NULL`, [db]);
  // 基数推导（v0.9.15）：单列唯一索引（含 PRIMARY）的列——子查询排除复合索引
  const { rows: uqs } = await handle.query(
    `SELECT s.table_name, s.column_name FROM information_schema.statistics s
     WHERE s.table_schema = ? AND s.non_unique = 0 AND s.seq_in_index = 1
       AND NOT EXISTS (SELECT 1 FROM information_schema.statistics s2
         WHERE s2.table_schema = s.table_schema AND s2.index_name = s.index_name AND s2.seq_in_index > 1)`, [db]);
  const uniqueFrom = new Set(uqs.map((raw) => { const u = lowerRow(raw); return `${u.table_name}.${u.column_name}`; }));
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.column_type, pk: c.column_key === 'PRI' }; }),
    fks.map((raw) => { const f = lowerRow(raw); return { table: f.table_name, col: f.column_name, refTable: f.referenced_table_name, refCol: f.referenced_column_name }; }),
    undefined,
    uniqueFrom
  );
}

async function erPostgres(handle, schema) {
  const s = schema && schema !== '(file)' ? schema : 'public';
  // v0.9.15：join tables 过滤视图
  const { rows: cols } = await handle.query(
    `SELECT c.table_name, c.column_name, c.data_type
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`, [s]);
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
  // 基数推导（v0.9.15）：单列 UNIQUE / PRIMARY KEY 约束的列
  const { rows: uqs } = await handle.query(
    `SELECT tp.relname AS table_name, pa.attname AS column_name
     FROM pg_constraint c
     JOIN pg_class tp ON tp.oid = c.conrelid
     JOIN pg_namespace sn ON sn.oid = tp.relnamespace
     JOIN pg_attribute pa ON pa.attrelid = c.conrelid AND pa.attnum = c.conkey[1]
     WHERE sn.nspname = $1 AND c.contype IN ('u','p') AND array_length(c.conkey, 1) = 1`, [s]);
  const uniqueFrom = new Set(uqs.map((raw) => { const u = lowerRow(raw); return `${u.table_name}.${u.column_name}`; }));
  const pkSet = new Set(pks.map((raw) => { const r = lowerRow(raw); return `${r.table_name}.${r.column_name}`; }));
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.data_type, pk: pkSet.has(`${c.table_name}.${c.column_name}`) }; }),
    fks.map((raw) => { const f = lowerRow(raw); return { table: f.table_name, col: f.column_name, refTable: f.ref_table, refCol: f.ref_col }; }),
    undefined,
    uniqueFrom
  );
}

async function erMssql(handle, schema) {
  const s = schema && schema !== '(file)' ? schema : 'dbo';
  // v0.9.15：过滤视图（TABLE_TYPE = BASE TABLE）
  const { rows: cols } = await handle.query(
    `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS c
     WHERE c.TABLE_SCHEMA = @p1
       AND c.TABLE_NAME IN (SELECT t.TABLE_NAME FROM INFORMATION_SCHEMA.TABLES t WHERE t.TABLE_SCHEMA = @p1 AND t.TABLE_TYPE = 'BASE TABLE')
     ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`, [s]);
  const { rows: pks } = await handle.query(
    `SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
     WHERE kcu.TABLE_SCHEMA = @p1 AND kcu.CONSTRAINT_NAME IN (
       SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_TYPE = 'PRIMARY KEY' AND TABLE_SCHEMA = @p1)`, [s]);
  // 基数推导（v0.9.15）：单列 UNIQUE / PRIMARY KEY 约束的列
  const { rows: uqs } = await handle.query(
    `SELECT tc.TABLE_NAME AS table_name, ku.COLUMN_NAME AS column_name
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
     WHERE tc.TABLE_SCHEMA = @p1 AND tc.CONSTRAINT_TYPE IN ('UNIQUE','PRIMARY KEY')
     GROUP BY tc.CONSTRAINT_NAME, tc.TABLE_NAME, ku.COLUMN_NAME
     HAVING COUNT(*) = 1`, [s]);
  const uniqueFrom = new Set(uqs.map((raw) => { const u = lowerRow(raw); return `${u.table_name}.${u.column_name}`; }));
  const pkSet = new Set(pks.map((raw) => { const r = lowerRow(raw); return `${r.table_name}.${r.column_name}`; }));
  return assemble(
    cols.map((raw) => { const c = lowerRow(raw); return { table: c.table_name, name: c.column_name, type: c.data_type, pk: pkSet.has(`${c.table_name}.${c.column_name}`) }; }),
    await fksForMssql(handle, s),
    undefined,
    uniqueFrom
  );
}

/** mssql 外键查询抽出（erMssql 内 await 需要顺序执行，抽函数保持可读）。 */
async function fksForMssql(handle, s) {
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
  return fks.map((raw) => { const f = lowerRow(raw); return { table: f.from_table, col: f.from_col, refTable: f.to_table, refCol: f.to_col }; });
}
