/**
 * Run.gs - M4 entry points: create the config tabs, validate the config,
 * and run one source row by key. Results only go to the Execution log;
 * writing the Results and Log tabs comes in M5.
 *
 * In the editor:
 *   1. Run setupConfigTabs once, then fill in Datasets, Variants, Assignments.
 *   2. Run validateConfig and fix any ERROR lines.
 *   3. Set RUN_ASSIGNMENT_ID and RUN_ROW_KEY below.
 *   4. Run dryRunOne (no API call), then runOne (one live, billed call).
 */

const RUN_ASSIGNMENT_ID = '';
const RUN_ROW_KEY = '';

/** Create any missing config tabs with their header row. Existing tabs are left alone. */
function setupConfigTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(CONFIG_TABS).forEach(function (kind) {
    const name = CONFIG_TABS[kind];
    if (ss.getSheetByName(name)) {
      Logger.log('Tab "' + name + '" already exists, left unchanged');
      return;
    }
    getOrCreateSheet(name, CONFIG_COLUMNS[kind]);
    Logger.log('Created tab "' + name + '"');
  });
}

/**
 * Validate the config tabs and every source tab they reference.
 * Logs every error and warning. No API calls.
 * @return {{errors: Array<string>, warnings: Array<string>}}
 */
function validateConfig() {
  const config = loadConfigWithSources();
  const problems = listProblems(config);
  Logger.log('Loaded ' + Object.keys(config.datasets).length + ' dataset(s), ' +
    Object.keys(config.variants).length + ' variant(s), ' +
    Object.keys(config.assignments).length + ' assignment(s)');
  Object.keys(config.datasets).forEach(function (id) {
    const d = config.datasets[id];
    if (!d.table) return;
    const rows = d.table.rowNumbers;
    Logger.log('Dataset ' + id + ': tab "' + d.tabName + '"' + (d.title ? ', title "' + d.title + '"' : '') +
      ', rows ' + rows[0] + '-' + rows[rows.length - 1] + ' (' + rows.length + ' rows)');
  });
  problems.errors.forEach(function (e) { Logger.log('ERROR ' + e); });
  problems.warnings.forEach(function (w) { Logger.log('WARN ' + w); });
  Logger.log(problems.errors.length ? problems.errors.length + ' error(s), ' + problems.warnings.length + ' warning(s)'
    : 'No errors, ' + problems.warnings.length + ' warning(s)');
  return problems;
}

/** Editor entry point: dryRunRow with the constants above. */
function dryRunOne() {
  checkRunConstants_();
  return dryRunRow(RUN_ASSIGNMENT_ID, RUN_ROW_KEY);
}

/** Editor entry point: runRow with the constants above. Makes one billed call. */
function runOne() {
  checkRunConstants_();
  return runRow(RUN_ASSIGNMENT_ID, RUN_ROW_KEY);
}

/**
 * Load config and the source row, and build the payload. No API call.
 * @param {string} assignmentId
 * @param {*} rowKey
 * @return {{ctx: Object, record: Object, rowNumber: number, rowKey: string, payload: Object}}
 */
function prepareRow(assignmentId, rowKey) {
  const ctx = loadRunContext(assignmentId);
  const found = findRecord(ctx.dataset, rowKey);
  const payload = buildRecordPayload(found.record, ctx.variant, ctx.assignment);
  return { ctx: ctx, record: found.record, rowNumber: found.rowNumber, rowKey: found.rowKey, payload: payload };
}

/**
 * Build and log the payload for one row without calling the API.
 * @param {string} assignmentId
 * @param {*} rowKey
 */
function dryRunRow(assignmentId, rowKey) {
  const prep = prepareRow(assignmentId, rowKey);
  logPrepared_('dryRunRow', prep);
  return prep;
}

/**
 * Run one row against the live API and log the mapped outputs.
 * @param {string} assignmentId
 * @param {*} rowKey
 * @return {{prep: Object, result: Object, mapped: Object}} mapped is null on an HTTP error
 */
function runRow(assignmentId, rowKey) {
  const prep = prepareRow(assignmentId, rowKey);
  logPrepared_('runRow', prep);

  const result = sendAgentRequest(prep.payload);
  Logger.log('HTTP ' + result.code + ' in ' + result.elapsedMs + ' ms');
  if (!result.ok || !result.json) {
    Logger.log('Error body: ' + truncate_(result.body, 3000));
    return { prep: prep, result: result, mapped: null };
  }

  const mapped = mapRecordOutputs(result.json, prep.ctx.assignment);
  Logger.log('Usage: ' + JSON.stringify(extractUsage(result.json)));
  if (mapped.envelope.output_json_error) {
    Logger.log('Model JSON not parsed: ' + mapped.envelope.output_json_error);
    Logger.log('Output text: ' + truncate_(mapped.envelope.output_text, 3000));
  }
  Logger.log('Mapped output: ' + JSON.stringify(mapped.values));
  if (mapped.missing.length) Logger.log('Missing paths: ' + mapped.missing.join(', '));
  return { prep: prep, result: result, mapped: mapped };
}

function checkRunConstants_() {
  if (!RUN_ASSIGNMENT_ID || RUN_ROW_KEY === '') {
    throw new Error('Set RUN_ASSIGNMENT_ID and RUN_ROW_KEY at the top of Run.gs');
  }
}

function logPrepared_(label, prep) {
  const a = prep.ctx.assignment;
  Logger.log('=== ' + label + ': assignment ' + a.id + ', variant ' + a.variantId +
    ', dataset ' + a.datasetId + ', key ' + prep.rowKey + ' (row ' + prep.rowNumber + ') ===');
  prep.ctx.warnings.forEach(function (w) { Logger.log('WARN ' + w); });
  Logger.log('Request: ' + JSON.stringify(prep.payload));
}
