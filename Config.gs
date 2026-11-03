/**
 * Config.gs - load and validate the config tabs (Datasets, Variants,
 * Assignments) and the source tabs they point to.
 *
 * The logic lives in pure functions that take plain 2D arrays (buildConfig,
 * attachSourceValues, checkBlockOverlaps, checkInputColumns, findRecord), so
 * it can be tested without a spreadsheet. loadConfig, loadConfigWithSources
 * and loadRunContext are thin wrappers that read the sheets.
 *
 * Problems are collected, not thrown, so one validation run reports all of
 * them. Each entry (dataset, variant, assignment) keeps its own errors and
 * warnings, so a mistake in one variant does not block an assignment that
 * uses another variant.
 *
 * Messages start with the location, e.g. 'Variants row 3 (hq_v1): ...'.
 */

const CONFIG_TABS = {
  datasets: 'Datasets',
  variants: 'Variants',
  assignments: 'Assignments'
};

// The first column of each tab is the id column.
const CONFIG_COLUMNS = {
  datasets: ['dataset_id', 'tab_name', 'key_column', 'dataset_title', 'default_assignment'],
  variants: ['variant_id', 'model', 'prompt_template', 'instructions_template',
    'tools', 'max_urls', 'max_steps', 'output_json_schema'],
  assignments: ['assignment_id', 'dataset_id', 'variant_id', 'input_mapping', 'output_mapping']
};

// Columns that may be absent from a config tab (treated as empty cells).
const CONFIG_OPTIONAL_COLUMNS = {
  datasets: ['dataset_title', 'default_assignment'],
  variants: [],
  assignments: []
};

// Column on a source tab that holds dataset headings (see selectDatasetBlock).
const SOURCE_TITLE_COLUMN = 'Title';

const PLACEHOLDER_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ---------- pure functions ---------- */

/**
 * Build the config from the raw values of the three config tabs.
 * valuesByTab: { datasets: 2D array, variants: 2D array, assignments: 2D array };
 * a null value means the tab does not exist.
 *
 * Returns:
 *   datasets     { id: {id, rowNumber, where, tabName, keyColumn, title,
 *                  defaultAssignment, errors, warnings} }
 *   variants     { id: {id, rowNumber, where, model, promptTemplate,
 *                  instructionsTemplate, tools, maxUrls, maxSteps, schema,
 *                  schemaName, errors, warnings} }
 *   assignments  { id: {id, rowNumber, where, datasetId, variantId,
 *                  inputMapping, outputMapping, errors, warnings} }
 *   errors       problems not tied to one entry (missing tab, missing column, empty id)
 *   warnings     same, for warnings
 *
 * @param {Object} valuesByTab
 * @return {Object}
 */
function buildConfig(valuesByTab) {
  const config = { datasets: {}, variants: {}, assignments: {}, errors: [], warnings: [] };
  const src = valuesByTab || {};

  collectEntries_(config, 'datasets', readConfigTable_('datasets', src.datasets, config.errors), parseDatasetRow_);
  collectEntries_(config, 'variants', readConfigTable_('variants', src.variants, config.errors), parseVariantRow_);
  collectEntries_(config, 'assignments', readConfigTable_('assignments', src.assignments, config.errors), parseAssignmentRow_);

  Object.keys(config.assignments).forEach(function (id) {
    linkAssignment_(config.assignments[id], config);
  });
  Object.keys(config.datasets).forEach(function (id) {
    linkDefaultAssignment_(config.datasets[id], config);
  });
  checkDatasetTitles_(config);
  return config;
}

/**
 * Parse a mapping cell: a JSON object whose values are non-empty strings.
 * Keys and values are trimmed. An empty cell returns {}.
 * Strict JSON, because a config typo should fail loudly.
 *
 * @param {*} value cell value
 * @param {string} label column name used in error messages
 * @return {Object<string,string>}
 */
function parseMappingCell(value, label) {
  if (value === null || value === undefined || String(value).trim() === '') return {};
  const text = String(value).trim();
  const r = tryParse_(text);
  if (!r.ok) {
    const hint = /[\u201c\u201d]/.test(text) ? ' (it contains curly quotes; use straight quotes ")' : '';
    throw new Error(label + ' is not valid JSON' + hint + ': ' + r.error);
  }
  const obj = r.value;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(label + ' must be a JSON object like {"name": "value"}');
  }
  const out = {};
  Object.keys(obj).forEach(function (k) {
    const key = k.trim();
    const v = obj[k];
    if (!key) throw new Error(label + ' has an empty key');
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(label + ' value for "' + key + '" must be a non-empty string');
    }
    out[key] = v.trim();
  });
  return out;
}

