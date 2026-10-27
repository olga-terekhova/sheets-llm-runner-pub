/**
 * Tests.gs - minimal test runner for the pure utilities.
 * In the Apps Script editor, select runAllTests and click Run.
 * Results appear in the Execution log.
 */

function runAllTests() {
  const tests = [
    test_getPath_basic,
    test_getPath_arrays,
    test_getPath_missing,
    test_getPath_malformed,
    test_parseModelJson_direct,
    test_parseModelJson_fence,
    test_parseModelJson_braces,
    test_parseModelJson_failure,
    test_stringifyForCell,
    test_applyOutputMapping,
    test_parseSchemaCell,
    test_schemaNameFromId,
    test_listPlaceholders,
    test_renderTemplate_basic,
    test_renderTemplate_strict,
    test_renderTemplate_nonStrict,
    test_renderTemplate_noReexpand,
    test_buildVars,
    test_normalizeToolList,
    test_buildAgentPayload,
    test_extractOutputText_and_sources,
    test_buildResponseEnvelope,
    test_envelope_mapping,
    test_tableFromValues,
    test_tableFromValues_errors,
    test_indexByKey,
    test_planUpsert_empty,
    test_planUpsert_updateAndInsert,
    test_planUpsert_compositeAndRepeat,
    test_columnLetter
  ];
  let passed = 0;
  const failures = [];
  tests.forEach(function (t) {
    try {
      t();
      passed++;
    } catch (e) {
      failures.push(t.name + ': ' + (e && e.message ? e.message : e));
    }
  });
  Logger.log('Tests passed: ' + passed + ' / ' + tests.length);
  failures.forEach(function (f) { Logger.log('FAIL ' + f); });
  return { passed: passed, total: tests.length, failures: failures };
}

/* ---------- assertion helpers ---------- */

function assertEqual_(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((label || 'assertEqual') + ' expected ' + e + ' but got ' + a);
}

function assertTrue_(cond, label) {
  if (!cond) throw new Error((label || 'assertTrue') + ' failed');
}

function assertThrows_(fn, containsText, label) {
  try {
    fn();
  } catch (e) {
    if (containsText && String(e.message).indexOf(containsText) === -1) {
      throw new Error((label || 'assertThrows') + ' threw "' + e.message +
        '" which does not contain "' + containsText + '"');
    }
    return;
  }
  throw new Error((label || 'assertThrows') + ' did not throw');
}

/* ---------- Util_Json ---------- */

function test_getPath_basic() {
  const o = { a: { b: { c: 42 } }, s: 'x' };
  assertEqual_(getPath(o, 'a.b.c'), 42, 'nested');
  assertEqual_(getPath(o, 's'), 'x', 'top level');
  assertEqual_(getPath(o, ''), o, 'empty path returns object');
}

function test_getPath_arrays() {
  const o = { items: [{ name: 'first' }, { name: 'second' }] };
  assertEqual_(getPath(o, 'items[1].name'), 'second', 'bracket index');
  assertEqual_(getPath(o, 'items.0.name'), 'first', 'dot index');
  assertEqual_(getPath([[1, 2], [3, 4]], '[1][0]'), 3, 'nested arrays');
}

function test_getPath_missing() {
  const o = { a: { b: null } };
  assertEqual_(getPath(o, 'a.x.y'), undefined, 'missing branch');
  assertEqual_(getPath(o, 'a.b.c'), undefined, 'through null');
  assertEqual_(getPath(null, 'a'), undefined, 'null root');
}

function test_getPath_malformed() {
  assertThrows_(function () { getPath({}, 'a[x]'); }, 'Malformed', 'non-numeric bracket');
  assertThrows_(function () { getPath({}, 'a..b'); }, 'Malformed', 'double dot');
}

function test_parseModelJson_direct() {
  const r = parseModelJson('{"a": 1}');
  assertTrue_(r.ok, 'ok');
  assertEqual_(r.value, { a: 1 }, 'value');
  assertEqual_(r.method, 'direct', 'method');
}

function test_parseModelJson_fence() {
  const r = parseModelJson('Here you go:\n```json\n{"a": [1, 2]}\n```\nDone.');
  assertTrue_(r.ok, 'ok');
  assertEqual_(r.value, { a: [1, 2] }, 'value');
  assertEqual_(r.method, 'fence', 'method');
}

