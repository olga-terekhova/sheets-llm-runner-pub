/**
 * Util_Json.gs - JSON helpers: path extraction, lenient parsing of model
 * output, and converting values into something a sheet cell can hold.
 * All functions are pure (no sheet or network access).
 */

const CELL_MAX_CHARS = 50000;
const TRUNCATION_SUFFIX = ' ...[truncated]';

/**
 * Read a value from a nested object using a path string.
 *
 * Supported syntax:
 *   'a.b.c'          object keys
 *   'items[0].name'  array index in brackets
 *   'items.0.name'   array index as a plain segment (same result)
 *   ''               returns the object itself
 *
 * Returns undefined when any step is missing. Keys that contain dots or
 * brackets are not supported.
 *
 * @param {*} obj
 * @param {string} path
 * @return {*}
 */
function getPath(obj, path) {
  const segments = parsePath_(path);
  let cur = obj;
  for (let i = 0; i < segments.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[segments[i]];
  }
  return cur;
}

/**
 * Split a path string into segments. Bracket indices become numbers.
 * Throws on malformed paths so config mistakes surface early.
 * @param {string} path
 * @return {Array<string|number>}
 */
function parsePath_(path) {
  if (path === null || path === undefined) return [];
  const s = String(path).trim();
  if (s === '') return [];

  const segments = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let lastEnd = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const between = s.slice(lastEnd, m.index);
    // Only "", "." are allowed between tokens.
    if (between !== '' && between !== '.') {
      throw new Error('Malformed path "' + path + '" near "' + between + '"');
    }
    if (m[1] !== undefined) {
      segments.push(/^\d+$/.test(m[1]) ? Number(m[1]) : m[1]);
    } else {
      segments.push(Number(m[2]));
    }
    lastEnd = re.lastIndex;
  }
  if (lastEnd !== s.length) {
    throw new Error('Malformed path "' + path + '" near "' + s.slice(lastEnd) + '"');
  }
  return segments;
}

/**
 * Parse JSON that came from a model. Tries, in order:
 *   1. the whole text
 *   2. the contents of a ```json ... ``` (or ``` ... ```) fence
 *   3. the substring from the first "{" to the last "}"
 *
 * Never throws.
 *
 * @param {string} text
 * @return {{ok: boolean, value: *, error: string, method: string}}
 */
function parseModelJson(text) {
  if (text === null || text === undefined || String(text).trim() === '') {
    return { ok: false, value: null, error: 'empty text', method: '' };
  }
  const s = String(text).trim();

  const direct = tryParse_(s);
  if (direct.ok) return { ok: true, value: direct.value, error: '', method: 'direct' };

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse_(fence[1].trim());
    if (fenced.ok) return { ok: true, value: fenced.value, error: '', method: 'fence' };
  }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const braces = tryParse_(s.slice(first, last + 1));
    if (braces.ok) return { ok: true, value: braces.value, error: '', method: 'braces' };
  }

  return { ok: false, value: null, error: 'could not parse JSON: ' + direct.error, method: '' };
}

/** JSON.parse wrapper that returns {ok, value, error}. */
function tryParse_(s) {
  try {
    return { ok: true, value: JSON.parse(s), error: '' };
  } catch (e) {
    return { ok: false, value: null, error: String(e.message || e) };
  }
}

/**
 * Convert any value into something safe to write to a cell.
 *   null / undefined   -> ''
 *   number / boolean   -> unchanged (so the sheet keeps the native type)
 *   Date               -> unchanged
 *   string             -> unchanged, truncated if too long
 *   array / object     -> JSON string, truncated if too long
 *
 * @param {*} value
 * @param {number=} maxChars defaults to CELL_MAX_CHARS
 * @return {*}
 */
function stringifyForCell(value, maxChars) {
  const limit = maxChars || CELL_MAX_CHARS;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return truncate_(s, limit);
}

/** Cut a string to at most maxChars, marking the cut. */
function truncate_(s, maxChars) {
  if (s.length <= maxChars) return s;
  const keep = Math.max(0, maxChars - TRUNCATION_SUFFIX.length);
  return s.slice(0, keep) + TRUNCATION_SUFFIX;
}

/**
 * Parse the output_json_schema value from a Variants row.
 *   empty cell        -> null (no structured output for this variant)
 *   object            -> returned as is
 *   JSON text         -> parsed strictly (no fence or brace recovery,
 *                        because a config typo should fail loudly)
 * The root must be a JSON object with "type": "object".
 *
 * @param {*} value cell value
 * @param {string=} label used in error messages, e.g. the variant id
 * @return {Object|null}
 */
function parseSchemaCell(value, label) {
  const where = label ? ' (' + label + ')' : '';
  if (value === null || value === undefined || String(value).trim() === '') return null;

  let schema = value;
  if (typeof value === 'string') {
    const r = tryParse_(value.trim());
    if (!r.ok) throw new Error('output_json_schema is not valid JSON' + where + ': ' + r.error);
    schema = r.value;
  }
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('output_json_schema must be a JSON object' + where);
  }
  if (schema.type !== 'object') {
    throw new Error('output_json_schema root must have "type": "object"' + where);
  }
  return schema;
}

/**
 * Derive the schema name the API requires (1-64 chars of A-Z a-z 0-9 _ -)
 * from a variant id. Other characters become "_". Empty input -> "output".
 * @param {*} id
 * @return {string}
 */
function schemaNameFromId(id) {
  const cleaned = String(id === null || id === undefined ? '' : id)
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 64);
  return cleaned || 'output';
}

/**
 * Apply an output mapping to a parsed object.
 * mapping: { outputColumnName: 'json.path', ... }
 * Returns { values: {column: cellValue}, missing: [column, ...] }.
 * A path that resolves to undefined is reported in "missing" and written
 * as ''. A JSON null is written as '' but is not reported as missing.
 *
 * @param {Object} obj
 * @param {Object<string,string>} mapping
 * @return {{values: Object, missing: Array<string>}}
 */
function applyOutputMapping(obj, mapping) {
  const values = {};
  const missing = [];
  Object.keys(mapping || {}).forEach(function (column) {
    const v = getPath(obj, mapping[column]);
    if (v === undefined) missing.push(column);
    values[column] = stringifyForCell(v);
  });
  return { values: values, missing: missing };
}