/**
 * Attach a source tab to a dataset: parse it, select the dataset's block of
 * rows (see selectDatasetBlock) and index that block by key. Sets
 * dataset.table (the block only) and dataset.index on success; otherwise
 * adds to dataset.errors.
 *
 * @param {Object} dataset entry from buildConfig
 * @param {Array<Array<*>>|null} values tab values, null if the tab does not exist
 */
function attachSourceValues(dataset, values) {
  dataset.table = null;
  dataset.index = null;
  if (!values) {
    fail_(dataset, 'tab "' + dataset.tabName + '" not found');
    return;
  }
  try {
    const table = tableFromValues(values, dataset.tabName);
    if (table.headers.indexOf(dataset.keyColumn) === -1) {
      throw new Error('key_column "' + dataset.keyColumn + '" not found in tab "' + dataset.tabName + '"');
    }
    const block = selectDatasetBlock(table, dataset.keyColumn, dataset.title, dataset.tabName);
    dataset.index = indexByKey(block, dataset.keyColumn, dataset.tabName);
    dataset.table = block;
  } catch (e) {
    dataset.index = null;
    fail_(dataset, e.message);
  }
}

/**
 * Flag datasets on the same tab that resolved to the same block. A block
 * runs up to the next empty-key row, so two blocks are either the same or
 * disjoint, and comparing the first row is enough. This happens e.g. when
 * two headings are adjacent with no data rows between them. Needs
 * attachSourceValues to have run; datasets without a table are ignored.
 *
 * @param {Array<Object>} datasets dataset entries
 */
function checkBlockOverlaps(datasets) {
  const seen = {};
  datasets.forEach(function (d) {
    if (!d || !d.table) return;
    const rows = d.table.rowNumbers;
    const at = d.tabName + '\u001f' + rows[0];
    if (!hasOwn_(seen, at)) {
      seen[at] = d;
      return;
    }
    const other = seen[at];
    const range = 'rows ' + rows[0] + '-' + rows[rows.length - 1] + ' of tab "' + d.tabName + '"';
    fail_(d, 'selects the same rows as dataset "' + other.id + '" (' + range + ')');
    fail_(other, 'selects the same rows as dataset "' + d.id + '" (' + range + ')');
  });
}

/**
 * Select one dataset's rows from a source table. A tab can hold several
 * datasets under the shared row 1 headers.
 *
 * A block is an uninterrupted run of rows with a non-empty key. Any row with
 * an empty key ends it, including a fully blank row.
 *   title empty: the first block below the header row
 *   title set:   the first block below the heading row, which is the only
 *                row whose Title cell equals the title and whose key is empty
 * Rows between the heading (or header) and the block, such as a metadata
 * row with an empty key, are skipped.
 *
 * @param {{headers: Array<string>, rows: Array<Object>, rowNumbers: Array<number>}} table from tableFromValues
 * @param {string} keyColumn
 * @param {string} title '' for the first block on the tab
 * @param {string=} label tab name for messages
 * @return {{headers: Array<string>, rows: Array<Object>, rowNumbers: Array<number>}} the block
 */
function selectDatasetBlock(table, keyColumn, title, label) {
  const where = label ? ' in tab "' + label + '"' : '';
  const n = table.rows.length;
  const hasKey = table.rows.map(function (row) { return makeKey(row, [keyColumn]) !== ''; });

  let from = 0;
  if (title) {
    if (table.headers.indexOf(SOURCE_TITLE_COLUMN) === -1) {
      throw new Error('dataset_title is set but column "' + SOURCE_TITLE_COLUMN + '" not found' + where);
    }
    const headings = [];
    table.rows.forEach(function (row, i) {
      if (!hasKey[i] && cellText_(row[SOURCE_TITLE_COLUMN]) === title) headings.push(i);
    });
    if (!headings.length) {
      throw new Error('heading row not found' + where + ' (' + SOURCE_TITLE_COLUMN + ' = "' + title +
        '" and ' + keyColumn + ' empty)');
    }
    if (headings.length > 1) {
      throw new Error('heading "' + title + '" appears ' + headings.length + ' times' + where + ', at rows ' +
        headings.map(function (i) { return table.rowNumbers[i]; }).join(', '));
    }
    from = headings[0] + 1;
  }

  let start = from;
  while (start < n && !hasKey[start]) start++;
  if (start === n) {
    throw new Error('no rows with a ' + keyColumn + ' value' + where +
      (title ? ' below heading "' + title + '"' : ''));
  }
  // Blank rows are absent from table.rows, so a gap in rowNumbers also ends the block.
  let end = start + 1;
  while (end < n && hasKey[end] && table.rowNumbers[end] === table.rowNumbers[end - 1] + 1) end++;

  return {
    headers: table.headers,
    rows: table.rows.slice(start, end),
    rowNumbers: table.rowNumbers.slice(start, end)
  };
}

