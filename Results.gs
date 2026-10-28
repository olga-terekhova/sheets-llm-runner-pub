/**
 * Results.gs - turn what happened to one source row into a Results row
 * (upserted by dataset, row key and variant) and a Log row (appended, one
 * per API call), and write them.
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
  'search_calls', 'fetch_calls', 'error', 'raw'];

const ROW_STATUS = { ok: 'ok', warning: 'warning', error: 'error' };

const LOG_RAW_MAX_CHARS = 10000;
const ERROR_MAX_CHARS = 2000;

/**
 * Decide the status of one row and build its Results and Log rows.
 *
 * Status:
 *   error    exception before or during the call, HTTP error, or a body
 *            that is not JSON. Output columns of the assignment are
 *            cleared, so values from an earlier run do not look current.
 *   warning  the call worked but the response status is not "completed",
 *            the model JSON did not parse while the mapping reads
 *            output_json, or some mapped paths were missing.
 *   ok       everything else.
 *
 * @param {Object} o
 * @param {Object} o.assignment assignment entry from buildConfig
 * @param {string} o.rowKey normalized row key
 * @param {string} o.jobId
 * @param {Date} o.runAt
 * @param {boolean=} o.called true when an API call was attempted
 * @param {string=} o.error message of an exception, '' or absent if none
 * @param {Object=} o.result from sendAgentRequest, null if no response
 * @param {Object=} o.mapped from mapRecordOutputs, null if not mapped
 * @param {string=} o.model model from the payload, for the Log row
 * @param {number=} o.elapsedMs time until an exception, when there is no result
 * @return {{status: string, error: string, resultRow: Object, logRow: Object}}
 *   logRow is null when no call was attempted
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
    missingPaths = o.mapped.missing.map(function (column) { return a.outputMapping[column]; });
    if (notes.length || missingPaths.length) status = ROW_STATUS.warning;
    error = notes.join('; ');
  }
  error = truncate_(String(error), ERROR_MAX_CHARS);

  const usage = json ? extractUsage(json) : {};
  const resultRow = {
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
  Object.keys(a.outputMapping).forEach(function (column) {
    resultRow[column] = status === ROW_STATUS.error ? '' : o.mapped.values[column];
  });

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
    raw: result ? truncate_(String(result.body || ''), LOG_RAW_MAX_CHARS) : ''
  } : null;

  return { status: status, error: error, resultRow: resultRow, logRow: logRow };
}

/**
 * Write outcomes from buildRowOutcome: Log rows are appended first (so a
 * billed call is recorded even if the Results write fails), then Results
 * rows are upserted. Both tabs are created on first use.
 * @param {Array<Object>} outcomes
 * @return {{logged: number, inserted: number, updated: number, addedColumns: Array<string>}}
 */
function writeRowOutcomes(outcomes) {
  const logRows = outcomes.map(function (o) { return o.logRow; }).filter(Boolean);
  const logged = appendRows(getOrCreateSheet(LOG_TAB, LOG_COLUMNS), logRows);
  const up = upsertRows(getOrCreateSheet(RESULTS_TAB, RESULT_SYSTEM_COLUMNS), RESULT_KEY_COLUMNS,
    outcomes.map(function (o) { return o.resultRow; }));
  return { logged: logged.appended, inserted: up.inserted, updated: up.updated, addedColumns: up.addedColumns };
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

/** True when any output path of the assignment starts at output_json. */
function mapsOutputJson_(assignment) {
  const paths = assignment.outputPaths || {};
  return Object.keys(paths).some(function (column) { return paths[column][0] === 'output_json'; });
}

function blankIfAbsent_(v) {
  return v === undefined || v === null ? '' : v;
}
