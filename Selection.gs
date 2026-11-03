/**
 * Selection.gs - turn the user's selection on a source tab into row keys,
 * check the run before any API call, and format its summary.
 *
 * Pure: no sheet access. The runner (Menu.gs) reads the active range list
 * and the tab once, then calls these functions. Keys are resolved
 * immediately, so later steps work by key, not by row number (the other
 * script inserts rows).
 */

/**
 * Sheet row numbers covered by a list of ranges, sorted and deduplicated.
 * Any selected cell counts as its whole row.
 *
 * @param {Array<{row: number, numRows: number}>} ranges e.g. from getRow()/getNumRows()
 * @return {Array<number>}
 */
function rowNumbersFromRanges(ranges) {
  const seen = {};
  const out = [];
  (ranges || []).forEach(function (r) {
    for (let n = r.row; n < r.row + r.numRows; n++) {
      if (seen[n]) continue;
      seen[n] = true;
      out.push(n);
    }
  });
  return out.sort(function (a, b) { return a - b; });
}

/**
 * Map selected sheet rows to (dataset, key, assignment).
 *
 * Each selected row falls into one of:
 *   items       data rows of a declared dataset block, in sheet order
 *   undeclared  rows with a key that are in no declared block (likely a
 *               missing Datasets row); reported by row number
 *   skipped     everything else: header, headings, metadata rows, blank
 *               rows, rows below the data; skipped quietly (counted only)
 * Rows of a dataset without default_assignment are still items, with
 * assignmentId ''; the caller decides what to do with them.
 *
 * @param {{rows: Array<Object>, rowNumbers: Array<number>}} table the whole tab, from tableFromValues
 * @param {Array<Object>} datasets dataset entries on this tab, with table attached (attachSourceValues)
 * @param {Array<number>} rowNumbers selected sheet rows (from rowNumbersFromRanges)
 * @return {{items: Array<{rowNumber: number, rowKey: string, datasetId: string, assignmentId: string}>,
 *           undeclared: Array<number>, skipped: Array<number>}}
 */
function resolveSelection(table, datasets, rowNumbers) {
  const byRow = {}; // sheet row -> {dataset, i}
  const keyColumns = [];
  datasets.forEach(function (d) {
    if (keyColumns.indexOf(d.keyColumn) === -1) keyColumns.push(d.keyColumn);
    if (!d.table) return;
    d.table.rowNumbers.forEach(function (n, i) { byRow[n] = { dataset: d, i: i }; });
  });
  const tableRow = {}; // sheet row -> row object, for rows outside any block
  table.rowNumbers.forEach(function (n, i) { tableRow[n] = table.rows[i]; });

  const out = { items: [], undeclared: [], skipped: [] };
  rowNumbersFromRanges(rowNumbers.map(function (n) { return { row: n, numRows: 1 }; })).forEach(function (n) {
    const hit = byRow[n];
    if (hit) {
      out.items.push({
        rowNumber: n,
        rowKey: makeKey(hit.dataset.table.rows[hit.i], [hit.dataset.keyColumn]),
        datasetId: hit.dataset.id,
        assignmentId: hit.dataset.defaultAssignment || ''
      });
      return;
    }
    const row = tableRow[n];
    const keyed = row && keyColumns.some(function (c) { return makeKey(row, [c]) !== ''; });
    (keyed ? out.undeclared : out.skipped).push(n);
  });
  return out;
}

/**
 * Check a resolved selection before any API call and build one run context
 * per involved assignment (same shape as loadRunContext). The run must not
 * start if errors is non-empty. Errors:
 *   - any dataset on the tab has config errors (its rows would look undeclared)
 *   - selected keyed rows outside any declared block
 *   - selected rows of a dataset without default_assignment
 *   - config problems of an involved assignment, its dataset or variant
 * Needs the datasets' blocks attached (attachSourceValues), because the
 * input columns are checked here.
 *
 * @param {Object} config from buildConfig
 * @param {Array<Object>} tabDatasets every dataset on the tab
 * @param {{items: Array<Object>, undeclared: Array<number>}} resolved from resolveSelection
 * @return {{errors: Array<string>, warnings: Array<string>, contexts: Object<string, Object>}}
 */