function test_parseModelJson_braces() {
  const r = parseModelJson('Result: {"city": "Ottawa"} - hope that helps');
  assertTrue_(r.ok, 'ok');
  assertEqual_(r.value, { city: 'Ottawa' }, 'value');
  assertEqual_(r.method, 'braces', 'method');
}

function test_parseModelJson_failure() {
  assertEqual_(parseModelJson('').ok, false, 'empty');
  assertEqual_(parseModelJson('no json here').ok, false, 'plain text');
  assertEqual_(parseModelJson('{broken').ok, false, 'broken');
}

function test_stringifyForCell() {
  assertEqual_(stringifyForCell(null), '', 'null');
  assertEqual_(stringifyForCell(undefined), '', 'undefined');
  assertEqual_(stringifyForCell(3.5), 3.5, 'number kept');
  assertEqual_(stringifyForCell(true), true, 'boolean kept');
  assertEqual_(stringifyForCell('hi'), 'hi', 'string');
  assertEqual_(stringifyForCell({ a: [1] }), '{"a":[1]}', 'object');
  const long = stringifyForCell('x'.repeat(100), 40);
  assertEqual_(long.length, 40, 'truncated length');
  assertTrue_(long.indexOf('[truncated]') !== -1, 'truncation marker');
}

function test_applyOutputMapping() {
  const obj = { company: 'Acme', hq: { city: 'Toronto' }, tags: ['a', 'b'], note: null };
  const r = applyOutputMapping(obj, {
    Company: 'company',
    City: 'hq.city',
    Tags: 'tags',
    Note: 'note',
    Missing: 'nope.here'
  });
  assertEqual_(r.values, { Company: 'Acme', City: 'Toronto', Tags: '["a","b"]', Note: '', Missing: '' }, 'values');
  assertEqual_(r.missing, ['Missing'], 'missing list');
}

function test_parseSchemaCell() {
  assertEqual_(parseSchemaCell(''), null, 'empty cell');
  assertEqual_(parseSchemaCell(null), null, 'null');
  const text = '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"]}';
  assertEqual_(parseSchemaCell(text).required, ['a'], 'parsed from text');
  const obj = { type: 'object', properties: {} };
  assertEqual_(parseSchemaCell(obj), obj, 'object passthrough');
  assertThrows_(function () { parseSchemaCell('{bad', 'v1'); }, 'not valid JSON (v1)', 'bad json');
  assertThrows_(function () { parseSchemaCell('[1,2]'); }, 'must be a JSON object', 'array');
  assertThrows_(function () { parseSchemaCell('{"type":"string"}'); }, '"type": "object"', 'root type');
}

function test_schemaNameFromId() {
  assertEqual_(schemaNameFromId('hq_lookup-v2'), 'hq_lookup-v2', 'already valid');
  assertEqual_(schemaNameFromId('HQ lookup v2.1'), 'HQ_lookup_v2_1', 'invalid chars replaced');
  assertEqual_(schemaNameFromId('x'.repeat(80)).length, 64, 'truncated');
  assertEqual_(schemaNameFromId(''), 'output', 'empty fallback');
}

/* ---------- Util_Template ---------- */

function test_listPlaceholders() {
  assertEqual_(listPlaceholders('Hi {{name}}, {{ name }} from {{city_1}}'), ['name', 'city_1'], 'unique in order');
  assertEqual_(listPlaceholders('no placeholders'), [], 'none');
  assertEqual_(listPlaceholders('{{1bad}} {{ok}}'), ['ok'], 'invalid name ignored');
}

function test_renderTemplate_basic() {
  const out = renderTemplate('Company: {{company}}; Year: {{ year }}; Empty: [{{e}}]',
    { company: 'Acme', year: 2026, e: null });
  assertEqual_(out, 'Company: Acme; Year: 2026; Empty: []', 'rendered');
}

function test_renderTemplate_strict() {
  assertThrows_(function () { renderTemplate('{{a}} {{b}} {{c}}', { a: 1 }); }, 'b, c', 'lists all missing');
}

function test_renderTemplate_nonStrict() {
  assertEqual_(renderTemplate('{{a}} {{b}}', { a: 1 }, { strict: false }), '1 {{b}}', 'unknown left as is');
}

function test_renderTemplate_noReexpand() {
  assertEqual_(renderTemplate('{{a}}', { a: '{{b}}', b: 'X' }), '{{b}}', 'value not expanded');
}

