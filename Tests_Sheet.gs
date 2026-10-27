/**
 * Tests_Sheet.gs - integration test for Util_Sheet against a real tab.
 * Creates a temporary tab, exercises readTable and upsertRows, checks the
 * results, and deletes the tab. No API calls.
 *
 * Run testSheetUtils from the editor. The first run asks for permission
 * to edit the spreadsheet.
 */

const SCRATCH_TAB = '_scratch_test';

function testSheetUtils() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const old = ss.getSheetByName(SCRATCH_TAB);
  if (old) ss.deleteSheet(old);

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

    Logger.log('testSheetUtils: PASS');
  } catch (e) {
    Logger.log('testSheetUtils: FAIL ' + (e && e.message ? e.message : e));
    throw e;
  } finally {
    const s = ss.getSheetByName(SCRATCH_TAB);
    if (s) ss.deleteSheet(s);
  }
}
