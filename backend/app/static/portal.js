'use strict';
// AccidentAlert AI System, Response Portal: station sign-in, live incident queue with status workflow, analytics.

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const SEV = ['Minor', 'Minor', 'Serious', 'Critical'];          // index = severity (0 folds into minor)
const SEVC = ['s1', 's1', 's2', 's3'];
const SEVVAR = ['var(--sev1)', 'var(--sev1)', 'var(--sev2)', 'var(--sev3)'];
const STATUS = { new: 'Unassigned', acknowledged: 'Acknowledged', en_route: 'En route', on_scene: 'On scene', resolved: 'Resolved', false_alarm: 'False alarm' };
const STATUSVAR = { new: 'var(--st-new)', acknowledged: 'var(--st-ack)', en_route: 'var(--st-route)', on_scene: 'var(--st-scene)', resolved: 'var(--st-ok)', false_alarm: 'var(--st-false)' };
const ACTIVE = ['new', 'acknowledged', 'en_route', 'on_scene'];
const STEPS = ['acknowledged', 'en_route', 'on_scene', 'resolved'];
const NEXT = { acknowledged: ['en_route', 'Mark en route'], en_route: ['on_scene', 'Mark on scene'], on_scene: ['resolved', 'Resolve incident'] };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

let token = localStorage.getItem('cg_token');
let me = null, stations = [];
let alerts = [], sel = null, detail = null, nearestFor = null, lastTop = null, fresh = new Set();
let filter = 'active', view = 'live', pollT = null, busy = false;
let audio = null, alarmT = null, alarmEnd = null;
let aPeriod = 'year', aDate = todayStr(), aData = null;

// ---------- Helpers ----------
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function todayStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
function fmtMin(m) {
  if (m == null) return '—';
  if (m < 1) return Math.round(m * 60) + ' s';
  if (m < 60) return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)) + ' min';
  return Math.floor(m / 60) + ' h ' + Math.round(m % 60) + ' min';
}
const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;
const timeOf = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function km(lat1, lng1, lat2, lng2) {
  const p = Math.PI / 180, a = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lng2 - lng1) * p / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  if (r.status === 401 && path !== '/api/auth/login') { signOut('Your session expired. Sign in again.'); throw new Error('signed-out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Request failed (' + r.status + ')');
  return data;
}

// ---------- Sign in ----------
async function showLogin(msg) {
  clearInterval(pollT); stopAlarm();
  $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || '';
  try { stations = await fetch('/api/stations').then(r => r.json()); } catch { stations = []; }
  const s = $('stationSel'); s.textContent = '';
  if (!stations.length) {
    s.append(h('option', { value: '' }, 'No stations set up'));
    $('loginErr').textContent = 'No stations exist yet. An administrator must add one (see README).';
  }
  for (const st of stations) s.append(h('option', { value: st.id }, st.name + (st.area ? ' · ' + st.area : '')));
  const last = localStorage.getItem('cg_station'); if (last) s.value = last;
  $('pin').value = ''; $('pin').focus();
}
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  const btn = e.submitter; btn.disabled = true; $('loginErr').textContent = '';
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ station_id: +$('stationSel').value, pin: $('pin').value }) });
    token = r.token; me = r.station;
    localStorage.setItem('cg_token', token); localStorage.setItem('cg_station', me.id);
    startApp();
  } catch (err) { $('loginErr').textContent = err.message; }
  btn.disabled = false;
};
function signOut(msg) {
  if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  token = null; me = null; localStorage.removeItem('cg_token');
  alerts = []; sel = null; detail = null; lastTop = null;
  showLogin(msg);
}
$('logout').onclick = () => signOut();

async function startApp() {
  $('login').hidden = true; $('app').hidden = false;
  $('meName').textContent = me.name; $('meArea').textContent = me.area || '';
  stations = await fetch('/api/stations').then(r => r.json()).catch(() => stations);
  setView(view);
  poll(); clearInterval(pollT); pollT = setInterval(poll, 4000);
}

// ---------- Shell ----------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
function setView(v) {
  view = v;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === v));
  $('view-live').hidden = v !== 'live'; $('view-analytics').hidden = v !== 'analytics';
  if (v === 'analytics') loadAnalytics();
}
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString(); }, 1000);
function setLive(ok) { $('live').classList.toggle('off', !ok); $('liveTxt').textContent = ok ? 'Live' : 'Offline, retrying'; }

