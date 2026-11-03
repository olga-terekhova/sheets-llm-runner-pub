/**
 * Smoke.gs - M0 live API checks. Each run makes a real, billed API call.
 *
 * Before running:
 *   1. In the library project: Project Settings > Script properties >
 *      add PERPLEXITY_API_KEY. Run these from the library editor (no
 *      spreadsheet needed).
 *   2. Set SMOKE_MODEL to a model from the Agent API model list:
 *      https://docs.perplexity.ai/docs/agent-api/models
 *
 * Run smokeTestPlain first, then smokeTestStructured.
 * The first call with a new JSON schema can take 10-30 seconds.
 */

const SMOKE_MODEL = 'openai/gpt-5.4-mini';

/** Cheapest possible check: no tools, no schema. */
function smokeTestPlain() {
  const payload = buildAgentPayload({
    model: SMOKE_MODEL,
    input: 'Reply with exactly one word: pong'
  });
  const result = sendAgentRequest(payload);
  logApiResult_('smokeTestPlain', payload, result);
}

/**
 * Closer to the real use case: web_search + fetch_url, a step limit,
 * templated prompt, and a JSON schema for the answer.
 */
function smokeTestStructured() {
  const record = { 'Company Name': 'Shopify', 'Country': 'Canada' };
  const inputMap = { company: 'Company Name', country: 'Country' };

  const promptTemplate =
    'Find the headquarters city and the official website of the company ' +
    '"{{company}}" based in {{country}}.';
  const instructionsTemplate =
    'Use web search to verify facts. Return only a JSON object that matches the schema. ' +
    'If a value cannot be found, use null.';

  // Simulates one Variants row; output_json_schema is JSON text, as in a cell.
  const variant = {
    variant_id: 'hq_lookup_v1',
    model: SMOKE_MODEL,
    tools: 'web_search, fetch_url',
    max_urls: 2,
    max_steps: 4,
    output_json_schema: JSON.stringify({
      type: 'object',
      properties: {
        company: { type: 'string' },
        headquarters_city: { type: ['string', 'null'] },
        website: { type: ['string', 'null'] },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
      },
      required: ['company', 'headquarters_city', 'website', 'confidence'],
      additionalProperties: false
    })
  };

  const vars = buildVars(record, inputMap);
  const payload = buildAgentPayload({
    model: variant.model,
    input: renderTemplate(promptTemplate, vars),
    instructions: renderTemplate(instructionsTemplate, vars),
    tools: variant.tools,
    maxUrls: variant.max_urls,
    maxSteps: variant.max_steps,
    schema: parseSchemaCell(variant.output_json_schema, variant.variant_id),
    schemaName: schemaNameFromId(variant.variant_id)
  });

  const result = sendAgentRequest(payload);
  logApiResult_('smokeTestStructured', payload, result);
  if (!result.ok || !result.json) return;

  const env = buildResponseEnvelope(result.json);
  Logger.log('Model JSON parsed: ' + (env.output_json !== null) +
    (env.output_json_error ? ' error: ' + env.output_json_error : ''));

  // Simulates an assignment's output mapping: result column -> path in the envelope.
  const mapped = applyOutputMapping(env, {
    'HQ City': 'output_json.headquarters_city',
    'Website': 'output_json.website',
    'Confidence': 'output_json.confidence',
    'Sources': 'sources',
    'Cost USD': 'usage.cost.total_cost'
  });
  Logger.log('Mapped output: ' + JSON.stringify(mapped.values));
  if (mapped.missing.length) Logger.log('Missing paths: ' + mapped.missing.join(', '));
}

/** Log the parts of a result worth inspecting during M0. */
function logApiResult_(label, payload, result) {
  Logger.log('=== ' + label + ' ===');
  Logger.log('Request: ' + JSON.stringify(payload));
  Logger.log('HTTP ' + result.code + ' in ' + result.elapsedMs + ' ms');
  if (!result.ok) {
    Logger.log('Error body: ' + truncate_(result.body, 3000));
    return;
  }
  Logger.log('Usage: ' + JSON.stringify(extractUsage(result.json)));
  Logger.log('Output text: ' + truncate_(extractOutputText(result.json), 3000));
  const types = (result.json.output || []).map(function (i) { return i && i.type; });
  Logger.log('Output item types: ' + JSON.stringify(types));
  Logger.log('Raw (first 3000 chars): ' + truncate_(result.body, 3000));
}
