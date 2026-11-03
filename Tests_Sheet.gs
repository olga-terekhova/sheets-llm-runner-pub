/**
 * Tests_Sheet.gs - integration test for Util_Sheet against a real tab.
 * Creates a temporary tab, exercises readTable and upsertRows, checks the
 * results, and deletes the tab. No API calls.
 *
 * Run testSheetUtils from the bound script (its wrapper in bound/Code.gs),
 * not from the library project. The first run asks for permission
 * to edit the spreadsheet.
 */

const SCRATCH_TAB = '_scratch_test';

function testSheetUtils() {
  const ss = getSpreadsheet_();
  [SCRATCH_TAB, SCRATCH_TAB + '_log', SCRATCH_TAB + '_src'].forEach(function (name) {
    const old = ss.getSheetByName(name);
    if (old) ss.deleteSheet(old);
  });

  const keys = ['_dataset_id', '_row_key', '_variant_id'];
  try {
    const sheet = getOrCreateSheet(SCRATCH_TAB, keys.concat(['_status']));

    // 1. Insert into an empty tab (header only).
    let r = upsertRows(sheet, keys, [
      { _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v1', _status: 'done', 'HQ City': 'Ottawa' },
      { _dataset_id: 'ds1', _row_key: 2, _variant_id: 'v1', _status: 'done', 'HQ City': 'Waterloo' }
    ]);
    assertEqual_([r.inserted, r.updated, r.addedColumns], [2, 0, ['HQ City']], 'first upsert');

    // 2. Update one row, add a new variant row and a new column.
    r = upsertRows(sheet, keys, [
      { _dataset_id: 'ds1', _row_key: '1', _variant_id: 'v1', 'HQ City': 'Ottawa, ON' },
      { _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v2', _status: 'error', Website: 'shopify.com' }
    ]);
    assertEqual_([r.inserted, r.updated, r.addedColumns], [1, 1, ['Website']], 'second upsert');

    // 3. Read back and check.
    const t = readTable(sheet);
    assertEqual_(t.headers, ['_dataset_id', '_row_key', '_variant_id', '_status', 'HQ City', 'Website'], 'headers');
    assertEqual_(t.rows.length, 3, 'row count');
    const idx = indexByKey(t, keys, SCRATCH_TAB);
    const row1 = t.rows[idx[makeKey({ _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v1' }, keys)]];
    assertEqual_(row1['HQ City'], 'Ottawa, ON', 'updated value');
    assertEqual_(row1._status, 'done', 'untouched column kept');
    const row3 = t.rows[idx[makeKey({ _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v2' }, keys)]];
    assertEqual_([row3._status, row3.Website, row3['HQ City']], ['error', 'shopify.com', ''], 'new variant row');

    // 4. Text that looks like a formula or a number survives as text, also on later rewrites.
    upsertRows(sheet, keys, [{ _dataset_id: 'ds1', _row_key: '007', _variant_id: 'v1', Phone: '+1 555 0100' }]);
    upsertRows(sheet, keys, [{ _dataset_id: 'ds1', _row_key: 1, _variant_id: 'v1', _status: 'ok' }]);
    const t2 = readTable(sheet);
    const row7 = t2.rows[indexByKey(t2, keys, SCRATCH_TAB)[makeKey({ _dataset_id: 'ds1', _row_key: '007', _variant_id: 'v1' }, keys)]];
    assertEqual_([row7._row_key, row7.Phone], ['007', '+1 555 0100'], 'escaped values read back');

    // 5. Append below the header, adding a column; then grow past the sheet's row count.
    const log = getOrCreateSheet(SCRATCH_TAB + '_log', ['a', 'b']);
    let ap = appendRows(log, [{ a: 1, b: '=x' }, { a: 2, c: 'new' }]);
    assertEqual_([ap.appended, ap.addedColumns], [2, ['c']], 'first append');
    const many = [];
    for (let i = 0; i < log.getMaxRows(); i++) many.push({ a: i });
    ap = appendRows(log, many);
    const lt = readTable(log);
    assertEqual_([lt.headers, lt.rows.length, lt.rows[0].b, lt.rows[1].c], [['a', 'b', 'c'], many.length + 2, '=x', 'new'], 'appended rows');

    // 6. Write back into a source-like tab: only mapped cells change; a column is added past the grid.
    const src = getOrCreateSheet(SCRATCH_TAB + '_src', ['ID', 'Name', 'HQ']);
    src.getRange(2, 1, 4, 3).setValues([['', 'meta', 'keep'], ["'007", 'A', 'old'], [8, 'B', ''], [9, 'C', 'c']]);
    if (src.getMaxColumns() > 3) src.deleteColumns(4, src.getMaxColumns() - 3);
    const wb = writeBackRows({ tabName: SCRATCH_TAB + '_src', keyColumn: 'ID', title: '' }, [
      { rowKey: '007', values: { HQ: 'Ottawa', Phone: '+1 555' } },
      { rowKey: 9, values: { Phone: '=x' } },
      { rowKey: 99, values: { HQ: 'nope' } }
    ]);
    assertEqual_([wb.cells, wb.addedColumns, wb.notFound], [3, ['Phone'], ['99']], 'write-back counts');
    const st = readTable(src);
    assertEqual_(st.headers, ['ID', 'Name', 'HQ', 'Phone'], 'write-back header');
    assertEqual_(st.rows.map(function (r) { return [r.ID, r.Name, r.HQ, r.Phone]; }),
      [['', 'meta', 'keep', ''], ['007', 'A', 'Ottawa', '+1 555'], [8, 'B', '', ''], [9, 'C', 'c', '=x']],
      'only mapped cells written, as text');

    Logger.log('testSheetUtils: PASS');
  } catch (e) {
    Logger.log('testSheetUtils: FAIL ' + (e && e.message ? e.message : e));
    throw e;
  } finally {
    [SCRATCH_TAB, SCRATCH_TAB + '_log', SCRATCH_TAB + '_src'].forEach(function (name) {
      const s = ss.getSheetByName(name);
      if (s) ss.deleteSheet(s);
    });
  }
}
