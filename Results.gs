/**
 * Results.gs - turn what happened to one source row into a Results row
 * (upserted by dataset, row key and variant), a Log row (appended, one
 * per API call) and the cells to write back into the source row, and
 * write them.
 *
 * Each sink is written only when its mapping is non-empty: results_mapping
 * -> Results, writeback_mapping -> source tab (see Writeback.gs). The Log
 * is always written.
 *
 * buildRowOutcome is pure; writeRowOutcomes does the sheet I/O.
 */

const RESULTS_TAB = 'Results';
const LOG_TAB = 'Log';

const RESULT_KEY_COLUMNS = ['_dataset_id', '_row_key', '_variant_id'];
const RESULT_SYSTEM_COLUMNS = RESULT_KEY_COLUMNS.concat(
  ['_assignment_id', '_status', '_error', '_missing_paths', '_run_at', '_cost_usd']);

const LOG_COLUMNS = ['timestamp', 'job_id', 'assignment_id', 'dataset_id', 'row_key', 'variant_id',
  'model', 'http_code', 'status', 'latency_ms', 'input_tokens', 'output_tokens', 'cost', 'currency',
  'search_calls', 'fetch_calls', 'error', 'missing_paths', 'raw'];

const ROW_STATUS = { ok: 'ok', warning: 'warning', error: 'error' };

const LOG_RAW_MAX_CHARS = 10000;
const ERROR_MAX_CHARS = 2000;

/**
 * Decide the status of one row and build its Results row, Log row and
 * write-back cells.
 *
 * Status:
 *   error    exception before or during the call, HTTP error, or a body
 *            that is not JSON. Results columns of the assignment are
 *            cleared, so values from an earlier run do not look current.
 *            Write-back cells are left unchanged.
 *   warning  the call worked but the response status is not "completed",
 *            the model JSON did not parse while a mapping reads
 *            output_json, or some mapped paths (of either mapping) were
 *            missing. Found values are still written; write-back cells of
 *            missing paths are left unchanged.
 *   ok       everything else.
 *
 * @param {Object} o
 * @param {Object} o.assignment assignment entry from buildConfig
 * @param {Object=} o.dataset dataset entry; needed when the assignment has a writeback_mapping
 * @param {string} o.rowKey normalized row key
 * @param {string} o.jobId
 * @param {Date} o.runAt
 * @param {boolean=} o.called true when an API call was attempted
 * @param {string=} o.error message of an exception, '' or absent if none
 * @param {Object=} o.result from sendAgentRequest, null if no response
 * @param {Object=} o.mapped from mapRecordOutputs, null if not mapped
 * @param {string=} o.model model from the payload, for the Log row
 * @param {number=} o.elapsedMs time until an exception, when there is no result
 * @return {{status: string, error: string, rowKey: string, missingPaths: Array<string>,
 *           resultRow: Object, logRow: Object, writeback: Object}}
 *   resultRow is null when results_mapping is empty
 *   logRow is null when no call was attempted
 *   writeback is {dataset: {id, tabName, keyColumn, title}, rowKey, values},
 *     or null when there is nothing to write back
 */
function buildRowOutcome(o) {
  const a = o.assignment;
  const result = o.result || null;
  const json = result && result.json ? result.json : null;
  let status = ROW_STATUS.ok;
  let error = '';
  let missingPaths = [];

  if (o.error) {
    status = ROW_STATUS.error;
    error = o.error;
  } else if (!result || !result.ok || !json) {
    status = ROW_STATUS.error;
    error = result ? apiErrorMessage_(result) : 'No response';
  } else if (!o.mapped) {
    status = ROW_STATUS.error;
    error = 'Response was not mapped';
  } else {
    const notes = [];
    if (isPresent_(json.status) && json.status !== 'completed') notes.push('Response status "' + json.status + '"');
    if (o.mapped.envelope.output_json_error && mapsOutputJson_(a)) {
      notes.push('Model JSON not parsed: ' + o.mapped.envelope.output_json_error);
    }
    // Paths, not column names; a path used by both mappings is listed once.
    o.mapped.results.missing.map(function (column) { return a.resultsMapping[column]; })
      .concat(o.mapped.writeback.missing.map(function (column) { return a.writebackMapping[column]; }))
      .forEach(function (path) { if (missingPaths.indexOf(path) === -1) missingPaths.push(path); });
    if (notes.length || missingPaths.length) status = ROW_STATUS.warning;
    error = notes.join('; ');
  }
  error = truncate_(String(error), ERROR_MAX_CHARS);

  const usage = json ? extractUsage(json) : {};
  let resultRow = null;
  if (Object.keys(a.resultsMapping).length) {
    resultRow = {
      _dataset_id: a.datasetId,
      _row_key: o.rowKey,
      _variant_id: a.variantId,
      _assignment_id: a.id,
      _status: status,
      _error: error,
      _missing_paths: missingPaths.join(', '),
      _run_at: o.runAt,
      _cost_usd: blankIfAbsent_(usage.totalCost)
    };
    Object.keys(a.resultsMapping).forEach(function (column) {
      resultRow[column] = status === ROW_STATUS.error ? '' : o.mapped.results.values[column];
    });
  }

  let writeback = null;
  if (status !== ROW_STATUS.error && Object.keys(a.writebackMapping).length) {
    const missing = o.mapped.writeback.missing;
    const values = {};
    Object.keys(a.writebackMapping).forEach(function (column) {
      if (missing.indexOf(column) === -1) values[column] = o.mapped.writeback.values[column];
    });
    if (Object.keys(values).length) {
      if (!o.dataset) throw new Error('buildRowOutcome: dataset is needed for the writeback_mapping of ' + a.id);
      const d = o.dataset;
      writeback = {
        dataset: { id: d.id, tabName: d.tabName, keyColumn: d.keyColumn, title: d.title },
        rowKey: o.rowKey,
        values: values
      };
    }
  }

  const logRow = (o.called || result) ? {
    timestamp: o.runAt,
    job_id: o.jobId,
    assignment_id: a.id,
    dataset_id: a.datasetId,
    row_key: o.rowKey,
    variant_id: a.variantId,
    model: blankIfAbsent_(usage.model || o.model),
    http_code: result ? result.code : '',
    status: status,
    latency_ms: blankIfAbsent_(result ? result.elapsedMs : o.elapsedMs),
    input_tokens: blankIfAbsent_(usage.inputTokens),
    output_tokens: blankIfAbsent_(usage.outputTokens),
    cost: blankIfAbsent_(usage.totalCost),
    currency: blankIfAbsent_(usage.currency),
    search_calls: blankIfAbsent_(usage.searchCalls),
    fetch_calls: blankIfAbsent_(usage.fetchCalls),
    error: error,
    missing_paths: missingPaths.join(', '),
    raw: result ? truncate_(String(result.body || ''), LOG_RAW_MAX_CHARS) : ''
  } : null;

  return {
    status: status, error: error, rowKey: o.rowKey, missingPaths: missingPaths,
    resultRow: resultRow, logRow: logRow, writeback: writeback
  };
}

