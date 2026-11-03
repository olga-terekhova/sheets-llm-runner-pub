/**
 * Util_Sheet.gs - reading tabs into row objects, indexing rows by key,
 * and upserting rows by key.
 *
 * Layout assumption: headers are in row 1, data starts in row 2.
 *
 * The logic lives in pure functions that take and return plain 2D arrays
 * (tableFromValues, indexByKey, planUpsert), so it can be tested without
 * a spreadsheet. readTable and upsertRows are thin wrappers that do the
 * actual sheet I/O with one read and one write each.
 */

const KEY_SEPARATOR = '\u001f'; // ASCII unit separator, never typed in cells

/* ---------- pure functions ---------- */

/**
 * Turn a 2D values array (row 1 = headers) into row objects.
 * Fully blank data rows are skipped. Headers are trimmed.
 * Throws on duplicate headers, or on a blank header over a column that has data.
 *
 * @param {Array<Array<*>>} values
 * @param {string=} label used in error messages, e.g. the tab name
 * @return {{headers: Array<string>, rows: Array<Object>, rowNumbers: Array<number>}}
 *   rowNumbers[i] is the 1-based sheet row of rows[i]
 */
function tableFromValues(values, label) {
  const where = label ? ' in "' + label + '"' : '';
  if (!values || values.length === 0) return { headers: [], rows: [], rowNumbers: [] };

  const rawHeaders = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  const used = []; // column indexes that have a header
  const seen = {};
  rawHeaders.forEach(function (h, c) {
    if (h === '') {
      const hasData = values.slice(1).some(function (row) { return !isBlankCell_(row[c]); });
      if (hasData) throw new Error('Column ' + columnLetter(c + 1) + where + ' has data but no header');
      return;
    }
    if (seen[h]) throw new Error('Duplicate header "' + h + '"' + where);
    seen[h] = true;
    used.push(c);
  });

  const headers = used.map(function (c) { return rawHeaders[c]; });
  const rows = [];
  const rowNumbers = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (row.every(isBlankCell_)) continue;
    const obj = {};
    used.forEach(function (c, i) { obj[headers[i]] = row[c] === undefined ? '' : row[c]; });
    rows.push(obj);
    rowNumbers.push(r + 1);
  }
  return { headers: headers, rows: rows, rowNumbers: rowNumbers };
}

/**
 * Build a lookup from key to row index for a table from tableFromValues.
 * Keys are compared as trimmed strings, so 123 and "123" match.
 * Throws on an empty key or a duplicate key, naming the sheet rows involved.
 *
 * @param {{rows: Array<Object>, rowNumbers: Array<number>}} table
 * @param {Array<string>|string} keyColumns
 * @param {string=} label
 * @return {Object<string, number>} key -> index into table.rows
 */
function indexByKey(table, keyColumns, label) {
  const cols = toArray_(keyColumns);
  const where = label ? ' in "' + label + '"' : '';
  const index = {};
  table.rows.forEach(function (row, i) {
    const key = makeKey(row, cols);
    const rowNo = table.rowNumbers ? table.rowNumbers[i] : i + 2;
    if (key === '') throw new Error('Row ' + rowNo + where + ' has an empty key (' + cols.join(', ') + ')');
    if (Object.prototype.hasOwnProperty.call(index, key)) {
      const firstNo = table.rowNumbers ? table.rowNumbers[index[key]] : index[key] + 2;
      throw new Error('Duplicate key "' + displayKey(key) + '"' + where + ' at rows ' + firstNo + ' and ' + rowNo);
    }
    index[key] = i;
  });
  return index;
}

/**
 * Compose a key from one or more columns of a row object.
 * Returns '' if any part is blank, so callers can reject it.
 * @param {Object} row
 * @param {Array<string>|string} keyColumns
 * @return {string}
 */
function makeKey(row, keyColumns) {
  const parts = toArray_(keyColumns).map(function (c) { return normalizeKeyPart_(row[c]); });
  if (parts.some(function (p) { return p === ''; })) return '';
  return parts.join(KEY_SEPARATOR);
}

/** Make a composite key readable in messages. */
function displayKey(key) {
  return String(key).split(KEY_SEPARATOR).join(' | ');
}

