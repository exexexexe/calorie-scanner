/* Scan & Track — client app */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ============================ device identity ===========================
   * No accounts: a random key generated once identifies this device's data.
   * It is shown in Settings so a log can be restored on another phone.
   * ====================================================================== */
  const KEY_DEVICE = 'cs.device';
  const KEY_CACHE = 'cs.cache';
  const KEY_QUEUE = 'cs.queue';

  function store(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private mode / quota — the server is still the source of truth */ }
  }
  function load(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  }

  function newKey() {
    if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  let deviceId = load(KEY_DEVICE);
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(deviceId)) {
    deviceId = newKey();
    store(KEY_DEVICE, deviceId);
  }

  /* ================================= api ================================= */

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'X-Device-Id': deviceId,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ================================ state ================================ */

  const state = {
    date: todayStr(),
    profile: null,
    entries: [],
    recents: [],
    history: [],
    food: null,        // food currently shown in the portion sheet
    online: navigator.onLine
  };

  function todayStr(d = new Date()) {
    // Local calendar date, not UTC — otherwise evening entries land on tomorrow.
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return t.toISOString().slice(0, 10);
  }
  function shiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return todayStr(d);
  }
  function prettyDate(dateStr) {
    if (dateStr === todayStr()) return 'Today';
    if (dateStr === shiftDate(todayStr(), -1)) return 'Yesterday';
    return new Date(dateStr + 'T12:00:00')
      .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  const round = (n) => Math.round(Number(n) || 0);
  const targetOf = () => state.profile?.target || 0;

  /* ================================ toast ================================ */

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function buzz(ms = 30) {
    try { navigator.vibrate?.(ms); } catch { /* unsupported */ }
  }

  /* ============================== rendering ============================== */

  function renderAll() {
    renderHeader();
    renderSummary();
    renderEntries();
    renderWeek();
    renderRecents();
  }

  function renderHeader() {
    const onToday = currentView === 'today';
    $('top-title').textContent = onToday ? prettyDate(state.date)
      : currentView === 'add' ? 'Add food' : 'You';
    $('date-nav').style.visibility = onToday ? 'visible' : 'hidden';
    $('next-day').disabled = state.date >= todayStr();

    const eaten = totals().kcal;
    const t = targetOf();
    $('top-sub').textContent = t
      ? `${eaten.toLocaleString()} of ${t.toLocaleString()} kcal`
      : 'Set your target in the You tab';
  }

  function totals() {
    return state.entries.reduce((acc, e) => ({
      kcal: acc.kcal + (e.kcal || 0),
      protein: acc.protein + (e.protein || 0),
      carbs: acc.carbs + (e.carbs || 0),
      fat: acc.fat + (e.fat || 0)
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }

  const CIRC = 2 * Math.PI * 50; // r=50 in the SVG

  function renderSummary() {
    const t = totals();
    const target = targetOf();
    const eaten = round(t.kcal);

    $('stat-eaten').textContent = eaten.toLocaleString();
    $('stat-target').textContent = target ? target.toLocaleString() : '—';
    $('stat-items').textContent = state.entries.length;

    const remaining = target - eaten;
    $('ring-num').textContent = target ? Math.abs(round(remaining)).toLocaleString() : '—';
    $('ring-label').textContent = !target ? 'no target' : remaining >= 0 ? 'left' : 'over';

    const pct = target ? Math.min(1, eaten / target) : 0;
    $('ring-prog').setAttribute('stroke-dasharray', `${(pct * CIRC).toFixed(1)} ${CIRC.toFixed(1)}`);
    $('ring').classList.toggle('over', target > 0 && eaten > target);

    // Macro goals: a conventional 30/40/30 split of the calorie target.
    const goals = target
      ? { protein: (target * 0.30) / 4, carbs: (target * 0.40) / 4, fat: (target * 0.30) / 9 }
      : { protein: 0, carbs: 0, fat: 0 };
    for (const m of ['protein', 'carbs', 'fat']) {
      $(`m-${m}`).textContent = `${round(t[m])} g`;
      const w = goals[m] ? Math.min(100, (t[m] / goals[m]) * 100) : 0;
      $(`mb-${m}`).style.width = `${w}%`;
    }
  }

  function renderEntries() {
    const list = $('entry-list');
    $('log-count').textContent = state.entries.length
      ? `${state.entries.length} item${state.entries.length === 1 ? '' : 's'}` : '';

    if (!state.entries.length) {
      list.innerHTML = '<p class="empty">Nothing logged yet. Tap <b>Scan</b> to add something.</p>';
      return;
    }

    list.textContent = '';
    for (const e of state.entries) {
      const row = document.createElement('div');
      row.className = 'entry';

      const main = document.createElement('div');
      main.className = 'entry-main';
      const name = document.createElement('div');
      name.className = 'entry-name';
      name.textContent = e.name;
      const sub = document.createElement('div');
      sub.className = 'entry-sub';
      sub.textContent = [
        e.brand,
        portionLabel(e),
        e.pending ? 'not synced yet' : null
      ].filter(Boolean).join(' · ');
      main.append(name, sub);

      const kcal = document.createElement('div');
      kcal.className = 'entry-kcal';
      kcal.textContent = `${round(e.kcal)}`;

      const del = document.createElement('button');
      del.className = 'entry-del';
      del.type = 'button';
      del.setAttribute('aria-label', `Remove ${e.name}`);
      del.textContent = '✕';
      del.addEventListener('click', () => removeEntry(e));

      row.append(main, kcal, del);
      list.append(row);
    }
  }

  function portionLabel(e) {
    if (!e.amount || !e.unit) return null;
    const amt = Number(e.amount);
    const pretty = Number.isInteger(amt) ? amt : amt.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    if (e.unit === 'serving') {
      return `${pretty} × ${e.serving_label || e.servingLabel || 'serving'}`;
    }
    return `${pretty} ${e.unit}`;
  }

  function renderWeek() {
    const wrap = $('week');
    wrap.textContent = '';
    const byDate = new Map(state.history.map((h) => [h.date, h]));
    const target = targetOf();
    const max = Math.max(target || 0, ...state.history.map((h) => h.kcal || 0), 1);

    for (let i = 6; i >= 0; i--) {
      const date = shiftDate(todayStr(), -i);
      const kcal = byDate.get(date)?.kcal || 0;
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'day';
      if (kcal > 0) day.classList.add('has');
      if (target && kcal > target) day.classList.add('over');
      if (date === state.date) day.classList.add('today');
      day.title = `${prettyDate(date)}: ${round(kcal)} kcal`;
      day.setAttribute('aria-label', day.title);

      const col = document.createElement('div');
      col.className = 'col';
      col.style.height = `${Math.max(3, (kcal / max) * 52)}px`;
      const lbl = document.createElement('small');
      lbl.textContent = new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'narrow' });

      day.append(col, lbl);
      day.addEventListener('click', () => goToDate(date));
      wrap.append(day);
    }
  }

  function renderRecents() {
    const card = $('recents-card');
    const wrap = $('recents');
    if (!state.recents.length) { card.hidden = true; return; }
    card.hidden = false;
    wrap.textContent = '';
    for (const r of state.recents) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = r.name;
      const kcal = document.createElement('b');
      kcal.textContent = `${round(r.kcal)}`;
      chip.append(label, kcal);
      chip.addEventListener('click', () => {
        addEntry({
          name: r.name, brand: r.brand, barcode: r.barcode, kcal: r.kcal,
          protein: r.protein, carbs: r.carbs, fat: r.fat,
          amount: r.amount, unit: r.unit, servingLabel: r.serving_label
        });
        toast(`Added ${r.name}`);
      });
      wrap.append(chip);
    }
  }

  /* =============================== entries =============================== */

  async function addEntry(payload) {
    const body = { ...payload, date: state.date };
    const temp = {
      id: `tmp_${newKey()}`,
      ...body,
      serving_label: body.servingLabel ?? null,
      kcal: round(body.kcal),
      created_at: new Date().toISOString(),
      pending: true
    };
    state.entries.push(temp);
    bumpHistory(round(body.kcal));
    renderAll();
    buzz();

    try {
      const { entry } = await api('/api/entries', { method: 'POST', body: JSON.stringify(body) });
      const i = state.entries.findIndex((e) => e.id === temp.id);
      if (i !== -1) state.entries[i] = entry;
      renderAll();
      refreshRecents();
    } catch (err) {
      // Keep it on screen and retry when the connection comes back.
      queuePush({ tempId: temp.id, body });
      renderAll();
      toast(state.online ? 'Saved locally — will retry' : 'Offline — saved locally');
    }
    cacheState();
  }

  async function removeEntry(entry) {
    const i = state.entries.findIndex((e) => e.id === entry.id);
    if (i === -1) return;
    const [removed] = state.entries.splice(i, 1);
    bumpHistory(-round(removed.kcal));
    renderAll();
    cacheState();

    if (String(entry.id).startsWith('tmp_')) {
      queueRemove(entry.id);
      return;
    }
    try {
      await api(`/api/entries/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      refreshRecents();
    } catch (err) {
      if (err.status !== 404) {
        state.entries.splice(i, 0, removed); // put it back; the server still has it
        bumpHistory(round(removed.kcal));
        renderAll();
        toast('Could not remove — try again');
      }
    }
    cacheState();
  }

  function bumpHistory(delta) {
    const row = state.history.find((h) => h.date === state.date);
    if (row) row.kcal = Math.max(0, (row.kcal || 0) + delta);
    else if (delta > 0) state.history.unshift({ date: state.date, kcal: delta, items: 1 });
  }

  async function refreshRecents() {
    try {
      const { recents } = await api('/api/recents?limit=12');
      state.recents = recents;
      renderRecents();
      cacheState();
    } catch { /* non-critical */ }
  }

  /* ========================== offline write queue ========================= */

  function queuePush(item) {
    const q = load(KEY_QUEUE, []);
    q.push(item);
    store(KEY_QUEUE, q);
  }
  function queueRemove(tempId) {
    store(KEY_QUEUE, load(KEY_QUEUE, []).filter((i) => i.tempId !== tempId));
  }

  async function flushQueue() {
    const q = load(KEY_QUEUE, []);
    if (!q.length) return;
    const left = [];
    for (const item of q) {
      try {
        const { entry } = await api('/api/entries', { method: 'POST', body: JSON.stringify(item.body) });
        const i = state.entries.findIndex((e) => e.id === item.tempId);
        if (i !== -1) state.entries[i] = entry;
      } catch {
        left.push(item);
      }
    }
    store(KEY_QUEUE, left);
    if (left.length < q.length) {
      renderAll();
      cacheState();
      refreshRecents();
    }
  }

  /* ================================ cache ================================ */

  function cacheState() {
    store(KEY_CACHE, {
      date: state.date, profile: state.profile,
      entries: state.entries, recents: state.recents, history: state.history
    });
  }

  function hydrateFromCache() {
    const c = load(KEY_CACHE);
    if (!c) return false;
    state.profile = c.profile ?? null;
    state.recents = c.recents ?? [];
    state.history = c.history ?? [];
    if (c.date === state.date) state.entries = c.entries ?? [];
    return true;
  }

  /* ================================ views ================================ */

  let currentView = 'today';
  function showView(name) {
    currentView = name;
    for (const v of ['today', 'add', 'you']) {
      $(`view-${v}`).hidden = v !== name;
      $(`tab-${v}`).setAttribute('aria-selected', String(v === name));
    }
    renderHeader();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  async function goToDate(date) {
    if (date > todayStr()) return;
    const prevDate = state.date;
    const prevEntries = state.entries;
    state.date = date;
    state.entries = [];
    renderAll();
    try {
      const { entries } = await api(`/api/entries?date=${date}`);
      state.entries = entries;
      renderAll();
      cacheState();
    } catch {
      state.date = prevDate;
      state.entries = prevEntries;
      renderAll();
      toast('Could not load that day');
    }
  }

  /* =============================== profile =============================== */

  function profileFromForm() {
    return {
      sex: $('sex').value,
      age: Number($('age').value),
      weight: Number($('weight').value),
      height: Number($('height').value),
      activity: Number($('activity').value),
      goal: $('goal').value,
      useCustomTarget: $('use-custom').checked,
      target: Number($('custom-target').value) || null
    };
  }

  function fillProfileForm(p) {
    if (!p) return;
    $('sex').value = p.sex ?? 'male';
    $('age').value = p.age ?? 30;
    $('weight').value = p.weight ?? 70;
    $('height').value = p.height ?? 175;
    $('activity').value = String(p.activity ?? 1.55);
    $('goal').value = p.goal ?? 'maintain';
    $('target-value').textContent = p.target ? p.target.toLocaleString() : '—';

    // The server stores only the final number, so infer whether it was custom.
    if (p.target && p.target !== formulaTarget(p)) {
      $('use-custom').checked = true;
      $('custom-target-field').hidden = false;
      $('custom-target').value = p.target;
    }
  }

  function formulaTarget({ sex, weight, height, age, activity, goal }) {
    const bmr = 10 * weight + 6.25 * height - 5 * age + (sex === 'male' ? 5 : -161);
    let t = Math.round(bmr * activity);
    if (goal === 'lose') t -= 500;
    if (goal === 'gain') t += 300;
    return Math.max(1000, t);
  }

  // Mirrors the server formula so the number updates as you type.
  function previewTarget() {
    const f = profileFromForm();
    if (f.useCustomTarget && f.target) {
      $('target-value').textContent = round(f.target).toLocaleString();
      return;
    }
    const t = formulaTarget(f);
    $('target-value').textContent = Number.isFinite(t) ? t.toLocaleString() : '—';
  }

  async function saveProfile() {
    const status = $('profile-status');
    status.className = 'status';
    status.textContent = 'Saving…';
    try {
      const { profile } = await api('/api/profile', {
        method: 'PUT', body: JSON.stringify(profileFromForm())
      });
      state.profile = profile;
      fillProfileForm(profile);
      renderAll();
      cacheState();
      status.textContent = `Saved — target ${profile.target.toLocaleString()} kcal/day.`;
      toast('Target saved');
    } catch (err) {
      status.className = 'status error';
      status.textContent = err.message;
    }
  }

  /* ========================== search and lookup ========================== */

  const searchStatus = $('search-status');
  function setSearchStatus(msg, isError = false, spinner = false) {
    searchStatus.className = `status${isError ? ' error' : ''}`;
    searchStatus.textContent = '';
    if (spinner) {
      const s = document.createElement('span');
      s.className = 'spinner';
      s.style.marginRight = '8px';
      searchStatus.append(s);
    }
    searchStatus.append(document.createTextNode(msg));
  }

  let searchSeq = 0;
  async function doSearch(q) {
    q = q.trim();
    if (q.length < 2) { setSearchStatus('Type at least two characters.'); return; }
    const seq = ++searchSeq;
    setSearchStatus('Searching…', false, true);
    $('search-results').textContent = '';
    try {
      const { foods } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return; // a newer search already came back
      if (!foods.length) {
        setSearchStatus('No foods found. Try a brand name, or use Quick add below.');
        return;
      }
      setSearchStatus(`${foods.length} result${foods.length === 1 ? '' : 's'}`);
      renderResults(foods);
    } catch (err) {
      if (seq !== searchSeq) return;
      setSearchStatus(err.message, true);
    }
  }

  function renderResults(foods) {
    const wrap = $('search-results');
    wrap.textContent = '';
    for (const food of foods) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'result';

      if (food.image) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.loading = 'lazy';
        img.alt = '';
        img.src = food.image;
        img.addEventListener('error', () => img.replaceWith(placeholderThumb()));
        btn.append(img);
      } else {
        btn.append(placeholderThumb());
      }

      const main = document.createElement('div');
      main.className = 'result-main';
      const name = document.createElement('div');
      name.className = 'result-name';
      name.textContent = food.name;
      const sub = document.createElement('div');
      sub.className = 'result-sub';
      sub.textContent = [food.brand, food.quantity].filter(Boolean).join(' · ');
      main.append(name, sub);

      const kcal = document.createElement('div');
      kcal.className = 'result-kcal';
      const basis = food.per100 ? food.per100.kcal : food.perServing.kcal;
      kcal.textContent = round(basis);
      const small = document.createElement('small');
      small.textContent = food.per100 ? 'per 100g' : 'per serving';
      kcal.append(small);

      btn.append(main, kcal);
      btn.addEventListener('click', () => openPortion(food));
      wrap.append(btn);
    }
  }

  function placeholderThumb() {
    const d = document.createElement('div');
    d.className = 'thumb ph';
    d.textContent = '🍽';
    return d;
  }

  async function lookup(code, { fromScanner = false } = {}) {
    const clean = String(code).replace(/\D/g, '');
    if (clean.length < 6) {
      setSearchStatus('That barcode looks too short.', true);
      return false;
    }
    if (!fromScanner) setSearchStatus(`Looking up ${clean}…`, false, true);
    try {
      const { food } = await api(`/api/lookup/${clean}`);
      setSearchStatus('');
      openPortion(food);
      return true;
    } catch (err) {
      const msg = err.status === 404
        ? `No product found for ${clean}. Try searching by name, or use Quick add.`
        : err.message;
      if (fromScanner) scanMessage(msg, true);
      else setSearchStatus(msg, true);
      return false;
    }
  }

  /* ============================ portion sheet ============================ */

  let portionUnit = 'serving';

  function openPortion(food) {
    state.food = food;
    $('portion-name').textContent = food.name;
    $('portion-brand').textContent = [food.brand, food.quantity].filter(Boolean).join(' · ');

    const canServing = !!food.perServing;
    const canGrams = !!food.per100;
    const seg = $('unit-seg');
    seg.querySelector('[data-unit="serving"]').disabled = !canServing;
    seg.querySelector('[data-unit="g"]').disabled = !canGrams;

    portionUnit = canServing ? 'serving' : 'g';
    $('portion-amount').value = portionUnit === 'serving' ? 1 : (food.servingGrams || 100);
    syncUnitButtons();
    updatePortion();

    $('portion-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closePortion() {
    $('portion-backdrop').hidden = true;
    document.body.style.overflow = '';
    state.food = null;
  }

  function syncUnitButtons() {
    for (const b of $('unit-seg').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.unit === portionUnit));
    }
    const isServing = portionUnit === 'serving';
    $('portion-amount-label').textContent = isServing ? 'Number of servings' : 'Grams / ml';
    $('portion-amount').step = isServing ? '0.25' : '5';
  }

  function computePortion() {
    const food = state.food;
    if (!food) return null;
    const amount = Math.max(0, Number($('portion-amount').value) || 0);
    const base = portionUnit === 'serving' ? food.perServing : food.per100;
    if (!base) return null;
    const factor = portionUnit === 'serving' ? amount : amount / 100;
    const scale = (v) => (v === null || v === undefined ? null : v * factor);
    return {
      amount,
      kcal: (base.kcal || 0) * factor,
      protein: scale(base.protein),
      carbs: scale(base.carbs),
      fat: scale(base.fat)
    };
  }

  function updatePortion() {
    const p = computePortion();
    if (!p) return;
    const food = state.food;

    $('portion-kcal').textContent = round(p.kcal).toLocaleString();
    $('portion-basis').textContent = portionUnit === 'serving'
      ? `per serving${food.servingLabel ? ` · ${food.servingLabel}` : ''}`
      : 'per 100 g';

    const macros = $('portion-macros');
    macros.textContent = '';
    const parts = [['Protein', p.protein], ['Carbs', p.carbs], ['Fat', p.fat]]
      .filter(([, v]) => v !== null && v !== undefined);
    for (const [label, v] of parts) {
      const span = document.createElement('span');
      span.textContent = `${label} `;
      const b = document.createElement('b');
      b.textContent = `${Math.round(v * 10) / 10} g`;
      span.append(b);
      macros.append(span);
    }

    const target = targetOf();
    const pill = $('portion-pct');
    if (target > 0 && p.kcal > 0) {
      const pct = Math.round((p.kcal / target) * 100);
      pill.hidden = false;
      pill.textContent = `${pct}% of your daily target`;
      pill.classList.toggle('high', pct >= 25);
    } else {
      pill.hidden = true;
    }
    $('portion-add').disabled = !(p.kcal > 0);
  }

  function confirmPortion() {
    const p = computePortion();
    const food = state.food;
    if (!p || !food) return;
    addEntry({
      name: food.name,
      brand: food.brand,
      barcode: food.barcode,
      kcal: p.kcal,
      protein: p.protein,
      carbs: p.carbs,
      fat: p.fat,
      amount: p.amount,
      unit: portionUnit,
      servingLabel: portionUnit === 'serving' ? food.servingLabel : null
    });
    closePortion();
    toast(`Added ${round(p.kcal)} kcal`);
    showView('today');
  }

  /* =============================== scanner =============================== */

  const scanner = {
    stream: null,
    track: null,
    running: false,
    reader: null,
    hints: null,
    detector: null,
    canvas: null,
    ctx: null,
    lastCode: null,
    lastAt: 0,
    rafId: null
  };

  function scanMessage(msg, isError = false) {
    const el = $('scan-msg');
    el.textContent = msg;
    el.style.color = isError ? '#FCA5A5' : '#fff';
  }

  function scanError(title, message) {
    stopScanner({ keepOpen: true });
    $('scan-err-title').textContent = title;
    $('scan-err-msg').textContent = message;
    $('scan-err').hidden = false;
  }

  async function openScanner() {
    $('scanner').hidden = false;
    $('scan-err').hidden = true;
    document.body.style.overflow = 'hidden';
    scanMessage('Starting camera…');

    // getUserMedia only exists on HTTPS (or localhost) — the usual reason a
    // scanner "does nothing" when a page is opened from a file:// path.
    if (!window.isSecureContext) {
      scanError('Camera needs a secure connection',
        'Open this app over https:// (or on localhost). Cameras are blocked on insecure pages.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      scanError('Camera not supported',
        'This browser cannot open a camera. Try Safari or Chrome, or type the barcode number instead.');
      return;
    }

    try {
      await startCamera();
    } catch (err) {
      handleCameraError(err);
      return;
    }

    if (!(await setupDecoder())) return; // setupDecoder already showed the error
    scanner.running = true;
    scanMessage('Line the barcode up inside the frame.');
    tick();
  }

  async function startCamera() {
    const base = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      // Continuous focus matters a lot for close-up barcodes on phones.
      focusMode: 'continuous'
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...base, facingMode: { exact: 'environment' } }, audio: false
      });
    } catch {
      // Desktops and some phones have no rear camera — fall back to any camera.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...base, facingMode: { ideal: 'environment' } }, audio: false
      });
    }

    scanner.stream = stream;
    scanner.track = stream.getVideoTracks()[0];

    const video = $('scan-video');
    video.srcObject = stream;
    video.setAttribute('playsinline', '');   // iOS refuses to inline-play without this
    // Never block on play(): on some devices the promise settles only once the
    // first frame arrives, which would leave the UI stuck on "Starting camera".
    await Promise.race([
      video.play().catch(() => { /* autoplay attribute covers most cases */ }),
      new Promise((r) => setTimeout(r, 3000))
    ]);

    setupTorch();
  }

  function setupTorch() {
    const btn = $('torch-btn');
    btn.hidden = true;
    btn.setAttribute('aria-pressed', 'false');
    const caps = scanner.track?.getCapabilities?.();
    if (caps && 'torch' in caps && caps.torch) btn.hidden = false;
  }

  async function toggleTorch() {
    const btn = $('torch-btn');
    const on = btn.getAttribute('aria-pressed') === 'true';
    try {
      await scanner.track.applyConstraints({ advanced: [{ torch: !on }] });
      btn.setAttribute('aria-pressed', String(!on));
    } catch {
      toast('Flashlight not available');
    }
  }

  async function setupDecoder() {
    // Native detector where it exists (Android Chrome): faster and battery-cheap.
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const wanted = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'].filter((f) => supported.includes(f));
        if (wanted.length) {
          scanner.detector = new window.BarcodeDetector({ formats: wanted });
          return true;
        }
      } catch { /* fall through to ZXing */ }
    }

    if (!window.ZXing) {
      scanError('Scanner failed to load',
        'The barcode library did not load. Refresh the page, or type the barcode number instead.');
      return false;
    }
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
      Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
      Z.BarcodeFormat.CODE_128
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    scanner.hints = hints;
    scanner.reader = new Z.MultiFormatReader();
    scanner.reader.setHints(hints);
    scanner.canvas = document.createElement('canvas');
    scanner.ctx = scanner.canvas.getContext('2d', { willReadFrequently: true });
    return true;
  }

  function handleCameraError(err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      scanError('Camera permission denied',
        'Allow camera access for this site in your browser settings, then try again. On iPhone: AA menu → Website Settings → Camera.');
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      scanError('No camera found',
        'This device has no usable camera. You can type the barcode number instead.');
    } else if (name === 'NotReadableError') {
      scanError('Camera is busy',
        'Another app is using the camera. Close it and try again.');
    } else {
      scanError('Could not start the camera', err?.message || 'Unknown error.');
    }
  }

  /** Crop to the reticle band: faster to decode and ignores background clutter. */
  function drawFrame() {
    const video = $('scan-video');
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    const cropW = Math.round(vw * 0.8);
    const cropH = Math.round(vh * 0.45);
    const sx = Math.round((vw - cropW) / 2);
    const sy = Math.round((vh - cropH) / 2);

    // Cap the working width; full-resolution frames are needlessly slow to decode.
    const scale = Math.min(1, 800 / cropW);
    const w = Math.round(cropW * scale);
    const h = Math.round(cropH * scale);

    const c = scanner.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    scanner.ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, w, h);
    return c;
  }

  async function tick() {
    if (!scanner.running) return;

    const video = $('scan-video');
    if (video.readyState >= 2) {
      try {
        if (scanner.detector) {
          const found = await scanner.detector.detect(video);
          if (found.length) { onDecoded(found[0].rawValue); return; }
        } else if (scanner.reader) {
          const canvas = drawFrame();
          if (canvas) {
            const Z = window.ZXing;
            const source = new Z.HTMLCanvasElementLuminanceSource(canvas);
            const bitmap = new Z.BinaryBitmap(new Z.HybridBinarizer(source));
            try {
              const result = scanner.reader.decode(bitmap, scanner.hints);
              onDecoded(result.getText());
              return;
            } catch { /* NotFoundException on most frames — expected */ }
          }
        }
      } catch { /* transient decode/detect error; keep scanning */ }
    }

    // ~10 fps is plenty for barcodes and keeps phones from getting hot.
    scanner.rafId = setTimeout(() => requestAnimationFrame(tick), 100);
  }

  async function onDecoded(raw) {
    const code = String(raw || '').replace(/\D/g, '');
    if (!code) { scanner.rafId = setTimeout(() => requestAnimationFrame(tick), 100); return; }

    const now = Date.now();
    if (code === scanner.lastCode && now - scanner.lastAt < 3000) {
      scanner.rafId = setTimeout(() => requestAnimationFrame(tick), 150);
      return;
    }
    scanner.lastCode = code;
    scanner.lastAt = now;

    buzz(60);
    scanner.running = false;            // pause while we look the product up
    scanMessage(`Found ${code} — looking it up…`);

    const ok = await lookup(code, { fromScanner: true });
    if (ok) {
      closeScanner();
    } else {
      // Product unknown: stay in the camera so the next item can be scanned.
      scanner.running = true;
      setTimeout(() => tick(), 1200);
    }
  }

  function stopScanner({ keepOpen = false } = {}) {
    scanner.running = false;
    clearTimeout(scanner.rafId);
    try {
      scanner.stream?.getTracks().forEach((t) => t.stop());
    } catch { /* already stopped */ }
    scanner.stream = null;
    scanner.track = null;
    const video = $('scan-video');
    video.srcObject = null;
    if (!keepOpen) {
      $('scanner').hidden = true;
      document.body.style.overflow = '';
    }
  }

  function closeScanner() {
    stopScanner();
    $('scan-err').hidden = true;
  }

  /* ================================ wiring =============================== */

  $('tab-today').addEventListener('click', () => showView('today'));
  $('tab-add').addEventListener('click', () => showView('add'));
  $('tab-you').addEventListener('click', () => showView('you'));

  $('prev-day').addEventListener('click', () => goToDate(shiftDate(state.date, -1)));
  $('next-day').addEventListener('click', () => goToDate(shiftDate(state.date, 1)));

  $('open-scanner').addEventListener('click', openScanner);
  $('close-scanner').addEventListener('click', closeScanner);
  $('torch-btn').addEventListener('click', toggleTorch);
  $('scan-err-retry').addEventListener('click', openScanner);
  $('scan-err-close').addEventListener('click', () => { closeScanner(); showView('add'); $('barcode-input').focus(); });
  $('scan-type-instead').addEventListener('click', () => { closeScanner(); showView('add'); $('barcode-input').focus(); });

  $('search-btn').addEventListener('click', () => doSearch($('search-input').value));
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); doSearch(e.target.value); }
  });
  $('barcode-btn').addEventListener('click', () => lookup($('barcode-input').value));
  $('barcode-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); lookup(e.target.value); }
  });

  $('custom-add').addEventListener('click', () => {
    const name = $('custom-name').value.trim();
    const kcal = Number($('custom-kcal').value);
    if (!name) { toast('Give it a name first'); return; }
    if (!(kcal > 0)) { toast('Enter the calories'); return; }
    addEntry({ name, kcal });
    $('custom-name').value = '';
    $('custom-kcal').value = '';
    toast(`Added ${round(kcal)} kcal`);
    showView('today');
  });

  for (const id of ['sex', 'age', 'weight', 'height', 'activity', 'goal', 'custom-target']) {
    $(id).addEventListener('input', previewTarget);
  }
  $('use-custom').addEventListener('change', (e) => {
    $('custom-target-field').hidden = !e.target.checked;
    previewTarget();
  });
  $('save-profile').addEventListener('click', saveProfile);

  $('unit-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-unit]');
    if (!btn || btn.disabled) return;
    const prev = portionUnit;
    portionUnit = btn.dataset.unit;
    if (prev !== portionUnit) {
      $('portion-amount').value = portionUnit === 'serving' ? 1 : (state.food?.servingGrams || 100);
    }
    syncUnitButtons();
    updatePortion();
  });
  $('portion-amount').addEventListener('input', updatePortion);
  $('portion-add').addEventListener('click', confirmPortion);
  $('portion-cancel').addEventListener('click', closePortion);
  $('portion-backdrop').addEventListener('click', (e) => {
    if (e.target === $('portion-backdrop')) closePortion();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('portion-backdrop').hidden) closePortion();
    else if (!$('scanner').hidden) closeScanner();
  });

  $('device-key').value = deviceId;
  $('copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(deviceId);
      toast('Device key copied');
    } catch {
      $('device-key').select();
      toast('Press copy on your keyboard');
    }
  });
  $('restore-key').addEventListener('click', () => {
    const entered = prompt('Paste a device key to load its data:', deviceId);
    if (!entered) return;
    const key = entered.trim();
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(key)) { toast('That key does not look valid'); return; }
    deviceId = key;
    store(KEY_DEVICE, key);
    store(KEY_CACHE, undefined);
    store(KEY_QUEUE, undefined);
    location.reload();
  });
  $('export-data').addEventListener('click', () => {
    const t = totals();
    const lines = [
      `${prettyDate(state.date)} — ${round(t.kcal)} kcal of ${targetOf() || '—'}`,
      ...state.entries.map((e) => `- ${e.name}${e.brand ? ` (${e.brand})` : ''}: ${round(e.kcal)} kcal`)
    ].join('\n');
    navigator.clipboard?.writeText(lines).then(
      () => toast('Copied to clipboard'),
      () => toast('Could not copy')
    );
  });

  window.addEventListener('online', () => {
    state.online = true;
    $('offline-banner').hidden = true;
    flushQueue();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    $('offline-banner').hidden = false;
  });

  // Coming back to the app after midnight should roll over to the new day.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.date !== todayStr()) {
      const wasToday = state.date === shiftDate(todayStr(), -1);
      if (wasToday) goToDate(todayStr());
    }
  });

  /* ================================= boot ================================ */

  async function boot() {
    $('offline-banner').hidden = navigator.onLine;
    if (hydrateFromCache()) { fillProfileForm(state.profile); renderAll(); }

    try {
      const data = await api(`/api/state?date=${state.date}`);
      state.profile = data.profile;
      state.entries = data.entries;
      state.recents = data.recents;
      state.history = data.history;
      fillProfileForm(state.profile);
      renderAll();
      cacheState();
      if (!state.profile) {
        showView('you');
        toast('Set your daily target to get started');
      }
    } catch (err) {
      renderAll();
      if (navigator.onLine) toast('Could not reach the server — showing cached data');
    }
    previewTarget();
    flushQueue();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* optional */ });
    }
  }

  boot();
})();
