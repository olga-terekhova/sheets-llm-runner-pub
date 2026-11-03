/**
 * Tests_Writeback.gs - pure tests for planWriteback (Writeback.gs).
 * They run as part of runAllTests (Tests.gs). writeBackRows is exercised
 * against a real tab in testSheetUtils (Tests_Sheet.gs).
 */

function test_planWriteback_cells() {
  // A blank header cell (column C) keeps its position.
  const values = [
    ['ID', 'Company Name', '', 'HQ', 'Title'],
    ['', 'meta', '', '', ''],
    [101, 'Shopify', '', 'old', ''],
    [102, 'Wealthsimple', '', '', ''],
    ['', '', '', '', 'US companies'],
    [101, 'Stripe', '', '', '']
  ];
  const ds = { tabName: 'Src', keyColumn: 'ID', title: '' };
  const p = planWriteback(values, ds, [
    { rowKey: '102', values: { HQ: 'Toronto', Phone: '+1 555', Web: 'ws.com' } },
    { rowKey: 101, values: { HQ: 'Ottawa' } },
    { rowKey: '999', values: { HQ: 'x' } }
  ]);
  assertEqual_([p.addedColumns, p.headerColumn], [['Phone', 'Web'], 6], 'new columns right of the last header');
  assertEqual_(p.runs, [
    { row: 3, column: 4, values: ['Ottawa'] },
    { row: 4, column: 4, values: ['Toronto'] },
    { row: 4, column: 6, values: ['+1 555', 'ws.com'] }
  ], 'only mapped cells, contiguous columns merged, rows in sheet order');
  assertEqual_([p.cells, p.notFound], [4, ['999']], 'counts and keys not in the block');

  const us = planWriteback(values, { tabName: 'Src', keyColumn: 'ID', title: 'US companies' },
    [{ rowKey: 101, values: { HQ: 'SF' } }]);
  assertEqual_([us.runs, us.addedColumns, us.headerColumn], [[{ row: 6, column: 4, values: ['SF'] }], [], ''],
    'same key in another block: the titled block is used');

  const twice = planWriteback(values, ds, [{ rowKey: 101, values: { HQ: 'a' } }, { rowKey: 101, values: { HQ: 'b' } }]);
  assertEqual_(twice.runs, [{ row: 3, column: 4, values: ['b'] }], 'later row wins');
}

function test_planWriteback_errors() {
  const ds = { tabName: 'Src', keyColumn: 'ID', title: '' };
  assertThrows_(function () { planWriteback([['Id'], [1]], ds, []); }, 'key_column "ID" not found in tab "Src"', 'key column');
  assertThrows_(function () { planWriteback([['ID'], [1], [1]], ds, []); }, 'Duplicate key "1"', 'duplicate key');
  assertThrows_(function () { planWriteback([['ID', 'Title'], [1, '']], { tabName: 'Src', keyColumn: 'ID', title: 'X' }, []); },
    'heading row not found', 'heading gone');
}