/**
 * Plan an upsert into existing sheet values. Pure: returns the full new
 * 2D array to write, plus counts. Does not touch any sheet.
 *
 * Rules:
 *   - Key columns and any new column names are appended to the header.
 *   - A row whose key exists updates only the columns present in that row
 *     object; other cells in that row are left as they were.
 *   - A row whose key does not exist is appended at the bottom.
 *   - Two incoming rows with the same key: the later one wins.
 *   - Existing duplicate keys in the sheet cause an error.
 *
 * @param {Array<Array<*>>} values existing values, row 1 = headers ([] for an empty sheet)
 * @param {Array<string>|string} keyColumns
 * @param {Array<Object>} newRows
 * @param {string=} label
 * @return {{values: Array<Array<*>>, inserted: number, updated: number, addedColumns: Array<string>}}
 */
function planUpsert(values, keyColumns, newRows, label) {
  const cols = toArray_(keyColumns);
  const existing = (values && values.length) ? values.map(function (r) { return r.slice(); }) : [[]];

  // Header: start from what is there, then append key columns and new columns.
  const headers = existing[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  const addedColumns = [];
  function ensureColumn(name) {
    if (headers.indexOf(name) === -1) { headers.push(name); addedColumns.push(name); }
  }
  cols.forEach(ensureColumn);
  (newRows || []).forEach(function (row) { Object.keys(row).forEach(ensureColumn); });

  // Pad every row to the new width.
  const width = headers.length;
  const body = existing.slice(1).map(function (r) {
    while (r.length < width) r.push('');
    return r;
  });

  // Index existing rows by key, using the padded body.
  const table = tableFromValues([headers].concat(body), label);
  const index = indexByKey(table, cols, label);
  // Map table row index -> body index (blank rows were skipped by tableFromValues).
  const bodyIndexOf = table.rowNumbers.map(function (n) { return n - 2; });

  const colIndex = {};
  headers.forEach(function (h, i) { colIndex[h] = i; });

  let inserted = 0;
  let updated = 0;
  const insertedAt = {}; // key -> body index, for repeated keys within newRows

  (newRows || []).forEach(function (row, n) {
    const key = makeKey(row, cols);
    if (key === '') throw new Error('Incoming row ' + (n + 1) + ' has an empty key (' + cols.join(', ') + ')');

    let target;
    if (Object.prototype.hasOwnProperty.call(index, key)) {
      target = body[bodyIndexOf[index[key]]];
      updated++;
    } else if (Object.prototype.hasOwnProperty.call(insertedAt, key)) {
      target = body[insertedAt[key]];
    } else {
      target = new Array(width).fill('');
      body.push(target);
      insertedAt[key] = body.length - 1;
      inserted++;
    }
    Object.keys(row).forEach(function (name) { target[colIndex[name]] = row[name]; });
  });

  return { values: [headers].concat(body), inserted: inserted, updated: updated, addedColumns: addedColumns };
}

/**
 * Plan an append below an existing header row. Pure.
 * Column names in the rows that are not in the header are appended to it.
 *
 * @param {Array<*>} headerRow existing row 1 ([] for an empty sheet)
 * @param {Array<Object>} rows
 * @return {{headers: Array<string>, values: Array<Array<*>>, addedColumns: Array<string>}}
 *   values holds only the new data rows, each as wide as headers
 */
function planAppend(headerRow, rows) {
  const headers = (headerRow || []).map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  const addedColumns = [];
  (rows || []).forEach(function (row) {
    Object.keys(row).forEach(function (name) {
      if (headers.indexOf(name) === -1) { headers.push(name); addedColumns.push(name); }
    });
  });
  const values = (rows || []).map(function (row) {
    return headers.map(function (h) { return Object.prototype.hasOwnProperty.call(row, h) ? row[h] : ''; });
  });
  return { headers: headers, values: values, addedColumns: addedColumns };
}

/**
 * Make a value safe for setValues, which parses strings as if typed.
 * A string starting with = + - @ would become a formula, so it gets the
 * leading apostrophe that tells Sheets to store it as text (the apostrophe
 * is not part of the stored value). With forceText every non-empty string
 * gets it, so key cells such as "007" are not turned into numbers.
 * @param {*} v
 * @param {boolean=} forceText
 * @return {*}
 */
function escapeCellValue_(v, forceText) {
  if (typeof v !== 'string' || v === '') return v;
  if (forceText || /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}

/**
 * Escape a 2D array (row 1 = headers) for setValues. Data cells in columns
 * named in textColumns are forced to text.
 * @param {Array<Array<*>>} values
 * @param {Array<string>=} textColumns
 * @return {Array<Array<*>>} new array
 */
function escapeValuesForWrite_(values, textColumns) {
  const force = (values.length ? values[0] : []).map(function (h) { return (textColumns || []).indexOf(h) !== -1; });
  return values.map(function (row, r) {
    return row.map(function (v, c) { return escapeCellValue_(v, r > 0 && force[c]); });
  });
}

/**
 * Convert a 1-based column number to letters (1 -> A, 27 -> AA).
 * @param {number} n
 * @return {string}
 */
function columnLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isBlankCell_(v) {
  return v === '' || v === null || v === undefined;
}

function normalizeKeyPart_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function toArray_(v) {
  return Array.isArray(v) ? v : [v];
}

/* ---------- sheet I/O wrappers ---------- */

/**
 * The spreadsheet the code runs for. Run from the library project's own
 * editor there is none, so throw a clear error instead of failing on null.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No active spreadsheet. Run this from the spreadsheet (its menu or its bound script), ' +
      'not from the library project.');
  }
  return ss;
}

/**
 * Get a tab by name or throw a clear error.
 * @param {string} name
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheetOrThrow(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('Tab "' + name + '" not found');
  return sheet;
}

/**
 * Get a tab by name, creating it with the given headers if it does not exist.
 * @param {string} name
 * @param {Array<string>=} headers
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getOrCreateSheet(name, headers) {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/**
 * Read all values of a tab (one read call). Returns [] for an empty tab.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @return {Array<Array<*>>}
 */
function readValues_(sheet) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
}

/**
 * Read a tab into row objects.
 * @param {GoogleAppsScript.Spreadsheet.Sheet|string} sheetOrName
 * @return {{headers: Array<string>, rows: Array<Object>, rowNumbers: Array<number>}}
 */
function readTable(sheetOrName) {
  const sheet = typeof sheetOrName === 'string' ? getSheetOrThrow(sheetOrName) : sheetOrName;
  return tableFromValues(readValues_(sheet), sheet.getName());
}

/**
 * Upsert row objects into a tab by key: one read, one write.
 * The whole data block is rewritten, so this is meant for tabs the script
 * owns (Results), not for tabs with formulas. Strings are escaped so they
 * are stored as text (see escapeCellValue_); key cells are always text.
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet|string} sheetOrName
 * @param {Array<string>|string} keyColumns
 * @param {Array<Object>} rows
 * @return {{inserted: number, updated: number, addedColumns: Array<string>}}
 */
function upsertRows(sheetOrName, keyColumns, rows) {
  const sheet = typeof sheetOrName === 'string' ? getSheetOrThrow(sheetOrName) : sheetOrName;
  if (!rows || rows.length === 0) return { inserted: 0, updated: 0, addedColumns: [] };

  const plan = planUpsert(readValues_(sheet), keyColumns, rows, sheet.getName());
  const height = plan.values.length;
  const width = plan.values[0].length;
  ensureSheetSize_(sheet, height, width);
  sheet.getRange(1, 1, height, width).setValues(escapeValuesForWrite_(plan.values, toArray_(keyColumns)));
  return { inserted: plan.inserted, updated: plan.updated, addedColumns: plan.addedColumns };
}

/**
 * Append row objects below the last row of a tab. Reads only the header
 * row; writes the header (when columns were added) and the new rows.
 * Strings are escaped so they are stored as text (see escapeCellValue_).
 *
 * @param {GoogleAppsScript.Spreadsheet.Sheet|string} sheetOrName
 * @param {Array<Object>} rows
 * @return {{appended: number, addedColumns: Array<string>}}
 */
function appendRows(sheetOrName, rows) {
  const sheet = typeof sheetOrName === 'string' ? getSheetOrThrow(sheetOrName) : sheetOrName;
  if (!rows || rows.length === 0) return { appended: 0, addedColumns: [] };

  const lastRow = sheet.getLastRow();
  const headerRow = lastRow === 0 ? [] : sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const plan = planAppend(headerRow, rows);
  const width = plan.headers.length;
  const start = Math.max(lastRow, 1) + 1;
  ensureSheetSize_(sheet, start + plan.values.length - 1, width);
  if (plan.addedColumns.length) sheet.getRange(1, 1, 1, width).setValues(escapeValuesForWrite_([plan.headers]));
  const body = escapeValuesForWrite_([plan.headers].concat(plan.values)).slice(1);
  sheet.getRange(start, 1, body.length, width).setValues(body);
  return { appended: body.length, addedColumns: plan.addedColumns };
}

/** Grow the sheet grid so rows x columns fit; getRange cannot reach past it. */
function ensureSheetSize_(sheet, rows, columns) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
}
