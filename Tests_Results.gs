/**
 * Tests_Results.gs - pure tests for Results.gs and the append/escape
 * helpers in Util_Sheet.gs. They run as part of runAllTests (Tests.gs).
 */

/** Inputs for buildRowOutcome with a successful, fully mapped response. */
function sampleOutcomeInput_() {
  const c = buildConfig(sampleConfigValues_());
  const raw = sampleResponse_();
  raw.output[1].content[0].text = '{"headquarters_city":"Ottawa","offices":[{"city":"Toronto"}]}';
  const a = c.assignments.a1;
  return {
    assignment: a,
    rowKey: '101',
    jobId: 'job_x',
    runAt: new Date(Date.UTC(2026, 9, 27)),
    called: true,
    model: 'some/model',
    result: { ok: true, code: 200, elapsedMs: 1500, json: raw, body: JSON.stringify(raw) },
    mapped: mapRecordOutputs(raw, a)
  };
}

function test_buildRowOutcome_ok() {
  const o = buildRowOutcome(sampleOutcomeInput_());
  assertEqual_([o.status, o.error], ['ok', ''], 'status');
  const r = o.resultRow;
  assertEqual_([r._dataset_id, r._row_key, r._variant_id, r._assignment_id], ['companies', '101', 'hq_v1', 'a1'], 'keys');
  assertEqual_([r._missing_paths, r._cost_usd, r['HQ City'], r['First Office'], r.Cost], ['', 0.0123, 'Ottawa', 'Toronto', 0.0123], 'values');
  assertEqual_(Object.keys(r).slice(0, RESULT_SYSTEM_COLUMNS.length), RESULT_SYSTEM_COLUMNS, 'system columns first');
  const l = o.logRow;
  assertEqual_([l.job_id, l.row_key, l.model, l.http_code, l.status, l.latency_ms, l.input_tokens, l.output_tokens, l.cost, l.currency],
    ['job_x', '101', 'some/model', 200, 'ok', 1500, 100, '', 0.0123, 'USD'], 'log row');
  assertTrue_(l.raw.indexOf('"completed"') !== -1, 'raw body kept');
}

function test_buildRowOutcome_warning() {
  const input = sampleOutcomeInput_();
  input.result.json.output[1].content[0].text = '{"headquarters_city":"Ottawa"}';
  input.result.json.status = 'incomplete';
  input.mapped = mapRecordOutputs(input.result.json, input.assignment);
  let o = buildRowOutcome(input);
  assertEqual_([o.status, o.error, o.resultRow._missing_paths], ['warning', 'Response status "incomplete"',
    'output_json.offices[0].city'], 'missing path is a warning');
  assertEqual_(o.resultRow['HQ City'], 'Ottawa', 'found values still written');

  input.result.json.status = 'completed';
  input.result.json.output[1].content[0].text = 'not json';
  input.mapped = mapRecordOutputs(input.result.json, input.assignment);
  o = buildRowOutcome(input);
  assertEqual_(o.status, 'warning', 'unparsed JSON');
  assertTrue_(o.error.indexOf('Model JSON not parsed') === 0, 'parse error reported');
}

function test_buildRowOutcome_errors() {
  const input = sampleOutcomeInput_();
  input.result = { ok: false, code: 401, elapsedMs: 80, json: { error: { message: 'Invalid API key' } }, body: '{...}' };
  input.mapped = null;
  let o = buildRowOutcome(input);
  assertEqual_([o.status, o.error], ['error', 'HTTP 401: Invalid API key'], 'http error');
  assertEqual_([o.resultRow['HQ City'], o.resultRow.Cost, o.resultRow._cost_usd], ['', '', ''], 'outputs cleared');
  assertEqual_([o.logRow.http_code, o.logRow.raw], [401, '{...}'], 'call logged');

  input.result = { ok: false, code: 502, elapsedMs: 80, json: null, body: '<html>Bad gateway</html>' };
  assertEqual_(buildRowOutcome(input).error, 'HTTP 502: <html>Bad gateway</html>', 'non-JSON error body');

  input.result = null;
  input.error = 'Timeout';
  input.elapsedMs = 60000;
  o = buildRowOutcome(input);
  assertEqual_([o.status, o.error, o.logRow.http_code, o.logRow.latency_ms, o.logRow.raw], ['error', 'Timeout', '', 60000, ''], 'fetch threw');

  input.called = false;
  input.error = 'Missing value for placeholder: company';
  o = buildRowOutcome(input);
  assertEqual_([o.status, o.logRow], ['error', null], 'no call, no log row');
}

function test_planAppend() {
  const p = planAppend(['a', 'b', ''], [{ b: 1, c: 2 }, { a: 'x' }]);
  assertEqual_(p.headers, ['a', 'b', 'c'], 'headers; trailing blank dropped');
  assertEqual_(p.values, [['', 1, 2], ['x', '', '']], 'rows');
  assertEqual_(p.addedColumns, ['c'], 'added');
  assertEqual_(planAppend([], [{ z: 1 }]).headers, ['z'], 'empty sheet');
}

function test_escapeCellValue() {
  assertEqual_([escapeCellValue_('=SUM(A1)'), escapeCellValue_('+1 555'), escapeCellValue_('-'), escapeCellValue_('@x')],
    ["'=SUM(A1)", "'+1 555", "'-", "'@x"], 'formula-like strings');
  assertEqual_([escapeCellValue_('Ottawa'), escapeCellValue_(''), escapeCellValue_(-5), escapeCellValue_(null)],
    ['Ottawa', '', -5, null], 'left alone');
  assertEqual_([escapeCellValue_('007', true), escapeCellValue_(7, true)], ["'007", 7], 'forced text');
  assertEqual_(escapeValuesForWrite_([['k', 'v'], ['007', '007']], ['k']), [['k', 'v'], ["'007", '007']], 'only key column forced; header not');
}
