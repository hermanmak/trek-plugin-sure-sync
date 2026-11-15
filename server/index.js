// Built plugin entry — runs in an isolated child process.
// One-way Sure -> TREK trip expense importer: native currency, pre-trip filters (date/name/category/tag),
// multi-signal TREK cost & booking/place correlation, 1:1 SQLite identity, and drift checks.
const { definePlugin } = require('trek-plugin-sdk');

const ALLOWED_REST_PATH_RE = /^\/api\/v1\/(accounts|categories|tags|transactions(\/[0-9a-zA-Z_-]+)?)$/;
const TRANSFER_KINDS = new Set(['funds_movement', 'cc_payment']);
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_UNBOUNDED_PAGES = 5;
const META_TTL_MS = 60 * 1000;
const DIRECT_LOOKUP_CONCURRENCY = 6;

// Short-lived in-memory cache for Sure metadata (accounts, categories, tags) keyed by baseUrl.
const metaCache = new Map();

const NOISE_TOKENS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'via', 'inc', 'ltd', 'llc', 'corp', 'co',
  'com', 'www', 'http', 'https', 'help', 'pay', 'payee', 'payment', 'pos', 'purchase',
  'card', 'visa', 'mastercard', 'amex', 'alipay', 'alipayhk', 'kpay', 'merchant',
  'tokyo', 'japan', 'hong', 'kong', 'hkg', 'islands', 'island', 'city', 'ward', 'ku',
  'shibuya', 'shinjuku', 'ginza', 'ueno', 'asakusa', 'narita', 'haneda',
  'store', 'shop', 'market', 'restaurant', 'cafe', 'bar', 'hotel', 'stay', 'booking',
  'trip', 'travel', 'ticket', 'tickets', 'online', 'official',
]);

// Null-prototype so a token like "constructor" can never resolve to an inherited member.
const TOKEN_ALIASES = Object.assign(Object.create(null), {
  jal: ['jl', 'japanairlines'],
  jl: ['jal', 'japanairlines'],
  cathay: ['cx', 'cathaypacific'],
  cx: ['cathay', 'cathaypacific'],
  hkexpress: ['uo'],
  uo: ['hkexpress'],
  skyliner: ['keisei'],
  keisei: ['skyliner'],
  disney: ['disneysea', 'disneyland'],
  disneysea: ['disney'],
});

class PluginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(status, data) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

function parseBody(body) {
  if (body == null) return {};
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof body === 'object' ? body : {};
}

function normalizeCurrency(code) {
  const s = String(code || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : '';
}

function normalizeDate(value) {
  const s = String(value || '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function addDays(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function daysBetween(ymdA, ymdB) {
  const [y1, m1, d1] = ymdA.split('-').map(Number);
  const [y2, m2, d2] = ymdB.split('-').map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / 86400000);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function formatMoneyNum(n) {
  return Number(n).toFixed(2);
}

function mapCategory(sureCategory, planType) {
  if (planType === 'flight') return 'flights';
  if (planType === 'hotel' || planType === 'accommodation' || planType === 'lodging') return 'accommodation';
  if (planType === 'train' || planType === 'transit' || planType === 'bus' || planType === 'ferry' || planType === 'car_rental') return 'transport';

  const c = String(sureCategory || '').trim().toLowerCase();
  if (!c) return 'other';
  if (c.includes('flight') || c.includes('airfare') || c.includes('airline')) return 'flights';
  if (c.includes('hotel') || c.includes('lodg') || c.includes('accommodat') || c.includes('stay')) return 'accommodation';
  if (c.includes('food') || c.includes('dining') || c.includes('grocer') || c.includes('restaur') || c.includes('coffee') || c.includes('drink')) return 'food';
  if (c.includes('transport') || c.includes('transit') || c.includes('ride') || c.includes('taxi') || c.includes('train') || c.includes('rail') || c.includes('gas') || c.includes('fuel') || c.includes('parking')) return 'transport';
  if (c.includes('shop') || c.includes('cloth') || c.includes('merch') || c.includes('retail') || c.includes('gift')) return 'shopping';
  if (c.includes('entertain') || c.includes('activit') || c.includes('attract') || c.includes('museum') || c.includes('ticket')) return 'activities';
  return 'other';
}

function buildProvenanceNote(txId, txAmount, txCurrency) {
  return `sure:${txId} \u00b7 ${formatMoneyNum(txAmount)} ${txCurrency}`;
}

function replaceProvenanceLine(existingNote, newProvenance) {
  const raw = String(existingNote || '').trim();
  if (!raw) return newProvenance;
  const lines = raw.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('sure:'));
  if (idx === -1) return `${raw}\n${newProvenance}`;
  lines[idx] = newProvenance;
  return lines.join('\n');
}

// The Sure key is instance-scoped, so only an admin may enumerate or claim from the ledger.
function requireAdmin(req) {
  if (!req.user || req.user.isAdmin !== true) {
    throw new PluginError(403, 'ADMIN_ONLY', 'Only a TREK admin can browse the Sure ledger. Ask an admin to import card charges.');
  }
}

function requireTripId(req, body) {
  const raw = (req.query && req.query.tripId) ?? (body && body.tripId);
  const tripId = Number(raw);
  if (!Number.isInteger(tripId) || tripId <= 0) {
    throw new PluginError(400, 'BAD_PARAMS', 'Missing or invalid tripId.');
  }
  return tripId;
}

function requireMappingId(req, body) {
  const raw = (req.query && req.query.id) ?? (body && body.id);
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PluginError(400, 'BAD_PARAMS', 'Missing or invalid mapping id.');
  }
  return id;
}

function normalizeSureBaseUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new PluginError(412, 'INVALID_SURE_URL', `Invalid Sure URL "${rawUrl}". Set a full http(s) URL in Instance settings.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PluginError(412, 'INVALID_SURE_URL', 'Sure URL must use http:// or https://.');
  }
  let pathname = parsed.pathname.replace(/\/+$/, '');
  pathname = pathname.replace(/\/(api\/v1|mcp)$/i, '');
  return {
    baseUrl: `${parsed.origin}${pathname}`,
    host: parsed.hostname,
  };
}

function resolveSureConfig(ctx) {
  const cfg = (ctx && ctx.config) || {};
  const rawUrl = String(cfg.sure_url || cfg.sure_mcp_url || '').trim();
  const apiKey = String(cfg.sure_api_key || cfg.sure_mcp_token || '').trim();
  if (!rawUrl) {
    throw new PluginError(
      412,
      'MISSING_SURE_URL',
      'Sure base URL is not configured. Open Admin -> Plugins -> Sure Sync -> Instance settings, set sure_url (e.g. https://sure.example.com), and add its hostname under Allowed hosts.'
    );
  }
  const { baseUrl, host } = normalizeSureBaseUrl(rawUrl);
  if (!apiKey) {
    throw new PluginError(
      412,
      'MISSING_API_KEY',
      'Sure API key is not configured. Open Admin -> Plugins -> Sure Sync -> Instance settings and set sure_api_key.'
    );
  }
  return { baseUrl, host, apiKey };
}

function buildRestQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      const arrKey = k.endsWith('[]') ? k : `${k}[]`;
      for (const item of v) {
        if (item !== undefined && item !== null && item !== '') {
          params.append(arrKey, String(item));
        }
      }
    } else {
      params.set(k, String(v));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function sureGet(sureCfg, apiPath, query = null, opts = {}) {
  if (!ALLOWED_REST_PATH_RE.test(apiPath)) {
    throw new PluginError(500, 'FORBIDDEN_SURE_PATH', `Refusing non-whitelisted Sure path "${apiPath}".`);
  }
  const targetUrl = `${sureCfg.baseUrl}${apiPath}${buildRestQuery(query)}`;
  let res;
  try {
    res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-api-key': sureCfg.apiKey,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'error', // never follow a redirect: undici forwards x-api-key across origins
    });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg.includes('egress:')) {
      const isPrivateBlock = msg.includes('blocked address') || msg.includes('local socket');
      throw new PluginError(
        502,
        'SURE_EGRESS_BLOCKED',
        isPrivateBlock
          ? `Outbound access to private/LAN address for "${sureCfg.host}" is blocked by TREK (${msg}). Connect via a public HTTPS domain or set TREK_PLUGIN_ALLOW_PRIVATE_EGRESS=on on the TREK server.`
          : `Outbound access to "${sureCfg.host}" is not allowed yet (${msg}). Add "${sureCfg.host}" under Admin -> Plugins -> Sure Sync -> Allowed hosts.`
      );
    }
    throw new PluginError(502, 'SURE_UNREACHABLE', `Cannot reach Sure API at ${sureCfg.baseUrl}: ${msg}`);
  }

  if (res.status === 404 && opts.allowNotFound) {
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    throw new PluginError(
      502,
      'SURE_AUTH_FAILED',
      `Sure API rejected the API key (HTTP ${res.status}). Check sure_api_key in Instance settings and ensure it is active with read scope.`
    );
  }
  if (res.status === 429) {
    const retryAfter = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    throw new PluginError(
      502,
      'SURE_RATE_LIMITED',
      `Sure API rate limit exceeded${retryAfter ? ` (retry after ${retryAfter}s)` : ''}.`
    );
  }
  if (!res.ok) {
    throw new PluginError(502, 'SURE_HTTP_ERROR', `Sure API returned HTTP ${res.status} on ${apiPath}.`);
  }

  try {
    return await res.json();
  } catch (err) {
    throw new PluginError(502, 'SURE_BAD_RESPONSE', `Invalid JSON from Sure API (${apiPath}): ${(err && err.message) || err}`);
  }
}

function resolveCreditCards(accountsPayload) {
  const accounts = Array.isArray(accountsPayload)
    ? accountsPayload
    : ((accountsPayload && Array.isArray(accountsPayload.accounts)) ? accountsPayload.accounts : []);
  const cards = accounts.filter((a) => {
    if (!a) return false;
    const kind = String(a.account_type || a.type || '').toLowerCase();
    const isCard = kind === 'credit_card' || kind === 'creditcard';
    const status = String(a.status || 'active').toLowerCase();
    return isCard && status !== 'inactive' && status !== 'pending_deletion';
  });
  return {
    cards,
    ids: cards.map((c) => String(c.id)),
  };
}

function normalizeRestTx(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawAmt = raw.amount_decimal !== undefined && raw.amount_decimal !== null
    ? Number(raw.amount_decimal)
    : Number(raw.amount);
  const amount = Number.isFinite(rawAmt) ? round2(Math.abs(rawAmt)) : NaN;
  const accountObj = (raw.account && typeof raw.account === 'object') ? raw.account : null;
  const categoryObj = (raw.category && typeof raw.category === 'object') ? raw.category : null;
  const merchantObj = (raw.merchant && typeof raw.merchant === 'object') ? raw.merchant : null;
  const merchantName = merchantObj ? (merchantObj.name ? String(merchantObj.name).trim() : null) : (raw.merchant ? String(raw.merchant).trim() : null);
  const kind = raw.kind ? String(raw.kind) : 'standard';
  const isTransfer = Boolean(raw.is_transfer) || Boolean(raw.transfer) || TRANSFER_KINDS.has(kind);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => (typeof t === 'string' ? t : (t && t.name ? String(t.name).trim() : ''))).filter(Boolean)
    : [];

  return {
    id: String(raw.id || ''),
    entry_id: raw.entry_id ? String(raw.entry_id) : null,
    date: normalizeDate(raw.date),
    amount,
    currency: normalizeCurrency(raw.currency) || 'USD',
    name: String(raw.name || merchantName || '').trim(),
    merchant: merchantName,
    notes: raw.notes ? String(raw.notes) : null,
    account: accountObj ? (accountObj.name ? String(accountObj.name).trim() : null) : (raw.account ? String(raw.account).trim() : null),
    account_id: accountObj && accountObj.id ? String(accountObj.id) : null,
    account_type: accountObj && accountObj.account_type ? String(accountObj.account_type) : null,
    category: categoryObj ? (categoryObj.name ? String(categoryObj.name).trim() : null) : (raw.category ? String(raw.category).trim() : null),
    category_id: categoryObj && categoryObj.id ? String(categoryObj.id) : null,
    tags,
    classification: String(raw.classification || ''),
    kind,
    split_parent: Boolean(raw.split_parent),
    excluded: Boolean(raw.excluded),
    is_transfer: isTransfer,
  };
}

function isEligibleCardExpense(tx) {
  if (!tx) return false;
  if (tx.is_transfer || tx.split_parent) return false;
  return tx.classification === 'expense' && Number.isFinite(tx.amount);
}

async function fetchPagedRest(sureCfg, apiPath, arrayKey) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= 10) {
    const res = await sureGet(sureCfg, apiPath, { page, per_page: PAGE_SIZE });
    if (Array.isArray(res)) {
      out.push(...res);
      break;
    }
    const pag = (res && res.pagination) || {};
    totalPages = Math.max(1, Number(pag.total_pages ?? res.total_pages) || 1);
    const items = Array.isArray(res && res[arrayKey]) ? res[arrayKey] : [];
    out.push(...items);
    if (items.length === 0) break;
    page += 1;
  }
  return out;
}

async function loadSureMetadata(sureCfg, force = false) {
  const cacheKey = `${sureCfg.baseUrl}|${sureCfg.apiKey.slice(0, 8)}`;
  const cached = metaCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.ts < META_TTL_MS) return cached.data;

  const [rawAccounts, rawCategories, rawTagsPayload] = await Promise.all([
    fetchPagedRest(sureCfg, '/api/v1/accounts', 'accounts'),
    fetchPagedRest(sureCfg, '/api/v1/categories', 'categories'),
    sureGet(sureCfg, '/api/v1/tags'),
  ]);

  const { cards, ids } = resolveCreditCards(rawAccounts);
  const rawTags = Array.isArray(rawTagsPayload)
    ? rawTagsPayload
    : ((rawTagsPayload && Array.isArray(rawTagsPayload.tags)) ? rawTagsPayload.tags : []);

  const categories = rawCategories
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => {
      const name = c.name.trim();
      const parentName = c.parent && typeof c.parent.name === 'string' ? c.parent.name.trim() : '';
      const label = c.name_with_parent
        ? String(c.name_with_parent).trim()
        : (parentName ? `${parentName} > ${name}` : name);
      return {
        id: c.id ? String(c.id) : name,
        name,
        label,
        parentId: c.parent && c.parent.id ? String(c.parent.id) : null,
        color: c.color || null,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const categoryIdsByFilter = new Map();
  for (const c of categories) {
    const childIds = categories.filter((ch) => ch.parentId && ch.parentId === c.id).map((ch) => ch.id);
    const familyIds = [c.id, ...childIds];
    categoryIdsByFilter.set(c.id, familyIds);
    categoryIdsByFilter.set(c.label.toLowerCase(), familyIds);
    if (!categoryIdsByFilter.has(c.name.toLowerCase())) {
      categoryIdsByFilter.set(c.name.toLowerCase(), familyIds);
    } else {
      const prev = categoryIdsByFilter.get(c.name.toLowerCase());
      categoryIdsByFilter.set(c.name.toLowerCase(), [...new Set([...prev, ...familyIds])]);
    }
  }

  const tags = rawTags
    .filter((t) => t && typeof t.name === 'string' && t.name.trim())
    .map((t) => ({
      id: t.id ? String(t.id) : t.name.trim(),
      name: t.name.trim(),
      color: t.color || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tagIdByName = new Map();
  for (const t of tags) {
    tagIdByName.set(t.name.toLowerCase(), t.id);
    tagIdByName.set(t.id, t.id);
  }

  const data = {
    cards,
    cardIds: ids,
    cardIdSet: new Set(ids),
    categories,
    categoryIdsByFilter,
    tags,
    tagIdByName,
  };
  metaCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

function parseCandidateFilters(query, tripStart, tripEnd) {
  const q = query || {};
  const allDates = q.allDates === '1' || q.allDates === 'true' || q.allDates === true;
  let startDate = allDates ? '' : (normalizeDate(q.startDate) || tripStart);
  let endDate = allDates ? '' : (normalizeDate(q.endDate) || tripEnd);
  if (startDate && endDate && startDate > endDate) {
    const tmp = startDate;
    startDate = endDate;
    endDate = tmp;
  }
  const search = String(q.search || '').trim().slice(0, 120);
  const category = String(q.category || '').trim().slice(0, 120);
  const tag = String(q.tag || '').trim().slice(0, 120);
  return { startDate, endDate, allDates, search, category, tag };
}

async function querySureTransactions(sureCfg, meta, opts) {
  const cardIds = meta && meta.cardIds;
  if (!cardIds || cardIds.length === 0) {
    return { byId: new Map(), transactions: [], pagesFetched: 0, truncated: false };
  }

  let categoryIds = null;
  const wantUncategorized = opts.category === 'Uncategorized';
  if (opts.category && !wantUncategorized) {
    categoryIds = meta.categoryIdsByFilter.get(opts.category) || meta.categoryIdsByFilter.get(opts.category.toLowerCase()) || null;
    if (!categoryIds || categoryIds.length === 0) {
      return { byId: new Map(), transactions: [], pagesFetched: 0, truncated: false };
    }
  }

  let tagIds = null;
  if (opts.tag) {
    const tid = meta.tagIdByName.get(opts.tag) || meta.tagIdByName.get(opts.tag.toLowerCase()) || null;
    if (!tid) {
      return { byId: new Map(), transactions: [], pagesFetched: 0, truncated: false };
    }
    tagIds = [tid];
  }

  const hasNarrowingFilter = Boolean(opts.startDate || opts.endDate || opts.search || opts.category || opts.tag);
  const pageCap = hasNarrowingFilter ? MAX_PAGES : MAX_UNBOUNDED_PAGES;

  const byId = new Map();
  let page = 1;
  let totalPages = 1;
  let pagesFetched = 0;
  let truncated = false;

  while (page <= totalPages) {
    if (page > pageCap) {
      truncated = true;
      break;
    }
    const query = {
      account_ids: cardIds,
      per_page: PAGE_SIZE,
      page,
    };
    if (opts.expensesOnly !== false) query.type = 'expense';
    if (opts.startDate) query.start_date = opts.startDate;
    if (opts.endDate) query.end_date = opts.endDate;
    if (opts.search) query.search = opts.search;
    if (categoryIds) query.category_ids = categoryIds;
    if (tagIds) query.tag_ids = tagIds;

    const res = await sureGet(sureCfg, '/api/v1/transactions', query);
    pagesFetched += 1;
    const pag = (res && res.pagination) || {};
    totalPages = Math.max(1, Number(pag.total_pages ?? res.total_pages) || 1);
    const list = Array.isArray(res && res.transactions) ? res.transactions : [];
    for (const rawTx of list) {
      const tx = normalizeRestTx(rawTx);
      if (!tx || !tx.id) continue;
      if (wantUncategorized && tx.category) continue;
      byId.set(tx.id, tx);
    }
    if (list.length === 0) break;
    page += 1;
  }

  return { byId, transactions: [...byId.values()], pagesFetched, truncated };
}

async function fetchTransactionById(sureCfg, txId) {
  const cleanId = String(txId || '').trim();
  if (!cleanId) return null;
  const raw = await sureGet(sureCfg, `/api/v1/transactions/${encodeURIComponent(cleanId)}`, null, { allowNotFound: true });
  if (!raw) return null;
  const unwrapped = (raw.transaction && typeof raw.transaction === 'object') ? raw.transaction : raw;
  return normalizeRestTx(unwrapped);
}

async function fetchTransactionsByIds(sureCfg, ids) {
  const unique = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < unique.length; i += DIRECT_LOOKUP_CONCURRENCY) {
    const chunk = unique.slice(i, i + DIRECT_LOOKUP_CONCURRENCY);
    const fetched = await Promise.all(chunk.map((id) => fetchTransactionById(sureCfg, id)));
    for (let j = 0; j < chunk.length; j++) {
      if (fetched[j]) byId.set(chunk[j], fetched[j]);
    }
  }
  return byId;
}

async function fetchLiveTransactionsForMappings(sureCfg, meta, mappings) {
  const ids = [...new Set((mappings || []).map((r) => String(r.sure_transaction_id || '').trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { byId: new Map(), checkedCount: 0, directLookups: 0, batchPages: 0 };
  }
  if (ids.length <= 8 || !meta || meta.cardIds.length === 0) {
    const byId = await fetchTransactionsByIds(sureCfg, ids);
    return { byId, checkedCount: ids.length, directLookups: ids.length, batchPages: 0 };
  }
  let minDate = null;
  let maxDate = null;
  for (const r of mappings) {
    const d = normalizeDate(r.snap_date);
    if (!d) continue;
    if (!minDate || d < minDate) minDate = d;
    if (!maxDate || d > maxDate) maxDate = d;
  }
  const byId = new Map();
  let batchPages = 0;
  if (minDate && maxDate) {
    const res = await sureGet(sureCfg, '/api/v1/transactions', {
      account_ids: meta.cardIds,
      start_date: minDate,
      end_date: maxDate,
      per_page: PAGE_SIZE,
      page: 1,
    });
    batchPages = 1;
    const list = Array.isArray(res && res.transactions) ? res.transactions : [];
    for (const rawTx of list) {
      const tx = normalizeRestTx(rawTx);
      if (tx && tx.id) byId.set(tx.id, tx);
    }
  }
  const missingIds = ids.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    const directMap = await fetchTransactionsByIds(sureCfg, missingIds);
    for (const [k, v] of directMap.entries()) byId.set(k, v);
  }
  return { byId, checkedCount: ids.length, directLookups: missingIds.length, batchPages };
}

// --- Multi-signal TREK correlation (existing cost items + trip bookings/places) ---

function extractTokens(parts) {
  const raw = (Array.isArray(parts) ? parts : [parts])
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!raw) return new Set();

  // Split ASCII words/flight codes (`jl 26` -> `jl26` + `jl` + `26`) and keep CJK runs.
  const compactFlight = raw.replace(/\b([a-z]{2})\s+(\d{2,4})\b/g, '$1$2 $1 $2');
  const pieces = compactFlight.match(/[a-z0-9]{2,}|[\u3040-\u30ff\u3400-\u9fff]{2,}/g) || [];
  const tokens = new Set();
  for (const p of pieces) {
    if (/^\d+$/.test(p)) continue; // bare numbers collide across merchant store ids
    if (p.length < 2 || NOISE_TOKENS.has(p)) continue;
    if (p.length === 2 && !TOKEN_ALIASES[p]) continue;
    tokens.add(p);
    const aliases = TOKEN_ALIASES[p];
    if (aliases) {
      for (const a of aliases) tokens.add(a);
    }
  }
  return tokens;
}

function sharedTokens(setA, setB) {
  const hits = [];
  for (const t of setA) {
    if (setB.has(t)) hits.push(t);
    else if (t.length >= 5) {
      for (const b of setB) {
        if (b.length >= 5 && (t.includes(b) || b.includes(t))) {
          hits.push(t.length <= b.length ? t : b);
          break;
        }
      }
    }
  }
  return [...new Set(hits)];
}

function toTripCurrencyApprox(amount, currency, rawTripCurrency, itemFrozenRate, rates) {
  const cur = normalizeCurrency(currency || rawTripCurrency);
  const tripCur = normalizeCurrency(rawTripCurrency);
  if (!tripCur || !cur) return null;
  if (cur === tripCur) return Number(amount);
  if (itemFrozenRate != null && Number.isFinite(itemFrozenRate) && itemFrozenRate > 0 && itemFrozenRate !== 1) {
    return Number(amount) / Number(itemFrozenRate);
  }
  const r = rates && typeof rates[cur] === 'number' ? rates[cur] : null;
  return r && r > 0 ? Number(amount) / r : null;
}

function relativeDiff(a, b) {
  const absA = Math.abs(Number(a));
  const absB = Math.abs(Number(b));
  const denom = Math.max(absA, absB);
  if (denom === 0) return 0;
  return Math.abs(absA - absB) / denom;
}

function withinHalfPercent(a, b) {
  const absA = Math.abs(Number(a));
  const absB = Math.abs(Number(b));
  const denom = Math.max(absA, absB);
  if (denom === 0) return true;
  if (denom < 2) return Math.abs(absA - absB) <= 0.01;
  return Math.abs(absA - absB) / denom <= 0.005;
}

function inspectItemSplit(item) {
  const members = Array.isArray(item && item.members) ? item.members.filter(Boolean) : [];
  const hasCustom = members.some((m) => m.amount != null && Number.isFinite(Number(m.amount)));
  if (!hasCustom) {
    return { kind: members.length > 0 ? 'equal' : 'none', memberCount: members.length, shares: [] };
  }
  const itemTotal = Math.max(0, Number(item.total_price) || 0);
  const explicitSum = members.reduce((s, m) => s + (m.amount != null ? Math.max(0, Number(m.amount) || 0) : 0), 0);
  const nullCount = members.filter((m) => m.amount == null).length;
  const remEach = nullCount > 0 ? Math.max(0, itemTotal - explicitSum) / nullCount : 0;
  const weights = members.map((m) => (m.amount != null ? Math.max(0, Number(m.amount) || 0) : remEach));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  const shares = members.map((m, idx) => {
    const ratio = weightSum > 0 ? (weights[idx] / weightSum) : (1 / members.length);
    return {
      user_id: Number(m.user_id),
      username: m.username ? String(m.username) : `User #${m.user_id}`,
      beforeAmount: round2(weights[idx]),
      ratio,
      pct: Math.round(ratio * 1000) / 10,
    };
  });
  return { kind: 'custom', memberCount: members.length, shares };
}