function test_buildVars() {
  const record = { 'Company Name': 'Acme', 'Country': 'CA', 'Other': 1 };
  assertEqual_(buildVars(record, { company: 'Company Name', country: 'Country' }),
    { company: 'Acme', country: 'CA' }, 'mapped');
  assertThrows_(function () { buildVars(record, { x: 'Nope' }); }, 'Nope', 'absent column');
}

/* ---------- Api (pure parts only, no network) ---------- */

function test_normalizeToolList() {
  assertEqual_(normalizeToolList('web_search, fetch_url'), ['web_search', 'fetch_url'], 'csv');
  assertEqual_(normalizeToolList(['fetch_url', 'fetch_url']), ['fetch_url'], 'dedupe');
  assertEqual_(normalizeToolList(''), [], 'empty');
  assertThrows_(function () { normalizeToolList('web_search, sandbox'); }, 'sandbox', 'unknown tool');
}

function test_buildAgentPayload() {
  const p = buildAgentPayload({
    model: 'some/model',
    input: 'Q',
    instructions: 'I',
    tools: 'web_search, fetch_url',
    maxUrls: 3,
    maxSteps: 4,
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    schemaName: 'my_schema'
  });
  assertEqual_(p.tools, [{ type: 'web_search' }, { type: 'fetch_url', max_urls: 3 }], 'tools');
  assertEqual_(p.max_steps, 4, 'max_steps');
  assertEqual_(p.response_format.json_schema.name, 'my_schema', 'schema name');
  assertEqual_(buildAgentPayload({ model: 'm', input: 'q' }), { model: 'm', input: 'q' }, 'minimal');
  assertThrows_(function () { buildAgentPayload({ model: 'm', input: 'q', tools: 'fetch_url', maxUrls: 11 }); }, 'maxUrls', 'maxUrls range');
  assertThrows_(function () { buildAgentPayload({ input: 'q' }); }, 'model', 'model required');
}

function test_extractOutputText_and_sources() {
  const resp = {
    output: [
      { type: 'search_results', results: [{ url: 'https://a.example' }, { url: 'https://b.example' }] },
      { type: 'fetch_url_results', contents: [{ url: 'https://a.example' }, { url: 'https://c.example' }] },
      { type: 'message', content: [{ type: 'output_text', text: '{"x":' }, { type: 'output_text', text: '1}' }] }
    ]
  };
  assertEqual_(extractOutputText(resp), '{"x":1}', 'joined text');
  assertEqual_(extractSourceUrls(resp), ['https://a.example', 'https://b.example', 'https://c.example'], 'unique urls');
  assertEqual_(extractOutputText({}), '', 'no output');
}

/** A trimmed-down response with a search step before the message. */
function sampleResponse_() {
  return {
    model: 'some/model',
    status: 'completed',
    output: [
      { type: 'search_results', results: [{ url: 'https://shopify.com' }] },
      { type: 'message', content: [{ type: 'output_text',
        text: '{"company":"Shopify","headquarters_city":"Ottawa","website":null}' }] }
    ],
    usage: { input_tokens: 100, cost: { total_cost: 0.0123, currency: 'USD' } }
  };
}

function test_buildResponseEnvelope() {
  const raw = sampleResponse_();
  const env = buildResponseEnvelope(raw);
  assertEqual_(env.output_json.headquarters_city, 'Ottawa', 'parsed branch');
  assertEqual_(env.output_json_error, '', 'no error');
  assertEqual_(env.sources, ['https://shopify.com'], 'sources');
  assertEqual_(env.usage.cost.total_cost, 0.0123, 'raw branch kept');
  assertTrue_(raw.output_json === undefined, 'raw not mutated');

  const bad = buildResponseEnvelope({ output: [{ type: 'message',
    content: [{ type: 'output_text', text: 'not json' }] }] });
  assertEqual_(bad.output_json, null, 'unparseable -> null');
  assertTrue_(bad.output_json_error !== '', 'error recorded');

  const empty = buildResponseEnvelope(null);
  assertEqual_(empty.output_json_error, 'no output text', 'empty response');
}

function test_envelope_mapping() {
  const env = buildResponseEnvelope(sampleResponse_());
  const r = applyOutputMapping(env, {
    'HQ City': 'output_json.headquarters_city',
    'Website': 'output_json.website',
    'Cost USD': 'usage.cost.total_cost',
    'Sources': 'sources',
    'Model': 'model',
    'Typo': 'output_json.headquarter_city'
  });
  assertEqual_(r.values, {
    'HQ City': 'Ottawa', 'Website': '', 'Cost USD': 0.0123,
    'Sources': '["https://shopify.com"]', 'Model': 'some/model', 'Typo': ''
  }, 'values');
  assertEqual_(r.missing, ['Typo'], 'only the typo is missing; JSON null is not');
}

