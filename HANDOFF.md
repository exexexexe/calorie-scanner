# Handoff — nutrition/barcode module

This repo is a **working, deployed** barcode calorie tracker. It is being folded
into a larger fitness app as one feature alongside pace, HR and sleep score.

**Do not rebuild it from scratch.** Everything here is tested against the live
Open Food Facts API and a real deploy. Read this file, then integrate.

- Root: `/Users/sapper/calorie-scanner`
- Live: https://web-production-94c1d.up.railway.app
- Railway: project `calorie-scanner` (`28f731dc-78ce-48a8-a149-52037abc66ec`),
  service `web`, volume `calorie-data` at `/data`
- Git: one commit, clean tree.

## File map

| Path | Lines | What it is | Portable? |
| --- | --- | --- | --- |
| `server.js` | 219 | Express app: API routes, static hosting, cache headers | Routes yes, hosting probably not |
| `lib/off.js` | 209 | Open Food Facts client: lookup, search, normalisation, caching | **Yes — take this whole file** |
| `lib/db.js` | 169 | SQLite schema + queries (`node:sqlite`, no native deps) | Swap engine, keep the interface |
| `public/app.js` | 1153 | SPA: rendering, scanner, offline queue | Scanner section yes, rest depends on your stack |
| `public/index.html` | 592 | Shell + all CSS | Only if you keep a web view |
| `public/vendor/zxing.min.js` | — | Bundled barcode decoder, deliberately **not** a CDN link | **Yes** |
| `public/sw.js`, `manifest.webmanifest`, `icon-*` | — | PWA bits | Only for a standalone web app |
| `scripts/make-icons.py`, `scripts/make-test-barcode.py` | — | Generators; the barcode one is how you test scanning without a product | Useful |
| `railway.json`, `.node-version` | — | Deploy config. **Node 24+ is required** (`node:sqlite`) | Deploy-specific |

## The three integration seams

### 1. Identity — the only real coupling

There are no accounts. Every row is keyed by a random `device_id` the browser
generates and sends as an `X-Device-Id` header.

- Middleware: `server.js:22-30` (`requireDevice`)
- Client: `public/app.js:7-40`
- Column: `device_id` in both tables (`lib/db.js`)

To adopt your app's auth: replace `requireDevice` with your session middleware
so it sets `req.deviceId` to your user id, and rename the column to `user_id`.
Nothing else in the stack cares.

### 2. Storage — one file

`lib/db.js` exports exactly nine functions. If your app is on Postgres, rewrite
this file only; the signatures are the contract.

```
getProfile(id)              saveProfile(id, profile)
listEntries(id, date)       addEntry(id, entry)       deleteEntry(id, entryId)
getHistory(id, sinceDate)   getRecents(id, limit)
cacheGet(key)               cacheSet(key, value, ttlMs)
```

Schema is at the top of `lib/db.js`: `profiles`, `entries`, `cache`.
Dates are local `YYYY-MM-DD` strings computed **on the client** — deliberate, so
an entry logged at 11pm doesn't land on tomorrow. Don't switch to server UTC.

### 3. Routes — mount under a prefix

All in `server.js`. Move them under e.g. `/api/nutrition/*` and update the
handful of `fetch` calls in `public/app.js` (section "api", line 41).

```
GET    /api/state?date=      boot payload (profile + entries + recents + history)
GET    /api/lookup/:barcode  product by barcode
GET    /api/search?q=        food search
GET    /api/profile          PUT to save
GET    /api/entries?date=    POST to add
DELETE /api/entries/:id
GET    /api/history?days=
GET    /api/recents
GET    /healthz
```

`/api/state` exists to make cold start one request instead of four. Keep it.

## If the host app is native or React

Take `lib/off.js` and `public/vendor/zxing.min.js` and drop the rest of the
frontend. The scanner logic worth porting is `public/app.js:736-1000`:

- native `BarcodeDetector` when present (Android Chrome), ZXing fallback
  otherwise (**iOS Safari has no BarcodeDetector** — the fallback is the iOS path)
- rear camera via `facingMode: {exact:'environment'}` with a graceful retry
- torch toggle through `track.applyConstraints({advanced:[{torch:true}]})`
- decode on a **cropped, downscaled** canvas (~10fps), not the full frame
- 3-second same-code debounce so one barcode doesn't log twice

The food shape `normalizeProduct()` returns (`lib/off.js:84`) is what the whole
UI speaks. Keep it if you can:

```js
{ source, barcode, name, brand, image, quantity,
  servingLabel, servingGrams,
  per100:     { kcal, protein, carbs, fat } | null,
  perServing: { kcal, protein, carbs, fat } | null }
```

Products with no usable energy value are filtered out entirely — they are noise
in a calorie tracker.

## Already solved — don't rediscover these

- **iOS camera silently does nothing** on a non-HTTPS origin. `getUserMedia`
  needs a secure context; `file://` fails. There is an explicit error state.
- **OFF search is two backends.** The fast cluster (`search.openfoodfacts.org`)
  is well ranked but returned *one* hit for "banana"; the old
  `/cgi/search.pl` is broad but poorly ranked and slow. `searchFoods()` merges
  them when the first pass is thin. Don't simplify back to one.
- **OFF needs a `User-Agent`** or it throttles you (`OFF_USER_AGENT`).
- **`[hidden]` loses to class rules.** `.field{display:flex}` outranks the UA
  `[hidden]` rule. There is a global `[hidden]{display:none!important}` in
  `index.html` — keep an equivalent.
- **`app.js` must not be cached long.** It was `max-age=3600`, which left users
  on old JS against a new API after a deploy. Now `no-cache` + ETag, and the
  service worker fetches it network-first.
- **`video.play()` can hang** until the first frame on some devices. It is
  raced against a 3s timeout.
- **Railway domain targets port 2020**, so `PORT=2020`. The volume must be
  mounted at `/data` or the log resets on every deploy.

## Deliberately not built

No accounts, no cross-device sync beyond pasting the device key, no editing an
entry after logging (delete and re-add), no meal grouping
(breakfast/lunch/dinner), no water or weight tracking, no exercise/HR/sleep —
that is the host app's job.

Macro goals are a hardcoded 30/40/30 split of the calorie target
(`public/app.js`, `renderSummary`). If the host app has real macro targets,
that is the line to change.