// Largest-remainder apportionment in integer cents so rescaled shares always sum to round2(newTotal).
function rescaleCustomShares(shares, newTotal) {
  const totalCents = Math.round(round2(newTotal) * 100);
  if (!Array.isArray(shares) || shares.length === 0) return [];
  const rawCents = shares.map((s) => s.ratio * totalCents);
  const floored = rawCents.map((c) => Math.floor(c + 1e-9));
  let rem = totalCents - floored.reduce((a, b) => a + b, 0);
  const order = shares
    .map((s, idx) => ({ idx, frac: rawCents[idx] - floored[idx], weight: s.ratio }))
    .sort((a, b) => (b.frac - a.frac) || (b.weight - a.weight) || (a.idx - b.idx));
  for (let k = 0; k < order.length && rem > 0; k++, rem--) {
    floored[order[k].idx] += 1;
  }
  return shares.map((s, idx) => ({
    ...s,
    afterAmount: floored[idx] / 100,
  }));
}

function summarizeReplaceableTarget(item, rawTripCurrency, rates) {
  const itemCur = normalizeCurrency(item.currency) || normalizeCurrency(rawTripCurrency) || null;
  const itemPrice = round2(Number(item.total_price) || 0);
  return {
    id: Number(item.id),
    name: String(item.name || '').trim() || `Item #${item.id}`,
    category: item.category ? String(item.category).trim() : null,
    total_price: itemPrice,
    currency: itemCur,
    approxTripAmount: itemCur ? toTripCurrencyApprox(itemPrice, itemCur, rawTripCurrency, item.exchange_rate, rates) : null,
    expense_date: normalizeDate(item.expense_date) || null,
    hasNote: Boolean(item.note && String(item.note).trim()),
    hasReservation: Boolean(item.reservation_id),
    hasPlace: Boolean(item.place_id),
    receiptCount: Array.isArray(item.receipts) ? item.receipts.length : 0,
    payers: Array.isArray(item.payers)
      ? item.payers.filter(Boolean).map((p) => ({
          user_id: Number(p.user_id),
          username: p.username ? String(p.username) : null,
          amount: round2(Number(p.amount) || 0),
        }))
      : [],
    split: inspectItemSplit(item),
  };
}