/**
 * Check that every column named in an assignment's input mapping exists in
 * its dataset's source tab. Needs attachSourceValues to have run.
 * @param {Object} assignment
 * @param {Object} dataset
 */
function checkInputColumns(assignment, dataset) {
  if (!dataset.table) return;
  const headers = dataset.table.headers;
  const absent = [];
  Object.keys(assignment.inputMapping).forEach(function (name) {
    const column = assignment.inputMapping[name];
    if (headers.indexOf(column) === -1 && absent.indexOf(column) === -1) absent.push(column);
  });
  if (absent.length) {
    fail_(assignment, 'input_mapping columns not found in tab "' + dataset.tabName + '": ' + absent.join(', '));
  }
}

/**
 * Find one source row by key. Keys compare as trimmed strings.
 * @param {Object} dataset with table and index from attachSourceValues
 * @param {*} rowKey
 * @return {{record: Object, rowNumber: number, rowKey: string}}
 */
function findRecord(dataset, rowKey) {
  const key = makeKey({ k: rowKey }, ['k']);
  if (key === '') throw new Error('Row key is empty');
  if (!hasOwn_(dataset.index, key)) {
    throw new Error('Row key "' + key + '" not found in column "' + dataset.keyColumn +
      '" of tab "' + dataset.tabName + '"');
  }
  const i = dataset.index[key];
  return { record: dataset.table.rows[i], rowNumber: dataset.table.rowNumbers[i], rowKey: key };
}

/**
 * Errors and warnings that matter for one assignment: config-wide ones
 * plus those of the assignment, its dataset and its variant.
 * @param {Object} config
 * @param {Object} assignment
 * @return {{errors: Array<string>, warnings: Array<string>}}
 */
function problemsFor(config, assignment) {
  const entries = [
    config.datasets[assignment.datasetId],
    config.variants[assignment.variantId],
    assignment
  ];
  return gatherProblems_(config, entries);
}

/**
 * Every error and warning in the config.
 * @param {Object} config
 * @return {{errors: Array<string>, warnings: Array<string>}}
 */
function listProblems(config) {
  const entries = [];
  ['datasets', 'variants', 'assignments'].forEach(function (kind) {
    Object.keys(config[kind]).forEach(function (id) { entries.push(config[kind][id]); });
  });
  return gatherProblems_(config, entries);
}

function gatherProblems_(config, entries) {
  let errors = config.errors.slice();
  let warnings = config.warnings.slice();
  entries.forEach(function (e) {
    if (!e) return;
    errors = errors.concat(e.errors);
    warnings = warnings.concat(e.warnings);
  });
  return { errors: errors, warnings: warnings };
}

/** Parse one config tab; on a tab-level problem record it and return null. */
function readConfigTable_(kind, values, errors) {
  const tab = CONFIG_TABS[kind];
  if (!values) {
    errors.push('Tab "' + tab + '" not found. Run setupConfigTabs to create it.');
    return null;
  }
  let table;
  try {
    table = tableFromValues(values, tab);
  } catch (e) {
    errors.push(e.message);
    return null;
  }
  const missing = CONFIG_COLUMNS[kind].filter(function (c) {
    return table.headers.indexOf(c) === -1 && CONFIG_OPTIONAL_COLUMNS[kind].indexOf(c) === -1;
  });
  if (missing.length) {
    errors.push('Tab "' + tab + '" is missing columns: ' + missing.join(', '));
    return null;
  }
  return table;
}

/** Turn table rows into entries keyed by id, using parseRow for the fields. */
function collectEntries_(config, kind, table, parseRow) {
  if (!table) return;
  const idColumn = CONFIG_COLUMNS[kind][0];
  const target = config[kind];
  table.rows.forEach(function (row, i) {
    const rowNumber = table.rowNumbers[i];
    const id = cellText_(row[idColumn]);
    if (!id) {
      config.errors.push(CONFIG_TABS[kind] + ' row ' + rowNumber + ': ' + idColumn + ' is empty');
      return;
    }
    if (hasOwn_(target, id)) {
      fail_(target[id], 'duplicate ' + idColumn + ', also at row ' + rowNumber);
      return;
    }
    const entry = {
      id: id,
      rowNumber: rowNumber,
      where: CONFIG_TABS[kind] + ' row ' + rowNumber + ' (' + id + ')',
      errors: [],
      warnings: []
    };
    parseRow(row, entry);
    target[id] = entry;
  });
}

