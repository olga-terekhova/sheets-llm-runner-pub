/**
 * Tests_Config.gs - pure tests for Config.gs and Pipeline.gs.
 * They run as part of runAllTests (Tests.gs). No sheet or network access.
 */

const SAMPLE_SCHEMA_TEXT_ = JSON.stringify({
  type: 'object',
  properties: {
    headquarters_city: { type: ['string', 'null'] },
    offices: { type: 'array', items: { type: 'object', properties: { city: { type: 'string' } } } }
  }
});

/** Config tab values for one valid dataset, variant and assignment. */
function sampleConfigValues_() {
  return {
    datasets: [
      CONFIG_COLUMNS.datasets,
      ['companies', 'Companies', 'ID', '', 'a1']
    ],
    variants: [
      CONFIG_COLUMNS.variants,
      ['hq_v1', 'some/model', 'Find the HQ of {{company}} in {{ country }}.', 'Answer for {{company}} as JSON.',
        'web_search, fetch_url', 2, 4, SAMPLE_SCHEMA_TEXT_]
    ],
    assignments: [
      CONFIG_COLUMNS.assignments,
      ['a1', 'companies', 'hq_v1', '{"company": "Company Name", "country": "Country"}',
        '{"HQ City": "output_json.headquarters_city", "First Office": "output_json.offices[0].city", ' +
        '"Cost": "usage.cost.total_cost"}']
    ]
  };
}

/** Return a copy of values with one cell replaced (row 1 = first data row). */
function withCell_(values, row, column, value) {
  const copy = values.map(function (r) { return r.slice(); });
  copy[row][copy[0].indexOf(column)] = value;
  return copy;
}

/** Assert that some message in the list contains the text. */
function assertHas_(messages, text, label) {
  const hit = messages.some(function (m) { return m.indexOf(text) !== -1; });
  if (!hit) throw new Error((label || 'assertHas') + ': no message contains "' + text + '" in ' + JSON.stringify(messages));
}

/** A source tab with a metadata row and two datasets under one header row. */
function sampleSourceValues_() {
  return [
    ['ID', 'Company Name', 'Country', 'Title'],
    ['', 'meta: used by another script', '', ''],
    [101, 'Shopify', 'Canada', ''],
    [' 102 ', 'Wealthsimple', 'Canada', ''],
    ['', '', '', ''],
    ['', '', '', 'US companies'],
    [101, 'Stripe', 'USA', ''],
    [201, 'Figma', 'USA', ''],
    ['', '', '', 'Empty list']
  ];
}

/* ---------- Config: buildConfig ---------- */

function test_buildConfig_valid() {
  const c = buildConfig(sampleConfigValues_());
  const p = listProblems(c);
  assertEqual_(p, { errors: [], warnings: [] }, 'no problems');
  const v = c.variants.hq_v1;
  assertEqual_([v.tools, v.maxUrls, v.maxSteps, v.schemaName], [['web_search', 'fetch_url'], 2, 4, 'hq_v1'], 'variant fields');
  assertEqual_(v.schema.properties.headquarters_city.type, ['string', 'null'], 'schema parsed');
  const a = c.assignments.a1;
  assertEqual_(a.inputMapping, { company: 'Company Name', country: 'Country' }, 'input mapping');
  assertEqual_(a.outputPaths['First Office'], ['output_json', 'offices', 0, 'city'], 'parsed output path');
  assertEqual_([c.datasets.companies.tabName, c.datasets.companies.keyColumn], ['Companies', 'ID'], 'dataset');
}

function test_buildConfig_tabProblems() {
  const vals = sampleConfigValues_();
  vals.datasets = null;
  vals.variants = [['variant_id', 'model'], ['x', 'm']];
  const c = buildConfig(vals);
  assertHas_(c.errors, 'Tab "Datasets" not found', 'missing tab');
  assertHas_(c.errors, 'Tab "Variants" is missing columns: prompt_template', 'missing columns');
  assertHas_(c.assignments.a1.errors, 'dataset_id "companies" not found', 'dangling dataset ref');
  assertHas_(c.assignments.a1.errors, 'variant_id "hq_v1" not found', 'dangling variant ref');

  const blankId = buildConfig({
    datasets: [CONFIG_COLUMNS.datasets, ['', 'T', 'ID']],
    variants: [CONFIG_COLUMNS.variants],
    assignments: [CONFIG_COLUMNS.assignments]
  });
  assertHas_(blankId.errors, 'Datasets row 2: dataset_id is empty', 'empty id');
}

