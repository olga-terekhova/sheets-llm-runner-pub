/**
 * Tests_Selection.gs - pure tests for Selection.gs.
 * They run as part of runAllTests (Tests.gs). No sheet or network access.
 */

/** A dataset entry on tab "Src" with sampleSourceValues_ attached. */
function selectionDataset_(id, title, defaultAssignment) {
  const vals = sampleConfigValues_();
  vals.datasets = [CONFIG_COLUMNS.datasets, [id, 'Src', 'ID', title, defaultAssignment]];
  const d = buildConfig(vals).datasets[id];
  attachSourceValues(d, sampleSourceValues_());
  return d;
}

function test_rowNumbersFromRanges() {
  assertEqual_(rowNumbersFromRanges([{ row: 7, numRows: 2 }, { row: 3, numRows: 3 }, { row: 4, numRows: 1 }]),
    [3, 4, 5, 7, 8], 'sorted, overlaps deduplicated');
  assertEqual_(rowNumbersFromRanges([]), [], 'empty');
}

function test_resolveSelection() {
  // Rows: 1 header, 2 metadata, 3-4 first block, 5 blank, 6 heading,
  // 7-8 "US companies" block, 9 heading of an empty list.
  const table = tableFromValues(sampleSourceValues_());
  const ca = selectionDataset_('ca', '', 'a1');
  const us = selectionDataset_('us', 'US companies', '');

  const r = resolveSelection(table, [ca, us], [9, 1, 2, 3, 4, 5, 6, 7, 8, 8, 20]);
  assertEqual_(r.items, [
    { rowNumber: 3, rowKey: '101', datasetId: 'ca', assignmentId: 'a1' },
    { rowNumber: 4, rowKey: '102', datasetId: 'ca', assignmentId: 'a1' },
    { rowNumber: 7, rowKey: '101', datasetId: 'us', assignmentId: '' },
    { rowNumber: 8, rowKey: '201', datasetId: 'us', assignmentId: '' }
  ], 'mixed datasets in sheet order; trimmed key; no default -> empty assignmentId');
  assertEqual_([r.undeclared, r.skipped], [[], [1, 2, 5, 6, 9, 20]], 'non-data rows skipped');

  const onlyUs = resolveSelection(table, [us], [3, 4, 7]);
  assertEqual_(onlyUs.items.map(function (i) { return i.rowNumber; }), [7], 'declared block only');
  assertEqual_(onlyUs.undeclared, [3, 4], 'keyed rows outside any declared block');

  assertEqual_(resolveSelection(table, [ca, us], []), { items: [], undeclared: [], skipped: [] }, 'nothing selected');
}

function test_formatRowList() {
  assertEqual_(formatRowList([3, 4, 5, 9, 11, 12]), '3-5, 9, 11-12', 'runs and singles');
  assertEqual_(formatRowList([]), '', 'empty');
}

function test_planSelectionRun() {
  const table = tableFromValues(sampleSourceValues_());
  function setup(usDefault) {
    const vals = sampleConfigValues_();
    vals.datasets = [CONFIG_COLUMNS.datasets, ['ca', 'Src', 'ID', '', 'a1'], ['us', 'Src', 'ID', 'US companies', usDefault]];
    vals.assignments = withCell_(vals.assignments, 1, 'dataset_id', 'ca');
    const config = buildConfig(vals);
    const datasets = [config.datasets.ca, config.datasets.us];
    datasets.forEach(function (d) { attachSourceValues(d, sampleSourceValues_()); });
    return { config: config, datasets: datasets };
  }

  // ca is untitled on a shared tab: a dataset error on the tab blocks the run.
  const broken = setup('');
  const p1 = planSelectionRun(broken.config, broken.datasets, resolveSelection(table, broken.datasets, [7]));
  assertHas_(p1.errors, 'dataset_title is empty', 'tab dataset error');
  assertHas_(p1.errors, 'Dataset "us" has no default_assignment; selected rows of it: 7', 'no default');

  const s = setup('');
  s.datasets[0].errors = []; // pretend ca is fine, to test the other checks alone
  const onlyUs = [s.datasets[1]];
  const p2 = planSelectionRun(s.config, onlyUs, resolveSelection(table, onlyUs, [3, 4, 7, 8]));
  assertHas_(p2.errors, 'Selected rows 3-4 have a key but are in no dataset declared in Datasets', 'undeclared');
  assertHas_(p2.errors, 'selected rows of it: 7-8', 'no default, row list');

  const p3 = planSelectionRun(s.config, s.datasets, resolveSelection(table, s.datasets, [3, 4]));
  assertEqual_(p3.errors, [], 'ok');
  assertEqual_(Object.keys(p3.contexts), ['a1'], 'one context per assignment');
  const ctx = p3.contexts.a1;
  assertEqual_([ctx.assignment.id, ctx.variant.id, ctx.dataset.id], ['a1', 'hq_v1', 'ca'], 'context shape');
  assertEqual_(findRecord(ctx.dataset, '102').rowNumber, 4, 'context dataset has its block');

  const badInput = setup('');
  badInput.datasets[0].errors = [];
  badInput.config.assignments.a1.inputMapping.company = 'No Such Column';
  const p4 = planSelectionRun(badInput.config, badInput.datasets, resolveSelection(table, badInput.datasets, [3]));
  assertHas_(p4.errors, 'input_mapping columns not found in tab "Src": No Such Column', 'input columns checked');
}

function test_formatRunSummary() {
  const text = formatRunSummary({
    jobId: 'job_x', total: 4, skipped: 2,
    done: [
      { rowNumber: 3, rowKey: '101', status: 'ok', error: '' },
      { rowNumber: 4, rowKey: '102', status: 'error', error: 'HTTP 500: boom' }
    ],
    notStarted: [{ rowNumber: 7, rowKey: '101' }, { rowNumber: 8, rowKey: '201' }],
    failure: ''
  });
  assertEqual_(text.split('\n'), [
    'Processed 2 of 4 row(s): 1 ok, 0 warning, 1 error.',
    '2 selected row(s) skipped (header, headings, metadata or blank).',
    '',
    'Errors:',
    '- row 4 (102): HTTP 500: boom',
    '',
    'Not processed (time limit), select and run again: rows 7-8.',
    '',
    'Job job_x. Details in the Results and Log tabs.'
  ], 'summary lines');
  const stopped = formatRunSummary({ jobId: 'j', total: 1, skipped: 0, done: [], notStarted: [{ rowNumber: 3 }], failure: 'disk full' });
  assertHas_([stopped], 'The run stopped: disk full', 'failure');
  assertHas_([stopped], 'Not processed (run stopped)', 'reason');
  const moved = formatRunSummary({ jobId: 'j', total: 2, skipped: 0, notStarted: [], failure: '', done: [
    { rowNumber: 3, rowKey: '1', status: 'ok', error: '', notWrittenBack: true },
    { rowNumber: 4, rowKey: '2', status: 'ok', error: '', notWrittenBack: false }] });
  assertHas_([moved], 'Not written back (the row moved out of its block during the run; see the Log tab): rows 3.',
    'write-back not found');
}