function parseDatasetRow_(row, d) {
  d.tabName = cellText_(row.tab_name);
  d.keyColumn = cellText_(row.key_column);
  d.title = cellText_(row.dataset_title);
  d.defaultAssignment = cellText_(row.default_assignment);
  if (!d.tabName) fail_(d, 'tab_name is empty');
  if (!d.keyColumn) fail_(d, 'key_column is empty');
}

function parseVariantRow_(row, v) {
  v.model = cellText_(row.model);
  v.promptTemplate = cellText_(row.prompt_template);
  v.instructionsTemplate = cellText_(row.instructions_template);
  v.tools = [];
  v.maxUrls = null;
  v.maxSteps = null;
  v.schema = null;
  v.schemaName = schemaNameFromId(v.id);

  if (!v.model) fail_(v, 'model is empty');
  if (!v.promptTemplate) fail_(v, 'prompt_template is empty');

  let toolsOk = true;
  try {
    v.tools = normalizeToolList(row.tools);
  } catch (e) {
    toolsOk = false;
    fail_(v, 'tools: ' + e.message);
  }

  const urls = parseIntCell_(row.max_urls, 1, 10);
  if (urls.error) fail_(v, 'max_urls ' + urls.error);
  v.maxUrls = urls.value;
  if (v.maxUrls !== null && toolsOk && v.tools.indexOf('fetch_url') === -1) {
    fail_(v, 'max_urls is set but tools does not include fetch_url');
  }

  const steps = parseIntCell_(row.max_steps, 1, null);
  if (steps.error) fail_(v, 'max_steps ' + steps.error);
  v.maxSteps = steps.value;

  try {
    v.schema = parseSchemaCell(row.output_json_schema, v.id);
  } catch (e) {
    fail_(v, e.message);
  }
}

function parseAssignmentRow_(row, a) {
  a.datasetId = cellText_(row.dataset_id);
  a.variantId = cellText_(row.variant_id);
  a.inputMapping = {};
  a.outputMapping = {};
  a.outputPaths = {}; // column -> parsed path segments

  if (!a.datasetId) fail_(a, 'dataset_id is empty');
  if (!a.variantId) fail_(a, 'variant_id is empty');

  try {
    a.inputMapping = parseMappingCell(row.input_mapping, 'input_mapping');
  } catch (e) {
    fail_(a, e.message);
  }
  Object.keys(a.inputMapping).forEach(function (name) {
    if (!PLACEHOLDER_NAME_RE.test(name)) {
      fail_(a, 'input_mapping key "' + name + '" is not a valid placeholder name');
    }
  });

  let outputOk = true;
  try {
    a.outputMapping = parseMappingCell(row.output_mapping, 'output_mapping');
  } catch (e) {
    outputOk = false;
    fail_(a, e.message);
  }
  Object.keys(a.outputMapping).forEach(function (column) {
    if (column.charAt(0) === '_') {
      fail_(a, 'output_mapping column "' + column + '" starts with "_", which is reserved for system columns');
    }
    try {
      const segments = parsePath_(a.outputMapping[column]);
      if (!segments.length) throw new Error('path is empty');
      a.outputPaths[column] = segments;
    } catch (e) {
      fail_(a, 'output_mapping "' + column + '": ' + e.message);
    }
  });
  if (outputOk && !Object.keys(a.outputMapping).length) {
    warn_(a, 'output_mapping is empty; nothing will be written to Results');
  }
}