function test_buildConfig_variantErrors() {
  const base = sampleConfigValues_();
  function variantErrors(column, value) {
    const vals = sampleConfigValues_();
    vals.variants = withCell_(base.variants, 1, column, value);
    return buildConfig(vals).variants.hq_v1.errors;
  }
  assertHas_(variantErrors('model', ''), 'Variants row 2 (hq_v1): model is empty', 'model');
  assertHas_(variantErrors('prompt_template', ' '), 'prompt_template is empty', 'prompt');
  assertHas_(variantErrors('tools', 'web_search, sandbox'), 'Unknown tool "sandbox"', 'tool');
  assertHas_(variantErrors('max_urls', 11), 'max_urls must be an integer from 1 to 10', 'max_urls range');
  assertHas_(variantErrors('max_urls', '2.5'), 'max_urls must be an integer', 'max_urls fraction');
  assertHas_(variantErrors('tools', 'web_search'), 'max_urls is set but tools does not include fetch_url', 'max_urls without fetch_url');
  assertHas_(variantErrors('max_steps', 0), 'max_steps must be an integer >= 1', 'max_steps');
  assertHas_(variantErrors('output_json_schema', '{bad'), 'not valid JSON', 'schema');

  const ok = sampleConfigValues_();
  ok.variants = withCell_(withCell_(base.variants, 1, 'max_urls', ''), 1, 'max_steps', '');
  const v = buildConfig(ok).variants.hq_v1;
  assertEqual_([v.errors, v.maxUrls, v.maxSteps], [[], null, null], 'blank optional cells');

  const dup = sampleConfigValues_();
  dup.variants.push(dup.variants[1].slice());
  assertHas_(buildConfig(dup).variants.hq_v1.errors, 'duplicate variant_id, also at row 3', 'duplicate id');
}

function test_buildConfig_assignmentErrors() {
  const base = sampleConfigValues_();
  function assignmentErrors(column, value) {
    const vals = sampleConfigValues_();
    vals.assignments = withCell_(base.assignments, 1, column, value);
    return buildConfig(vals).assignments.a1.errors;
  }
  assertHas_(assignmentErrors('input_mapping', '{"company": "Company Name"'), 'input_mapping is not valid JSON', 'bad json');
  assertHas_(assignmentErrors('input_mapping', '{\u201ccompany\u201d: \u201cX\u201d}'), 'curly quotes', 'curly quote hint');
  assertHas_(assignmentErrors('input_mapping', '["a"]'), 'must be a JSON object', 'array');
  assertHas_(assignmentErrors('input_mapping', '{"company": "Company Name"}'),
    'input_mapping has no entry for placeholders of variant "hq_v1": country', 'unmapped placeholder');
  assertHas_(assignmentErrors('input_mapping', '{"company": "A", "country": "B", "bad-name": "C"}'),
    '"bad-name" is not a valid placeholder name', 'placeholder name');
  assertHas_(assignmentErrors('output_mapping', '{"_status": "model"}'), 'reserved for system columns', 'underscore column');
  assertHas_(assignmentErrors('output_mapping', '{"X": "a..b"}'), 'Malformed path', 'malformed path');
  assertHas_(assignmentErrors('output_mapping', '{"X": 5}'), 'must be a non-empty string', 'non-string path');
  assertHas_(assignmentErrors('output_mapping', '{"City": "output_json.headquarter_city"}'),
    'property "headquarter_city" is not in the variant schema', 'schema typo');
  assertHas_(assignmentErrors('output_mapping', '{"City": "output_json.offices[0].cty"}'),
    'property "cty"', 'nested schema typo');
  assertEqual_(assignmentErrors('output_mapping', '{"Raw": "output_json", "Any": "usage.whatever"}'), [],
    'whole output_json and raw paths are not checked');
  assertHas_(assignmentErrors('dataset_id', ''), 'dataset_id is empty', 'empty dataset_id');
}

