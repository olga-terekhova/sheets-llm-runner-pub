/**
 * Writeback.gs - write mapped output values back into the source tab of a
 * dataset (an assignment's writeback_mapping).
 *
 * Rules:
 *   - Rows are found by key inside the dataset's block, in values read just
 *     before writing, because another script (the feed) may have inserted
 *     or moved rows since the run started. A key no longer in the block is
 *     reported, not written.
 *   - Only the mapped cells are written (one range per contiguous run of
 *     columns in a row), never the whole block, so formulas, formatting and
 *     metadata rows of the tab are left alone. upsertRows is not suitable.
 *   - Target columns missing from row 1 are appended to the right of the
 *     last header. Headers are tab-wide, so a new column also shows next to
 *     other datasets on the same tab.
 *   - Strings are escaped like other writes (see escapeCellValue_).
 *
 * planWriteback is pure; writeBackRows does the sheet I/O. The caller holds
 * the document lock.
 */

/* ---------- pure functions ---------- */

/**
 * Plan the cells to write into a source tab.
 *
 * @param {Array<Array<*>>} values the whole tab, row 1 = headers
 * @param {{tabName: string, keyColumn: string, title: string}} dataset
 * @param {Array<{rowKey: *, values: Object}>} rows column -> value per row;
 *   a later row with the same key wins
 * @return {{addedColumns: Array<string>, headerColumn: number,
 *           runs: Array<{row: number, column: number, values: Array<*>}>,
 *           cells: number, notFound: Array<string>}}
 *   headerColumn: 1-based column of the first added header ('' if none);
 *   runs: 1-row ranges to write, row and column 1-based
 */
function planWriteback(values, dataset, rows) {
  const tab = dataset.tabName;
  const table = tableFromValues(values, tab);
  if (table.headers.indexOf(dataset.keyColumn) === -1) {
    throw new Error('key_column "' + dataset.keyColumn + '" not found in tab "' + tab + '"');
  }
  const block = selectDatasetBlock(table, dataset.keyColumn, dataset.title, tab);
  const index = indexByKey(block, dataset.keyColumn, tab);

  // Real column positions: tableFromValues drops blank header cells.
  const colOf = {};
  let width = 0;
  (values.length ? values[0] : []).forEach(function (h, c) {
    const name = String(h === null || h === undefined ? '' : h).trim();
    if (name === '') return;
    colOf[name] = c + 1;
    width = c + 1;
  });
  const addedColumns = [];
  const headerColumn = width + 1;

  const cellAt = {}; // 'row:column' -> value
  const notFound = [];
  (rows || []).forEach(function (r) {
    const key = makeKey({ k: r.rowKey }, ['k']);
    if (!hasOwn_(index, key)) {
      if (notFound.indexOf(key) === -1) notFound.push(key);
      return;
    }
    const sheetRow = block.rowNumbers[index[key]];
    Object.keys(r.values).forEach(function (name) {
      if (!hasOwn_(colOf, name)) {
        colOf[name] = ++width;
        addedColumns.push(name);
      }
      cellAt[sheetRow + ':' + colOf[name]] = r.values[name];
    });
  });

  const cells = Object.keys(cellAt).map(function (at) {
    const p = at.split(':');
    return { row: Number(p[0]), column: Number(p[1]), value: cellAt[at] };
  }).sort(function (a, b) { return a.row - b.row || a.column - b.column; });

  const runs = [];
  cells.forEach(function (c) {
    const last = runs[runs.length - 1];
    if (last && last.row === c.row && last.column + last.values.length === c.column) last.values.push(c.value);
    else runs.push({ row: c.row, column: c.column, values: [c.value] });
  });

  return {
    addedColumns: addedColumns,
    headerColumn: addedColumns.length ? headerColumn : '',
    runs: runs,
    cells: cells.length,
    notFound: notFound
  };
}

/* ---------- sheet I/O wrappers ---------- */

/**
 * Write values back into a dataset's source tab: one read of the tab, then
 * one write for the added headers (if any) and one per run of cells.
 *
 * @param {{tabName: string, keyColumn: string, title: string}} dataset
 * @param {Array<{rowKey: *, values: Object}>} rows
 * @return {{cells: number, addedColumns: Array<string>, notFound: Array<string>}}
 */
function writeBackRows(dataset, rows) {
  if (!rows || !rows.length) return { cells: 0, addedColumns: [], notFound: [] };
  const sheet = getSheetOrThrow(dataset.tabName);
  const plan = planWriteback(readValues_(sheet), dataset, rows);

  const lastColumn = plan.addedColumns.length ? plan.headerColumn + plan.addedColumns.length - 1 : 0;
  const lastRow = plan.runs.reduce(function (m, r) { return Math.max(m, r.row); }, 1);
  ensureSheetSize_(sheet, lastRow, Math.max(lastColumn, 1));
  if (plan.addedColumns.length) {
    sheet.getRange(1, plan.headerColumn, 1, plan.addedColumns.length)
      .setValues([plan.addedColumns.map(function (h) { return escapeCellValue_(h); })]);
  }
  plan.runs.forEach(function (r) {
    sheet.getRange(r.row, r.column, 1, r.values.length)
      .setValues([r.values.map(function (v) { return escapeCellValue_(v); })]);
  });
  return { cells: plan.cells, addedColumns: plan.addedColumns, notFound: plan.notFound };
}