function beep() {
  if (!audio) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 880; g.gain.value = .25; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + .35);
}
$('snd').onclick = () => {
  if (audio) { audio.close(); audio = null; $('snd').textContent = 'Sound off'; return; }
  audio = new (window.AudioContext || window.webkitAudioContext)(); beep(); $('snd').textContent = 'Sound on';
};
function startAlarm() { stopAlarm(); beep(); alarmT = setInterval(beep, 700); alarmEnd = setTimeout(stopAlarm, 12000); }
function stopAlarm() { clearInterval(alarmT); clearTimeout(alarmEnd); }
$('banner').onclick = () => {
  stopAlarm(); $('banner').hidden = true;
  const id = +$('banner').dataset.id; setView('live'); setFilter('active'); select(id);
};

// ---------- Live: polling ----------
async function poll() {
  try {
    const list = await api('/api/alerts?limit=300');
    setLive(true);
    const top = list.length ? list[0].id : 0;
    if (lastTop !== null && top > lastTop) onNewAlerts(list.filter(a => a.id > lastTop));
    lastTop = top; alerts = list;
    if (sel === null) { const first = visible()[0]; if (first) sel = first.id; }
    renderStats(); renderList();
    const cur = alerts.find(a => a.id === sel);
    if (sel !== null && (!detail || detail.id !== sel || (cur && cur.updated_at_utc !== detail.updated_at_utc))) loadDetail(sel);
    else if (sel === null) renderDetail();
  } catch (e) { if (e.message !== 'signed-out') setLive(false); }
}
function onNewAlerts(list) {
  list.forEach(a => fresh.add(a.id));
  setTimeout(() => { list.forEach(a => fresh.delete(a.id)); renderList(); }, 4000);
  const n = list[0], b = $('banner');
  b.textContent = (list.length > 1 ? list.length + ' new crash alerts. Latest: ' : 'New crash alert: ') +
    SEV[n.severity] + ' crash, ' + n.vehicle_label + '. Click to open.';
  b.dataset.id = n.id; b.hidden = false; startAlarm();
  if (!detail || !ACTIVE.includes(detail.status)) sel = n.id;
  document.title = '(' + alerts.filter(a => a.status === 'new').length + ') AccidentAlert AI · Response Portal';
}

// ---------- Live: queue ----------
document.querySelectorAll('.filters button').forEach(b => b.onclick = () => setFilter(b.dataset.f));
function setFilter(f) { filter = f; document.querySelectorAll('.filters button').forEach(b => b.classList.toggle('on', b.dataset.f === f)); renderList(); }
$('search').oninput = renderList;
function visible() {
  const term = $('search').value.trim().toLowerCase();
  let list = alerts.filter(a => {
    if (filter === 'active' && !ACTIVE.includes(a.status)) return false;
    if (filter === 'closed' && ACTIVE.includes(a.status)) return false;
    if (filter === 'mine' && a.assigned_station_id !== me.id) return false;
    return !term || a.vehicle_label.toLowerCase().includes(term);
  });
  if (filter === 'active') list = list.slice().sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1) || b.severity - a.severity || b.id - a.id);
  return list;
}
function renderStats() {
  const today = todayStr();
  const n = alerts.filter(a => a.status === 'new').length;
  $('sNew').textContent = n;
  $('sNew').parentElement.classList.toggle('alert', n > 0);
  $('sProg').textContent = alerts.filter(a => ['acknowledged', 'en_route', 'on_scene'].includes(a.status)).length;
  $('sMine').textContent = alerts.filter(a => ACTIVE.includes(a.status) && a.assigned_station_id === me.id).length;
  $('sClosed').textContent = alerts.filter(a => a.closed_at_utc && todayStr(new Date(a.closed_at_utc)) === today).length;
  $('tabCount').textContent = n; $('tabCount').hidden = n === 0;
  document.title = (n ? '(' + n + ') ' : '') + 'AccidentAlert AI · Response Portal';
}
function renderList() {
  const box = $('list'), list = visible(); box.textContent = '';
  if (!list.length) {
    box.append(h('p', { class: 'none' }, { active: 'No active incidents. All clear.', mine: 'Your station is not leading any incident.', closed: 'No closed incidents yet.', all: 'No incidents yet.' }[filter]));
    return;
  }
  for (const a of list) {
    const who = a.assigned_station_id === me.id ? 'Your station' : (a.assigned_station_name || 'No station yet');
    box.append(h('button', {
      class: 'inc' + (a.id === sel ? ' sel' : '') + (fresh.has(a.id) ? ' fresh' : ''), style: '--c:' + SEVVAR[a.severity],
      onclick: () => select(a.id), 'aria-current': a.id === sel ? 'true' : null,
    },
      h('div', { class: 'row1' }, h('span', { class: 'sev ' + SEVC[a.severity] }, SEV[a.severity] + ' crash'), h('span', { class: 'ago' }, ago(a.created_at_utc))),
      h('div', { class: 'veh' }, a.vehicle_label, (a.flags & 2) ? h('span', { class: 'tag', style: 'margin-left:8px' }, 'Test') : null),
      h('div', { class: 'row3' }, h('span', { class: 'pill st-' + a.status }, STATUS[a.status]), h('span', null, who)),
    ));
  }
}
function select(id) { sel = id; stopAlarm(); renderList(); loadDetail(id); }

