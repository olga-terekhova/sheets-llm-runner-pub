# Setup of sheets-llm-runner

The code lives in one standalone Apps Script project (the library). Each
spreadsheet has a small bound script, [bound/Code.gs](bound/Code.gs), with
`onOpen` and one-line wrappers that call the library under the identifier
`LLMRunner`.

- The guinea-pig spreadsheet uses the library in development mode (HEAD):
  it always runs the latest saved library code.
- Other spreadsheets use a pinned library version and are updated
  deliberately.

## Initial deploy

### The library project
- Create a new project on script.google.com, name it `sheets-llm-runner`
- Add a script file for each `.gs` file in the repo root and paste its
  content (the editor adds `.gs` to the name). Do not add `bound/Code.gs` or
  `run_tests_node.js`
- Delete the default `Code.gs` (with `myFunction`), save
- Project Settings - Script properties - Add property `PERPLEXITY_API_KEY`
  with the API key. All spreadsheets share this key; a bound script's own
  Script Properties are not used
- Run `runAllTests` (pure tests, no spreadsheet needed); all should pass
- Optional: run `smokeTestPlain` (one billed call) to authorize external
  requests and check the key
- Project Settings - IDs - copy the Script ID

Functions that need a spreadsheet (`validateConfig`, `testSheetUtils`,
`menuProcessSelection`, ...) cannot run from the library editor: they stop
with `No active spreadsheet...`. Run them from a spreadsheet's bound script.

### Creating a library version (for pinned spreadsheets)
- Deploy - New deployment - Select type: Library - Enter description - Deploy
- Make note of the version number, and tag the commit it came from, e.g.
  `git tag lib-v1`

### A spreadsheet
- Extensions - Apps Script
- Guinea pig only (it held the code before the split): delete every old
  `.gs` file, and delete the Script property `PERPLEXITY_API_KEY` (no
  longer read)
- Libraries - Add a library - paste the Script ID - Look up
  - Version: `HEAD (Development mode)` for the guinea pig; the latest
    version number for any other spreadsheet
  - Identifier: `LLMRunner` (exactly; the wrappers use it)
  - Add
- Paste [bound/Code.gs](bound/Code.gs) into `Code.gs`, save
- Run `validateConfig` from the editor; allow the permissions it asks for
  (spreadsheet, external service, dialogs)
- New spreadsheet only: run `setupConfigTabs`, then fill in Datasets,
  Variants and Assignments
- Reload the spreadsheet to see the `LLM Runner` menu

### Checks in the guinea pig (once, after the split)
- Editor: `testSheetUtils` passes (sheet access through the library)
- Menu - Validate config: the dialog appears (UI through the library)
- Menu - Process selection on one row: toast, summary dialog, Results and
  Log rows written, Log `cost` filled (API key read from the library)
- Menu - Process selection on more than 5 rows, and while it runs click
  Process selection again: the second click is refused with "Another run
  is in progress" (document lock shared with the library)

## Making changes

### In the library
- Update the changed `.gs` files in the library project, save
- The guinea pig runs the new code at once: test it there
- When it works: create a library version (see above)

### In the other spreadsheets
- Extensions - Apps Script - Libraries - `LLMRunner` - select the new
  version - Save
- If `bound/Code.gs` changed (e.g. a new menu item), paste it again. A menu
  item must name a wrapper in the bound script, and a wrapper can call only
  library functions whose names do not end in `_`; `node run_tests_node.js`
  checks both
- Check whether the release changed config tabs or columns (see
  PROJECT.md and the list below) and update the tabs before running

## Config changes by release

### M8 (write-back)
- Library: new files `Writeback.gs` and `Tests_Writeback.gs`; most other
  files changed
- Assignments tab: rename the header `output_mapping` to `results_mapping`
  (until then, validation reports `missing columns: results_mapping`)
- Assignments tab: optionally add a `writeback_mapping` column, e.g.
  `{"HQ": "output_json.headquarters_city"}`; target columns are created on
  the source tab on first write
- Log tab: a `missing_paths` column is added at the right on the next run
- Check in the guinea pig: Validate config, then Process selection on a few
  rows of an assignment with a `writeback_mapping`; only the mapped cells
  change, and an HTTP error leaves them as they were