function test_buildConfig_warnings() {
  const vals = sampleConfigValues_();
  vals.assignments = withCell_(vals.assignments, 1, 'input_mapping',
    '{"company": "Company Name", "country": "Country", "extra": "Notes"}');
  assertHas_(buildConfig(vals).assignments.a1.warnings, 'not used by the templates of variant "hq_v1": extra', 'unused input');

  const noSchema = sampleConfigValues_();
  noSchema.variants = withCell_(noSchema.variants, 1, 'output_json_schema', '');
  const a = buildConfig(noSchema).assignments.a1;
  assertEqual_(a.errors, [], 'no errors without schema');
  assertHas_(a.warnings, 'has no output_json_schema', 'output_json without schema');

  const empty = sampleConfigValues_();
  empty.assignments = withCell_(empty.assignments, 1, 'output_mapping', '');
  assertHas_(buildConfig(empty).assignments.a1.warnings, 'output_mapping is empty', 'empty output mapping');
}

function test_parseMappingCell() {
  assertEqual_(parseMappingCell(''), {}, 'empty');
  assertEqual_(parseMappingCell(' { " a ": " Col A " } ', 'm'), { a: 'Col A' }, 'trimmed');
  assertThrows_(function () { parseMappingCell('{"": "x"}', 'm'); }, 'empty key', 'empty key');
  assertThrows_(function () { parseMappingCell('{"a": ""}', 'm'); }, 'non-empty string', 'empty value');
}

function test_problemsFor_scoped() {
  const vals = sampleConfigValues_();
  vals.variants.push(['broken_v', '', 'x', '', 'nope', '', '', '']);
  const c = buildConfig(vals);
  assertEqual_(problemsFor(c, c.assignments.a1).errors, [], 'a broken unrelated variant does not block a1');
  assertTrue_(listProblems(c).errors.length >= 2, 'but shows in the full list');
}

/* ---------- Config: source tabs ---------- */

function test_attachSourceValues() {
  const d = buildConfig(sampleConfigValues_()).datasets.companies;
  attachSourceValues(d, sampleSourceValues_());
  assertEqual_(d.errors, [], 'no errors');
  assertEqual_(d.index, { '101': 0, '102': 1 }, 'first block indexed, metadata row skipped');
  assertEqual_(d.table.rowNumbers, [3, 4], 'block row numbers');

  const titled = buildConfig(sampleConfigValues_()).datasets.companies;
  titled.title = 'US companies';
  attachSourceValues(titled, sampleSourceValues_());
  assertEqual_([titled.errors, titled.table.rowNumbers], [[], [7, 8]], 'block under its heading; key 101 reused');

  const missing = buildConfig(sampleConfigValues_()).datasets.companies;
  attachSourceValues(missing, null);
  assertHas_(missing.errors, 'tab "Companies" not found', 'missing tab');

  const noKey = buildConfig(sampleConfigValues_()).datasets.companies;
  attachSourceValues(noKey, [['Id', 'Company Name'], [1, 'x']]);
  assertHas_(noKey.errors, 'key_column "ID" not found', 'missing key column');

  const dup = buildConfig(sampleConfigValues_()).datasets.companies;
  attachSourceValues(dup, [['ID'], [1], ['1 ']]);
  assertHas_(dup.errors, 'Duplicate key "1" in "Companies" at rows 2 and 3', 'duplicate key');
  assertEqual_(dup.table, null, 'no table on error');
}

