/**
 * Run.gs - entry points: create the config tabs, validate the config, and
 * run one source row by key. runRow writes the outcome to the Log tab
 * (append), the Results tab (upsert) and the source tab (write-back); see
 * Results.gs and Writeback.gs.
 *
 * These need a spreadsheet, so run them from the bound script's editor
 * through its wrappers (bound/Code.gs), not from the library project:
 *   1. Run setupConfigTabs once, then fill in Datasets, Variants, Assignments.
 *   2. Run validateConfig and fix any ERROR lines.
 *   3. Set RUN_ASSIGNMENT_ID and RUN_ROW_KEY in the bound script.
 *   4. Run dryRunOne (no API call), then runOne (one live, billed call).
 */

/** Create any missing config tabs with their header row. Existing tabs are left alone. */
function setupConfigTabs() {
  const ss = getSpreadsheet_();
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
 * @return {{errors: Array<string>, warnings: Array<string>, lines: Array<string>}}
 *   lines: the logged report, also shown by the menu
 */
function validateConfig() {
  const config = loadConfigWithSources();
  const problems = listProblems(config);
  const lines = ['Loaded ' + Object.keys(config.datasets).length + ' dataset(s), ' +
    Object.keys(config.variants).length + ' variant(s), ' +
    Object.keys(config.assignments).length + ' assignment(s)'];
  Object.keys(config.datasets).forEach(function (id) {
    const d = config.datasets[id];
    if (!d.table) return;
    const rows = d.table.rowNumbers;
    lines.push('Dataset ' + id + ': tab "' + d.tabName + '"' + (d.title ? ', title "' + d.title + '"' : '') +
      ', default assignment ' + (d.defaultAssignment ? '"' + d.defaultAssignment + '"' : '(none)') +
      ', rows ' + rows[0] + '-' + rows[rows.length - 1] + ' (' + rows.length + ' rows)');
  });
  problems.errors.forEach(function (e) { lines.push('ERROR ' + e); });
  problems.warnings.forEach(function (w) { lines.push('WARN ' + w); });
  lines.push(problems.errors.length ? problems.errors.length + ' error(s), ' + problems.warnings.length + ' warning(s)'
    : 'No errors, ' + problems.warnings.length + ' warning(s)');
  lines.forEach(function (l) { Logger.log(l); });
  problems.lines = lines;
  return problems;
}

/**
 * Load config and the source row, and build the payload. No API call.
 * @param {string} assignmentId
 * @param {*} rowKey
 * @return {{ctx: Object, record: Object, rowNumber: number, rowKey: string, payload: Object}}
 */
function prepareRow(assignmentId, rowKey) {
  return prepareRecord(loadRunContext(assignmentId), rowKey);
}

/**
 * Find the source row in a loaded run context and build its payload.
 * Throws if the key is not found or a placeholder has no value.
 * @param {Object} ctx from loadRunContext
 * @param {*} rowKey
 * @return {{ctx: Object, record: Object, rowNumber: number, rowKey: string, payload: Object}}
 */
function prepareRecord(ctx, rowKey) {
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
 * Run one row against the live API, log the details, and write the
 * outcome to the Log, Results and source tabs (each per its mapping).
 * Holds the document lock, like the menu, so it does not run at the same
 * time as a menu run.
 * Config problems throw; per-row problems end up in the outcome.
 * @param {string} assignmentId
 * @param {*} rowKey
 * @return {{prep: Object, result: Object, mapped: Object, outcome: Object, written: Object}}
 */
function runRow(assignmentId, rowKey) {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(10000)) throw new Error('Another run is in progress. Wait for it to finish.');
  try {
    const ctx = loadRunContext(assignmentId);
    const run = processRow(ctx, rowKey, newJobId_());
    logRun_('runRow', ctx, run);
    run.written = writeRowOutcomes([run.outcome]);
    Logger.log(describeWrites_(run.written));
    return run;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Prepare, call and map one row, and build its outcome (buildRowOutcome).
 * Does not write anything. An empty or unknown key throws (no Results row
 * for a typo). A placeholder without a value, an HTTP error or a fetch
 * exception is reported in the outcome instead of thrown, so a batch can
 * go on with the next row.
 * @param {Object} ctx from loadRunContext
 * @param {*} rowKey
 * @param {string} jobId
 * @return {{prep: Object, result: Object, mapped: Object, outcome: Object}}
 *   prep, result and mapped are null when that step was not reached
 */
function processRow(ctx, rowKey, jobId) {
  const found = findRecord(ctx.dataset, rowKey);
  const info = { assignment: ctx.assignment, dataset: ctx.dataset, rowKey: found.rowKey, jobId: jobId, runAt: new Date() };
  const run = { prep: null, result: null, mapped: null, outcome: null };

  try {
    run.prep = prepareRecord(ctx, rowKey);
    info.model = run.prep.payload.model;
    info.called = true;
    const t0 = Date.now();
    try {
      run.result = sendAgentRequest(run.prep.payload);
    } catch (e) {
      info.elapsedMs = Date.now() - t0;
      throw e;
    }
    if (run.result.ok && run.result.json) run.mapped = mapRecordOutputs(run.result.json, ctx.assignment);
  } catch (e) {
    info.error = e && e.message ? e.message : String(e);
  }

  info.result = run.result;
  info.mapped = run.mapped;
  run.outcome = buildRowOutcome(info);
  return run;
}

function logRun_(label, ctx, run) {
  if (run.prep) logPrepared_(label, run.prep);
  else Logger.log('=== ' + label + ': assignment ' + ctx.assignment.id + ', key ' + run.outcome.rowKey + ' (not prepared) ===');
  const result = run.result;
  if (result) {
    Logger.log('HTTP ' + result.code + ' in ' + result.elapsedMs + ' ms');
    if (!result.ok || !result.json) Logger.log('Error body: ' + truncate_(String(result.body || ''), 3000));
    else Logger.log('Usage: ' + JSON.stringify(extractUsage(result.json)));
  }
  const mapped = run.mapped;
  if (mapped) {
    if (mapped.envelope.output_json_error) Logger.log('Output text: ' + truncate_(mapped.envelope.output_text, 3000));
    if (Object.keys(ctx.assignment.resultsMapping).length) Logger.log('Mapped results: ' + JSON.stringify(mapped.results.values));
    if (Object.keys(ctx.assignment.writebackMapping).length) Logger.log('Mapped write-back: ' + JSON.stringify(mapped.writeback.values));
  }
  const o = run.outcome;
  Logger.log('Status: ' + o.status + (o.error ? ' - ' + o.error : '') +
    (o.missingPaths.length ? ' (missing paths: ' + o.missingPaths.join(', ') + ')' : ''));
}

function logPrepared_(label, prep) {
  const a = prep.ctx.assignment;
  Logger.log('=== ' + label + ': assignment ' + a.id + ', variant ' + a.variantId +
    ', dataset ' + a.datasetId + ', key ' + prep.rowKey + ' (row ' + prep.rowNumber + ') ===');
  prep.ctx.warnings.forEach(function (w) { Logger.log('WARN ' + w); });
  Logger.log('Request: ' + JSON.stringify(prep.payload));
}