// ---------- Live: detail ----------
async function loadDetail(id) {
  try {
    const d = await api('/api/alerts/' + id);
    if (sel !== id) return;
    detail = d; renderDetail();
    if (nearestFor !== id) { nearestFor = id; loadNearest(id); }
  } catch (e) { if (e.message !== 'signed-out') toast(e.message, true); }
}
async function loadNearest(id) {
  const ul = $('nearest'); ul.textContent = '';
  try {
    const rows = await api('/api/alerts/' + id + '/nearest-stations');
    if (sel !== id) return;
    if (!rows.length) { ul.append(h('li', null, h('span', { class: 'muted' }, 'No location, distance unknown.'))); return; }
    for (const s of rows) ul.append(h('li', null, h('span', null, s.name, s.id === me.id ? h('span', { class: 'you' }, 'YOU') : null), h('span', { class: 'km' }, s.distance_km + ' km')));
  } catch { /* shown as empty */ }
}
function renderDetail() {
  const a = detail && detail.id === sel ? detail : null;
  $('empty').hidden = !!a; $('info').hidden = !a;
  if (!a) return;
  $('dSev').className = 'sev ' + SEVC[a.severity]; $('dSev').textContent = SEV[a.severity] + ' crash';
  $('dStatus').className = 'pill st-' + a.status; $('dStatus').textContent = STATUS[a.status];
  $('dTest').hidden = !(a.flags & 2);
  $('dVeh').textContent = a.vehicle_label;
  $('dSub').textContent = 'Incident #' + a.id + ' · received ' + ago(a.created_at_utc) +
    (a.assisting_stations ? ' · supported by ' + a.assisting_stations.split(',').join(', ') : '');
  $('mPeak').textContent = a.peak_g.toFixed(1) + ' g';
  $('mConf').textContent = Math.round(a.confidence * 100) + '%';
  $('mTime').textContent = a.created_at_local;
  $('mAcc').textContent = a.accuracy_m != null ? Math.round(a.accuracy_m) + ' m' : 'n/a';
  $('mAck').textContent = a.acknowledged_at_utc ? fmtMin(minutesBetween(a.created_at_utc, a.acknowledged_at_utc)) : 'Waiting';
  renderActions(a);
  const has = a.lat != null;
  const canRoute = has && me.lat != null;
  $('map').hidden = !has; $('noLoc').hidden = has; $('mapMode').hidden = !canRoute;
  if (has) setFrame($('map'), mapMode === 'route' && canRoute ? gRoute(me, a) : gPin(a, 16));
  renderTimeline(a);
}
// Google Maps embeds (no API key, stays inside the portal). Route mode shows drive time from the station.
let mapMode = 'pin';
const gPin = (p, z) => `https://maps.google.com/maps?q=${p.lat},${p.lng}&z=${z}&hl=en&output=embed`;
const gRoute = (from, to) => `https://maps.google.com/maps?saddr=${from.lat},${from.lng}&daddr=${to.lat},${to.lng}&hl=en&output=embed`;
function setFrame(frame, src) { if (frame.dataset.src !== src) { frame.src = src; frame.dataset.src = src; } }
document.querySelectorAll('#mapMode button').forEach(b => b.onclick = () => {
  mapMode = b.dataset.m;
  document.querySelectorAll('#mapMode button').forEach(x => x.classList.toggle('on', x === b));
  renderDetail();
});
function stepper(status) {
  const i = STEPS.indexOf(status);
  return h('div', { class: 'steps', 'aria-label': 'Progress' }, STEPS.map((s, k) => h('span', { class: k < i ? 'done' : k === i ? 'now' : '' }, STATUS[s])));
}
function renderActions(a) {
  const box = $('actions'); box.textContent = '';
  const btn = (label, cls, fn) => h('button', { class: 'btn ' + cls, onclick: fn, disabled: busy }, label);
  const mine = a.assigned_station_id === me.id;
  if (!ACTIVE.includes(a.status)) {
    const last = (a.updates || []).filter(u => u.action === 'status').pop();
    box.append(h('div', { class: 'who' }, 'Closed as ', h('b', null, STATUS[a.status].toLowerCase()),
      last ? [' by ', h('b', null, last.station_name || 'a station'), ' at ' + timeOf(last.created_at_utc)] : null));
    return;
  }
  if (a.status === 'new') {
    box.append(h('div', { class: 'who' }, 'No station has taken this incident yet.'),
      h('div', { class: 'btns' },
        btn('Mark false alarm', 'danger', () => confirmUpdate('false_alarm')),
        btn('Acknowledge and respond', 'primary', () => update({ action: 'status', status: 'acknowledged' }))));
    return;
  }
  if (mine) {
    const [next, label] = NEXT[a.status];
    box.append(h('div', { class: 'who' }, h('b', null, 'Your station'), ' is leading this incident.'), stepper(a.status),
      h('div', { class: 'btns' },
        btn('False alarm', 'danger', () => confirmUpdate('false_alarm')),
        next !== 'resolved' ? btn('Resolve', 'ghost', () => confirmUpdate('resolved')) : null,
        btn(label, next === 'resolved' ? 'ok' : 'primary', () => next === 'resolved' ? confirmUpdate('resolved') : update({ action: 'status', status: next }))));
    return;
  }
  const assisting = (a.updates || []).some(u => u.action === 'assist' && u.station_id === me.id);
  box.append(h('div', { class: 'who' }, h('b', null, a.assigned_station_name), ' is leading this incident.'), stepper(a.status),
    h('div', { class: 'btns' }, assisting ? h('span', { class: 'pill st-en_route' }, 'Your station is supporting')
      : btn('Send support', 'primary', () => update({ action: 'assist', note: $('note').value.trim() || null }))));
}
function confirmUpdate(status) {
  const msg = status === 'resolved' ? 'Mark this incident as resolved? It will be closed for all stations.'
    : 'Mark this incident as a false alarm? It will be closed for all stations.';
  if (confirm(msg)) update({ action: 'status', status, note: $('note').value.trim() || null });
}
async function update(body) {
  if (busy || !detail) return;
  busy = true; renderActions(detail);
  try {
    const d = await api('/api/alerts/' + detail.id + '/updates', { method: 'POST', body: JSON.stringify(body) });
    if (body.note) $('note').value = '';
    detail = d;
    const i = alerts.findIndex(a => a.id === d.id); if (i >= 0) alerts[i] = { ...alerts[i], ...d };
    toast(body.action === 'assist' ? 'Support recorded. The leading station can see it.' : body.action === 'note' ? 'Note added' : 'Status updated: ' + STATUS[d.status]);
    renderStats(); renderList();
  } catch (e) { if (e.message !== 'signed-out') { toast(e.message, true); poll(); } }
  busy = false; renderDetail();
}
$('noteForm').onsubmit = e => { e.preventDefault(); const n = $('note').value.trim(); if (n) update({ action: 'note', note: n }); };
function renderTimeline(a) {
  const ol = $('timeline'); ol.textContent = '';
  const item = (color, text, at, note) => h('li', { style: '--sc:' + color }, h('div', null, text), h('div', { class: 't' }, timeOf(at) + ' · ' + ago(at)), note ? h('div', { class: 'n' }, note) : null);
  ol.append(item('var(--st-new)', 'Crash alert received from ' + a.vehicle_label, a.created_at_utc));
  for (const u of a.updates || []) {
    const who = u.station_id === me.id ? 'Your station' : (u.station_name || 'A station');
    if (u.action === 'status') ol.append(item(STATUSVAR[u.status], who + ' marked it ' + STATUS[u.status].toLowerCase(), u.created_at_utc, u.note));
    else if (u.action === 'assist') ol.append(item('var(--st-route)', who + ' is sending support', u.created_at_utc, u.note));
    else ol.append(item('var(--mu)', who + ' added a note', u.created_at_utc, u.note));
  }
  ol.scrollTop = ol.scrollHeight;
}
setInterval(() => { if (view === 'live' && alerts.length) { renderList(); if (detail) $('dSub').textContent = $('dSub').textContent.replace(/received [^·]+/, 'received ' + ago(detail.created_at_utc) + ' '); } }, 30000);

