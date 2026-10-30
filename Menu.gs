/**
 * Menu.gs - the custom menu: process the selected rows of a source tab,
 * and validate the config.
 *
 * Process selection:
 *   1. Read the selection (Ctrl+click ranges allowed) and the tab once;
 *      map rows to keys (Selection.gs). Non-data rows are skipped.
 *   2. Check the config of every involved assignment; any error stops the
 *      run before the first billed call.
 *   3. More than CONFIRM_ABOVE_ROWS rows: OK/Cancel. More than
 *      MAX_SELECTION_ROWS: refused (until chunking is built).
 *   4. Rows run one by one; Results and Log are written after each row, so
 *      a stopped run keeps what was done. No new row is started after
 *      RUN_TIME_BUDGET_MS (Apps Script stops an execution at about 6 min).
 *
 * The time budget counts from the menu click, because time spent in the
 * confirm dialog counts toward the execution limit too.
 */

const MENU_NAME = 'LLM Runner';
const CONFIRM_ABOVE_ROWS = 5;
const MAX_SELECTION_ROWS = 100;
const RUN_TIME_BUDGET_MS = 4.5 * 60 * 1000;
const DIALOG_MAX_LINES = 25;

function onOpen() {
  SpreadsheetApp.getUi().createMenu(MENU_NAME)
    .addItem('Process selection', 'menuProcessSelection')
    .addItem('Validate config', 'menuValidateConfig')
    .addToUi();
}

function menuProcessSelection() {
  const started = Date.now();
  const ui = SpreadsheetApp.getUi();
  // upsertRows rewrites the Results block, so two runs at once could lose rows.
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(0)) {
    ui.alert(MENU_NAME, 'Another run is in progress. Wait for it to finish.', ui.ButtonSet.OK);
    return;
  }
  try {
    processSelection_(ui, started);
  } catch (e) {
    Logger.log('ERROR ' + (e && e.stack ? e.stack : e));
    ui.alert(MENU_NAME, 'Error: ' + (e && e.message ? e.message : e), ui.ButtonSet.OK);
  } finally {
    lock.releaseLock();
  }
}

function menuValidateConfig() {
  const ui = SpreadsheetApp.getUi();
  try {
    showLines_(ui, validateConfig().lines);
  } catch (e) {
    ui.alert(MENU_NAME, 'Error: ' + (e && e.message ? e.message : e), ui.ButtonSet.OK);
  }
}

function processSelection_(ui, started) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const rangeList = sheet.getActiveRangeList();
  const ranges = rangeList ? rangeList.getRanges().map(function (r) {
    return { row: r.getRow(), numRows: r.getNumRows() };
  }) : [];

  const sel = loadSelectionContext(sheet.getName());
  const resolved = resolveSelection(sel.table, sel.datasets, rowNumbersFromRanges(ranges));
  const items = resolved.items;
  if (!items.length && !resolved.undeclared.length) {
    ui.alert(MENU_NAME, 'Nothing to process: the selection has no data rows of a dataset.', ui.ButtonSet.OK);
    return;
  }

  const plan = planSelectionRun(sel.config, sel.datasets, resolved);
  if (plan.errors.length) {
    const lines = ['Cannot run. Fix the config first, then run again:'].concat(
      plan.errors.map(function (e) { return '- ' + e; }));
    lines.forEach(function (l) { Logger.log(l); });
    showLines_(ui, lines);
    return;
  }
  if (items.length > MAX_SELECTION_ROWS) {
    ui.alert(MENU_NAME, items.length + ' rows selected. At most ' + MAX_SELECTION_ROWS +
      ' rows can run at once for now; select fewer rows.', ui.ButtonSet.OK);
    return;
  }
  if (items.length > CONFIRM_ABOVE_ROWS) {
    const answer = ui.alert(MENU_NAME, 'Process ' + items.length + ' rows (' + countByDataset_(items) +
      ')? Each row is one billed API call.', ui.ButtonSet.OK_CANCEL);
    if (answer !== ui.Button.OK) return;
  }

  const jobId = newJobId_();
  Logger.log('Job ' + jobId + ': ' + items.length + ' row(s) on tab "' + sheet.getName() + '"');
  plan.warnings.forEach(function (w) { Logger.log('WARN ' + w); });

  const done = [];
  const notStarted = [];
  let failure = '';
  items.forEach(function (item, i) {
    if (failure || Date.now() - started > RUN_TIME_BUDGET_MS) {
      notStarted.push(item);
      return;
    }
    ss.toast('Row ' + item.rowNumber + ' (' + (i + 1) + ' of ' + items.length + ')', MENU_NAME, 60);
    try {
      const run = processRow(plan.contexts[item.assignmentId], item.rowKey, jobId);
      writeRowOutcomes([run.outcome]);
      const o = run.outcome;
      Logger.log('Row ' + item.rowNumber + ' (' + item.datasetId + ', ' + displayKey(item.rowKey) + '): ' +
        o.status + (o.error ? ' - ' + o.error : ''));
      done.push({ rowNumber: item.rowNumber, rowKey: item.rowKey, status: o.status, error: o.error });
    } catch (e) {
      failure = e && e.message ? e.message : String(e);
      Logger.log('ERROR row ' + item.rowNumber + ': ' + (e && e.stack ? e.stack : e));
      notStarted.push(item);
    }
  });

  ss.toast('Done', MENU_NAME, 3);
  const summary = formatRunSummary({
    jobId: jobId, total: items.length, skipped: resolved.skipped.length,
    done: done, notStarted: notStarted, failure: failure
  });
  Logger.log(summary);
  ui.alert(MENU_NAME, summary, ui.ButtonSet.OK);
}

/** e.g. 'companies: 3, people: 4' */
function countByDataset_(items) {
  const counts = {};
  items.forEach(function (i) { counts[i.datasetId] = (counts[i.datasetId] || 0) + 1; });
  return Object.keys(counts).map(function (id) { return id + ': ' + counts[id]; }).join(', ');
}

/** Show lines in a dialog, cut to DIALOG_MAX_LINES. The caller logs them. */
function showLines_(ui, lines) {
  let shown = lines;
  if (lines.length > DIALOG_MAX_LINES) {
    shown = lines.slice(0, DIALOG_MAX_LINES).concat(['... and ' + (lines.length - DIALOG_MAX_LINES) +
      ' more line(s); see the execution log (Extensions > Apps Script > Executions)']);
  }
  ui.alert(MENU_NAME, shown.join('\n'), ui.ButtonSet.OK);
}
