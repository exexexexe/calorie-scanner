import express from 'express';
import compression from 'compression';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  getProfile, saveProfile, listEntries, addEntry, deleteEntry,
  getHistory, getRecents
} from './lib/db.js';
import { lookupBarcode, searchFoods } from './lib/off.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '64kb' }));

/* ----------------------------- middleware ----------------------------- */

// The app has no accounts: a device id generated in the browser owns the data.
function requireDevice(req, res, next) {
  const id = req.get('X-Device-Id') || req.query.device;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    return res.status(400).json({ error: 'A valid X-Device-Id header is required.' });
  }
  req.deviceId = id;
  next();
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

const clamp = (v, lo, hi, fallback) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

// Wrap async handlers so a rejected promise becomes a 500 instead of a hang.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------------------- rate limiting --------------------------- */

/* The app has no accounts, so there is nobody to bill and nobody to ban —
   the only thing standing between a public URL and a full volume is this.
   Two separate budgets, because the two abuses are different: writes cost
   disk here, and lookups cost somebody else's bandwidth at Open Food Facts,
   who ask nicely that you not hammer them. Fixed windows rather than a
   token bucket; the failure mode of a fixed window is that you can spend
   two windows' worth across a boundary, which at these numbers is fine.

   In memory, so it resets on deploy and does not survive more than one
   replica. Both are acceptable for a single-instance personal tracker and
   would not be for anything larger. */
const buckets = new Map();

function rateLimit({ max, windowMs, name }) {
  return (req, res, next) => {
    const key = name + ':' + (req.ip || 'unknown');
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    const left = Math.max(0, max - b.count);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(left));
    res.set('X-RateLimit-Reset', String(Math.ceil(b.reset / 1000)));
    if (b.count > max) {
      const secs = Math.ceil((b.reset - now) / 1000);
      res.set('Retry-After', String(secs));
      return res.status(429).json({
        error: 'Too many requests. Try again in ' + secs + 's.'
      });
    }
    next();
  };
}

// Sweep expired buckets so a long uptime does not grow the map without end.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}, 10 * 60 * 1000).unref();

const HOUR = 60 * 60 * 1000;
const limitWrites = rateLimit({ max: 120, windowMs: HOUR, name: 'w' });
const limitUpstream = rateLimit({ max: 300, windowMs: HOUR, name: 'u' });

/* ------------------------------- health ------------------------------- */

app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* ------------------------------ food data ----------------------------- */

app.get('/api/lookup/:barcode', limitUpstream, wrap(async (req, res) => {
  const code = String(req.params.barcode).replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) {
    return res.status(400).json({ error: 'That barcode does not look valid.' });
  }
  try {
    const food = await lookupBarcode(code);
    if (!food) {
      return res.status(404).json({ error: 'No product found for that barcode.', barcode: code });
    }
    res.json({ food });
  } catch (err) {
    console.error('[lookup]', err.message);
    res.status(502).json({ error: 'Open Food Facts is not responding. Try again in a moment.' });
  }
}));

app.get('/api/search', limitUpstream, wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ foods: [] });
  try {
    const foods = await searchFoods(q, clamp(req.query.limit, 1, 40, 24));
    res.json({ foods });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: 'Search is unavailable right now. Try again in a moment.' });
  }
}));

/* ------------------------------- profile ------------------------------ */

function sanitizeProfile(body) {
  const sex = body.sex === 'female' ? 'female' : 'male';
  const goal = ['lose', 'maintain', 'gain'].includes(body.goal) ? body.goal : 'maintain';
  const age = Math.round(clamp(body.age, 10, 100, 30));
  const weight = clamp(body.weight, 25, 300, 70);
  const height = clamp(body.height, 100, 250, 175);
  const activity = clamp(body.activity, 1.2, 1.9, 1.55);

  // Mifflin-St Jeor, then an activity multiplier and a goal adjustment.
  let bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'male' ? 5 : -161);
  let target = Math.round(bmr * activity);
  if (goal === 'lose') target -= 500;
  if (goal === 'gain') target += 300;
  target = Math.max(1000, target);

  // An explicit custom target always wins over the calculated one.
  const custom = clamp(body.target, 800, 8000, null);
  if (body.useCustomTarget && custom) target = Math.round(custom);

  return { sex, age, weight, height, activity, goal, target };
}

app.get('/api/profile', requireDevice, (req, res) => {
  res.json({ profile: getProfile(req.deviceId) });
});

app.put('/api/profile', limitWrites, requireDevice, (req, res) => {
  const profile = saveProfile(req.deviceId, sanitizeProfile(req.body || {}));
  res.json({ profile });
});

/* ------------------------------- entries ------------------------------ */

function sanitizeEntry(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) return { error: 'A food name is required.' };

  const kcal = clamp(body.kcal, 0, 20000, null);
  if (kcal === null) return { error: 'A calorie value is required.' };

  const optional = (v) => {
    const n = clamp(v, 0, 5000, null);
    return n === null ? null : Math.round(n * 10) / 10;
  };

  return {
    entry: {
      id: crypto.randomUUID(),
      date: isDate(body.date) ? body.date : new Date().toISOString().slice(0, 10),
      name,
      brand: body.brand ? String(body.brand).trim().slice(0, 80) : null,
      barcode: body.barcode ? String(body.barcode).replace(/\D/g, '').slice(0, 14) || null : null,
      kcal: Math.round(kcal),
      protein: optional(body.protein),
      carbs: optional(body.carbs),
      fat: optional(body.fat),
      amount: clamp(body.amount, 0, 10000, null),
      unit: ['g', 'ml', 'serving'].includes(body.unit) ? body.unit : null,
      serving_label: body.servingLabel ? String(body.servingLabel).trim().slice(0, 80) : null,
      created_at: new Date().toISOString()
    }
  };
}

app.get('/api/entries', requireDevice, (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  res.json({ date, entries: listEntries(req.deviceId, date) });
});

app.post('/api/entries', limitWrites, requireDevice, (req, res) => {
  const { entry, error } = sanitizeEntry(req.body || {});
  if (error) return res.status(400).json({ error });
  res.status(201).json({ entry: addEntry(req.deviceId, entry) });
});

app.delete('/api/entries/:id', limitWrites, requireDevice, (req, res) => {
  const ok = deleteEntry(req.deviceId, String(req.params.id));
  if (!ok) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ ok: true });
});

/* -------------------------- history + recents ------------------------- */

app.get('/api/history', requireDevice, (req, res) => {
  const days = Math.round(clamp(req.query.days, 1, 90, 14));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  res.json({ history: getHistory(req.deviceId, since) });
});

app.get('/api/recents', requireDevice, (req, res) => {
  res.json({ recents: getRecents(req.deviceId, Math.round(clamp(req.query.limit, 1, 50, 20))) });
});

/* ---------------------------- boot payload ---------------------------- */

// One request on startup instead of four: keeps the app usable on slow mobile data.
app.get('/api/state', requireDevice, (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  res.json({
    date,
    profile: getProfile(req.deviceId),
    entries: listEntries(req.deviceId, date),
    recents: getRecents(req.deviceId, 12),
    history: getHistory(req.deviceId, since)
  });
});

/* ------------------------------- static ------------------------------- */

app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    // The shell, worker and app code must revalidate, or a redeploy leaves
    // users running old JavaScript against a new API. ETags keep this cheap.
    if (/(index\.html|sw\.js|app\.js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\/vendor\//.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});