/**
 * Write outcomes from buildRowOutcome: Log rows are appended first (so a
 * billed call is recorded even if a later write fails), then Results rows
 * are upserted, then values are written back into the source tabs. The
 * Log and Results tabs are created on first use.
 *
 * The caller holds the document lock (upsertRows rewrites the Results
 * block; write-back finds rows by key just before writing).
 *
 * @param {Array<Object>} outcomes
 * @return {{logged: number, inserted: number, updated: number, addedColumns: Array<string>,
 *           writeback: {cells: number, addedColumns: Array<string>, notFound: Array<Object>}}}
 *   writeback.addedColumns: 'Tab!Column' names; notFound: {datasetId, rowKey}
 *   of rows no longer in their block (left unwritten)
 */
function writeRowOutcomes(outcomes) {
  const logRows = outcomes.map(function (o) { return o.logRow; }).filter(Boolean);
  const logged = appendRows(getOrCreateSheet(LOG_TAB, LOG_COLUMNS), logRows);

  const resultRows = outcomes.map(function (o) { return o.resultRow; }).filter(Boolean);
  const up = resultRows.length
    ? upsertRows(getOrCreateSheet(RESULTS_TAB, RESULT_SYSTEM_COLUMNS), RESULT_KEY_COLUMNS, resultRows)
    : { inserted: 0, updated: 0, addedColumns: [] };

  const wb = { cells: 0, addedColumns: [], notFound: [] };
  const byDataset = {};
  outcomes.forEach(function (o) {
    if (!o.writeback) return;
    const id = o.writeback.dataset.id;
    if (!hasOwn_(byDataset, id)) byDataset[id] = { dataset: o.writeback.dataset, rows: [] };
    byDataset[id].rows.push({ rowKey: o.writeback.rowKey, values: o.writeback.values });
  });
  Object.keys(byDataset).forEach(function (id) {
    const group = byDataset[id];
    const r = writeBackRows(group.dataset, group.rows);
    wb.cells += r.cells;
    r.addedColumns.forEach(function (c) { wb.addedColumns.push(group.dataset.tabName + '!' + c); });
    r.notFound.forEach(function (key) { wb.notFound.push({ datasetId: id, rowKey: key }); });
  });

  return { logged: logged.appended, inserted: up.inserted, updated: up.updated, addedColumns: up.addedColumns,
    writeback: wb };
}

/** One log line describing what writeRowOutcomes wrote. */
function describeWrites_(w) {
  const parts = [w.logged + ' ' + LOG_TAB + ' row(s)'];
  if (w.inserted || w.updated) {
    parts.push(RESULTS_TAB + ' ' + w.inserted + ' inserted, ' + w.updated + ' updated' +
      (w.addedColumns.length ? ' (new columns: ' + w.addedColumns.join(', ') + ')' : ''));
  }
  const wb = w.writeback;
  if (wb.cells || wb.notFound.length) {
    parts.push(wb.cells + ' cell(s) written back' +
      (wb.addedColumns.length ? ' (new columns: ' + wb.addedColumns.join(', ') + ')' : '') +
      (wb.notFound.length ? ', not written back (row no longer in its block): ' +
        wb.notFound.map(function (n) { return n.datasetId + ' ' + displayKey(n.rowKey); }).join(', ') : ''));
  }
  return 'Wrote ' + parts.join('; ');
}

/** A job id that sorts by start time, e.g. job_20261027T153012Z_k3f9. */
function newJobId_() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return 'job_' + stamp + '_' + Math.random().toString(36).slice(2, 6);
}

/** Short message for a failed call: the API error message if there is one, else the body. */
function apiErrorMessage_(result) {
  const json = result.json;
  let detail = '';
  if (json && json.error) detail = typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error));
  else if (json && json.detail) detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail);
  else if (result.ok) detail = 'response body is not JSON';
  else detail = truncate_(String(result.body || ''), 500);
  return 'HTTP ' + result.code + ': ' + detail;
}

/** True when any results or write-back path of the assignment starts at output_json. */
function mapsOutputJson_(assignment) {
  return [assignment.resultsPaths || {}, assignment.writebackPaths || {}].some(function (paths) {
    return Object.keys(paths).some(function (column) { return paths[column][0] === 'output_json'; });
  });
}

function blankIfAbsent_(v) {
  return v === undefined || v === null ? '' : v;
}
