const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../server/index.js');

const GRANTS = [
  'db:own',
  'db:read:trips',
  'db:read:costs',
  'db:write:costs',
  'rates:read',
  'http:outbound',
];

const ALLOWED_REST_RE = /^\/api\/v1\/(accounts|categories|tags|transactions(\/[0-9a-zA-Z_-]+)?)$/;

// The Sure key is instance-scoped, so ledger routes require an admin.
const ADMIN = { id: 7, username: 'alice', isAdmin: true };

function attachRealSqlite(ctx) {
  const sqlite = new DatabaseSync(':memory:');
  const migrated = new Set();
  ctx.db = {
    async migrate(id, sql) {
      if (migrated.has(id)) return;
      sqlite.exec(sql);
      migrated.add(id);
    },
    async query(sql, ...args) {
      return sqlite.prepare(sql).all(...args);
    },
    async exec(sql, ...args) {
      const info = sqlite.prepare(sql).run(...args);
      return { changes: info.changes };
    },
    async tx(ops) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const op of ops) {
          const stmt = sqlite.prepare(op.sql);
          const args = op.args || [];
          if (/^\s*select\b/i.test(op.sql)) {
            results.push({ rows: stmt.all(...args) });
          } else {
            const info = stmt.run(...args);
            results.push({ changes: info.changes });
          }
        }
        sqlite.exec('COMMIT');
        return { results };
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return sqlite;
}

function toApiTxWire(tx, categories, tags, accounts) {
  const acc = (accounts || []).find((a) => a.name === tx.account || a.id === tx.account_id) ||
    (accounts || []).find((a) => (a.account_type || a.type || '').toLowerCase().includes('credit')) ||
    { id: 'acc-card-1', name: tx.account || 'Example Visa (4242)', account_type: 'credit_card' };
  const cat = tx.category
    ? ((categories || []).find((c) => c.name === tx.category || c.label === tx.category || c.name_with_parent === tx.category) || { id: `cat-${tx.category}`, name: tx.category, color: '#3b82f6', icon: 'tag' })
    : null;
  const tagObjs = (tx.tags || []).map((t) => {
    if (t && typeof t === 'object') return t;
    return (tags || []).find((x) => x.name === t) || { id: `tag-${t}`, name: String(t), color: '#7c3aed' };
  });
  const dec = Number(tx.amount_decimal ?? tx.amount).toFixed(4);
  const cls = tx.classification || 'expense';
  return {
    id: tx.id,
    entry_id: `entry-${tx.id}`,
    date: tx.date,
    // Formatted string on `amount` just like Sure's jbuilder (`-$83.20`) to prove we read `amount_decimal`!
    amount: `${cls === 'income' ? '+' : '-'}$${Number(tx.amount_decimal ?? tx.amount).toFixed(2)}`,
    amount_cents: Math.round(Math.abs(Number(tx.amount_decimal ?? tx.amount)) * (tx.currency === 'JPY' ? 1 : 100)),
    amount_decimal: cls === 'income' ? `-${dec}` : dec,
    currency: tx.currency || 'USD',
    name: tx.name,
    notes: tx.notes || null,
    classification: cls,
    kind: tx.kind || 'standard',
    excluded: Boolean(tx.excluded),
    split_parent: Boolean(tx.split_parent),
    account: {
      id: acc.id,
      name: acc.name,
      account_type: acc.account_type || 'credit_card',
    },
    category: cat ? { id: cat.id, name: cat.name, color: cat.color || '#3b82f6', icon: 'tag' } : null,
    merchant: tx.merchant ? { id: `m-${tx.id}`, name: tx.merchant } : null,
    tags: tagObjs,
    transfer: tx.is_transfer ? { id: `trf-${tx.id}`, amount: `$${tx.amount}`, currency: tx.currency || 'USD' } : null,
  };
}