function planSelectionRun(config, tabDatasets, resolved) {
  const errors = [];
  const warnings = [];
  function add(list, messages) {
    messages.forEach(function (m) { if (list.indexOf(m) === -1) list.push(m); });
  }

  tabDatasets.forEach(function (d) { add(errors, d.errors); });
  if (resolved.undeclared.length) {
    add(errors, ['Selected rows ' + formatRowList(resolved.undeclared) +
      ' have a key but are in no dataset declared in ' + CONFIG_TABS.datasets]);
  }

  const noDefault = {}; // datasetId -> row numbers
  const assignmentIds = [];
  resolved.items.forEach(function (item) {
    if (!item.assignmentId) {
      if (!hasOwn_(noDefault, item.datasetId)) noDefault[item.datasetId] = [];
      noDefault[item.datasetId].push(item.rowNumber);
    } else if (assignmentIds.indexOf(item.assignmentId) === -1) {
      assignmentIds.push(item.assignmentId);
    }
  });
  Object.keys(noDefault).forEach(function (id) {
    add(errors, ['Dataset "' + id + '" has no default_assignment; selected rows of it: ' + formatRowList(noDefault[id])]);
  });

  const contexts = {};
  assignmentIds.forEach(function (id) {
    const a = config.assignments[id];
    if (!a) return; // reported as a dataset error (linkDefaultAssignment_)
    const d = config.datasets[a.datasetId];
    checkInputColumns(a, d);
    const p = problemsFor(config, a);
    add(errors, p.errors);
    add(warnings, p.warnings);
    contexts[id] = { config: config, assignment: a, variant: config.variants[a.variantId], dataset: d, warnings: p.warnings };
  });
  return { errors: errors, warnings: warnings, contexts: contexts };
}

/**
 * Row numbers as short text: [3, 4, 5, 9] -> '3-5, 9'.
 * @param {Array<number>} rows sorted
 * @return {string}
 */
function formatRowList(rows) {
  const parts = [];
  for (let i = 0; i < rows.length; i++) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    parts.push(j > i ? rows[i] + '-' + rows[j] : String(rows[i]));
    i = j;
  }
  return parts.join(', ');
}

/**
 * Text for the end-of-run dialog.
 *
 * @param {{jobId: string, total: number, skipped: number,
 *          done: Array<{rowNumber: number, rowKey: string, status: string, error: string,
 *                       notWrittenBack: boolean}>,
 *          notStarted: Array<{rowNumber: number, rowKey: string}>, failure: string}} s
 *   notStarted: rows not started, plus the row that hit the failure
 *   failure: message of an exception that stopped the run, '' if none
 * @return {string}
 */
function formatRunSummary(s) {
  const counts = {};
  Object.keys(ROW_STATUS).forEach(function (k) { counts[ROW_STATUS[k]] = 0; });
  s.done.forEach(function (d) { counts[d.status] = (counts[d.status] || 0) + 1; });

  const lines = ['Processed ' + s.done.length + ' of ' + s.total + ' row(s): ' +
    Object.keys(counts).map(function (k) { return counts[k] + ' ' + k; }).join(', ') + '.'];
  if (s.skipped) lines.push(s.skipped + ' selected row(s) skipped (header, headings, metadata or blank).');
  const failed = s.done.filter(function (d) { return d.status === ROW_STATUS.error; });
  if (failed.length) {
    lines.push('', 'Errors:');
    failed.forEach(function (d) { lines.push('- row ' + d.rowNumber + ' (' + displayKey(d.rowKey) + '): ' + truncate_(String(d.error || ''), 200)); });
  }
  const lost = s.done.filter(function (d) { return d.notWrittenBack; });
  if (lost.length) {
    lines.push('', 'Not written back (the row moved out of its block during the run; see the ' + LOG_TAB +
      ' tab): rows ' + formatRowList(lost.map(function (d) { return d.rowNumber; })) + '.');
  }
  if (s.failure) lines.push('', 'The run stopped: ' + s.failure);
  if (s.notStarted.length) {
    lines.push('', 'Not processed (' + (s.failure ? 'run stopped' : 'time limit') + '), select and run again: rows ' +
      formatRowList(s.notStarted.map(function (i) { return i.rowNumber; })) + '.');
  }
  lines.push('', 'Job ' + s.jobId + '. Details in the ' + RESULTS_TAB + ' and ' + LOG_TAB + ' tabs.');
  return lines.join('\n');
}