// ---------- Analytics ----------
document.querySelectorAll('.a-controls .seg button').forEach(b => b.onclick = () => { aPeriod = b.dataset.p; loadAnalytics(); });
$('aYear').onchange = () => { aDate = $('aYear').value + aDate.slice(4); loadAnalytics(); };
$('aMonth').onchange = () => { if ($('aMonth').value) { aDate = $('aMonth').value + '-01'; loadAnalytics(); } };
$('aDay').onchange = () => { if ($('aDay').value) { aDate = $('aDay').value; loadAnalytics(); } };
$('aTests').onchange = loadAnalytics;
$('aPrev').onclick = () => shift(-1);
$('aNext').onclick = () => shift(1);
function shift(dir) {
  const [y, m, d] = aDate.split('-').map(Number);
  const nd = aPeriod === 'year' ? new Date(y + dir, 0, 1) : aPeriod === 'month' ? new Date(y, m - 1 + dir, 1) : new Date(y, m - 1, d + dir);
  aDate = todayStr(nd); loadAnalytics();
}
function syncControls(years) {
  document.querySelectorAll('.a-controls .seg button').forEach(b => b.classList.toggle('on', b.dataset.p === aPeriod));
  $('aYear').hidden = aPeriod !== 'year'; $('aMonth').hidden = aPeriod !== 'month'; $('aDay').hidden = aPeriod !== 'day';
  const y = +aDate.slice(0, 4), set = [...new Set([...(years || []), new Date().getFullYear(), y])].sort();
  $('aYear').textContent = ''; set.forEach(v => $('aYear').append(h('option', { value: v }, v)));
  $('aYear').value = y; $('aMonth').value = aDate.slice(0, 7); $('aDay').value = aDate;
  $('aNext').disabled = aDate.slice(0, aPeriod === 'year' ? 4 : aPeriod === 'month' ? 7 : 10) >= todayStr().slice(0, aPeriod === 'year' ? 4 : aPeriod === 'month' ? 7 : 10);
}
async function loadAnalytics() {
  syncControls(aData && aData.years);
  const date = aPeriod === 'year' ? aDate.slice(0, 4) + '-01-01' : aPeriod === 'month' ? aDate.slice(0, 7) + '-01' : aDate;
  try {
    const d = await api(`/api/analytics?period=${aPeriod}&date=${date}&include_tests=${$('aTests').checked}`);
    aData = d; syncControls(d.years); renderAnalytics(d);
  } catch (e) { if (e.message !== 'signed-out') toast(e.message, true); }
}
window.addEventListener('resize', () => { clearTimeout(window._rs); window._rs = setTimeout(() => { if (aData && view === 'analytics') renderAnalytics(aData); }, 150); });