function test_selectDatasetBlock() {
  const t = tableFromValues(sampleSourceValues_());
  function rowsOf(title) { return selectDatasetBlock(t, 'ID', title, 'Src').rowNumbers; }
  assertEqual_(rowsOf(''), [3, 4], 'first block; blank row 5 ends it');
  assertEqual_(rowsOf('US companies'), [7, 8], 'titled block');
  assertThrows_(function () { rowsOf('Nope'); }, 'heading row not found in tab "Src" (Title = "Nope" and ID empty)', 'unknown title');
  assertThrows_(function () { rowsOf('Empty list'); }, 'no rows with a ID value in tab "Src" below heading "Empty list"', 'empty block');

  const dupHeading = tableFromValues([['ID', 'Title'], ['', 'A'], [1, ''], ['', 'A'], [2, '']]);
  assertThrows_(function () { selectDatasetBlock(dupHeading, 'ID', 'A'); }, 'appears 2 times, at rows 2, 4', 'duplicate heading');
  const keyedTitle = tableFromValues([['ID', 'Title'], [1, 'A'], [2, '']]);
  assertThrows_(function () { selectDatasetBlock(keyedTitle, 'ID', 'A'); }, 'heading row not found', 'a row with a key is not a heading');

  const noTitleCol = tableFromValues([['ID'], [1]]);
  assertThrows_(function () { selectDatasetBlock(noTitleCol, 'ID', 'A'); }, 'column "Title" not found', 'no Title column');
  assertEqual_(selectDatasetBlock(noTitleCol, 'ID', '').rowNumbers, [2], 'Title column only needed with a title');

  const metaOnly = tableFromValues([['ID', 'Name'], ['', 'meta']]);
  assertThrows_(function () { selectDatasetBlock(metaOnly, 'ID', ''); }, 'no rows with a ID value', 'no data');
}

function test_buildConfig_optionalTitleColumn() {
  const vals = sampleConfigValues_();
  vals.datasets = [['dataset_id', 'tab_name', 'key_column'], ['companies', 'Companies', 'ID']];
  const c = buildConfig(vals);
  assertEqual_([listProblems(c).errors, c.datasets.companies.title, c.datasets.companies.defaultAssignment],
    [[], '', ''], 'dataset_title and default_assignment columns may be absent');
}

function test_buildConfig_defaultAssignment() {
  assertEqual_(buildConfig(sampleConfigValues_()).datasets.companies.defaultAssignment, 'a1', 'parsed');

  const unknown = withCell_(sampleConfigValues_().datasets, 1, 'default_assignment', 'nope');
  const vals = sampleConfigValues_();
  vals.datasets = unknown;
  assertHas_(buildConfig(vals).datasets.companies.errors,
    'Datasets row 2 (companies): default_assignment "nope" not found in Assignments', 'unknown assignment');

  const other = sampleConfigValues_();
  other.datasets.push(['people', 'People', 'ID', '', 'a1']);
  const c = buildConfig(other);
  assertHas_(c.datasets.people.errors, 'default_assignment "a1" belongs to dataset "companies", not "people"', 'wrong dataset');
  assertEqual_(c.datasets.companies.errors, [], 'the owning dataset is fine');
}

function test_buildConfig_datasetTitles() {
  function datasetsWith(rows) {
    const vals = sampleConfigValues_();
    vals.datasets = [CONFIG_COLUMNS.datasets].concat(rows);
    return buildConfig(vals).datasets;
  }
  const ok = datasetsWith([['ca', 'Src', 'ID', 'CA', ''], ['us', 'Src', 'ID', 'US', ''], ['solo', 'Other', 'ID', '', '']]);
  assertEqual_([ok.ca.errors, ok.us.errors, ok.solo.errors], [[], [], []], 'titled on a shared tab, untitled alone');

  const untitled = datasetsWith([['ca', 'Src', 'ID', '', ''], ['us', 'Src', 'ID', 'US', '']]);
  assertHas_(untitled.ca.errors, 'dataset_title is empty, but tab "Src" holds 2 datasets (ca, us); each needs a title', 'untitled shared');
  assertEqual_(untitled.us.errors, [], 'the titled one is fine');

  const dup = datasetsWith([['ca', 'Src', 'ID', 'X', ''], ['us', 'Src', 'ID', 'X', ''], ['x2', 'Other', 'ID', 'X', '']]);
  assertHas_(dup.ca.errors, 'dataset_title "X" is not unique in tab "Src" (datasets: ca, us)', 'duplicate title');
  assertHas_(dup.us.errors, 'is not unique', 'reported on both');
  assertEqual_(dup.x2.errors, [], 'same title on another tab is fine');
}