/** Cross-reference checks that need the datasets and variants. */
function linkAssignment_(a, config) {
  if (a.datasetId && !hasOwn_(config.datasets, a.datasetId)) {
    fail_(a, 'dataset_id "' + a.datasetId + '" not found in ' + CONFIG_TABS.datasets);
  }
  if (!a.variantId) return;
  if (!hasOwn_(config.variants, a.variantId)) {
    fail_(a, 'variant_id "' + a.variantId + '" not found in ' + CONFIG_TABS.variants);
    return;
  }
  const v = config.variants[a.variantId];

  const placeholders = listPlaceholders(v.promptTemplate);
  listPlaceholders(v.instructionsTemplate).forEach(function (p) {
    if (placeholders.indexOf(p) === -1) placeholders.push(p);
  });
  const unmapped = placeholders.filter(function (p) { return !hasOwn_(a.inputMapping, p); });
  if (unmapped.length) {
    fail_(a, 'input_mapping has no entry for placeholders of variant "' + v.id + '": ' + unmapped.join(', '));
  }
  const unused = Object.keys(a.inputMapping).filter(function (k) { return placeholders.indexOf(k) === -1; });
  if (unused.length) {
    warn_(a, 'input_mapping entries not used by the templates of variant "' + v.id + '": ' + unused.join(', '));
  }

  const jsonColumns = Object.keys(a.outputPaths).filter(function (c) { return a.outputPaths[c][0] === 'output_json'; });
  if (v.schema) {
    jsonColumns.forEach(function (column) {
      const problem = schemaPathProblem_(v.schema, a.outputPaths[column].slice(1));
      if (problem) fail_(a, 'output_mapping "' + column + '" (' + a.outputMapping[column] + '): ' + problem);
    });
  } else if (jsonColumns.length && !v.errors.length) {
    warn_(a, 'variant "' + v.id + '" has no output_json_schema, so these columns depend on the model ' +
      'returning JSON on its own: ' + jsonColumns.join(', '));
  }
}

/** default_assignment, if set, must name an assignment of this dataset. */
function linkDefaultAssignment_(d, config) {
  if (!d.defaultAssignment) return;
  const a = config.assignments[d.defaultAssignment];
  if (!a) {
    fail_(d, 'default_assignment "' + d.defaultAssignment + '" not found in ' + CONFIG_TABS.assignments);
  } else if (a.datasetId !== d.id) {
    fail_(d, 'default_assignment "' + a.id + '" belongs to dataset "' + a.datasetId + '", not "' + d.id + '"');
  }
}

/**
 * Datasets sharing a tab: each needs a dataset_title, unique within the tab.
 * An empty title is allowed only for the only dataset on its tab.
 */
function checkDatasetTitles_(config) {
  const byTab = {};
  Object.keys(config.datasets).forEach(function (id) {
    const d = config.datasets[id];
    if (!d.tabName) return;
    if (!hasOwn_(byTab, d.tabName)) byTab[d.tabName] = [];
    byTab[d.tabName].push(d);
  });
  Object.keys(byTab).forEach(function (tab) {
    const group = byTab[tab];
    if (group.length < 2) return;
    const ids = group.map(function (d) { return d.id; }).join(', ');
    const byTitle = {};
    group.forEach(function (d) {
      if (!d.title) {
        fail_(d, 'dataset_title is empty, but tab "' + tab + '" holds ' + group.length +
          ' datasets (' + ids + '); each needs a title');
        return;
      }
      if (!hasOwn_(byTitle, d.title)) byTitle[d.title] = [];
      byTitle[d.title].push(d.id);
    });
    group.forEach(function (d) {
      const same = d.title ? byTitle[d.title] : [];
      if (same.length < 2) return;
      fail_(d, 'dataset_title "' + d.title + '" is not unique in tab "' + tab + '" (datasets: ' + same.join(', ') + ')');
    });
  });
}

/**
 * Walk path segments through a JSON schema. Returns a message when a key is
 * not among the declared properties, '' when it is found or when the schema
 * does not say (no "properties" or "items" at that level).
 */
function schemaPathProblem_(schema, segments) {
  let node = schema;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!node || typeof node !== 'object') return '';
    if (typeof seg === 'number') {
      if (!node.items || typeof node.items !== 'object') return '';
      node = node.items;
      continue;
    }
    if (!node.properties || typeof node.properties !== 'object') return '';
    if (!hasOwn_(node.properties, seg)) {
      return 'property "' + seg + '" is not in the variant schema (known: ' +
        Object.keys(node.properties).join(', ') + ')';
    }
    node = node.properties[seg];
  }
  return '';
}

/**
 * Parse an optional integer cell. Blank -> {value: null}.
 * max may be null for no upper bound.
 */
function parseIntCell_(value, min, max) {
  if (value === null || value === undefined || String(value).trim() === '') return { value: null, error: '' };
  const n = Number(String(value).trim());
  if (Math.floor(n) === n && n >= min && (max === null || n <= max)) return { value: n, error: '' };
  const range = max === null ? '>= ' + min : 'from ' + min + ' to ' + max;
  return { value: null, error: 'must be an integer ' + range + ', got: ' + value };
}