function makeSureFetchMock(state, expectedOrigin = 'http://sure:3000') {
  const calls = [];
  const fn = async (rawUrl, init = {}) => {
    const u = new URL(String(rawUrl));
    const method = String(init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    calls.push({ url: u.href, origin: u.origin, pathname: u.pathname, searchParams: u.searchParams, method, headers });

    assert.equal(method, 'GET', 'Plugin must only issue GET requests to Sure REST API');
    assert.equal(init.redirect, 'error', 'never follow a redirect: undici forwards x-api-key across origins');
    assert.equal(u.origin, expectedOrigin);
    assert.match(u.pathname, ALLOWED_REST_RE);

    if (headers['x-api-key'] !== 'secret-sure-api-key') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }

    if (u.pathname === '/api/v1/accounts') {
      return new Response(
        JSON.stringify({
          accounts: state.accounts,
          pagination: { page: 1, per_page: 100, total_count: state.accounts.length, total_pages: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.pathname === '/api/v1/categories') {
      return new Response(
        JSON.stringify({
          categories: state.categories,
          pagination: { page: 1, per_page: 100, total_count: state.categories.length, total_pages: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.pathname === '/api/v1/tags') {
      // Matches Sure's TagsController#index returning a bare JSON array!
      return new Response(JSON.stringify(state.tags), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname.startsWith('/api/v1/transactions/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/v1/transactions/'.length));
      const found = state.transactions.find((t) => t.id === id);
      if (!found) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response(
        JSON.stringify(toApiTxWire(found, state.categories, state.tags, state.accounts)),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.pathname === '/api/v1/transactions') {
      const sp = u.searchParams;
      const accountIds = sp.getAll('account_ids[]');
      const categoryIds = sp.getAll('category_ids[]');
      const tagIds = sp.getAll('tag_ids[]');
      const startDate = sp.get('start_date');
      const endDate = sp.get('end_date');
      const search = sp.get('search');
      const type = sp.get('type');
      const perPage = Number(sp.get('per_page')) || 100;
      const page = Number(sp.get('page')) || 1;

      const wired = state.transactions.map((t) => toApiTxWire(t, state.categories, state.tags, state.accounts));
      const filtered = wired.filter((w) => {
        if (accountIds.length > 0 && !accountIds.includes(w.account.id)) return false;
        if (startDate && w.date < startDate) return false;
        if (endDate && w.date > endDate) return false;
        if (type === 'expense' && w.classification !== 'expense') return false;
        if (search && !String(w.name || '').toLowerCase().includes(search.toLowerCase())) return false;
        if (categoryIds.length > 0 && (!w.category || !categoryIds.includes(w.category.id))) return false;
        if (tagIds.length > 0 && !w.tags.some((t) => tagIds.includes(t.id))) return false;
        return true;
      });
      const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
      const slice = filtered.slice((page - 1) * perPage, page * perPage);
      return new Response(
        JSON.stringify({
          transactions: slice,
          pagination: { page, per_page: perPage, total_count: filtered.length, total_pages: totalPages },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected Sure REST path: ${u.pathname}`);
  };
  return { fetchMock: fn, calls };
}

function buildHarness(overrides = {}) {
  plugin._clearMetaCache();
  const sureState = {
    accounts: overrides.accounts || [
      { id: 'acc-card-1', name: 'Example Visa (4242)', account_type: 'credit_card', classification: 'liability', status: 'active', currency: 'USD' },
      { id: 'acc-card-hk', name: 'Sample Mastercard (5454)', account_type: 'credit_card', classification: 'liability', status: 'active', currency: 'HKD' },
      { id: 'acc-brokerage', name: 'Brokerage', account_type: 'investment', classification: 'asset', status: 'active', currency: 'HKD' },
    ],
    categories: overrides.categories || [
      { id: 'c1', name: 'Travel', parent: null, color: '#3b82f6' },
      { id: 'c-food', name: 'Food', parent: null, color: '#e99537' },
      { id: 'c2', name: 'Dining & Delivery', parent: { id: 'c-food', name: 'Food' }, color: '#e99537' },
    ],
    tags: overrides.tags || [
      { id: 't1', name: 'tokyo-2026', color: '#7c3aed' },
      { id: 't2', name: 'reimbursable', color: '#059669' },
    ],
    transactions: overrides.transactions || [
      { id: 'tx-pre-flight', name: 'JAPAN AIRLINES JL 26', date: '2026-04-12', amount: '83.20', currency: 'USD', classification: 'expense', kind: 'one_time', is_transfer: false, account: 'Example Visa (4242)', category: 'Travel', tags: ['tokyo-2026'] },
      { id: 'tx-1', name: 'Uber Tokyo', date: '2026-09-23', amount: '33.54', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Travel', tags: [] },
      { id: 'tx-2', name: 'OpenAI', date: '2026-09-24', amount: '22.08', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: null, tags: [] },
      { id: 'tx-3', name: 'Ramen Ichiran', date: '2026-09-20', amount: '15.00', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Sample Mastercard (5454)', category: 'Dining & Delivery', tags: ['tokyo-2026'] },
      { id: 'tx-split-parent', name: 'Split Receipt Parent', date: '2026-09-22', amount: '99.00', currency: 'USD', classification: 'expense', split_parent: true, excluded: true, is_transfer: false, account: 'Example Visa (4242)', category: 'Travel', tags: [] },
      { id: 'tx-brokerage-div', name: 'Brokerage Dividend', date: '2026-09-22', amount: '50.00', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Brokerage', account_id: 'acc-brokerage', category: null, tags: [] },
    ],
  };

  const tripData = overrides.trip || {
    id: 1,
    title: 'Japan in September',
    start_date: '2026-09-18',
    end_date: '2026-09-27',
    currency: 'HKD',
  };

  const initialCosts = overrides.costs ? [...overrides.costs] : [];
  const host = createMockHost({
    grants: overrides.grants || GRANTS,
    actingUserId: overrides.actingUserId ?? 7,
    config: overrides.config || {
      sure_url: 'http://sure:3000',
      sure_api_key: 'secret-sure-api-key',
    },
    declaredActions: [{ key: 'test_connection', scope: 'instance' }],
    trips: overrides.trips || {
      1: {
        members: [7, 8],
        data: tripData,
        costs: initialCosts,
        reservations: overrides.reservations || [
          { id: 10, title: 'JL 26 — HKG → HND', type: 'flight', confirmation_number: 'JOZKWO', metadata: '{"airline":"Japan Airlines","flight_number":"JL 26"}' },
        ],
        places: overrides.places || [
          { id: 20, name: 'Ichiran Shibuya', category: 'food' },
        ],
      },
    },
  });

  // Ledger routes require an admin; default the acting user so tests don't repeat it.
  const runWithAdmin = host.run.bind(host);
  host.run = (def) => {
    const app = runWithAdmin(def);
    const route = app.route.bind(app);
    app.route = (spec, opts = {}) => route(spec, { user: ADMIN, ...opts });
    return app;
  };

  const sqlite = attachRealSqlite(host.ctx);
  const ratesTable = overrides.rates !== undefined ? overrides.rates : { HKD: { USD: 0.128, JPY: 20 } };
  host.ctx.rates = {
    async get(base) {
      return (ratesTable && ratesTable[base]) || null;
    },
  };
  if (overrides.forbidBudgetEdit) {
    host.ctx.costs.create = async () => {
      throw new Error('PERMISSION_DENIED: no permission to edit costs on trip 1');
    };
  }
  if (overrides.costsAddonOff) {
    host.ctx.costs.getByTrip = async () => {
      throw new Error('RESOURCE_FORBIDDEN: Costs addon is disabled');
    };
  }

  return { host, sqlite, sureState };
}

test('pre-trip date/name/category/tag search, booking/place correlation, native currency import, and dynamic drift span', async (t) => {
  const { host, sureState } = buildHarness();
  const { fetchMock, calls } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  const actRes = await app.action('test_connection');
  assert.equal(actRes.ok, true);
  assert.match(actRes.message, /2 credit card\(s\), 3 categories, 2 tags/);

  // 1) Default trip window excludes April flight, split_parent, and non-card brokerage row; includes both US & HKD cards.
  const candDefault = await app.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' } });
  const defBody = JSON.parse(candDefault.body);
  assert.equal(defBody.candidates.length, 3);
  assert.equal(defBody.sureCategories.length, 3);
  assert.equal(defBody.sureTags.length, 2);
  // Ramen Ichiran matches Trip Place "Ichiran Shibuya"!
  const ramen = defBody.candidates.find((c) => c.id === 'tx-3');
  assert.equal(ramen.planMatch.title, 'Ichiran Shibuya');

  // 2) Filter across allDates=1 + tag=tokyo-2026 finds BOTH pre-booked April flight AND Sep ramen!
  const candByTag = await app.route(
    { method: 'GET', path: '/candidates' },
    { query: { tripId: '1', allDates: '1', tag: 'tokyo-2026' } }
  );
  const tagBody = JSON.parse(candByTag.body);
  assert.equal(tagBody.candidates.length, 2);
  const flight = tagBody.candidates.find((c) => c.id === 'tx-pre-flight');
  assert.ok(flight);
  // Pre-booked flight correlates to reservation "JL 26 — HKG → HND" and upgrades category to `flights`!
  assert.equal(flight.planMatch.title, 'JL 26 — HKG → HND');
  assert.equal(flight.trekCategory, 'flights');

  // 3) Filter by category + name search
  const candBySearch = await app.route(
    { method: 'GET', path: '/candidates' },
    { query: { tripId: '1', startDate: '2026-04-01', endDate: '2026-09-30', category: 'Travel', search: 'japan' } }
  );
  const searchBody = JSON.parse(candBySearch.body);
  assert.deepEqual(searchBody.candidates.map((c) => c.id), ['tx-pre-flight']);

  // 4) Import the April pre-booked flight + Sep Uber in native USD currency
  const impRes = await app.route(
    { method: 'POST', path: '/import' },
    {
      body: {
        tripId: 1,
        transactionIds: ['tx-pre-flight', 'tx-1'],
        filters: { allDates: true, tag: 'tokyo-2026' },
      },
      user: ADMIN,
    }
  );
  assert.equal(impRes.status, 201);
  const impBody = JSON.parse(impRes.body);
  assert.equal(impBody.imported.length, 2);
  assert.equal(impBody.imported[0].totalPrice, 83.2);
  assert.equal(impBody.imported[0].itemCurrency, 'USD');

  // 5) Direct REST lookup verifies both the April 2026 pre-booked flight and Sep Uber without buffered window scans!
  const driftRes = await app.route({ method: 'GET', path: '/imports' }, { query: { tripId: '1' } });
  const driftBody = JSON.parse(driftRes.body);
  assert.equal(driftBody.lookup.mode, 'direct-id');
  assert.equal(driftBody.lookup.checkedCount, 2);
  assert.ok(driftBody.imports.every((r) => r.status === 'ok'));

  // 6) Re-submit is idempotent, and every outbound call was a GET to /api/v1/*
  const dupSubmit = await app.route(
    { method: 'POST', path: '/import' },
    { body: { tripId: 1, transactionIds: ['tx-1'] }, user: ADMIN }
  );
  assert.equal(JSON.parse(dupSubmit.body).alreadyImported.length, 1);

  assert.ok(calls.every((c) => c.method === 'GET' && ALLOWED_REST_RE.test(c.pathname)));
});

test('multi-signal cost correlation: blocks exact & pre-booked named matches, hints on partial matches, preserves TREK-only items', async (t) => {
  const prebookedHotelInTrek = {
    id: 100,
    trip_id: 1,
    name: 'TABI UENO Hotel',
    category: 'accommodation',
    total_price: 14835.51,
    currency: 'HKD',
    exchange_rate: 1,
    expense_date: '2026-09-25', // Trip date in TREK, whereas card was charged in June!
    payers: [],
    members: [],
  };
  const partnerItem = {
    id: 101,
    trip_id: 1,
    name: 'Partner Hotel Paid',
    category: 'accommodation',
    total_price: 1800,
    currency: 'HKD',
    exchange_rate: 1,
    expense_date: '2026-09-21',
    payers: [{ user_id: 8, amount: 1800 }],
    members: [{ user_id: 7, amount: null }, { user_id: 8, amount: null }],
  };

  const { host, sureState } = buildHarness({
    costs: [prebookedHotelInTrek, partnerItem],
    transactions: [
      // 1898.95 USD / 0.128 = 14,835.55 HKD (within 0.01%!), charged 3 months earlier with matching token "tabi"
      { id: 'tx-hotel-full', name: 'TABI UENO RESERVATION', date: '2026-06-10', amount: '1898.95', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Travel' },
      // Small minibar charge at same hotel -> non-blocking `costHint` (selectable without override!)
      { id: 'tx-hotel-mini', name: 'TABI UENO MINIBAR', date: '2026-09-22', amount: '12.83', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Food' },
    ],
  });
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  const candRes = await app.route(
    { method: 'GET', path: '/candidates' },
    { query: { tripId: '1', startDate: '2026-06-01', endDate: '2026-09-30' } }
  );
  const candBody = JSON.parse(candRes.body);
  const full = candBody.candidates.find((c) => c.id === 'tx-hotel-full');
  const mini = candBody.candidates.find((c) => c.id === 'tx-hotel-mini');

  // Pre-booked hotel full charge is caught by name + FX amount even 3 months before trip!
  assert.equal(full.duplicateOf.id, 100);
  assert.match(full.duplicateOf.reason, /pre-booked/);
  // Minibar charge gets a helpful non-blocking `costHint`, NOT blocked!
  assert.equal(mini.duplicateOf, null);
  assert.equal(mini.costHint.id, 100);

  const blocked = await app.route(
    { method: 'POST', path: '/import' },
    { body: { tripId: 1, transactionIds: ['tx-hotel-full'], filters: { startDate: '2026-06-01', endDate: '2026-09-30' } } }
  );
  assert.equal(JSON.parse(blocked.body).blockedDuplicates.length, 1);

  const allowed = await app.route(
    { method: 'POST', path: '/import' },
    {
      body: {
        tripId: 1,
        transactionIds: ['tx-hotel-full', 'tx-hotel-mini'],
        overrideDuplicateIds: ['tx-hotel-full'],
        filters: { startDate: '2026-06-01', endDate: '2026-09-30' },
      },
    }
  );
  assert.equal(allowed.status, 201);
  const allItems = await host.ctx.costs.getByTrip(1);
  assert.equal(allItems.length, 4);
  assert.deepEqual(allItems.find((i) => i.id === 101).payers, [{ user_id: 8, amount: 1800 }]);
});

test('drift reconciliation (changed, not-expense, missing, edited-in-trek), pagination >100, ±60d buffer, and unlink', async (t) => {
  const filler = Array.from({ length: 125 }, (_, i) => ({
    id: `tx-fill-${i}`,
    name: `Snack ${i}`,
    date: '2026-09-22',
    amount: '5.00',
    currency: 'USD',
    classification: 'expense',
    is_transfer: false,
    account: 'Example Visa (4242)',
  }));
  const { host, sureState } = buildHarness({
    transactions: [
      { id: 'tx-del', name: 'Cashier A', date: '2026-09-20', amount: '10.00', currency: 'USD', classification: 'expense', is_transfer: false },
      { id: 'tx-chg', name: 'OpenAI', date: '2026-09-21', amount: '22.08', currency: 'USD', classification: 'expense', is_transfer: false },
      { id: 'tx-trf', name: 'Card Autopay', date: '2026-09-22', amount: '50.00', currency: 'USD', classification: 'expense', is_transfer: false },
      { id: 'tx-trk', name: 'Dinner', date: '2026-09-23', amount: '40.00', currency: 'USD', classification: 'expense', is_transfer: false },
      { id: 'tx-redate', name: 'Hotel Deposit', date: '2026-09-19', amount: '100.00', currency: 'USD', classification: 'expense', is_transfer: false },
      ...filler,
    ],
  });
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  await app.route(
    { method: 'POST', path: '/import' },
    { body: { tripId: 1, transactionIds: ['tx-del', 'tx-chg', 'tx-trf', 'tx-trk', 'tx-redate'] } }
  );

  sureState.transactions = sureState.transactions.filter((x) => x.id !== 'tx-del');
  const chg = sureState.transactions.find((x) => x.id === 'tx-chg');
  chg.name = 'OPENAI CHATGPT SUBSCR';
  chg.amount = '24.00';
  sureState.transactions.find((x) => x.id === 'tx-trf').is_transfer = true;
  sureState.transactions.find((x) => x.id === 'tx-redate').date = '2026-08-20';
  const items = await host.ctx.costs.getByTrip(1);
  const trkItem = items.find((i) => i.name === 'Dinner');
  await host.ctx.costs.update(1, trkItem.id, { total_price: 999, payers: [{ user_id: 7, amount: 999 }] });

  const impRes = await app.route({ method: 'GET', path: '/imports' }, { query: { tripId: '1' } });
  assert.equal(impRes.status, 200);
  const impBody = JSON.parse(impRes.body);
  assert.equal(impBody.lookup.checkedCount, 5);

  const bySure = Object.fromEntries(impBody.imports.map((r) => [r.sureTransactionId, r]));
  assert.equal(bySure['tx-del'].status, 'missing');
  assert.equal(bySure['tx-chg'].status, 'changed');
  assert.equal(bySure['tx-chg'].canRefresh, true);
  assert.equal(bySure['tx-trf'].status, 'not-expense');
  assert.equal(bySure['tx-trf'].canRefresh, false);
  assert.equal(bySure['tx-trk'].status, 'edited-in-trek');
  assert.equal(bySure['tx-trk'].canRefresh, false);
  assert.equal(bySure['tx-redate'].status, 'changed');

  const refTrf = await app.route({ method: 'POST', path: '/imports/refresh' }, { body: { tripId: 1, id: bySure['tx-trf'].id } });
  assert.equal(refTrf.status, 409);
  const refTrk = await app.route({ method: 'POST', path: '/imports/refresh' }, { body: { tripId: 1, id: bySure['tx-trk'].id } });
  assert.equal(refTrk.status, 409);

  const refChg = await app.route({ method: 'POST', path: '/imports/refresh' }, { body: { tripId: 1, id: bySure['tx-chg'].id } });
  assert.equal(refChg.status, 200);
  const updatedOpenAi = (await host.ctx.costs.getByTrip(1)).find((i) => i.id === bySure['tx-chg'].budgetItemId);
  assert.equal(updatedOpenAi.name, 'OPENAI CHATGPT SUBSCR');
  assert.equal(updatedOpenAi.total_price, 24);
  assert.equal(updatedOpenAi.currency, 'USD');

  const countBeforeUnlink = (await host.ctx.costs.getByTrip(1)).length;
  const unl = await app.route(
    { method: 'DELETE', path: '/imports' },
    { query: { tripId: '1', id: String(bySure['tx-del'].id), deleteBudgetItem: 'false' } }
  );
  assert.equal(unl.status, 200);
  assert.equal((await host.ctx.costs.getByTrip(1)).length, countBeforeUnlink);
});

test('pinned selections from a far-off search import on their own dates', async (t) => {
  const { host, sureState } = buildHarness({
    transactions: [
      // Booked nearly three years before the trip, far outside any trip-derived fallback window.
      { id: 'tx-ancient-hotel', name: 'HOSHINOYA Deposit', date: '2023-11-02', amount: '410.00', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Travel' },
      { id: 'tx-near', name: 'Uber Tokyo', date: '2026-09-23', amount: '33.54', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Travel' },
    ],
  });
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  // Default trip window must not see the 2023 charge.
  const candRes = await app.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' } });
  assert.deepEqual(JSON.parse(candRes.body).candidates.map((c) => c.id), ['tx-near']);

  // Pinned alongside a trip-window row, the 2023 row is fetched by its own date and imported.
  const impRes = await app.route(
    { method: 'POST', path: '/import' },
    {
      body: {
        tripId: 1,
        transactionIds: ['tx-ancient-hotel', 'tx-near'],
        selectionDates: ['2023-11-02', '2026-09-23'],
        filters: { startDate: '2026-09-18', endDate: '2026-09-27' },
      },
    }
  );
  assert.equal(impRes.status, 201);
  const impBody = JSON.parse(impRes.body);
  assert.equal(impBody.imported.length, 2);

  const ancient = impBody.imported.find((i) => i.sureTransactionId === 'tx-ancient-hotel');
  const trekItems = await host.ctx.costs.getByTrip(1);
  const ancientItem = trekItems.find((i) => i.id === ancient.budgetItemId);
  assert.equal(ancientItem.expense_date, '2023-11-02');
  assert.equal(ancientItem.currency, 'USD');
});

test('explicit refusals: missing token, viewer without budget_edit, Costs addon off', async (t) => {
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not call fetch'); };
  t.after(() => { globalThis.fetch = origFetch; });

  const noUrl = buildHarness({ config: { sure_url: '', sure_api_key: 'secret-sure-api-key' } });
  await plugin.onLoad(noUrl.host.ctx);
  const noUrlApp = noUrl.host.run(plugin);
  const r0 = await noUrlApp.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' } });
  assert.equal(r0.status, 412);
  assert.equal(JSON.parse(r0.body).code, 'MISSING_SURE_URL');

  const noTok = buildHarness({ config: { sure_url: 'https://sure.example.com', sure_api_key: '' } });
  await plugin.onLoad(noTok.host.ctx);
  const noTokApp = noTok.host.run(plugin);
  const r1 = await noTokApp.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' } });
  assert.equal(r1.status, 412);
  assert.equal(fetchCalled, false);
  const viewer = buildHarness({ forbidBudgetEdit: true });
  const { fetchMock } = makeSureFetchMock(viewer.sureState);
  globalThis.fetch = fetchMock;
  await plugin.onLoad(viewer.host.ctx);
  const viewerApp = viewer.host.run(plugin);
  const r2 = await viewerApp.route({ method: 'POST', path: '/import' }, { body: { tripId: 1, transactionIds: ['tx-1'] }, user: { id: 9, username: 'viewer', isAdmin: true } });
  assert.equal(r2.status, 403);
  assert.equal(JSON.parse(r2.body).code, 'NO_BUDGET_EDIT');

  const noAddon = buildHarness({ costsAddonOff: true });
  await plugin.onLoad(noAddon.host.ctx);
  const noAddonApp = noAddon.host.run(plugin);
  const r3 = await noAddonApp.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' } });
  assert.equal(r3.status, 403);
  assert.equal(JSON.parse(r3.body).code, 'COSTS_ADDON_OFF');
});

test('intelligent replace: matches guesstimate, preserves title/links/notes, rescales uneven split with cent accuracy, resets base FX, and supports drift refresh', async (t) => {
  const dinnerEstimate = {
    id: 201,
    trip_id: 1,
    name: 'Dinner with friends',
    category: 'food',
    total_price: 450,
    currency: 'HKD',
    exchange_rate: 1,
    expense_date: '2026-09-21',
    note: 'Birthday dinner',
    place_id: 20,
    payers: [{ user_id: 8, username: 'bob', amount: 450 }],
    members: [
      { user_id: 7, username: 'alice', amount: 270, paid: 1 },
      { user_id: 8, username: 'bob', amount: 180, paid: 0 },
    ],
  };
  const usdEstimate = {
    id: 202,
    trip_id: 1,
    name: 'Airport bus estimate',
    category: 'transport',
    total_price: 20,
    currency: 'USD',
    exchange_rate: 0.128,
    expense_date: null,
    payers: [],
    members: [
      { user_id: 7, username: 'alice', amount: null },
      { user_id: 8, username: 'bob', amount: null },
    ],
  };
  const bigHotel = {
    id: 203,
    trip_id: 1,
    name: 'Park Hyatt Tokyo',
    category: 'accommodation',
    total_price: 15000,
    currency: 'HKD',
    exchange_rate: 1,
    expense_date: '2026-09-22',
    payers: [],
    members: [],
  };

  const { host, sureState } = buildHarness({
    costs: [dinnerEstimate, usdEstimate, bigHotel],
    transactions: [
      { id: 'tx-yakiniku', name: 'KABUKICHO YAKINIKU', date: '2026-09-21', amount: '63.11', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Food & Dining' },
      { id: 'tx-hyatt-mini', name: 'PARK HYATT MINIBAR', date: '2026-09-22', amount: '9.50', currency: 'USD', classification: 'expense', is_transfer: false, account: 'Example Visa (4242)', category: 'Food & Dining' },
      { id: 'tx-hkd-bus', name: 'CITYFLYER A21', date: '2026-09-20', amount: '150.00', currency: 'HKD', classification: 'expense', is_transfer: false, account: 'Example Debit Visa (1111)', category: 'Transport' },
    ],
  });
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  // 1) Guesstimate dinner matches by category + date + ~amount; $9.50 minibar does NOT suggest replacing $15,000 hotel
  const candRes = await app.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' }, user: ADMIN });
  const candBody = JSON.parse(candRes.body);
  assert.equal(candBody.replaceableTargets.length, 3);
  const yakiniku = candBody.candidates.find((c) => c.id === 'tx-yakiniku');
  assert.equal(yakiniku.replaceSuggestion.targetId, 201);
  const minibar = candBody.candidates.find((c) => c.id === 'tx-hyatt-mini');
  assert.equal(minibar.replaceSuggestion, null);
  assert.equal(minibar.costHint.id, 203);

  // 2) Replace dinnerEstimate (60% / 40% custom split on 63.11 USD -> 37.87 + 25.24 = 63.11)
  const repRes = await app.route(
    { method: 'POST', path: '/imports/replace' },
    {
      body: { tripId: 1, transactionId: 'tx-yakiniku', budgetItemId: 201 },
      user: ADMIN,
    }
  );
  assert.equal(repRes.status, 200);
  const repBody = JSON.parse(repRes.body);
  assert.equal(repBody.replaced, true);
  assert.equal(repBody.name, 'Dinner with friends');
  assert.deepEqual(
    repBody.splitRescaled.map((s) => ({ user_id: s.user_id, afterAmount: s.afterAmount })),
    [{ user_id: 7, afterAmount: 37.87 }, { user_id: 8, afterAmount: 25.24 }]
  );

  const itemsAfter = await host.ctx.costs.getByTrip(1);
  const updatedDinner = itemsAfter.find((i) => i.id === 201);
  assert.equal(updatedDinner.name, 'Dinner with friends');
  assert.equal(updatedDinner.category, 'food');
  assert.equal(updatedDinner.place_id, 20);
  assert.equal(updatedDinner.total_price, 63.11);
  assert.equal(updatedDinner.currency, 'USD');
  assert.match(updatedDinner.note, /^Birthday dinner\nsure:tx-yakiniku · 63\.11 USD$/);
  assert.deepEqual(updatedDinner.payers, [{ user_id: 7, amount: 63.11 }]);
  assert.deepEqual(updatedDinner.members, [
    { user_id: 7, amount: 37.87 },
    { user_id: 8, amount: 25.24 },
  ]);

  // 3) Refuses replacing an already-mapped item
  const dupTargetRes = await app.route(
    { method: 'POST', path: '/imports/replace' },
    { body: { tripId: 1, transactionId: 'tx-hkd-bus', budgetItemId: 201 }, user: ADMIN }
  );
  assert.equal(dupTargetRes.status, 409);
  assert.equal(JSON.parse(dupTargetRes.body).code, 'TARGET_ALREADY_MAPPED');

  // 4) Replacing a USD estimate with an HKD (trip base) charge resets exchange_rate to 1 and leaves equal split untouched
  const busRepRes = await app.route(
    { method: 'POST', path: '/imports/replace' },
    { body: { tripId: 1, transactionId: 'tx-hkd-bus', budgetItemId: 202 }, user: ADMIN }
  );
  assert.equal(busRepRes.status, 200);
  const updatedBus = (await host.ctx.costs.getByTrip(1)).find((i) => i.id === 202);
  assert.equal(updatedBus.currency, 'HKD');
  assert.equal(updatedBus.exchange_rate, 1);
  assert.equal(updatedBus.expense_date, '2026-09-20');
  assert.ok(updatedBus.members.every((m) => m.amount === null));

  // 5) Drift check on replaced custom-split item is `ok`, and Sure settlement change refreshes amount + custom shares while keeping TREK title!
  const imp1 = JSON.parse((await app.route({ method: 'GET', path: '/imports' }, { query: { tripId: '1' } })).body);
  const dinnerMap = imp1.imports.find((r) => r.budgetItemId === 201);
  assert.equal(dinnerMap.status, 'ok');

  sureState.transactions[0].amount = '65.00';
  sureState.transactions[0].name = 'KABUKICHO YAKINIKU SETTLED';
  const imp2 = JSON.parse((await app.route({ method: 'GET', path: '/imports' }, { query: { tripId: '1' } })).body);
  const dinnerChanged = imp2.imports.find((r) => r.budgetItemId === 201);
  assert.equal(dinnerChanged.status, 'changed');
  assert.equal(dinnerChanged.canRefresh, true);

  const refRes = await app.route(
    { method: 'POST', path: '/imports/refresh' },
    { body: { tripId: 1, id: dinnerChanged.id }, user: ADMIN }
  );
  assert.equal(refRes.status, 200);
  const refreshedDinner = (await host.ctx.costs.getByTrip(1)).find((i) => i.id === 201);
  assert.equal(refreshedDinner.name, 'Dinner with friends');
  assert.equal(refreshedDinner.total_price, 65);
  assert.deepEqual(refreshedDinner.members, [
    { user_id: 7, amount: 39 },
    { user_id: 8, amount: 26 },
  ]);

  const imp3 = JSON.parse((await app.route({ method: 'GET', path: '/imports' }, { query: { tripId: '1' } })).body);
  assert.equal(imp3.imports.find((r) => r.budgetItemId === 201).status, 'ok');
});

test('remote HTTPS endpoint (https://sure.example.com) and URL normalization work for any operator hostname', async (t) => {
  assert.deepEqual(plugin.normalizeSureBaseUrl('https://sure.example.com'), {
    baseUrl: 'https://sure.example.com',
    host: 'sure.example.com',
  });
  assert.deepEqual(plugin.normalizeSureBaseUrl('https://sure.example.com/api/v1/'), {
    baseUrl: 'https://sure.example.com',
    host: 'sure.example.com',
  });
  assert.deepEqual(plugin.normalizeSureBaseUrl('http://sure:3000/mcp'), {
    baseUrl: 'http://sure:3000',
    host: 'sure',
  });

  const { host, sureState } = buildHarness({
    grants: [...GRANTS, 'http:outbound:sure.example.com'],
    config: {
      sure_url: 'https://sure.example.com/',
      sure_api_key: 'secret-sure-api-key',
    },
  });
  const { fetchMock, calls } = makeSureFetchMock(sureState, 'https://sure.example.com');
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);
  const act = await app.action('test_connection');
  assert.equal(act.ok, true);
  assert.match(act.message, /https:\/\/sure\.example\.com/);
  assert.ok(calls.every((c) => c.origin === 'https://sure.example.com' && c.method === 'GET'));
});

test('cross-trip privacy: a foreign import is flagged without revealing the other trip\'s ids', async (t) => {
  const trip1 = { id: 1, title: 'Japan in September', start_date: '2026-09-18', end_date: '2026-09-27', currency: 'HKD' };
  const trip2 = { id: 2, title: 'Weekend in Taipei', start_date: '2026-09-18', end_date: '2026-09-27', currency: 'HKD' };
  const cost1 = { id: 9001, trip_id: 1, name: 'OpenAI', category: 'other', total_price: 22.08, currency: 'USD', exchange_rate: 1, expense_date: '2026-09-24', payers: [], members: [] };
  const cost2 = { id: 9002, trip_id: 2, name: 'Rail', category: 'transport', total_price: 20, currency: 'HKD', exchange_rate: 1, expense_date: '2026-09-24', payers: [], members: [] };
  const { host, sureState } = buildHarness({
    trips: {
      1: { members: [7, 8], data: trip1, costs: [cost1] },
      2: { members: [7, 9], data: trip2, costs: [cost2] },
    },
  });
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);

  const first = await app.route({ method: 'POST', path: '/import' }, { body: { tripId: 1, transactionIds: ['tx-1'] }, user: ADMIN });
  assert.equal(first.status, 201);

  // User 7 also belongs to trip 2: the same charge is offered there, but only as a flag.
  const cand = await app.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '2' }, user: ADMIN });
  const foreign = JSON.parse(cand.body).candidates.find((c) => c.id === 'tx-1');
  assert.equal(foreign.mappedInOtherTrip, true);
  assert.equal('mappedOtherTripId' in foreign, false);
  assert.ok(!cand.body.includes('9001'), 'foreign budget item id must not reach the client');

  // Re-importing there is refused without naming trip 1 or its budget item.
  const dup = await app.route({ method: 'POST', path: '/import' }, { body: { tripId: 2, transactionIds: ['tx-1'] }, user: ADMIN });
  const dupBody = JSON.parse(dup.body);
  assert.equal(dupBody.alreadyImported.length, 1);
  assert.equal(dupBody.alreadyImported[0].tripId, null);
  assert.equal(dupBody.alreadyImported[0].budgetItemId, null);
  assert.ok(!dup.body.includes('9001'));

  // The replace route refuses the same way, with no trip number in the message.
  const rep = await app.route({ method: 'POST', path: '/imports/replace' }, { body: { tripId: 2, transactionId: 'tx-1', budgetItemId: 9002 }, user: ADMIN });
  assert.equal(rep.status, 409);
  assert.match(JSON.parse(rep.body).error, /another trip/);
  assert.doesNotMatch(JSON.parse(rep.body).error, /#\d|trip \d/);
});

test('security guards: ledger routes refuse non-admins, imports are capped, odd merchant names never throw', async (t) => {
  const { host, sureState } = buildHarness();
  const { fetchMock } = makeSureFetchMock(sureState);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  t.after(() => { globalThis.fetch = origFetch; });

  await plugin.onLoad(host.ctx);
  const app = host.run(plugin);
  const member = { id: 8, username: 'bob', isAdmin: false };

  const cand = await app.route({ method: 'GET', path: '/candidates' }, { query: { tripId: '1' }, user: member });
  assert.equal(cand.status, 403);
  assert.equal(JSON.parse(cand.body).code, 'ADMIN_ONLY');

  const imp = await app.route({ method: 'POST', path: '/import' }, { body: { tripId: 1, transactionIds: ['tx-1'] }, user: member });
  assert.equal(imp.status, 403);
  assert.equal(JSON.parse(imp.body).code, 'ADMIN_ONLY');

  const tooMany = await app.route(
    { method: 'POST', path: '/import' },
    { body: { tripId: 1, transactionIds: Array.from({ length: 26 }, (_, i) => `tx-bulk-${i}`) } }
  );
  assert.equal(tooMany.status, 400);
  assert.match(JSON.parse(tooMany.body).error, /at most 25/);

  // 'constructor' is a token, not a prototype key: correlation must not throw.
  assert.doesNotThrow(() =>
    plugin.correlateCandidate(
      { name: 'Constructor University', amount: 1, currency: 'USD', date: '2026-01-01' },
      [],
      [],
      'USD',
      null
    )
  );
});