/**
 * Correlate one Sure transaction against:
 *  1) Existing TREK budget items (`duplicateOf` when high-confidence duplicate, `costHint` when softer match)
 *  2) Unmapped TREK guesstimates (`replaceSuggestion` for floating candidate replacements to the top)
 *  3) Trip bookings / accommodations / places (`planMatch` when matching an un-costed reservation or place)
 */
function correlateCandidate(tx, tripItems, planTargets, rawTripCurrency, rates, mappedItemIds = null) {
  const txDate = normalizeDate(tx.date);
  const txCur = normalizeCurrency(tx.currency) || 'USD';
  const txAmt = Number(tx.amount);
  const txTokens = extractTokens([tx.name, tx.merchant, tx.notes]);
  const txMappedCat = mapCategory(tx.category, null);
  const mappedSet = mappedItemIds instanceof Set ? mappedItemIds : new Set(mappedItemIds || []);

  let bestBlocking = null;
  let bestHint = null;
  let bestReplace = null;

  for (const item of tripItems || []) {
    if (!item) continue;
    const itemPrice = Number(item.total_price);
    if (!Number.isFinite(itemPrice)) continue;
    const itemId = Number(item.id);
    const isMapped = mappedSet.has(itemId);
    const itemCur = normalizeCurrency(item.currency) || normalizeCurrency(rawTripCurrency);
    const itemDate = normalizeDate(item.expense_date);
    const dayGap = (txDate && itemDate) ? Math.abs(daysBetween(txDate, itemDate)) : null;

    let sameCurMatch = false;
    let rel = null;
    if (itemCur && itemCur === txCur) {
      rel = relativeDiff(txAmt, itemPrice);
      sameCurMatch = withinHalfPercent(txAmt, itemPrice);
    } else if (rawTripCurrency && rates) {
      const txInTrip = toTripCurrencyApprox(txAmt, txCur, rawTripCurrency, null, rates);
      const itemInTrip = toTripCurrencyApprox(itemPrice, itemCur, rawTripCurrency, item.exchange_rate, rates);
      if (txInTrip != null && itemInTrip != null) {
        rel = relativeDiff(txInTrip, itemInTrip);
      }
    }

    const itemTokens = extractTokens([item.name, item.note]);
    const overlap = sharedTokens(txTokens, itemTokens);
    const sameCategory = Boolean(
      item.category && txMappedCat && txMappedCat !== 'other' &&
      String(item.category).toLowerCase() === txMappedCat.toLowerCase()
    );

    const summary = {
      id: itemId,
      name: item.name,
      total_price: itemPrice,
      currency: itemCur || txCur,
      expense_date: itemDate || null,
      isMapped,
    };

    // High-confidence duplicate guard (requires explicit Override to import as a separate item):
    //  a) Exact spec rule: amount within ±0.5% AND date within ±3 days
    //  b) Cross-currency issuer-FX tolerance (±2.5%) + date within ±3 days + merchant/name token match
    //  c) Pre-booked flight/hotel: amount within ±2.0% + merchant/name token match (any date!)
    const classicDup = dayGap != null && dayGap <= 3 && (sameCurMatch || (rel != null && rel <= 0.005));
    const fxNamedDup = dayGap != null && dayGap <= 3 && rel != null && rel <= 0.025 && overlap.length > 0;
    const prebookedNamedDup = rel != null && rel <= 0.02 && overlap.length > 0;

    if (classicDup || fxNamedDup || prebookedNamedDup) {
      const reason = classicDup
        ? 'amount & date match'
        : (prebookedNamedDup && (dayGap == null || dayGap > 3) ? 'name & amount match (pre-booked)' : 'name & FX amount match');
      const score = (overlap.length * 30) + (rel != null ? (1 - Math.min(rel, 1)) * 50 : 0) + (dayGap != null ? Math.max(0, 10 - dayGap) : 0);
      if (!bestBlocking || score > bestBlocking.score) {
        bestBlocking = { score, match: { ...summary, reason } };
      }
      if (!isMapped) {
        const repScore = 100 + score;
        if (!bestReplace || repScore > bestReplace.score) {
          bestReplace = { score: repScore, match: { targetId: itemId, confidence: 'strong', score: repScore, reason } };
        }
      }
      continue;
    }

    // Advisory non-blocking hint:
    const closeAmountDate = dayGap != null && dayGap <= 2 && rel != null && rel <= 0.025;
    const nameOnlyMatch = overlap.length > 0 && overlap.some((t) => t.length >= 4 || TOKEN_ALIASES[t]);
    if (closeAmountDate || nameOnlyMatch) {
      const reason = closeAmountDate ? '~amount & date' : `name "${overlap[0]}"`;
      const score = (overlap.length * 25) + (closeAmountDate ? 30 : 0);
      if (!bestHint || score > bestHint.score) {
        bestHint = { score, match: { ...summary, reason } };
      }
    }

    // Unmapped guesstimate matching for Replace suggestions (excludes tiny incidentals like $12 minibar vs $1,900 hotel):
    if (!isMapped) {
      const closeEstAmountDate = dayGap != null && dayGap <= 2 && rel != null && rel <= 0.15;
      const catEstAmountDate = sameCategory && dayGap != null && dayGap <= 3 && rel != null && rel <= 0.35;
      const namedEstimate = nameOnlyMatch && (itemPrice === 0 || rel == null || rel <= 0.55);
      if (closeEstAmountDate || catEstAmountDate || namedEstimate) {
        const reason = namedEstimate
          ? (itemPrice === 0 ? `placeholder "${overlap[0]}"` : `name "${overlap[0]}" & ~amount`)
          : (catEstAmountDate ? 'category, date & ~amount' : '~amount & date');
        const repScore = (overlap.length * 25) +
          (sameCategory ? 15 : 0) +
          (rel != null ? Math.max(0, (0.55 - rel) * 40) : 10) +
          (dayGap != null ? Math.max(0, 6 - dayGap) * 3 : 0);
        if (!bestReplace || repScore > bestReplace.score) {
          bestReplace = { score: repScore, match: { targetId: itemId, confidence: 'estimate', score: repScore, reason } };
        }
      }
    }
  }

  // Correlate against trip bookings (flights, hotels, trains) and places!
  let bestPlan = null;
  for (const target of planTargets || []) {
    const overlap = sharedTokens(txTokens, target.tokens);
    let codeHit = false;
    if (target.code && target.code.length >= 5) {
      const hay = `${tx.name || ''} ${tx.notes || ''}`.toUpperCase();
      if (hay.includes(target.code.toUpperCase())) codeHit = true;
    }
    if (!codeHit && overlap.length === 0) continue;
    const strong = codeHit || overlap.length >= 2 || overlap.some((t) => t.length >= 4 || Boolean(TOKEN_ALIASES[t]));
    if (!strong) continue;
    const score = (codeHit ? 60 : 0) + overlap.length * 20 + (target.kind === 'reservation' ? 10 : 5);
    if (!bestPlan || score > bestPlan.score) {
      bestPlan = {
        score,
        match: {
          kind: target.kind,
          type: target.type || null,
          id: target.id,
          title: target.title,
        },
      };
    }
  }

  return {
    duplicateOf: bestBlocking ? bestBlocking.match : null,
    costHint: (!bestBlocking && bestHint) ? bestHint.match : null,
    planMatch: bestPlan ? bestPlan.match : null,
    replaceSuggestion: bestReplace ? bestReplace.match : null,
  };
}

function findDuplicateItem(tx, tripItems, rawTripCurrency, rates) {
  return correlateCandidate(tx, tripItems, [], rawTripCurrency, rates).duplicateOf;
}

function buildPlanTargets(reservations, accommodations, places) {
  const targets = [];
  for (const r of reservations || []) {
    if (!r) continue;
    let metaText = '';
    if (r.metadata && typeof r.metadata === 'string') {
      try {
        const m = JSON.parse(r.metadata);
        metaText = [m.airline, m.flight_number, m.train_number, m.hotel_name, m.provider].filter(Boolean).join(' ');
      } catch {
        // ignore malformed metadata
      }
    } else if (r.metadata && typeof r.metadata === 'object') {
      metaText = [r.metadata.airline, r.metadata.flight_number, r.metadata.train_number, r.metadata.provider].filter(Boolean).join(' ');
    }
    const endpointText = Array.isArray(r.endpoints) ? r.endpoints.map((e) => e && e.name).filter(Boolean).join(' ') : '';
    const title = String(r.title || r.name || '').trim();
    if (!title) continue;
    targets.push({
      kind: 'reservation',
      type: r.type || null,
      id: Number(r.id),
      title,
      code: r.confirmation_number ? String(r.confirmation_number).trim() : null,
      tokens: extractTokens([title, metaText, endpointText, r.location]),
    });
  }
  for (const a of accommodations || []) {
    if (!a) continue;
    const title = String(a.name || a.place_name || a.title || '').trim();
    if (!title) continue;
    targets.push({
      kind: 'accommodation',
      type: 'accommodation',
      id: Number(a.id),
      title,
      code: a.confirmation ? String(a.confirmation).trim() : null,
      tokens: extractTokens([title, a.notes]),
    });
  }
  for (const p of places || []) {
    if (!p) continue;
    const title = String(p.name || '').trim();
    if (!title) continue;
    targets.push({
      kind: 'place',
      type: p.category || null,
      id: Number(p.id),
      title,
      code: null,
      tokens: extractTokens([title]),
    });
  }
  return targets;
}