function fail_(entry, message) {
  entry.errors.push(entry.where + ': ' + message);
}

function warn_(entry, message) {
  entry.warnings.push(entry.where + ': ' + message);
}

/** Cell value as a trimmed string; null/undefined -> ''. */
function cellText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function hasOwn_(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/* ---------- sheet I/O wrappers ---------- */

/** Read a tab's values by name, or null if the tab does not exist. */
function readTabValues_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  return sheet ? readValues_(sheet) : null;
}

/**
 * Read and validate the config tabs (no source tabs).
 * @return {Object} see buildConfig
 */
function loadConfig() {
  const values = {};
  Object.keys(CONFIG_TABS).forEach(function (kind) { values[kind] = readTabValues_(CONFIG_TABS[kind]); });
  return buildConfig(values);
}

/**
 * Read and validate the config tabs and every source tab they reference.
 * Reads each source tab once, even when several datasets share it.
 * @return {Object}
 */
function loadConfigWithSources() {
  const config = loadConfig();
  const valuesByTab = {};
  Object.keys(config.datasets).forEach(function (id) {
    const d = config.datasets[id];
    if (d.errors.length) return;
    if (!hasOwn_(valuesByTab, d.tabName)) valuesByTab[d.tabName] = readTabValues_(d.tabName);
    attachSourceValues(d, valuesByTab[d.tabName]);
  });
  checkBlockOverlaps(Object.keys(config.datasets).map(function (id) { return config.datasets[id]; }));
  Object.keys(config.assignments).forEach(function (id) {
    const a = config.assignments[id];
    const d = config.datasets[a.datasetId];
    if (d) checkInputColumns(a, d);
  });
  return config;
}

/**
 * Load everything needed to run one assignment, reading only its own
 * source tab. Throws, listing every relevant error, if it cannot run.
 *
 * @param {string} assignmentId
 * @return {{config: Object, assignment: Object, variant: Object, dataset: Object, warnings: Array<string>}}
 */
function loadRunContext(assignmentId) {
  const config = loadConfig();
  const id = cellText_(assignmentId);
  const assignment = config.assignments[id];
  if (!assignment) {
    const extra = config.errors.length ? '\n- ' + config.errors.join('\n- ') : '';
    throw new Error('Assignment "' + id + '" not found in ' + CONFIG_TABS.assignments + extra);
  }
  const dataset = config.datasets[assignment.datasetId];
  if (dataset && !dataset.errors.length) {
    // Attach every dataset on the tab, so the overlap check can see them all.
    const values = readTabValues_(dataset.tabName);
    const sameTab = Object.keys(config.datasets).map(function (k) { return config.datasets[k]; })
      .filter(function (d) { return d.tabName === dataset.tabName && !d.errors.length; });
    sameTab.forEach(function (d) { attachSourceValues(d, values); });
    checkBlockOverlaps(sameTab);
    checkInputColumns(assignment, dataset);
  }
  const problems = problemsFor(config, assignment);
  if (problems.errors.length) {
    throw new Error('Cannot run assignment "' + id + '":\n- ' + problems.errors.join('\n- '));
  }
  return {
    config: config,
    assignment: assignment,
    variant: config.variants[assignment.variantId],
    dataset: dataset,
    warnings: problems.warnings
  };
}

/**
 * Load everything needed to resolve a selection on one source tab: the
 * config, every dataset on the tab (blocks attached, overlap checked) and
 * the whole tab as a table. Reads the tab once. Throws if no dataset uses
 * the tab. Problems are left in the entries for planSelectionRun.
 *
 * @param {string} tabName
 * @return {{config: Object, datasets: Array<Object>, table: Object}}
 */
function loadSelectionContext(tabName) {
  const config = loadConfig();
  const datasets = Object.keys(config.datasets).map(function (id) { return config.datasets[id]; })
    .filter(function (d) { return d.tabName === tabName; });
  if (!datasets.length) {
    const extra = config.errors.length ? '\n- ' + config.errors.join('\n- ') : '';
    throw new Error('Tab "' + tabName + '" is not a source tab: no row in ' + CONFIG_TABS.datasets +
      ' has tab_name "' + tabName + '"' + extra);
  }
  const values = readTabValues_(tabName);
  datasets.forEach(function (d) { if (!d.errors.length) attachSourceValues(d, values); });
  checkBlockOverlaps(datasets);
  return { config: config, datasets: datasets, table: tableFromValues(values, tabName) };
}