function test_checkBlockOverlaps() {
  function datasetOn(id, title, values) {
    const vals = sampleConfigValues_();
    vals.datasets = [CONFIG_COLUMNS.datasets, [id, 'Src', 'ID', title, '']];
    const d = buildConfig(vals).datasets[id];
    attachSourceValues(d, values);
    return d;
  }
  // Heading A has no data rows, so A runs on into B's block.
  const adjacent = [['ID', 'Title'], ['', 'A'], ['', 'B'], [1, ''], [2, '']];
  const a = datasetOn('a', 'A', adjacent);
  const b = datasetOn('b', 'B', adjacent);
  checkBlockOverlaps([a, b]);
  assertHas_(a.errors, 'selects the same rows as dataset "b" (rows 4-5 of tab "Src")', 'overlap on a');
  assertHas_(b.errors, 'selects the same rows as dataset "a"', 'overlap on b');

  const ca = datasetOn('ca', '', sampleSourceValues_());
  const us = datasetOn('us', 'US companies', sampleSourceValues_());
  checkBlockOverlaps([ca, us, null]);
  assertEqual_([ca.errors, us.errors], [[], []], 'separate blocks');
}

function test_checkInputColumns() {
  const vals = sampleConfigValues_();
  vals.assignments = withCell_(vals.assignments, 1, 'input_mapping', '{"company": "Company", "country": "Country"}');
  const c = buildConfig(vals);
  attachSourceValues(c.datasets.companies, sampleSourceValues_());
  checkInputColumns(c.assignments.a1, c.datasets.companies);
  assertHas_(c.assignments.a1.errors, 'input_mapping columns not found in tab "Companies": Company', 'absent column');
}

function test_findRecord() {
  const d = buildConfig(sampleConfigValues_()).datasets.companies;
  attachSourceValues(d, sampleSourceValues_());
  const r = findRecord(d, '102');
  assertEqual_([r.record['Company Name'], r.rowNumber, r.rowKey], ['Wealthsimple', 4, '102'], 'found by string');
  assertEqual_(findRecord(d, 101).rowNumber, 3, 'found by number');
  assertThrows_(function () { findRecord(d, 201); }, 'not found', 'row outside the block');
  assertThrows_(function () { findRecord(d, '999'); }, 'Row key "999" not found in column "ID"', 'not found');
  assertThrows_(function () { findRecord(d, ' '); }, 'empty', 'empty key');
}

/* ---------- Pipeline ---------- */

function test_buildRecordPayload() {
  const c = buildConfig(sampleConfigValues_());
  const record = { 'ID': 101, 'Company Name': 'Shopify', 'Country': 'Canada' };
  const p = buildRecordPayload(record, c.variants.hq_v1, c.assignments.a1);
  assertEqual_(p.input, 'Find the HQ of Shopify in Canada.', 'prompt rendered');
  assertEqual_(p.instructions, 'Answer for Shopify as JSON.', 'instructions rendered');
  assertEqual_(p.tools, [{ type: 'web_search' }, { type: 'fetch_url', max_urls: 2 }], 'tools');
  assertEqual_([p.max_steps, p.response_format.json_schema.name], [4, 'hq_v1'], 'steps and schema name');

  const plain = sampleConfigValues_();
  plain.variants = withCell_(plain.variants, 1, 'instructions_template', '');
  const c2 = buildConfig(plain);
  assertTrue_(!('instructions' in buildRecordPayload(record, c2.variants.hq_v1, c2.assignments.a1)), 'no instructions when blank');
}

function test_mapRecordOutputs() {
  const c = buildConfig(sampleConfigValues_());
  const raw = sampleResponse_();
  raw.output[1].content[0].text = '{"headquarters_city":"Ottawa","offices":[{"city":"Toronto"}]}';
  const r = mapRecordOutputs(raw, c.assignments.a1);
  assertEqual_(r.values, { 'HQ City': 'Ottawa', 'First Office': 'Toronto', 'Cost': 0.0123 }, 'values');
  assertEqual_(r.missing, [], 'nothing missing');
  assertEqual_(r.envelope.sources, ['https://shopify.com'], 'envelope returned');
}