function isEditedInTrek(mappingRow, trekItem, rawTripCurrency) {
  if (!trekItem) return false;
  const expectedPrice = Number(mappingRow.amount);
  const actualPrice = Number(trekItem.total_price);
  if (Math.abs(actualPrice - expectedPrice) > 0.009) return true;

  const expectedCur = normalizeCurrency(mappingRow.item_currency);
  const actualCur = normalizeCurrency(trekItem.currency) || normalizeCurrency(rawTripCurrency);
  if (expectedCur && actualCur && expectedCur !== actualCur) return true;

  const expectedName = String(
    (mappingRow.trek_name != null && mappingRow.trek_name !== '') ? mappingRow.trek_name : (mappingRow.snap_name || '')
  ).trim();
  if (String(trekItem.name || '').trim() !== expectedName) return true;

  if (Array.isArray(trekItem.payers)) {
    if (trekItem.payers.length > 1) return true;
    if (trekItem.payers.length === 1 && Math.abs(Number(trekItem.payers[0].amount) - expectedPrice) > 0.009) {
      return true;
    }
  }
  const members = Array.isArray(trekItem.members) ? trekItem.members.filter(Boolean) : [];
  if (mappingRow.custom_shares_json) {
    let expectedShares = null;
    try { expectedShares = JSON.parse(mappingRow.custom_shares_json); } catch { expectedShares = null; }
    if (!Array.isArray(expectedShares) || expectedShares.length !== members.length) return true;
    const byUser = new Map(expectedShares.map((s) => [Number(s.user_id), Number(s.amount)]));
    for (const m of members) {
      const exp = byUser.get(Number(m.user_id));
      if (exp === undefined || m.amount == null || Math.abs(Number(m.amount) - exp) > 0.009) return true;
    }
  } else if (members.some((m) => m.amount != null)) {
    return true;
  }
  return false;
}

function classifyDrift(mappingRow, trekItem, liveTx, rawTripCurrency) {
  const edited = isEditedInTrek(mappingRow, trekItem, rawTripCurrency);
  if (edited) {
    return {
      status: 'edited-in-trek',
      canRefresh: false,
      changes: null,
    };
  }
  if (!liveTx) {
    return {
      status: 'missing',
      canRefresh: false,
      changes: null,
    };
  }

  if (!isEligibleCardExpense(liveTx)) {
    return {
      status: 'not-expense',
      canRefresh: false,
      changes: null,
    };
  }

  const liveName = String(liveTx.name || '').trim();
  const liveAmount = round2(Number(liveTx.amount));
  const liveDate = normalizeDate(liveTx.date);
  const snapName = String(mappingRow.snap_name || '').trim();
  const snapAmount = round2(Number(mappingRow.snap_amount));
  const snapDate = normalizeDate(mappingRow.snap_date);

  const hasKeptTrekName = Boolean(mappingRow.trek_name != null && mappingRow.trek_name !== '');
  const nameChanged = !hasKeptTrekName && (liveName !== snapName);
  const amountChanged = Math.abs(liveAmount - snapAmount) > 0.004;
  const dateChanged = Boolean(liveDate && snapDate && liveDate !== snapDate);

  if (nameChanged || amountChanged || dateChanged) {
    return {
      status: 'changed',
      canRefresh: true,
      changes: {
        name: nameChanged ? { before: snapName, after: liveName } : null,
        amount: amountChanged
          ? { before: snapAmount, after: liveAmount, currency: normalizeCurrency(liveTx.currency) || mappingRow.currency }
          : null,
        date: dateChanged ? { before: snapDate, after: liveDate } : null,
      },
    };
  }

  return {
    status: 'ok',
    canRefresh: false,
    changes: null,
  };
}

async function loadTripContextAndPrune(ctx, tripId, includePlan = false) {
  const promises = [
    ctx.trips.getById(tripId),
    ctx.costs.getByTrip(tripId),
    ctx.db.query('SELECT * FROM imports WHERE trip_id = ? ORDER BY imported_at DESC, id DESC', tripId),
  ];
  if (includePlan) {
    promises.push(
      ctx.trips.getReservations ? ctx.trips.getReservations(tripId).catch(() => []) : Promise.resolve([]),
      ctx.trips.getAccommodations ? ctx.trips.getAccommodations(tripId).catch(() => []) : Promise.resolve([]),
      ctx.trips.getPlaces ? ctx.trips.getPlaces(tripId).catch(() => []) : Promise.resolve([])
    );
  }
  const [trip, tripItems, rawMappings, reservations, accommodations, places] = await Promise.all(promises);
  if (!trip) {
    throw new PluginError(404, 'TRIP_NOT_FOUND', `Trip ${tripId} was not found.`);
  }
  const startDate = normalizeDate(trip.start_date);
  const endDate = normalizeDate(trip.end_date);
  if (!startDate || !endDate) {
    throw new PluginError(400, 'MISSING_TRIP_DATES', 'Set start and end dates on this trip before importing Sure expenses.');
  }

  const items = Array.isArray(tripItems) ? tripItems : [];
  const itemById = new Map(items.map((it) => [Number(it.id), it]));

  const liveMappings = [];
  for (const row of rawMappings || []) {
    if (itemById.has(Number(row.budget_item_id))) {
      liveMappings.push(row);
    } else {
      await ctx.db.exec('DELETE FROM imports WHERE id = ? AND trip_id = ?', row.id, tripId);
    }
  }

  const rawTripCurrency = normalizeCurrency(trip.currency);
  let rates = null;
  if (rawTripCurrency) {
    try {
      rates = await ctx.rates.get(rawTripCurrency);
    } catch {
      rates = null;
    }
  }

  const planTargets = includePlan ? buildPlanTargets(reservations, accommodations, places) : [];

  return {
    trip,
    startDate,
    endDate,
    rawTripCurrency,
    rates,
    items,
    itemById,
    mappings: liveMappings,
    planTargets,
  };
}

function errorResponse(err, ctx) {
  if (err instanceof PluginError) {
    return json(err.status, { error: err.message, code: err.code });
  }
  const message = (err && err.message) || 'Unexpected plugin error';
  if (ctx && ctx.log) ctx.log.warn('sure-expense-import error', { error: message });

  if (message.includes('Costs addon') || (message.startsWith('RESOURCE_FORBIDDEN') && message.toLowerCase().includes('addon'))) {
    return json(403, {
      code: 'COSTS_ADDON_OFF',
      error: 'The Costs (budget) addon is disabled on this TREK instance. Enable it in Admin -> Addons.',
    });
  }
  if (message.includes('no permission to edit costs') || message.includes('budget_edit')) {
    return json(403, {
      code: 'NO_BUDGET_EDIT',
      error: 'You do not have budget_edit permission on this trip. Only trip editors can import or refresh expenses.',
    });
  }
  const rpcCode = message.split(':', 1)[0];
  const statusByRpc = {
    PERMISSION_DENIED: 403,
    RESOURCE_FORBIDDEN: 403,
    BAD_PARAMS: 400,
    UNKNOWN_METHOD: 501,
    TIMEOUT: 504,
  };
  return json(statusByRpc[rpcCode] || 500, {
    code: statusByRpc[rpcCode] ? rpcCode : 'INTERNAL_ERROR',
    error: statusByRpc[rpcCode] ? message : 'Unexpected plugin error. Check the TREK server log.',
  });
}

