/**
 * Api.gs - Perplexity Agent API client.
 *
 * Building a request is kept separate from sending it, so a later
 * milestone can pass the same request objects to UrlFetchApp.fetchAll().
 *
 * Docs: https://docs.perplexity.ai/docs/agent-api
 */

const PPLX_ENDPOINT = 'https://api.perplexity.ai/v1/agent';
const PPLX_KEY_PROPERTY = 'PERPLEXITY_API_KEY';
const PPLX_ALLOWED_TOOLS = ['web_search', 'fetch_url'];

/**
 * Read the API key from Script Properties.
 * Set it once in the library project (not in a spreadsheet's bound
 * script): Project Settings > Script properties > Add property. A library
 * reads its own Script Properties, so every spreadsheet shares the key.
 * @return {string}
 */
function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty(PPLX_KEY_PROPERTY);
  if (!key) {
    throw new Error('Missing script property ' + PPLX_KEY_PROPERTY +
      '. Add it in the library project: Project Settings > Script properties.');
  }
  return key;
}

/**
 * Normalize a tool list that may come from a sheet cell.
 * Accepts an array (['web_search']) or a comma-separated string
 * ('web_search, fetch_url'). Empty input returns [].
 * @param {Array<string>|string} tools
 * @return {Array<string>}
 */
function normalizeToolList(tools) {
  if (tools === null || tools === undefined || tools === '') return [];
  const list = Array.isArray(tools) ? tools : String(tools).split(',');
  const out = [];
  list.forEach(function (t) {
    const name = String(t).trim();
    if (!name) return;
    if (PPLX_ALLOWED_TOOLS.indexOf(name) === -1) {
      throw new Error('Unknown tool "' + name + '". Allowed: ' + PPLX_ALLOWED_TOOLS.join(', '));
    }
    if (out.indexOf(name) === -1) out.push(name);
  });
  return out;
}

/**
 * Build the JSON body for one Agent API call. Pure function, no I/O.
 *
 * spec fields:
 *   model        string, required
 *   input        string, required (the rendered prompt)
 *   instructions string, optional (the rendered instructions)
 *   tools        array or comma-separated string of 'web_search' / 'fetch_url'
 *   maxUrls      integer 1-10, optional, applied to the fetch_url tool
 *   maxSteps     integer, optional, top-level max_steps
 *   maxOutputTokens integer, optional, top-level max_output_tokens
 *                (required by the API for anthropic/* models)
 *   schema       object, optional, JSON schema for structured output
 *   schemaName   string, optional, default 'output' (1-64 chars: A-Z a-z 0-9 _ -)
 *
 * @param {Object} spec
 * @return {Object} payload ready for JSON.stringify
 */
function buildAgentPayload(spec) {
  if (!spec || !spec.model) throw new Error('buildAgentPayload: model is required');
  if (!spec.input) throw new Error('buildAgentPayload: input is required');

  const payload = { model: String(spec.model).trim(), input: String(spec.input) };

  if (spec.instructions) payload.instructions = String(spec.instructions);

  const toolNames = normalizeToolList(spec.tools);
  if (toolNames.length) {
    payload.tools = toolNames.map(function (name) {
      const tool = { type: name };
      if (name === 'fetch_url' && isPresent_(spec.maxUrls)) {
        const n = Number(spec.maxUrls);
        if (!(n >= 1 && n <= 10 && Math.floor(n) === n)) {
          throw new Error('maxUrls must be an integer from 1 to 10, got: ' + spec.maxUrls);
        }
        tool.max_urls = n;
      }
      return tool;
    });
  }

  if (isPresent_(spec.maxSteps)) {
    const s = Number(spec.maxSteps);
    if (!(s >= 1 && Math.floor(s) === s)) {
      throw new Error('maxSteps must be a positive integer, got: ' + spec.maxSteps);
    }
    payload.max_steps = s;
  }

  if (isPresent_(spec.maxOutputTokens)) {
    const t = Number(spec.maxOutputTokens);
    if (!(t >= 1 && Math.floor(t) === t)) {
      throw new Error('maxOutputTokens must be a positive integer, got: ' + spec.maxOutputTokens);
    }
    payload.max_output_tokens = t;
  }

  if (spec.schema) {
    const name = spec.schemaName || 'output';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new Error('schemaName must be 1-64 chars of A-Z a-z 0-9 _ -, got: ' + name);
    }
    payload.response_format = {
      type: 'json_schema',
      json_schema: { name: name, schema: spec.schema }
    };
  }

  return payload;
}