/* ---------- Util_Sheet (pure parts) ---------- */

function test_tableFromValues() {
  const t = tableFromValues([
    [' ID ', 'Name', ''],
    [1, 'Acme', ''],
    ['', '', ''],
    [2, 'Globex', '']
  ]);
  assertEqual_(t.headers, ['ID', 'Name'], 'trimmed headers, empty column dropped');
  assertEqual_(t.rows, [{ ID: 1, Name: 'Acme' }, { ID: 2, Name: 'Globex' }], 'blank row skipped');
  assertEqual_(t.rowNumbers, [2, 4], 'sheet row numbers');
  assertEqual_(tableFromValues([]).rows, [], 'empty sheet');
}

function test_tableFromValues_errors() {
  assertThrows_(function () { tableFromValues([['A', 'A'], [1, 2]], 'T'); }, 'Duplicate header "A" in "T"', 'dup header');
  assertThrows_(function () { tableFromValues([['A', ''], [1, 2]]); }, 'Column B has data but no header', 'blank header');
}

function test_indexByKey() {
  const t = tableFromValues([['ID', 'Name'], [1, 'a'], ['2', 'b']]);
  const idx = indexByKey(t, 'ID');
  assertEqual_(idx['1'], 0, 'number key as string');
  assertEqual_(idx['2'], 1, 'string key');
  const dup = tableFromValues([['ID'], [5], ['x'], [' 5 ']]);
  assertThrows_(function () { indexByKey(dup, 'ID', 'Src'); }, 'rows 2 and 4', 'duplicate after trim');
  const blank = tableFromValues([['ID', 'N'], ['', 'x']]);
  assertThrows_(function () { indexByKey(blank, 'ID'); }, 'Row 2', 'empty key');
}

function test_planUpsert_empty() {
  const p = planUpsert([], ['_row_key'], [{ _row_key: 'a', Out: 1 }]);
  assertEqual_(p.values, [['_row_key', 'Out'], ['a', 1]], 'created from nothing');
  assertEqual_(p.inserted, 1, 'inserted');
  assertEqual_(p.addedColumns, ['_row_key', 'Out'], 'added columns');
}

function test_planUpsert_updateAndInsert() {
  const existing = [
    ['_row_key', 'A', 'B'],
    ['k1', 'a1', 'b1'],
    ['k2', 'a2', 'b2']
  ];
  const p = planUpsert(existing, '_row_key', [
    { _row_key: 'k2', A: 'A2-new', C: 'c2' },
    { _row_key: 'k3', B: 'b3' }
  ]);
  assertEqual_(p.values, [
    ['_row_key', 'A', 'B', 'C'],
    ['k1', 'a1', 'b1', ''],
    ['k2', 'A2-new', 'b2', 'c2'],
    ['k3', '', 'b3', '']
  ], 'B untouched on update; C appended; k3 inserted');
  assertEqual_([p.inserted, p.updated], [1, 1], 'counts');
  assertEqual_(p.addedColumns, ['C'], 'only C added');
  assertEqual_(existing[1].length, 3, 'input not mutated');
}

function test_planUpsert_compositeAndRepeat() {
  const keys = ['_dataset_id', '_row_key', '_variant_id'];
  const existing = [
    ['_dataset_id', '_row_key', '_variant_id', 'Out'],
    ['ds1', '1', 'v1', 'old']
  ];
  const p = planUpsert(existing, keys, [
    { _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v2', Out: 'x' },
    { _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v2', Out: 'y' },
    { _dataset_id: 'ds1', _row_key: '1', _variant_id: 'v1', Out: 'new' }
  ]);
  assertEqual_(p.values.slice(1), [
    ['ds1', '1', 'v1', 'new'],
    ['ds1', 1, 'v2', 'y']
  ], 'same key different variant is a new row; repeat key -> last wins');
  assertEqual_([p.inserted, p.updated], [1, 1], 'counts');
  assertThrows_(function () { planUpsert([], keys, [{ _dataset_id: 'ds1', _row_key: '' }]); }, 'empty key', 'empty key rejected');
}

function test_columnLetter() {
  assertEqual_([columnLetter(1), columnLetter(26), columnLetter(27), columnLetter(702), columnLetter(703)],
    ['A', 'Z', 'AA', 'ZZ', 'AAA'], 'letters');
}
