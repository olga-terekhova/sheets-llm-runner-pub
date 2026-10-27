/**
 * Util_Template.gs - prompt templating.
 *
 * Placeholder syntax: {{name}} or {{ name }}.
 * Names: letters, digits and underscore, not starting with a digit.
 * Replacement is single-pass, so a value that itself contains "{{x}}"
 * is inserted as plain text and never expanded again.
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * List the unique placeholder names in a template, in order of first use.
 * @param {string} template
 * @return {Array<string>}
 */
function listPlaceholders(template) {
  const names = [];
  if (!template) return names;
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m;
  while ((m = re.exec(String(template))) !== null) {
    if (names.indexOf(m[1]) === -1) names.push(m[1]);
  }
  return names;
}

/**
 * Fill placeholders in a template from a vars object.
 *
 * By default a placeholder without a matching key in vars throws, listing
 * every missing name at once. Pass {strict: false} to leave unknown
 * placeholders untouched instead.
 *
 * Values: null / undefined -> '', Date -> ISO string,
 * objects / arrays -> JSON string, everything else -> String(value).
 *
 * @param {string} template
 * @param {Object} vars
 * @param {{strict: boolean}=} options
 * @return {string}
 */
function renderTemplate(template, vars, options) {
  if (template === null || template === undefined) return '';
  const strict = !options || options.strict !== false;
  const data = vars || {};

  if (strict) {
    const missing = listPlaceholders(template).filter(function (name) {
      return !Object.prototype.hasOwnProperty.call(data, name);
    });
    if (missing.length) {
      throw new Error('Template is missing values for: ' + missing.join(', '));
    }
  }

  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  return String(template).replace(re, function (whole, name) {
    if (!Object.prototype.hasOwnProperty.call(data, name)) return whole;
    return valueToText_(data[name]);
  });
}

/** Convert a variable value into prompt text. */
function valueToText_(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Build the vars object for one record from an input mapping.
 * mapping: { placeholderName: 'Source Column Header', ... }
 * Throws if a mapped column is absent from the record.
 *
 * @param {Object} record  one row as {header: value}
 * @param {Object<string,string>} mapping
 * @return {Object}
 */
function buildVars(record, mapping) {
  const vars = {};
  const absent = [];
  Object.keys(mapping || {}).forEach(function (name) {
    const column = mapping[name];
    if (!Object.prototype.hasOwnProperty.call(record, column)) {
      absent.push(column);
      return;
    }
    vars[name] = record[column];
  });
  if (absent.length) {
    throw new Error('Record is missing mapped columns: ' + absent.join(', '));
  }
  return vars;
}