const SEVSERIES = [{ key: 'minor', name: 'Minor', color: 'var(--sev1)' }, { key: 'serious', name: 'Serious', color: 'var(--sev2)' }, { key: 'critical', name: 'Critical', color: 'var(--sev3)' }];
const PREVWORD = { year: 'last year', month: 'last month', day: 'the day before' };

function renderAnalytics(d) {
  const k = d.kpis, total = k.alerts;
  $('aLabel').textContent = { year: 'Year ', month: '', day: '' }[d.period] + d.label;

  // KPI tiles
  const delta = k.prev_alerts ? (total - k.prev_alerts) / k.prev_alerts : null;
  const tiles = [
    ['Accidents', total, null, delta == null ? 'No data for ' + PREVWORD[d.period]
      : h('span', { class: delta > 0 ? 'up' : delta < 0 ? 'down' : '' }, (delta > 0 ? '▲ ' : delta < 0 ? '▼ ' : '') + Math.abs(Math.round(delta * 100)) + '% vs ' + PREVWORD[d.period])],
    ['Critical', k.critical, null, total ? Math.round(k.critical / total * 100) + '% of accidents' : '—'],
    ['Median response', ...splitUnit(k.median_ack_min), 'alert to acknowledgement'],
    ['Median to resolve', ...splitUnit(k.median_resolve_min), 'alert to resolved'],
    ['Cancelled by driver', k.cancelled_by_driver, null, k.cancel_rate != null ? Math.round(k.cancel_rate * 100) + '% of crash detections' : '—'],
    ['False alarms', k.false_alarm, null, total ? Math.round(k.false_alarm / total * 100) + '% of incidents' : '—'],
  ];
  const kp = $('kpis'); kp.textContent = '';
  for (const [label, val, unit, sub] of tiles) kp.append(h('div', { class: 'kpi' }, h('small', null, label), h('b', null, val, unit ? h('u', null, unit) : null), h('span', null, sub)));

  // Accidents over time
  const cats = d.series.map(s => s.label);
  $('tsSub').textContent = { year: 'By month', month: 'By day of the month', day: 'By hour' }[d.period] + ', stacked by severity';
  $('tsLegend').textContent = '';
  SEVSERIES.forEach(s => $('tsLegend').append(h('span', { style: '--c:' + s.color }, h('i'), s.name)));
  const ser = SEVSERIES.map(s => ({ ...s, values: d.series.map(r => r[s.key]) }));
  columnChart($('tsChart'), cats, ser, { label: 'Accidents over time by severity', tip: i => tipFor(d.series[i].label + tipSuffix(d, i), ser, i) });
  $('tsTable').textContent = '';
  $('tsTable').append(table([{ t: { year: 'Month', month: 'Day', day: 'Hour' }[d.period] }, { t: 'Minor', num: 1 }, { t: 'Serious', num: 1 }, { t: 'Critical', num: 1 }, { t: 'Total', num: 1 }],
    d.series.map(r => [r.label, r.minor, r.serious, r.critical, r.minor + r.serious + r.critical])));

  // Time of day / weekday (not meaningful for a single day: the main chart is already hourly)
  const multi = d.period !== 'day';
  $('hourCard').hidden = !multi; $('dowCard').hidden = !multi;
  if (multi) {
    const hs = [{ name: 'Accidents', color: 'var(--accent)', values: d.by_hour }];
    columnChart($('hourChart'), d.by_hour.map((_, i) => pad(i)), hs, { h: 200, label: 'Accidents by hour of day', tip: i => tipFor(pad(i) + ':00 – ' + pad((i + 1) % 24) + ':00', hs, i) });
    hbars($('dowChart'), WEEKDAYS.map((w, i) => ({ label: w, value: d.by_weekday[i] })));
  }

  // Outcomes
  hbars($('outChart'), Object.entries(d.outcomes).map(([s, v]) => ({ label: STATUS[s], value: v, sc: STATUSVAR[s], c: STATUSVAR[s] })));

  // Stations
  const maxLed = Math.max(1, ...d.stations.map(s => s.handled));
  $('stationTable').textContent = '';
  $('stationTable').append(d.stations.length ? table(
    [{ t: 'Station' }, { t: 'Led' }, { t: 'Resolved', num: 1 }, { t: 'False alarms', num: 1 }, { t: 'Supported others', num: 1 }, { t: 'Median response', num: 1 }],
    d.stations.map(s => [h('span', null, s.name, s.id === me.id ? h('span', { class: 'you' }, 'YOU') : null, s.area ? h('div', { class: 'muted', style: 'font-size:12px' }, s.area) : null),
      h('span', null, h('span', { class: 'minibar', style: 'width:' + Math.round(s.handled / maxLed * 120) + 'px' }), s.handled),
      s.resolved, s.false_alarm, s.assisted, fmtMin(s.median_ack_min)])) : h('p', { class: 'nodata' }, 'No stations yet.'));

  // Hotspots
  // Hotspots: click a row to show it on the embedded map
  $('hotspots').textContent = '';
  $('hotMap').hidden = !d.hotspots.length;
  if (d.hotspots.length) {
    const tbl = table([{ t: '#' }, { t: 'Area' }, { t: 'Accidents', num: 1 }, { t: 'Critical', num: 1 }],
      d.hotspots.map((p, i) => [i + 1, h('span', null, p.lat.toFixed(4) + ', ' + p.lng.toFixed(4),
        h('div', { class: 'muted', style: 'font-size:12px' }, nearestText(p))), p.count, p.critical]));
    const rows = [...tbl.querySelectorAll('tbody tr')];
    const show = i => { rows.forEach((r, k) => r.classList.toggle('on', k === i)); setFrame($('hotMap'), gPin(d.hotspots[i], 15)); };
    rows.forEach((r, i) => { r.className = 'pick'; r.tabIndex = 0; r.onclick = () => show(i); r.onkeydown = e => { if (e.key === 'Enter') show(i); }; });
    $('hotspots').append(tbl); show(0);
  } else $('hotspots').append(h('p', { class: 'nodata' }, 'No located accidents in this period.'));

  // Vehicles
  $('vehicles').textContent = '';
  if (d.vehicles.length) hbars($('vehicles'), d.vehicles.map(v => ({ label: v.label, value: v.count })));
  else $('vehicles').append(h('p', { class: 'nodata' }, 'No alerts in this period.'));

  renderInsights(d);
}
function splitUnit(m) {
  if (m == null) return ['—', null];
  const s = fmtMin(m), i = s.lastIndexOf(' ');
  return s.includes('h ') ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}
