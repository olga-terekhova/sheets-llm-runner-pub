/**
 * Code.gs - the bound script of a spreadsheet that uses the LLM Runner
 * library (identifier LLMRunner). All logic lives in the library; see
 * SETUP.md. Paste this file into Extensions > Apps Script of each
 * spreadsheet.
 *
 * Menu items must name functions of this script, so each one has a
 * one-line wrapper here. The menu is built here, without a library call,
 * so it appears even if the library cannot be loaded (the error then shows
 * when an item is clicked).
 *
 * Editor entry points (select one and click Run):
 *   setupConfigTabs - create missing config tabs
 *   validateConfig  - log config errors and warnings
 *   dryRunOne       - build the request for RUN_ASSIGNMENT_ID / RUN_ROW_KEY
 *   runOne          - same, plus one live, billed call; writes Results and Log
 *   testSheetUtils  - sheet utility test on scratch tabs (no API calls)
 */

const RUN_ASSIGNMENT_ID = '';
const RUN_ROW_KEY = '';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('LLM Runner')
    .addItem('Process selection', 'menuProcessSelection')
    .addItem('Validate config', 'menuValidateConfig')
    .addToUi();
}

function menuProcessSelection() { return LLMRunner.menuProcessSelection(); }
function menuValidateConfig() { return LLMRunner.menuValidateConfig(); }

function setupConfigTabs() { return LLMRunner.setupConfigTabs(); }
function validateConfig() { return LLMRunner.validateConfig(); }
function testSheetUtils() { return LLMRunner.testSheetUtils(); }

function dryRunOne() {
  checkRunConstants_();
  return LLMRunner.dryRunRow(RUN_ASSIGNMENT_ID, RUN_ROW_KEY);
}

/** Makes one billed call. */
function runOne() {
  checkRunConstants_();
  return LLMRunner.runRow(RUN_ASSIGNMENT_ID, RUN_ROW_KEY);
}

function checkRunConstants_() {
  if (!RUN_ASSIGNMENT_ID || RUN_ROW_KEY === '') {
    throw new Error('Set RUN_ASSIGNMENT_ID and RUN_ROW_KEY at the top of this file');
  }
}
