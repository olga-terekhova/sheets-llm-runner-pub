/**
 * Pipeline.gs - pure per-record steps: build the API payload for one source
 * row, and map one API response to output column values.
 * No sheet or network access; entries come from buildConfig (Config.gs).
 */

/**
 * Build the Agent API payload for one source row.
 * Throws if a mapped column is absent or a placeholder has no value.
 *
 * @param {Object} record one source row as {header: value}
 * @param {Object} variant variant entry from buildConfig
 * @param {Object} assignment assignment entry from buildConfig
 * @return {Object} payload ready for sendAgentRequest
 */
function buildRecordPayload(record, variant, assignment) {
  const vars = buildVars(record, assignment.inputMapping);
  return buildAgentPayload({
    model: variant.model,
    input: renderTemplate(variant.promptTemplate, vars),
    instructions: renderTemplate(variant.instructionsTemplate, vars),
    tools: variant.tools,
    maxUrls: variant.maxUrls,
    maxSteps: variant.maxSteps,
    schema: variant.schema,
    schemaName: variant.schemaName
  });
}

/**
 * Map a parsed API response to output column values using the
 * assignment's results_mapping and writeback_mapping. See
 * buildResponseEnvelope for the paths.
 *
 * @param {Object} responseJson
 * @param {Object} assignment
 * @return {{envelope: Object, results: {values: Object, missing: Array<string>},
 *           writeback: {values: Object, missing: Array<string>}}}
 *   missing lists column names whose path resolved to undefined
 */
function mapRecordOutputs(responseJson, assignment) {
  const envelope = buildResponseEnvelope(responseJson);
  return {
    envelope: envelope,
    results: applyOutputMapping(envelope, assignment.resultsMapping),
    writeback: applyOutputMapping(envelope, assignment.writebackMapping)
  };
}