/**
 * Wrap a payload into a UrlFetchApp request object.
 * The returned object includes "url", which is the shape fetchAll() expects.
 * @param {Object} payload
 * @return {Object}
 */
function buildFetchRequest(payload) {
  return {
    url: PPLX_ENDPOINT,
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getApiKey_() },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

/**
 * Send one payload and return a normalized result. Never throws on HTTP
 * errors; check result.ok and result.code instead.
 * @param {Object} payload
 * @return {{ok: boolean, code: number, elapsedMs: number, json: Object, body: string}}
 */
function sendAgentRequest(payload) {
  const req = buildFetchRequest(payload);
  const params = Object.assign({}, req);
  delete params.url;

  const t0 = Date.now();
  const resp = UrlFetchApp.fetch(req.url, params);
  return toApiResult_(resp, Date.now() - t0);
}

/**
 * Convert an HTTPResponse into the normalized result shape.
 * Shared with the future fetchAll() path.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} resp
 * @param {number} elapsedMs
 */
function toApiResult_(resp, elapsedMs) {
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* leave null, body kept for logs */ }
  return { ok: code >= 200 && code < 300, code: code, elapsedMs: elapsedMs, json: json, body: body };
}

/**
 * Collect the assistant text from an Agent API response.
 * Reads output[] items of type "message", then their content entries of
 * type "output_text", and joins the text.
 * @param {Object} responseJson
 * @return {string}
 */
function extractOutputText(responseJson) {
  if (!responseJson || !Array.isArray(responseJson.output)) return '';
  const parts = [];
  responseJson.output.forEach(function (item) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) return;
    item.content.forEach(function (c) {
      if (c && c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
    });
  });
  return parts.join('');
}

/**
 * Collect source URLs from search_results and fetch_url_results items.
 * These come from the API itself, so they are more reliable than URLs
 * the model writes into its JSON answer.
 * @param {Object} responseJson
 * @return {Array<string>} unique URLs in order of appearance
 */
function extractSourceUrls(responseJson) {
  const urls = [];
  if (!responseJson || !Array.isArray(responseJson.output)) return urls;
  responseJson.output.forEach(function (item) {
    if (!item) return;
    const list = item.type === 'search_results' ? item.results
      : item.type === 'fetch_url_results' ? item.contents
      : null;
    (list || []).forEach(function (r) {
      if (r && r.url && urls.indexOf(r.url) === -1) urls.push(r.url);
    });
  });
  return urls;
}

/**
 * Build the object that output mapping paths are resolved against:
 * the raw API response plus derived top-level branches.
 *
 *   output_text        assistant text joined from output[] message items
 *   output_json        the model's JSON answer, parsed (null if absent or unparseable)
 *   output_json_error  parse error message, '' when parsing succeeded
 *   sources            unique URLs from search_results and fetch_url_results
 *
 * Every raw branch stays available, so mappings can use paths such as
 *   output_json.headquarters_city
 *   usage.cost.total_cost
 *   sources
 *   model
 *
 * The raw response is not modified (shallow copy). The raw response has no
 * top-level keys with these names today; if one ever appears, the derived
 * value wins.
 *
 * @param {Object} responseJson
 * @return {Object}
 */
function buildResponseEnvelope(responseJson) {
  const env = Object.assign({}, responseJson || {});
  const text = extractOutputText(responseJson);
  const parsed = text ? parseModelJson(text) : { ok: false, value: null, error: 'no output text' };
  env.output_text = text;
  env.output_json = parsed.ok ? parsed.value : null;
  env.output_json_error = parsed.ok ? '' : parsed.error;
  env.sources = extractSourceUrls(responseJson);
  return env;
}

/**
 * Pull the usage and cost numbers worth logging.
 * @param {Object} responseJson
 * @return {Object}
 */
function extractUsage(responseJson) {
  return {
    status: getPath(responseJson, 'status'),
    model: getPath(responseJson, 'model'),
    inputTokens: getPath(responseJson, 'usage.input_tokens'),
    outputTokens: getPath(responseJson, 'usage.output_tokens'),
    totalCost: getPath(responseJson, 'usage.cost.total_cost'),
    currency: getPath(responseJson, 'usage.cost.currency'),
    searchCalls: getPath(responseJson, 'usage.tool_calls_details.search_web.invocation'),
    fetchCalls: getPath(responseJson, 'usage.tool_calls_details.fetch_url.invocation')
  };
}

/** True when a value is not null, undefined or an empty string. */
function isPresent_(v) {
  return v !== null && v !== undefined && v !== '';
}
