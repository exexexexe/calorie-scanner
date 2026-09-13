import { cacheGet, cacheSet } from './db.js';

// Open Food Facts asks every client to identify itself; anonymous traffic gets throttled.
const UA = process.env.OFF_USER_AGENT ||
  'CalorieScanner/1.0 (https://github.com/sapper/calorie-scanner)';

const PRODUCT_TTL = 7 * 24 * 60 * 60 * 1000; // products barely change
const SEARCH_TTL = 6 * 60 * 60 * 1000;

const FIELDS = [
  'code', 'product_name', 'product_name_en', 'generic_name', 'brands',
  'serving_size', 'serving_quantity', 'nutriments', 'quantity',
  'image_front_small_url', 'image_small_url'
].join(',');

async function getJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!type.includes('json')) throw new Error(`expected JSON, got ${type}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** Pull kcal out of a nutriments blob, converting from kJ when kcal is absent. */
function energyKcal(nutr, suffix) {
  const kcal = num(nutr[`energy-kcal${suffix}`]);
  if (kcal !== null) return kcal;
  const kj = num(nutr[`energy-kj${suffix}`]) ?? num(nutr[`energy${suffix}`]);
  if (kj !== null) return kj / 4.184;
  return null;
}

function macros(nutr, suffix) {
  return {
    kcal: energyKcal(nutr, suffix),
    protein: num(nutr[`proteins${suffix}`]),
    carbs: num(nutr[`carbohydrates${suffix}`]),
    fat: num(nutr[`fat${suffix}`])
  };
}

/** "28 g (1 ONZ)" / "2 cookies (30g)" -> 28 / 30 */
function parseServingGrams(product) {
  const q = num(product.serving_quantity);
  if (q && q > 0) return q;
  const raw = product.serving_size;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/([\d.,]+)\s*(g|ml)\b/i);
  if (!m) return null;
  const grams = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(grams) && grams > 0 ? grams : null;
}

function pickName(p) {
  const name = p.product_name || p.product_name_en || p.generic_name || '';
  return String(name).trim() || null;
}

function brandOf(p) {
  const b = Array.isArray(p.brands) ? p.brands[0] : p.brands;
  if (!b) return null;
  return String(b).split(',')[0].trim() || null;
}

/**
 * Normalise an OFF product into the single shape the client understands.
 * Returns null for products with no usable energy value — they are noise in a
 * calorie tracker, so we filter them out of search results entirely.
 */
export function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const name = pickName(p);
  if (!name) return null;

  const nutr = p.nutriments || {};
  const per100 = macros(nutr, '_100g');
  const perServingRaw = macros(nutr, '_serving');
  const servingGrams = parseServingGrams(p);

  // Fall back to scaling the 100 g figures when OFF has no per-serving values.
  let perServing = perServingRaw.kcal !== null ? perServingRaw : null;
  if (!perServing && per100.kcal !== null && servingGrams) {
    const f = servingGrams / 100;
    perServing = {
      kcal: per100.kcal * f,
      protein: per100.protein !== null ? per100.protein * f : null,
      carbs: per100.carbs !== null ? per100.carbs * f : null,
      fat: per100.fat !== null ? per100.fat * f : null
    };
  }

  if (per100.kcal === null && !perServing) return null;

  return {
    source: 'off',
    barcode: p.code ? String(p.code) : null,
    name,
    brand: brandOf(p),
    image: p.image_front_small_url || p.image_small_url || null,
    quantity: p.quantity || null,
    servingLabel: typeof p.serving_size === 'string' ? p.serving_size.trim() || null : null,
    servingGrams,
    per100: per100.kcal !== null ? per100 : null,
    perServing
  };
}

/* ------------------------------- lookup ------------------------------- */

export async function lookupBarcode(code) {
  const key = `product:${code}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;

  const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`;
  const data = await getJSON(url);

  if (data.status === 0 || !data.product) {
    cacheSet(key, false, 60 * 60 * 1000); // remember misses briefly too
    return false;
  }
  const food = normalizeProduct(data.product);
  const result = food ?? false;
  cacheSet(key, result, PRODUCT_TTL);
  return result;
}

/* ------------------------------- search ------------------------------- */

// Primary: the dedicated search cluster. It is much faster and far less prone
// to the 503s that the main site's /cgi/search.pl returns under load.
async function searchViaSearchalicious(q, pageSize) {
  const url = 'https://search.openfoodfacts.org/search' +
    `?q=${encodeURIComponent(q)}&page_size=${pageSize}` +
    `&fields=${encodeURIComponent(FIELDS)}`;
  const data = await getJSON(url, 8000);
  return Array.isArray(data.hits) ? data.hits : [];
}

async function searchViaCgi(q, pageSize) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl' +
    `?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1` +
    `&page_size=${pageSize}&fields=${encodeURIComponent(FIELDS)}`;
  const data = await getJSON(url, 12000);
  return Array.isArray(data.products) ? data.products : [];
}

export async function searchFoods(query, pageSize = 24) {
  const q = query.trim();
  if (!q) return [];

  const key = `search:${pageSize}:${q.toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;

  let raw = [];
  let primaryFailed = false;
  try {
    raw = await searchViaSearchalicious(q, pageSize);
  } catch (err) {
    console.warn('[off] search-a-licious failed:', err.message);
    primaryFailed = true;
  }

  // The fast endpoint is well ranked but returns very little for some common
  // terms ("banana" gives a single hit). Top up from the older, broader index
  // whenever the first pass is thin, so a plain word search is never empty.
  if (primaryFailed || raw.length < 8) {
    try {
      const extra = await searchViaCgi(q, pageSize);
      const have = new Set(raw.map((p) => String(p.code)));
      for (const p of extra) {
        if (!have.has(String(p.code))) raw.push(p);
      }
    } catch (err) {
      console.warn('[off] cgi search failed:', err.message);
    }
  }

  const seen = new Set();
  const foods = [];
  for (const p of raw) {
    const food = normalizeProduct(p);
    if (!food) continue;
    const dedupe = `${food.name.toLowerCase()}|${(food.brand || '').toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    foods.push(food);
    if (foods.length >= pageSize) break;
  }

  // Only cache real results; an outage must not be remembered for six hours.
  if (foods.length) cacheSet(key, foods, SEARCH_TTL);
  return foods;
}