function tipSuffix(d, i) {
  if (d.period === 'month') return ' ' + new Date(d.start + 'T12:00').toLocaleString([], { month: 'short' });
  if (d.period === 'year') return ' ' + d.label;
  return ' – ' + pad((i + 1) % 24) + ':00';
}
function nearestText(p) {
  const near = stations.filter(s => s.lat != null).map(s => ({ s, d: km(p.lat, p.lng, s.lat, s.lng) })).sort((a, b) => a.d - b.d)[0];
  return near ? near.d.toFixed(1) + ' km from ' + near.s.name : '';
}
function renderInsights(d) {
  const ul = $('insights'), k = d.kpis, li = (...c) => ul.append(h('li', null, h('span', null, ...c)));
  ul.textContent = '';
  if (!k.alerts) { li('No accidents were recorded in this period.'); return; }
  const busiest = d.series.reduce((b, r) => (r.minor + r.serious + r.critical) > (b.minor + b.serious + b.critical) ? r : b);
  const word = { year: 'month', month: 'day', day: 'hour' }[d.period];
  li('Busiest ', word, ': ', h('b', null, d.period === 'month' ? busiest.label + ' ' + new Date(d.start + 'T12:00').toLocaleString([], { month: 'long' }) : busiest.label),
    ' with ', h('b', null, busiest.minor + busiest.serious + busiest.critical), ' accidents.');
  if (d.period !== 'day') {
    let best = 0; for (let i = 0; i < 24; i++) if (d.by_hour[i] + d.by_hour[(i + 1) % 24] > d.by_hour[best] + d.by_hour[(best + 1) % 24]) best = i;
    const share = Math.round((d.by_hour[best] + d.by_hour[(best + 1) % 24]) / k.alerts * 100);
    li('Peak window is ', h('b', null, pad(best) + ':00 – ' + pad((best + 2) % 24) + ':00'), ' (', share + '% of accidents). Consider more patrols then.');
    const wd = d.by_weekday.indexOf(Math.max(...d.by_weekday));
    li(h('b', null, WEEKDAYS[wd]), ' has the most accidents (' + d.by_weekday[wd] + ').');
  }
  if (d.hotspots.length && d.hotspots[0].count > 1) li('Top hotspot has ', h('b', null, d.hotspots[0].count + ' accidents'), ' (' + nearestText(d.hotspots[0]) + ').');
  const fast = d.stations.filter(s => s.handled >= 3 && s.median_ack_min != null).sort((a, b) => a.median_ack_min - b.median_ack_min);
  if (fast.length > 1) li('Fastest response: ', h('b', null, fast[0].name), ' (median ' + fmtMin(fast[0].median_ack_min) + ' vs ' + fmtMin(fast[fast.length - 1].median_ack_min) + ' slowest).');
  if (k.cancel_rate != null && k.cancel_rate >= .25) li('Drivers cancelled ', h('b', null, Math.round(k.cancel_rate * 100) + '%'), ' of crash detections. The detector may be too sensitive.');
  if (k.unassigned) li(h('b', null, k.unassigned + ' incident' + (k.unassigned > 1 ? 's' : '')), ' from this period ', k.unassigned > 1 ? 'are' : 'is', ' still unassigned.');
}