const pluginDefinition = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate(
      '001_create_imports',
      `CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trip_id INTEGER NOT NULL,
        sure_transaction_id TEXT NOT NULL UNIQUE,
        budget_item_id INTEGER NOT NULL,
        imported_at TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT NOT NULL,
        exchange_rate REAL NOT NULL,
        item_currency TEXT NOT NULL,
        snap_name TEXT NOT NULL,
        snap_amount REAL NOT NULL,
        snap_date TEXT NOT NULL,
        snap_classification TEXT NOT NULL,
        snap_is_transfer INTEGER NOT NULL DEFAULT 0
      )`
    );
    await ctx.db.migrate(
      '002_imports_trip_idx',
      'CREATE INDEX IF NOT EXISTS idx_imports_trip_id ON imports(trip_id)'
    );
    await ctx.db.migrate(
      '003_add_trek_name',
      'ALTER TABLE imports ADD COLUMN trek_name TEXT'
    );
    await ctx.db.migrate(
      '004_add_custom_shares_json',
      'ALTER TABLE imports ADD COLUMN custom_shares_json TEXT'
    );
    ctx.log.info('sure-expense-import loaded');
  },

  actions: {
    async test_connection(ctx) {
      let sureCfg;
      try {
        sureCfg = resolveSureConfig(ctx);
      } catch (err) {
        return { ok: false, message: err.message };
      }
      try {
        const meta = await loadSureMetadata(sureCfg, true);
        if (meta.cardIds.length === 0) {
          return { ok: false, message: `Reached Sure REST API (${sureCfg.baseUrl}/api/v1), but found 0 active credit_card accounts.` };
        }
        const txRes = await sureGet(sureCfg, '/api/v1/transactions', {
          account_ids: meta.cardIds,
          per_page: 10,
          page: 1,
        });
        const pag = (txRes && txRes.pagination) || {};
        const total = Number(pag.total_count ?? txRes.total_results) || 0;
        return {
          ok: true,
          message: `Connected to Sure (${sureCfg.baseUrl}): ${meta.cards.length} credit card(s), ${meta.categories.length} categories, ${meta.tags.length} tags, ${total} card transaction(s).`,
        };
      } catch (err) {
        return { ok: false, message: (err && err.message) || 'Connection test failed.' };
      }
    },
  },

  routes: [
    // List candidate Sure card expenses filtered by custom date range, name search, Sure category, and Sure tag.
    {
      method: 'GET',
      path: '/candidates',
      auth: true,
      async handler(req, ctx) {
        try {
          requireAdmin(req);
          const tripId = requireTripId(req);
          const sureCfg = resolveSureConfig(ctx);
          const [state, meta, allMappedRows] = await Promise.all([
            loadTripContextAndPrune(ctx, tripId, true),
            loadSureMetadata(sureCfg),
            ctx.db.query('SELECT trip_id, sure_transaction_id FROM imports'),
          ]);
          const filters = parseCandidateFilters(req.query, state.startDate, state.endDate);

          const tripMappedSet = new Set();
          const otherTripMap = new Map();
          for (const r of allMappedRows || []) {
            if (Number(r.trip_id) === tripId) {
              tripMappedSet.add(String(r.sure_transaction_id));
            } else {
              otherTripMap.set(String(r.sure_transaction_id), Number(r.trip_id));
            }
          }

          const mappedBudgetItemIds = new Set(state.mappings.map((r) => Number(r.budget_item_id)));
          const replaceableTargets = state.items
            .filter((it) => it && !mappedBudgetItemIds.has(Number(it.id)))
            .map((it) => summarizeReplaceableTarget(it, state.rawTripCurrency, state.rates));

          const sureWin = await querySureTransactions(sureCfg, meta, filters);
          const candidates = [];
          for (const tx of sureWin.transactions) {
            const txId = String(tx.id || '');
            if (!txId || tripMappedSet.has(txId)) continue;
            const txDate = normalizeDate(tx.date);
            if (!txDate) continue;
            if (filters.startDate && txDate < filters.startDate) continue;
            if (filters.endDate && txDate > filters.endDate) continue;
            if (!isEligibleCardExpense(tx)) continue;

            const txAmount = round2(Number(tx.amount));
            const txCurrency = normalizeCurrency(tx.currency) || 'USD';
            const corr = correlateCandidate(
              tx,
              state.items,
              state.planTargets,
              state.rawTripCurrency,
              state.rates,
              mappedBudgetItemIds
            );
            const mappedInOtherTrip = otherTripMap.has(txId);
            const txTags = Array.isArray(tx.tags) ? tx.tags : [];
            candidates.push({
              id: txId,
              date: txDate,
              name: String(tx.name || '').trim() || 'Unnamed transaction',
              merchant: tx.merchant ? String(tx.merchant).trim() : null,
              account: tx.account ? String(tx.account).trim() : null,
              category: tx.category ? String(tx.category).trim() : null,
              tags: txTags,
              trekCategory: mapCategory(tx.category, corr.planMatch && corr.planMatch.type),
              amount: txAmount,
              currency: txCurrency,
              approxTripAmount: toTripCurrencyApprox(txAmount, txCurrency, state.rawTripCurrency, null, state.rates),
              duplicateOf: corr.duplicateOf,
              costHint: corr.costHint,
              planMatch: corr.planMatch,
              replaceSuggestion: mappedInOtherTrip ? null : corr.replaceSuggestion,
              mappedInOtherTrip,
            });
          }

          candidates.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));

          return json(200, {
            trip: {
              id: tripId,
              title: state.trip.title,
              startDate: state.startDate,
              endDate: state.endDate,
              currency: state.rawTripCurrency || null,
            },
            actingUserId: req.user && req.user.id != null ? Number(req.user.id) : null,
            appliedFilters: filters,
            sureCategories: meta.categories,
            sureTags: meta.tags,
            pagesFetched: sureWin.pagesFetched,
            truncated: sureWin.truncated,
            replaceableTargets,
            candidates,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },

    // List imported mappings on this trip with live Sure drift classification via REST /api/v1/transactions/:id.
    {
      method: 'GET',
      path: '/imports',
      auth: true,
      async handler(req, ctx) {
        try {
          const tripId = requireTripId(req);
          const sureCfg = resolveSureConfig(ctx);
          const state = await loadTripContextAndPrune(ctx, tripId, false);
          const resolvedMeta = state.mappings.length > 8 ? await loadSureMetadata(sureCfg) : null;
          const liveLookup = await fetchLiveTransactionsForMappings(sureCfg, resolvedMeta, state.mappings);

          const imports = state.mappings.map((row) => {
            const trekItem = state.itemById.get(Number(row.budget_item_id));
            const liveTx = liveLookup.byId.get(String(row.sure_transaction_id)) || null;
            const drift = classifyDrift(row, trekItem, liveTx, state.rawTripCurrency);
            return {
              id: Number(row.id),
              tripId: Number(row.trip_id),
              sureTransactionId: String(row.sure_transaction_id),
              budgetItemId: Number(row.budget_item_id),
              importedAt: row.imported_at,
              amount: Number(row.amount),
              itemCurrency: row.item_currency,
              originalAmount: Number(row.snap_amount),
              originalCurrency: row.currency,
              trekItem: {
                id: Number(trekItem.id),
                name: trekItem.name,
                total_price: Number(trekItem.total_price),
                currency: normalizeCurrency(trekItem.currency) || state.rawTripCurrency || row.item_currency,
                expense_date: normalizeDate(trekItem.expense_date),
              },
              snapshot: {
                name: row.snap_name,
                amount: Number(row.snap_amount),
                currency: row.currency,
                date: row.snap_date,
                classification: row.snap_classification,
                isTransfer: Boolean(row.snap_is_transfer),
              },
              status: drift.status,
              canRefresh: drift.canRefresh,
              changes: drift.changes,
            };
          });

          return json(200, {
            lookup: {
              mode: 'direct-id',
              checkedCount: liveLookup.checkedCount,
              directLookups: liveLookup.directLookups,
              batchPages: liveLookup.batchPages,
            },
            imports,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },

    // Import explicitly selected Sure transactions (on any pre-trip or trip date) in their native Sure currency.
    {
      method: 'POST',
      path: '/import',
      auth: true,
      async handler(req, ctx) {
        try {
          const body = parseBody(req.body);
          requireAdmin(req);
          const tripId = requireTripId(req, body);
          const rawIds = Array.isArray(body.transactionIds)
            ? body.transactionIds
            : (Array.isArray(body.transactions) ? body.transactions : []);
          const requestedIds = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))];
          if (requestedIds.length === 0) {
            throw new PluginError(400, 'BAD_PARAMS', 'Select at least one transaction to import.');
          }
          if (requestedIds.length > 25) {
            throw new PluginError(400, 'BAD_PARAMS', 'Import at most 25 transactions per request.');
          }
          const overrideSet = new Set(
            (Array.isArray(body.overrideDuplicateIds) ? body.overrideDuplicateIds : []).map((x) => String(x || '').trim())
          );

          const sureCfg = resolveSureConfig(ctx);
          const [state, meta] = await Promise.all([
            loadTripContextAndPrune(ctx, tripId, true),
            loadSureMetadata(sureCfg),
          ]);

          const placeholders = requestedIds.map(() => '?').join(', ');
          const existingRows = await ctx.db.query(
            `SELECT * FROM imports WHERE sure_transaction_id IN (${placeholders})`,
            ...requestedIds
          );
          const alreadyMapped = new Map();
          for (const row of existingRows || []) {
            if (Number(row.trip_id) === tripId) {
              alreadyMapped.set(String(row.sure_transaction_id), row);
            } else {
              const otherItems = await ctx.costs.getByTrip(Number(row.trip_id)).catch(() => null);
              if (Array.isArray(otherItems) && !otherItems.some((it) => Number(it.id) === Number(row.budget_item_id))) {
                await ctx.db.exec('DELETE FROM imports WHERE id = ?', row.id);
              } else {
                alreadyMapped.set(String(row.sure_transaction_id), row);
              }
            }
          }

          const alreadyImported = [];
          const toImportIds = [];
          for (const txId of requestedIds) {
            const existing = alreadyMapped.get(txId);
            if (existing) {
              const own = Number(existing.trip_id) === tripId;
              alreadyImported.push({
                sureTransactionId: txId,
                tripId: own ? tripId : null,
                budgetItemId: own ? Number(existing.budget_item_id) : null,
              });
            } else {
              toImportIds.push(txId);
            }
          }

          if (toImportIds.length === 0) {
            return json(200, {
              imported: [],
              alreadyImported,
              blockedDuplicates: [],
            });
          }

          const txById = await fetchTransactionsByIds(sureCfg, toImportIds);

          const imported = [];
          const blockedDuplicates = [];
          const currentItems = [...state.items];
          const actingUserId = req.user && req.user.id != null ? Number(req.user.id) : null;

          for (const txId of toImportIds) {
            const tx = txById.get(txId);
            if (!tx) {
              throw new PluginError(404, 'TX_NOT_FOUND', `Transaction ${txId} was not found in Sure.`);
            }
            if (tx.account_id && meta.cardIdSet.size > 0 && !meta.cardIdSet.has(tx.account_id)) {
              throw new PluginError(400, 'NOT_CREDIT_CARD', `Transaction ${txId} does not belong to an active Sure credit card.`);
            }
            if (!isEligibleCardExpense(tx)) {
              throw new PluginError(400, 'NOT_EXPENSE', `Transaction ${txId} is not an eligible expense and cannot be imported.`);
            }
            const corr = correlateCandidate(tx, currentItems, state.planTargets, state.rawTripCurrency, state.rates);
            if (corr.duplicateOf && !overrideSet.has(txId)) {
              blockedDuplicates.push({ sureTransactionId: txId, duplicateOf: corr.duplicateOf });
              continue;
            }

            const txAmount = round2(Number(tx.amount));
            const txCurrency = normalizeCurrency(tx.currency) || 'USD';
            const txDate = normalizeDate(tx.date) || state.startDate;
            const txName = String(tx.name || '').trim() || 'Card expense';
            const note = buildProvenanceNote(txId, txAmount, txCurrency);

            const createInput = {
              name: txName,
              category: mapCategory(tx.category, corr.planMatch && corr.planMatch.type),
              total_price: txAmount,
              currency: txCurrency,
              expense_date: txDate,
              note,
            };
            if (actingUserId && Number.isFinite(actingUserId)) {
              createInput.payers = [{ user_id: actingUserId, amount: txAmount }];
            }

            const createdItem = await ctx.costs.create(tripId, createInput);
            const storedRate = Number(createdItem && createdItem.exchange_rate) || 1;
            const nowIso = new Date().toISOString();

            try {
              await ctx.db.tx([
                {
                  sql: `INSERT INTO imports (
                    trip_id, sure_transaction_id, budget_item_id, imported_at,
                    amount, currency, exchange_rate, item_currency,
                    snap_name, snap_amount, snap_date, snap_classification, snap_is_transfer
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  args: [
                    tripId,
                    txId,
                    Number(createdItem.id),
                    nowIso,
                    txAmount,
                    txCurrency,
                    storedRate,
                    txCurrency,
                    txName,
                    txAmount,
                    txDate,
                    String(tx.classification || 'expense'),
                    tx.is_transfer ? 1 : 0,
                  ],
                },
              ]);
            } catch (dbErr) {
              await ctx.costs.delete(tripId, Number(createdItem.id)).catch(() => {});
              const msg = (dbErr && dbErr.message) || '';
              if (msg.includes('UNIQUE')) {
                alreadyImported.push({ sureTransactionId: txId, tripId, budgetItemId: null });
                continue;
              }
              throw dbErr;
            }

            currentItems.push(createdItem);
            imported.push({
              sureTransactionId: txId,
              budgetItemId: Number(createdItem.id),
              name: txName,
              totalPrice: txAmount,
              itemCurrency: txCurrency,
              originalAmount: txAmount,
              originalCurrency: txCurrency,
            });
          }

          return json(imported.length > 0 ? 201 : 200, {
            imported,
            alreadyImported,
            blockedDuplicates,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },

    // Refresh one mapped item from Sure in Sure's native currency when drift status is `changed`.
    {
      method: 'POST',
      path: '/imports/refresh',
      auth: true,
      async handler(req, ctx) {
        try {
          const body = parseBody(req.body);
          const tripId = requireTripId(req, body);
          const mappingId = requireMappingId(req, body);
          const sureCfg = resolveSureConfig(ctx);

          const rows = await ctx.db.query('SELECT * FROM imports WHERE id = ? AND trip_id = ?', mappingId, tripId);
          const row = rows && rows[0];
          if (!row) {
            throw new PluginError(404, 'MAPPING_NOT_FOUND', 'Import mapping not found on this trip.');
          }

          const state = await loadTripContextAndPrune(ctx, tripId, false);
          const trekItem = state.itemById.get(Number(row.budget_item_id));
          if (!trekItem) {
            throw new PluginError(404, 'ITEM_DELETED_IN_TREK', 'The TREK budget item was deleted; stale mapping pruned.');
          }

          if (isEditedInTrek(row, trekItem, state.rawTripCurrency)) {
            throw new PluginError(
              409,
              'EDITED_IN_TREK',
              'This budget item was edited in TREK; Sure refresh is suppressed so edits do not overwrite each other.'
            );
          }

          const liveTx = await fetchTransactionById(sureCfg, row.sure_transaction_id);
          if (!liveTx) {
            throw new PluginError(
              409,
              'MISSING_IN_SURE',
              'Transaction was not found in Sure (404); TREK budget item kept unchanged.'
            );
          }

          if (!isEligibleCardExpense(liveTx)) {
            throw new PluginError(
              409,
              'NOT_EXPENSE',
              'Transaction is no longer an eligible expense in Sure; amount refresh is refused. Unlink if needed.'
            );
          }

          const txAmount = round2(Number(liveTx.amount));
          const txCurrency = normalizeCurrency(liveTx.currency) || row.currency;
          const txDate = normalizeDate(liveTx.date) || row.snap_date;
          const txName = String(liveTx.name || '').trim() || row.snap_name;
          const keptName = (row.trek_name != null && row.trek_name !== '') ? String(row.trek_name) : txName;
          const provenance = buildProvenanceNote(row.sure_transaction_id, txAmount, txCurrency);
          const nextNote = replaceProvenanceLine(trekItem.note, provenance);

          const updatePayload = {
            name: keptName,
            total_price: txAmount,
            currency: txCurrency,
            expense_date: txDate,
            note: nextNote,
          };
          if (state.rawTripCurrency && txCurrency === state.rawTripCurrency) {
            updatePayload.exchange_rate = 1;
          }
          if (Array.isArray(trekItem.payers) && trekItem.payers.length === 1) {
            updatePayload.payers = [{ user_id: Number(trekItem.payers[0].user_id), amount: txAmount }];
          }
          let nextCustomSharesJson = row.custom_shares_json || null;
          if (row.custom_shares_json) {
            const splitInfo = inspectItemSplit(trekItem);
            if (splitInfo.kind === 'custom') {
              const rescaled = rescaleCustomShares(splitInfo.shares, txAmount).map((s) => ({
                user_id: s.user_id,
                amount: s.afterAmount,
              }));
              updatePayload.members = rescaled;
              nextCustomSharesJson = JSON.stringify(rescaled);
            }
          }

          const updated = await ctx.costs.update(tripId, Number(row.budget_item_id), updatePayload);
          const storedRate = (state.rawTripCurrency && txCurrency === state.rawTripCurrency)
            ? 1
            : (Number(updated && updated.exchange_rate) || Number(row.exchange_rate) || 1);
          await ctx.db.tx([
            {
              sql: `UPDATE imports
                    SET amount = ?, currency = ?, exchange_rate = ?, item_currency = ?,
                        snap_name = ?, snap_amount = ?, snap_date = ?, snap_classification = ?, snap_is_transfer = ?,
                        custom_shares_json = ?
                    WHERE id = ? AND trip_id = ?`,
              args: [
                txAmount,
                txCurrency,
                storedRate,
                txCurrency,
                txName,
                txAmount,
                txDate,
                String(liveTx.classification || 'expense'),
                liveTx.is_transfer ? 1 : 0,
                nextCustomSharesJson,
                mappingId,
                tripId,
              ],
            },
          ]);

          return json(200, {
            refreshed: true,
            id: mappingId,
            budgetItemId: Number(row.budget_item_id),
            trekItem: updated,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },

    // Replace an existing unmapped TREK budget item in place with a Sure card transaction.
    {
      method: 'POST',
      path: '/imports/replace',
      auth: true,
      async handler(req, ctx) {
        try {
          const body = parseBody(req.body);
          const tripId = requireTripId(req, body);
          const txId = String(body.transactionId || '').trim();
          if (!txId) {
            throw new PluginError(400, 'BAD_PARAMS', 'Missing required parameter: transactionId.');
          }
          const budgetItemId = Number(body.budgetItemId);
          if (!Number.isInteger(budgetItemId) || budgetItemId <= 0) {
            throw new PluginError(400, 'BAD_PARAMS', 'Missing or invalid required parameter: budgetItemId.');
          }

          const sureCfg = resolveSureConfig(ctx);
          const [state, meta, existingTxRows, existingTargetRows] = await Promise.all([
            loadTripContextAndPrune(ctx, tripId, true),
            loadSureMetadata(sureCfg),
            ctx.db.query('SELECT * FROM imports WHERE sure_transaction_id = ?', txId),
            ctx.db.query('SELECT * FROM imports WHERE trip_id = ? AND budget_item_id = ?', tripId, budgetItemId),
          ]);

          const targetItem = state.itemById.get(budgetItemId);
          if (!targetItem) {
            throw new PluginError(404, 'TARGET_NOT_FOUND', `TREK cost item #${budgetItemId} was not found on this trip.`);
          }
          if (existingTargetRows && existingTargetRows.length > 0) {
            throw new PluginError(409, 'TARGET_ALREADY_MAPPED', 'This TREK cost item is already linked to a Sure transaction.');
          }

          for (const row of existingTxRows || []) {
            if (Number(row.trip_id) === tripId) {
              throw new PluginError(409, 'TX_ALREADY_IMPORTED', 'This Sure transaction is already imported on this trip.');
            }
            const otherItems = await ctx.costs.getByTrip(Number(row.trip_id)).catch(() => null);
            if (Array.isArray(otherItems) && !otherItems.some((it) => Number(it.id) === Number(row.budget_item_id))) {
              await ctx.db.exec('DELETE FROM imports WHERE id = ?', row.id);
            } else {
              throw new PluginError(409, 'TX_ALREADY_IMPORTED', 'This Sure transaction is already imported in another trip.');
            }
          }

          const tx = await fetchTransactionById(sureCfg, txId);
          if (!tx) {
            throw new PluginError(404, 'TX_NOT_FOUND', `Transaction ${txId} was not found in Sure.`);
          }
          if (tx.account_id && meta.cardIdSet.size > 0 && !meta.cardIdSet.has(tx.account_id)) {
            throw new PluginError(400, 'NOT_CREDIT_CARD', `Transaction ${txId} does not belong to an active Sure credit card.`);
          }
          if (!isEligibleCardExpense(tx)) {
            throw new PluginError(400, 'NOT_EXPENSE', `Transaction ${txId} is not an eligible expense and cannot replace a trip cost.`);
          }
          const corr = correlateCandidate(tx, state.items, state.planTargets, state.rawTripCurrency, state.rates);
          const txAmount = round2(Number(tx.amount));
          const txCurrency = normalizeCurrency(tx.currency) || 'USD';
          const txDate = normalizeDate(tx.date) || normalizeDate(targetItem.expense_date) || state.startDate;
          const txName = String(tx.name || '').trim() || 'Card expense';
          const keptName = String(targetItem.name || '').trim() || txName;
          const keptCategory = String(targetItem.category || '').trim() || mapCategory(tx.category, corr.planMatch && corr.planMatch.type);
          const provenance = buildProvenanceNote(txId, txAmount, txCurrency);
          const nextNote = replaceProvenanceLine(targetItem.note, provenance);

          const updatePayload = {
            name: keptName,
            category: keptCategory,
            total_price: txAmount,
            currency: txCurrency,
            expense_date: txDate,
            note: nextNote,
          };
          // TREK's freezeForeignRate returns early without resetting exchange_rate when updating into the trip currency.
          if (state.rawTripCurrency && txCurrency === state.rawTripCurrency) {
            updatePayload.exchange_rate = 1;
          }
          const actingUserId = req.user && req.user.id != null ? Number(req.user.id) : null;
          if (actingUserId && Number.isFinite(actingUserId)) {
            updatePayload.payers = [{ user_id: actingUserId, amount: txAmount }];
          }

          const splitInfo = inspectItemSplit(targetItem);
          let rescaledShares = null;
          let customSharesJson = null;
          if (splitInfo.kind === 'custom') {
            rescaledShares = rescaleCustomShares(splitInfo.shares, txAmount);
            const nextMembers = rescaledShares.map((s) => ({
              user_id: s.user_id,
              amount: s.afterAmount,
            }));
            updatePayload.members = nextMembers;
            customSharesJson = JSON.stringify(nextMembers);
          }

          const rollbackPayload = {
            name: targetItem.name,
            category: targetItem.category,
            total_price: Number(targetItem.total_price),
            currency: targetItem.currency ?? null,
            exchange_rate: Number(targetItem.exchange_rate) || 1,
            expense_date: targetItem.expense_date ?? null,
            note: targetItem.note ?? null,
          };
          if (Array.isArray(targetItem.payers)) {
            rollbackPayload.payers = targetItem.payers.map((p) => ({ user_id: Number(p.user_id), amount: Number(p.amount) }));
          }
          if (splitInfo.kind === 'custom' && Array.isArray(targetItem.members)) {
            rollbackPayload.members = targetItem.members.map((m) => ({
              user_id: Number(m.user_id),
              amount: m.amount != null ? Number(m.amount) : null,
            }));
          }

          const updatedItem = await ctx.costs.update(tripId, budgetItemId, updatePayload);
          const storedRate = (state.rawTripCurrency && txCurrency === state.rawTripCurrency)
            ? 1
            : (Number(updatedItem && updatedItem.exchange_rate) || 1);
          const nowIso = new Date().toISOString();

          try {
            await ctx.db.tx([
              {
                sql: `INSERT INTO imports (
                  trip_id, sure_transaction_id, budget_item_id, imported_at,
                  amount, currency, exchange_rate, item_currency,
                  snap_name, snap_amount, snap_date, snap_classification, snap_is_transfer,
                  trek_name, custom_shares_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [
                  tripId,
                  txId,
                  budgetItemId,
                  nowIso,
                  txAmount,
                  txCurrency,
                  storedRate,
                  txCurrency,
                  txName,
                  txAmount,
                  txDate,
                  String(tx.classification || 'expense'),
                  tx.is_transfer ? 1 : 0,
                  keptName,
                  customSharesJson,
                ],
              },
            ]);
          } catch (dbErr) {
            await ctx.costs.update(tripId, budgetItemId, rollbackPayload).catch(() => {});
            const msg = (dbErr && dbErr.message) || '';
            if (msg.includes('UNIQUE')) {
              throw new PluginError(409, 'TX_ALREADY_IMPORTED', 'This Sure transaction was concurrently imported.');
            }
            throw dbErr;
          }

          return json(200, {
            replaced: true,
            sureTransactionId: txId,
            budgetItemId,
            name: keptName,
            beforeAmount: round2(Number(targetItem.total_price) || 0),
            beforeCurrency: normalizeCurrency(targetItem.currency) || state.rawTripCurrency || txCurrency,
            totalPrice: txAmount,
            itemCurrency: txCurrency,
            splitRescaled: rescaledShares,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },

    // Unlink a mapping without ever calling Sure; optionally also delete the TREK budget item.
    {
      method: 'DELETE',
      path: '/imports',
      auth: true,
      async handler(req, ctx) {
        try {
          const body = parseBody(req.body);
          const tripId = requireTripId(req, body);
          const mappingId = requireMappingId(req, body);
          const rawDel = (req.query && req.query.deleteBudgetItem) ?? body.deleteBudgetItem;
          const deleteBudgetItem = rawDel === true || rawDel === 'true' || rawDel === '1';

          const trip = await ctx.trips.getById(tripId);
          if (!trip) {
            throw new PluginError(404, 'TRIP_NOT_FOUND', 'Trip not found.');
          }
          const rows = await ctx.db.query('SELECT * FROM imports WHERE id = ? AND trip_id = ?', mappingId, tripId);
          const row = rows && rows[0];
          if (!row) {
            throw new PluginError(404, 'MAPPING_NOT_FOUND', 'Import mapping not found on this trip.');
          }

          let budgetItemDeleted = false;
          if (deleteBudgetItem) {
            await ctx.costs.delete(tripId, Number(row.budget_item_id));
            budgetItemDeleted = true;
          }

          // shortcut: TREK exposes no read-side budget_edit check, so a read-only trip member can
          // unlink a mapping (recoverable by re-importing); upgrade when rights are readable.
          await ctx.db.exec('DELETE FROM imports WHERE id = ? AND trip_id = ?', mappingId, tripId);
          return json(200, {
            unlinked: true,
            id: mappingId,
            sureTransactionId: String(row.sure_transaction_id),
            budgetItemId: Number(row.budget_item_id),
            budgetItemDeleted,
          });
        } catch (err) {
          return errorResponse(err, ctx);
        }
      },
    },
  ],
});

module.exports = pluginDefinition;
module.exports.correlateCandidate = correlateCandidate;
module.exports.findDuplicateItem = findDuplicateItem;
module.exports.classifyDrift = classifyDrift;
module.exports.isEditedInTrek = isEditedInTrek;
module.exports.resolveCreditCards = resolveCreditCards;
module.exports.resolveLinkedCards = resolveCreditCards;
module.exports.normalizeSureBaseUrl = normalizeSureBaseUrl;
module.exports.normalizeRestTx = normalizeRestTx;
module.exports.addDays = addDays;
module.exports.inspectItemSplit = inspectItemSplit;
module.exports.rescaleCustomShares = rescaleCustomShares;
module.exports._clearMetaCache = () => metaCache.clear();