// ---------- Chart primitives ----------
function niceStep(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1e-9)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return Math.max(1, f * p);
  return Math.max(1, 10 * p);
}
function roundTop(x, y, w, hgt, r, color) {
  return `<path style="fill:${color}" d="M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z"/>`;
}
// Columns, optionally stacked. Bars <= 24px, 4px rounded data-end, 2px surface gap between stacked segments.
function columnChart(el, cats, series, opts) {
  const W = Math.max(el.clientWidth || 600, 280), H = opts.h || 250, m = { l: 34, r: 4, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const totals = cats.map((_, i) => series.reduce((s, se) => s + se.values[i], 0));
  const step = niceStep(Math.max(...totals, 1) / 4), max = step * 4;
  const y = v => m.t + ph - v / max * ph;
  const band = pw / cats.length, bw = Math.min(24, Math.max(3, band * .62));
  const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / 42))));
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opts.label)}">`;
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round(y(step * i)) + .5;
    if (i) s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    s += `<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${step * i}</text>`;
  }
  cats.forEach((c, i) => {
    const cx = m.l + band * i + band / 2, x = cx - bw / 2;
    const segs = series.map(se => ({ v: se.values[i], c: se.color })).filter(z => z.v > 0);
    let cum = 0;
    segs.forEach((z, k) => {
      let yb = y(cum); const yt = y(cum + z.v); if (k) yb -= 2; cum += z.v;
      const hgt = Math.max(1, yb - yt);
      s += k === segs.length - 1 ? roundTop(x, yb - hgt, bw, hgt, Math.min(4, hgt, bw / 2), z.c)
        : `<rect x="${x}" y="${yb - hgt}" width="${bw}" height="${hgt}" style="fill:${z.c}"/>`;
    });
    if (i % every === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(c)}</text>`;
  });
  s += `<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ph + .5}" y2="${m.t + ph + .5}"/>`;
  cats.forEach((_, i) => { s += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}"/>`; });
  el.innerHTML = s + '</svg>';
  el.querySelectorAll('.hit').forEach(r => { r.onmousemove = e => showTip(e, opts.tip(+r.dataset.i)); r.onmouseleave = hideTip; });
}
function tipFor(title, series, i) {
  const rows = series.map(s => h('div', null, h('span', { style: '--c:' + s.color }, series.length > 1 ? h('i') : null, s.name), h('b', null, s.values[i])));
  if (series.length > 1) rows.push(h('div', { class: 'tot' }, h('span', null, 'Total'), h('b', null, series.reduce((t, s) => t + s.values[i], 0))));
  return [h('h4', null, title), ...rows];
}
function showTip(e, content) {
  const t = $('tip'); t.textContent = ''; t.append(...content); t.hidden = false;
  const x = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 8), yy = Math.min(e.clientY + 14, innerHeight - t.offsetHeight - 8);
  t.style.left = x + 'px'; t.style.top = yy + 'px';
}
function hideTip() { $('tip').hidden = true; }
// Horizontal bars as HTML: one measure, labelled rows, value at the tip.
function hbars(el, rows) {
  el.textContent = '';
  const max = Math.max(1, ...rows.map(r => r.value));
  const box = h('div', { class: 'hbars' });
  for (const r of rows) box.append(h('div', { class: 'hbar', style: r.sc ? '--sc:' + r.sc : '' },
    h('span', { class: 'lab', title: r.label }, r.sc ? h('i') : null, r.label),
    h('span', { class: 'track' }, h('span', { class: 'fill', style: `width:${r.value / max * 100}%;${r.c ? '--c:' + r.c : ''}` })),
    h('span', { class: 'val' }, r.value)));
  el.append(box);
}
function table(cols, rows) {
  return h('table', { class: 'data' },
    h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.num ? 'num' : null }, c.t)))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((v, i) => h('td', { class: cols[i].num ? 'num' : null }, v))))));
}

// ---------- Boot ----------
(async () => {
  if (!token) return showLogin();
  try { me = await api('/api/auth/me'); startApp(); } catch (e) { if (e.message !== 'signed-out') showLogin(); }
})();
