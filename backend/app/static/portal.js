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
const NEXT = { acknowledged: ['en_route', 'Mark en route'], en_route: ['on_scene', 'Mark on scene'], on_scene: ['resolved', 'Resolve incident'] };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const APP_TITLE = 'AccidentAlert AI · Response Portal';

let token = localStorage.getItem('cg_token');
let me = null, stations = [];
let alerts = [], sel = null, detail = null, nearestFor = null, lastTop = null, fresh = new Set();
let filter = 'active', view = 'live', pollT = null, busy = false, polling = false, pollAgain = false, lastPoll = 0;
let streamCtl = null, streamOk = false;
let alertsOn = localStorage.getItem('cg_alerts') !== 'off';
let audio = null, alarmT = null, alarmEnd = null, titleT = null;
let pending = [];                                   // new alerts waiting in the pop-up
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
// Rough drive time: roads run ~1.4x the straight line, ~40 km/h average with lights in city traffic.
const etaMin = d => Math.max(1, Math.ceil(d * 1.4 / 40 * 60));
const fmtEta = d => { const m = etaMin(d); return m < 60 ? '≈ ' + m + ' min' : '≈ ' + Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min'; };
const distFromMe =a => (a.lat != null && me && me.lat != null) ? km(me.lat, me.lng, a.lat, a.lng) : null;
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
  clearInterval(pollT); stopAlarm(); closeIncoming(); if (streamCtl) streamCtl.abort();
  $('app').hidden = true; $('login').hidden = false; $('loginErr').textContent = msg || '';
  try { stations = await fetch('/api/stations').then(r => r.json()); } catch { stations = []; }
  const s = $('stationSel'); s.textContent = '';
  if (!stations.length) {
    s.append(h('option', { value: '' }, 'No districts set up'));
    $('loginErr').textContent = 'No districts exist yet. Restart the server with DEMO_STATION_PIN=2468 (see README).';
  }
  for (const st of stations) s.append(h('option', { value: st.id }, st.name + (st.area ? ' · ' + st.area : '')));
  const last = localStorage.getItem('cg_station'); if (last) s.value = last;
  $('pin').value = ''; $('pin').focus();
}
$('loginForm').onsubmit = async e => {
  e.preventDefault();
  unlockAudio();                          // the click on "Sign in" lets the browser play the alarm later
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
  if (askDone) askDone(false);
  nearCache.clear();
  token = null; me = null; localStorage.removeItem('cg_token');
  alerts = []; sel = null; detail = null; lastTop = null; pending = [];
  showLogin(msg);
}
$('logout').onclick = async () => {
  if (await ask({ kind: 'out', kicker: me ? me.name : 'Sign out', title: 'Sign out of the portal?',
    body: 'This screen will stop receiving crash alerts until someone signs in again.', okLabel: 'Sign out' })) signOut();
};

async function startApp() {
  $('login').hidden = true; $('app').hidden = false;
  $('meName').textContent = me.name; $('meArea').textContent = me.area || '';
  stations = await fetch('/api/stations').then(r => r.json()).catch(() => stations);
  renderAlertsBtn();
  setView(view);
  poll(); listen();
  clearInterval(pollT);
  // Backup polling: every 4 s while the live stream is down, otherwise a slow safety refresh.
  pollT = setInterval(() => { if (!streamOk || Date.now() - lastPoll > 20000) poll(); }, 4000);
}

// ---------- Shell ----------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => setView(b.dataset.view));
function setView(v) {
  view = v;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === v));
  $('view-live').hidden = v !== 'live'; $('view-analytics').hidden = v !== 'analytics';
  if (v === 'analytics') loadAnalytics();
}
function setLive(state) {
  $('live').classList.toggle('off', state !== 'live');
  $('liveTxt').textContent = { live: 'Live', slow: 'Live (every 4 s)', off: 'Offline, retrying' }[state];
}

// ---------- Alert sound & notifications ----------
function unlockAudio() {
  if (!alertsOn) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no audio support */ }
  setTimeout(renderSoundHint, 50);
}
document.addEventListener('pointerdown', unlockAudio, true);
document.addEventListener('keydown', unlockAudio, true);
function renderSoundHint() { $('soundHint').hidden = !(token && alertsOn && (!audio || audio.state !== 'running')); }
$('soundHint').onclick = unlockAudio;

function tone(freq, start, len, vol = .22) {
  const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + start;
  o.type = 'triangle'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + .02); g.gain.setValueAtTime(vol, t + len - .05); g.gain.linearRampToValueAtTime(0, t + len);
  o.connect(g); g.connect(audio.destination); o.start(t); o.stop(t + len);
}
function siren() { if (audio && alertsOn && audio.state === 'running') { tone(988, 0, .22); tone(740, .26, .22); tone(988, .52, .22); } }
function startAlarm() { stopAlarm(); siren(); alarmT = setInterval(siren, 1500); alarmEnd = setTimeout(stopAlarm, 45000); }
function stopAlarm() { clearInterval(alarmT); clearTimeout(alarmEnd); }

function renderAlertsBtn() {
  $('alertsBtn').classList.toggle('muted', !alertsOn);
  $('alertsTxt').textContent = alertsOn ? 'Alerts on' : 'Alerts muted';
  renderSoundHint();
}
$('alertsBtn').onclick = async () => {
  alertsOn = !alertsOn; localStorage.setItem('cg_alerts', alertsOn ? 'on' : 'off');
  if (alertsOn) {
    unlockAudio(); siren();
    if ('Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch { } }
    toast('Alerts on: alarm sound and desktop notifications for new crashes');
  } else { stopAlarm(); toast('Alerts muted. New crashes still pop up on screen.'); }
  renderAlertsBtn();
};
function desktopNotify(a) {
  if (!alertsOn || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;   // the pop-up is enough
  try {
    const d = distFromMe(a);
    const n = new Notification('New crash alert: ' + SEV[a.severity] + ' crash', {
      body: a.vehicle_label + (d != null ? ' · ' + d.toFixed(1) + ' km from your station' : '') + '\nClick to open the portal.',
      tag: 'crash-' + a.id, requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}
function flashTitle(on) {
  clearInterval(titleT);
  if (!on) { renderTitle(); return; }
  let k = 0;
  titleT = setInterval(() => { document.title = (k++ % 2) ? '🚨 NEW CRASH ALERT' : APP_TITLE; }, 1000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !pending.length) flashTitle(false); });
function renderTitle() {
  const n = alerts.filter(a => a.status === 'new').length;
  if (!titleT) document.title = (n ? '(' + n + ') ' : '') + APP_TITLE;
}
// Ask once for desktop notification permission (needs a click in most browsers, so we hook the first one)
document.addEventListener('click', function askOnce() {
  document.removeEventListener('click', askOnce);
  if (token && alertsOn && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
});

// ---------- New alert pop-up ----------
function onNewAlerts(list) {
  list.forEach(a => fresh.add(a.id));
  setTimeout(() => { list.forEach(a => fresh.delete(a.id)); renderList(); }, 5000);
  const ids = new Set(pending.map(a => a.id));
  pending.push(...list.filter(a => a.status === 'new' && !ids.has(a.id)));
  if (!pending.length) return;
  pending.sort((a, b) => b.severity - a.severity || b.id - a.id);
  showIncoming();
  startAlarm(); flashTitle(true);
  list.forEach(desktopNotify);
  if (!detail || !ACTIVE.includes(detail.status)) sel = pending[0].id;
}
function showIncoming() {
  const a = pending[0];
  if (!a) return closeIncoming();
  const d = distFromMe(a);
  $('inMore').textContent = pending.length > 1 ? '· ' + (pending.length - 1) + ' more waiting' : '';
  $('inSev').textContent = ''; $('inSev').append(h('span', { class: 'sev ' + SEVC[a.severity] }, SEV[a.severity] + ' crash'));
  if (a.flags & 2) $('inSev').append(h('span', { class: 'tag', style: 'margin-left:10px' }, 'Test'));
  $('inVeh').textContent = a.vehicle_label;
  $('inMeta').textContent = [d != null ? d.toFixed(1) + ' km, ' + fmtEta(d) + ' from your station' : 'No GPS location', 'impact ' + a.peak_g.toFixed(1) + ' g', 'received ' + timeOf(a.created_at_utc)].join(' · ');
  $('inNear').textContent = '';
  if (a.lat != null) fetchNearest(a.id).then(rows => {
    if (pending[0] !== a || !rows.length) return;
    $('inNear').append(h('div', { class: 'near-cap' }, 'Nearest stations'), ...nearRows(rows, null, 3));
  });
  $('incoming').hidden = false;
  $('inTake').disabled = false;
  $('inTake').focus();
}
function closeIncoming() { $('incoming').hidden = true; }
function dropPending(id) {
  pending = pending.filter(a => a.id !== id);
  if (pending.length) showIncoming(); else { closeIncoming(); stopAlarm(); flashTitle(false); }
}
$('inTake').onclick = async () => {
  const a = pending[0]; if (!a) return;
  $('inTake').disabled = true;
  setView('live'); setFilter('active'); sel = a.id;
  try {
    detail = await api('/api/alerts/' + a.id + '/updates', { method: 'POST', body: JSON.stringify({ action: 'status', status: 'acknowledged' }) });
    toast('Your station is now responding to ' + a.vehicle_label);
  } catch (e) { if (e.message !== 'signed-out') toast(e.message, true); }
  dropPending(a.id); select(a.id); poll();
};
$('inView').onclick = () => { const a = pending[0]; if (!a) return; dropPending(a.id); setView('live'); setFilter('active'); select(a.id); };
$('inLater').onclick = () => { pending = []; closeIncoming(); stopAlarm(); flashTitle(false); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (askDone) askDone(false);
  else if (!$('incoming').hidden) $('inLater').onclick();
});

// ---------- Live: updates (stream + backup polling) ----------
async function listen() {
  if (streamCtl) streamCtl.abort();
  const ctl = streamCtl = new AbortController();
  try {
    const r = await fetch('/api/stream', { headers: { Authorization: 'Bearer ' + token }, signal: ctl.signal });
    if (r.status === 401) { signOut('Your session expired. Sign in again.'); return; }
    if (!r.ok || !r.body) throw new Error('no stream');
    streamOk = true; setLive('live');
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^data:/m.test(msg)) poll();
      }
    }
  } catch (e) { if (ctl.signal.aborted) return; }
  streamOk = false; if (token) { setLive('slow'); setTimeout(() => { if (token && streamCtl === ctl) listen(); }, 3000); }
}
async function poll() {
  if (polling) { pollAgain = true; return; }
  polling = true; lastPoll = Date.now();
  try {
    const list = await api('/api/alerts?limit=300');
    setLive(streamOk ? 'live' : 'slow');
    const top = list.length ? list[0].id : 0;
    const prev = lastTop; lastTop = top; alerts = list;
    if (prev !== null && top > prev) onNewAlerts(list.filter(a => a.id > prev));
    // Someone else took an alert that is still in our pop-up: drop it quietly
    for (const p of pending.slice()) {
      const cur = alerts.find(a => a.id === p.id);
      if (cur && cur.status !== 'new') {
        if (cur.assigned_station_id !== me.id) toast(cur.vehicle_label + ' was taken by ' + (cur.assigned_station_name || 'another station'));
        dropPending(p.id);
      }
    }
    if (sel === null) { const first = visible()[0]; if (first) sel = first.id; }
    renderCounts(); renderList();
    const cur = alerts.find(a => a.id === sel);
    if (sel !== null && (!detail || detail.id !== sel || (cur && cur.updated_at_utc !== detail.updated_at_utc))) loadDetail(sel);
    else if (sel === null) renderDetail();
  } catch (e) { if (e.message !== 'signed-out') setLive('off'); }
  polling = false;
  if (pollAgain) { pollAgain = false; poll(); }
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
function renderCounts() {
  const waiting = alerts.filter(a => a.status === 'new').length;
  const active = alerts.filter(a => ACTIVE.includes(a.status)).length;
  const mine = alerts.filter(a => ACTIVE.includes(a.status) && a.assigned_station_id === me.id).length;
  $('cActive').textContent = active || ''; $('cActive').classList.toggle('urgent', waiting > 0);
  $('cMine').textContent = mine || '';
  $('tabCount').textContent = waiting; $('tabCount').hidden = waiting === 0;
  renderTitle();
}
function incCard(a) {
  const who = a.status === 'new' ? 'No station yet' : a.assigned_station_id === me.id ? 'Your station' : (a.assigned_station_name || '');
  return h('button', {
    class: 'inc' + (a.id === sel ? ' sel' : '') + (fresh.has(a.id) ? ' fresh' : '') + (a.status === 'new' ? ' waiting' : ''), style: '--c:' + SEVVAR[a.severity],
    onclick: () => select(a.id), 'aria-current': a.id === sel ? 'true' : null,
  },
    h('div', { class: 'row1' }, h('span', { class: 'veh' }, a.vehicle_label), h('span', { class: 'ago' }, ago(a.created_at_utc))),
    h('div', { class: 'row2' }, h('span', { class: 'sev ' + SEVC[a.severity] }, SEV[a.severity]), h('span', { class: 'pill st-' + a.status }, STATUS[a.status]),
      h('span', null, who), (a.flags & 2) ? h('span', { class: 'tag' }, 'Test') : null),
  );
}
function renderList() {
  const box = $('list'), list = visible(); box.textContent = '';
  if (!list.length) {
    const [t, s] = { active: ['All clear', 'No active incidents right now.'], mine: ['Nothing for your station', 'Your station is not leading any incident.'], closed: ['No closed incidents', 'Resolved incidents will show here.'] }[filter];
    box.append(h('p', { class: 'none' }, h('b', null, $('search').value ? 'No match' : t), $('search').value ? 'No vehicle matches your search.' : s));
    return;
  }
  if (filter === 'active') {
    const waiting = list.filter(a => a.status === 'new'), going = list.filter(a => a.status !== 'new');
    if (waiting.length) box.append(h('h4', { class: 'urgent' }, 'Needs a station · ' + waiting.length), ...waiting.map(incCard));
    if (going.length) box.append(h('h4', null, 'In progress · ' + going.length), ...going.map(incCard));
  } else box.append(...list.map(incCard));
}
function select(id) { sel = id; renderList(); loadDetail(id); }

// ---------- Live: detail ----------
async function loadDetail(id) {
  try {
    const d = await api('/api/alerts/' + id);
    if (sel !== id) return;
    detail = d; renderDetail();
    if (nearestFor !== id) { nearestFor = id; loadNearest(id); }
  } catch (e) { if (e.message !== 'signed-out') toast(e.message, true); }
}
// Stations near the scene, nearest first, with an estimated drive time.
const nearCache = new Map();                         // alert id -> rows from /nearest-stations
async function fetchNearest(id) {
  if (!nearCache.has(id)) nearCache.set(id, api('/api/alerts/' + id + '/nearest-stations').catch(() => { nearCache.delete(id); return []; }));
  return nearCache.get(id);
}
async function loadNearest(id) {
  $('nearest').hidden = true;
  const rows = await fetchNearest(id);
  if (sel === id && detail && detail.id === id) renderNearest(detail, rows);
}
function nearRows(rows, a, max) {
  const helping = new Set((a && a.assisting_stations || '').split(',').map(s => s.trim()).filter(Boolean));
  return rows.slice(0, max).map((s, i) => {
    const you = s.id === me.id;
    const role = a && s.id === a.assigned_station_id ? h('span', { class: 'role lead' }, 'Leading')
      : helping.has(s.name) ? h('span', { class: 'role help' }, 'Supporting') : null;
    return h('div', { class: 'near' + (you ? ' you' : '') + (i === 0 ? ' first' : '') },
      h('span', { class: 'rank' }, String(i + 1)),
      h('span', { class: 'nm' }, s.name, you ? h('span', { class: 'role you' }, 'You') : null, role),
      h('span', { class: 'km' }, s.distance_km.toFixed(1) + ' km'),
      h('span', { class: 'eta' }, h('b', null, fmtEta(s.distance_km)), ' away'));
  });
}
function renderNearest(a, rows) {
  if (!rows || !rows.length) { $('nearest').hidden = true; return; }
  $('nearList').textContent = '';
  $('nearList').append(...nearRows(rows, a, 5));
  $('nearest').hidden = false;
}
function renderDetail() {
  const a = detail && detail.id === sel ? detail : null;
  $('empty').hidden = !!a; $('info').hidden = !a;
  if (!a) return;
  $('dSev').className = 'sev ' + SEVC[a.severity]; $('dSev').textContent = SEV[a.severity] + ' crash';
  $('dStatus').className = 'pill st-' + a.status; $('dStatus').textContent = STATUS[a.status];
  $('dTest').hidden = !(a.flags & 2);
  $('dVeh').textContent = a.vehicle_label;
  const d = distFromMe(a);
  $('dSub').textContent = 'Incident #' + a.id + ' · ' + ago(a.created_at_utc) + (d != null ? ' · ' + d.toFixed(1) + ' km from your station' : '') +
    (a.assisting_stations ? ' · supported by ' + a.assisting_stations.split(',').join(', ') : '');
  $('mPeak').textContent = a.peak_g.toFixed(1) + ' g';
  $('mConf').textContent = Math.round(a.confidence * 100) + '%';
  $('mTime').textContent = timeOf(a.created_at_utc);
  $('mAcc').textContent = a.accuracy_m != null ? '± ' + Math.round(a.accuracy_m) + ' m' : 'No GPS';
  $('mAck').textContent = a.acknowledged_at_utc ? fmtMin(minutesBetween(a.created_at_utc, a.acknowledged_at_utc)) : 'Waiting';
  $('mAck').classList.toggle('wait', !a.acknowledged_at_utc && a.status === 'new');
  renderActions(a); renderProgress(a);
  const has = a.lat != null;
  const canRoute = has && me.lat != null;
  $('map').hidden = !has; $('noLoc').hidden = has; $('mapMode').hidden = !canRoute;
  if (has) setFrame($('map'), mapMode === 'route' && canRoute ? gRoute(me, a) : gPin(a, 16));
  renderTimeline(a);
  if (nearCache.has(a.id)) nearCache.get(a.id).then(rows => { if (detail && detail.id === a.id) renderNearest(detail, rows); });
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
function renderProgress(a) {
  const when = {};
  for (const u of a.updates || []) if (u.action === 'status') when[u.status] = u.created_at_utc;
  const last = a.status === 'false_alarm' ? 'false_alarm' : 'resolved';
  const steps = [['new', 'Received', a.created_at_utc], ['acknowledged', 'Acknowledged'], ['en_route', 'En route'], ['on_scene', 'On scene'], [last, STATUS[last]]];
  const cur = a.status === 'false_alarm' ? 4 : steps.findIndex(s => s[0] === a.status);
  const box = $('progress'); box.textContent = '';
  box.className = 'progress' + (ACTIVE.includes(a.status) ? '' : ' closed');
  box.style.setProperty('--sc', STATUSVAR[a.status]);
  steps.forEach(([key, label, t], i) => {
    const at = t || when[key];
    box.append(h('div', { class: i < cur ? 'done' : i === cur ? 'now' : '' }, h('b', null, label), at ? timeOf(at) : (i < cur ? 'skipped' : '')));
  });
}
function renderActions(a) {
  const box = $('actions'); box.textContent = '';
  const btn = (label, cls, fn) => h('button', { class: 'btn big ' + cls, onclick: fn, disabled: busy }, label);
  const link = (label, cls, fn) => h('button', { class: 'linkbtn ' + cls, onclick: fn, disabled: busy }, label);
  const mine = a.assigned_station_id === me.id;
  if (!ACTIVE.includes(a.status)) {
    const last = (a.updates || []).filter(u => u.action === 'status').pop();
    box.append(h('div', { class: 'note-line' }, 'Closed as ', h('b', null, STATUS[a.status].toLowerCase()),
      last ? [' by ', h('b', null, last.station_id === me.id ? 'your station' : last.station_name || 'a station'), ' at ' + timeOf(last.created_at_utc)] : null));
    return;
  }
  if (a.status === 'new') {
    box.append(btn('Acknowledge and respond', 'primary', () => update({ action: 'status', status: 'acknowledged' })),
      h('div', { class: 'more' }, link('Mark as false alarm', 'danger', () => confirmUpdate('false_alarm'))));
    return;
  }
  if (mine) {
    const [next, label] = NEXT[a.status];
    box.append(btn(label, next === 'resolved' ? 'ok' : 'primary', () => next === 'resolved' ? confirmUpdate('resolved') : update({ action: 'status', status: next })),
      h('div', { class: 'more' },
        next !== 'resolved' ? link('Resolve now', '', () => confirmUpdate('resolved')) : null,
        link('False alarm', 'danger', () => confirmUpdate('false_alarm'))));
    return;
  }
  const assisting = (a.updates || []).some(u => u.action === 'assist' && u.station_id === me.id);
  box.append(h('div', { class: 'note-line' }, h('b', null, a.assigned_station_name), ' is leading this incident.'),
    assisting ? h('span', { class: 'pill st-en_route' }, 'Your station is supporting')
      : btn('Send support', 'primary', () => update({ action: 'assist', note: $('note').value.trim() || null })));
}
async function confirmUpdate(status) {
  const a = detail; if (!a) return;
  const ok = status === 'resolved';
  const r = await ask({
    kind: ok ? 'ok' : 'warn',
    kicker: ok ? 'Close incident' : 'Not a real crash?',
    title: ok ? 'Mark as resolved?' : 'Mark as false alarm?',
    incident: a,
    body: ok ? 'The incident will be closed for every station and moved to Closed.'
      : 'The alert will be closed for every station and counted as a false detection in Analytics.',
    note: $('note').value.trim(),
    okLabel: ok ? 'Yes, resolve incident' : 'Yes, mark as false alarm',
  });
  if (!r || !detail || detail.id !== a.id) return;
  $('note').value = '';
  update({ action: 'status', status, note: r.note || null });
}

// ---------- Confirmation dialog ----------
const ASK_ICON = {
  ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 4 2.5 20h19L12 4z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/></svg>',
};
let askDone = null;
function ask(o) {
  if (askDone) askDone(false);
  return new Promise(resolve => {
    const m = $('ask'), back = document.activeElement;
    m.dataset.kind = o.kind;
    $('askIcon').innerHTML = ASK_ICON[o.kind];
    $('askKicker').textContent = o.kicker;
    $('askTitle').textContent = o.title;
    $('askBody').textContent = o.body;
    const inc = $('askInc'); inc.textContent = ''; inc.hidden = !o.incident;
    if (o.incident) inc.append(h('span', { class: 'sev ' + SEVC[o.incident.severity] }, SEV[o.incident.severity]),
      h('b', null, o.incident.vehicle_label), h('span', { class: 'muted' }, 'Incident #' + o.incident.id));
    $('askNote').hidden = o.note == null; $('askNote').value = o.note || '';
    $('askOk').className = 'btn big ' + (o.kind === 'ok' ? 'ok' : o.kind === 'warn' ? 'warn' : 'primary');
    $('askOk').textContent = o.okLabel;
    askDone = yes => {
      askDone = null; m.hidden = true;
      if (back && back.focus) back.focus();
      resolve(yes ? { note: $('askNote').value.trim() } : null);
    };
    $('askOk').onclick = () => askDone(true);
    $('askCancel').onclick = () => askDone(false);
    m.onclick = e => { if (e.target === m) askDone(false); };
    m.hidden = false;
    $('askCancel').focus();
  });
}
async function update(body) {
  if (busy || !detail) return;
  busy = true; renderActions(detail);
  try {
    const d = await api('/api/alerts/' + detail.id + '/updates', { method: 'POST', body: JSON.stringify(body) });
    if (body.note) $('note').value = '';
    detail = d;
    const i = alerts.findIndex(a => a.id === d.id); if (i >= 0) alerts[i] = { ...alerts[i], ...d };
    if (pending.some(p => p.id === d.id)) dropPending(d.id);
    toast(body.action === 'assist' ? 'Support recorded. The leading station can see it.' : body.action === 'note' ? 'Note sent' : 'Status updated: ' + STATUS[d.status]);
    renderCounts(); renderList();
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
setInterval(() => { if (view === 'live' && alerts.length) { renderList(); if (detail) renderDetail(); } }, 30000);

// ---------- Analytics ----------
document.querySelectorAll('.a-controls .seg button').forEach(b => b.onclick = () => { aPeriod = b.dataset.p; loadAnalytics(); });
$('aYear').onchange = () => { aDate = $('aYear').value + aDate.slice(4); loadAnalytics(); };
$('aMonth').onchange = () => { if ($('aMonth').value) { aDate = $('aMonth').value + '-01'; loadAnalytics(); } };
$('aDay').onchange = () => { if ($('aDay').value) { aDate = $('aDay').value; loadAnalytics(); } };
$('aTests').onchange = loadAnalytics;
$('aPrev').onclick = () => shift(-1);
$('aNext').onclick = () => shift(1);
$('aNow').onclick = () => { aDate = todayStr(); loadAnalytics(); };
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
  const n = aPeriod === 'year' ? 4 : aPeriod === 'month' ? 7 : 10, atNow = aDate.slice(0, n) >= todayStr().slice(0, n);
  $('aNext').disabled = atNow; $('aNow').hidden = atNow;
  $('aNow').textContent = { year: 'This year', month: 'This month', day: 'Today' }[aPeriod];
}
async function loadAnalytics() {
  syncControls(aData && aData.years);
  $('aBody').classList.add('loading');
  const date = aPeriod === 'year' ? aDate.slice(0, 4) + '-01-01' : aPeriod === 'month' ? aDate.slice(0, 7) + '-01' : aDate;
  const want = aPeriod + date + $('aTests').checked; loadAnalytics.want = want;
  try {
    const d = await api(`/api/analytics?period=${aPeriod}&date=${date}&include_tests=${$('aTests').checked}`);
    if (loadAnalytics.want !== want) return;          // a newer request is on its way
    aData = d; syncControls(d.years); renderAnalytics(d);
  } catch (e) { if (e.message !== 'signed-out') toast(e.message, true); }
  $('aBody').classList.remove('loading');
}
window.addEventListener('resize', () => { clearTimeout(window._rs); window._rs = setTimeout(() => { if (aData && view === 'analytics') renderAnalytics(aData); }, 150); });

const SEVSERIES = [{ key: 'minor', name: 'Minor', color: 'var(--sev1)' }, { key: 'serious', name: 'Serious', color: 'var(--sev2)' }, { key: 'critical', name: 'Critical', color: 'var(--sev3)' }];
const PREVWORD = { year: 'last year', month: 'last month', day: 'the day before' };

function peakWindow(byHour) {
  let best = 0; for (let i = 0; i < 24; i++) if (byHour[i] + byHour[(i + 1) % 24] > byHour[best] + byHour[(best + 1) % 24]) best = i;
  return best;
}
function renderAnalytics(d) {
  const k = d.kpis, total = k.alerts;
  $('aLabel').textContent = d.label;

  // KPI tiles: the four numbers a station chief asks first
  const delta = k.prev_alerts ? (total - k.prev_alerts) / k.prev_alerts : null;
  const tiles = [
    ['Accidents', total, null, delta == null ? 'No data for ' + PREVWORD[d.period]
      : h('span', { class: delta > 0 ? 'up' : delta < 0 ? 'down' : '' }, (delta > 0 ? '▲ ' : delta < 0 ? '▼ ' : '') + Math.abs(Math.round(delta * 100)) + '% vs ' + PREVWORD[d.period])],
    ['Critical crashes', k.critical, null, total ? Math.round(k.critical / total * 100) + '% of all accidents' : '—'],
    ['Typical response time', ...splitUnit(k.median_ack_min), 'from alert to a station acknowledging'],
    ['Typical time to resolve', ...splitUnit(k.median_resolve_min), 'from alert to incident resolved'],
  ];
  const kp = $('kpis'); kp.textContent = '';
  for (const [label, val, unit, sub] of tiles) kp.append(h('div', { class: 'kpi' }, h('small', null, label), h('b', null, val, unit ? h('u', null, unit) : null), h('span', null, sub)));

  // Accidents over time
  const cats = d.series.map(s => s.label);
  $('tsSub').textContent = { year: 'Per month', month: 'Per day', day: 'Per hour' }[d.period] + ', split by severity';
  $('tsLegend').textContent = '';
  SEVSERIES.forEach(s => $('tsLegend').append(h('span', { style: '--c:' + s.color }, h('i'), s.name)));
  const ser = SEVSERIES.map(s => ({ ...s, values: d.series.map(r => r[s.key]) }));
  columnChart($('tsChart'), cats, ser, { h: 270, label: 'Accidents over time by severity', tip: i => tipFor(d.series[i].label + tipSuffix(d, i), ser, i) });
  $('tsTable').textContent = '';
  $('tsTable').append(table([{ t: { year: 'Month', month: 'Day', day: 'Hour' }[d.period] }, { t: 'Minor', num: 1 }, { t: 'Serious', num: 1 }, { t: 'Critical', num: 1 }, { t: 'Total', num: 1 }],
    d.series.map(r => [r.label, r.minor, r.serious, r.critical, r.minor + r.serious + r.critical])));

  // Time of day / weekday (not meaningful for a single day: the main chart is already hourly)
  const multi = d.period !== 'day';
  $('patterns').hidden = !multi;
  if (multi) {
    const pk = total ? peakWindow(d.by_hour) : -1, inPeak = i => total > 0 && (i === pk || i === (pk + 1) % 24);
    const hs = [{ name: 'Accidents', color: 'var(--accent)', values: d.by_hour }];
    columnChart($('hourChart'), d.by_hour.map((_, i) => pad(i)), hs, {
      h: 210, label: 'Accidents by hour of day', hi: inPeak, barColor: i => inPeak(i) ? 'var(--accent)' : 'var(--accent-soft)',
      tip: i => tipFor(pad(i) + ':00 – ' + pad((i + 1) % 24) + ':00', hs, i),
    });
    const maxD = Math.max(...d.by_weekday), isMax = i => total > 0 && d.by_weekday[i] === maxD;
    const ds = [{ name: 'Accidents', color: 'var(--accent)', values: d.by_weekday }];
    columnChart($('dowChart'), WEEKDAYS.map(w => w.slice(0, 3)), ds, {
      h: 210, label: 'Accidents by day of week', hi: isMax, barColor: i => isMax(i) ? 'var(--accent)' : 'var(--accent-soft)',
      tip: i => tipFor(WEEKDAYS[i], ds, i),
    });
  }

  // Hotspots: pick one to show it on the map
  $('hotspots').textContent = '';
  $('hotMap').hidden = !d.hotspots.length;
  if (d.hotspots.length) {
    const btns = d.hotspots.map((p, i) => h('button', { class: 'hot', onclick: () => show(i) },
      h('span', { class: 'rank' }, i + 1),
      h('span', { class: 'where' }, nearestText(p) || p.lat.toFixed(3) + ', ' + p.lng.toFixed(3), h('small', null, p.lat.toFixed(4) + ', ' + p.lng.toFixed(4))),
      h('span', { class: 'n' }, p.count, h('small', null, p.critical + ' critical'))));
    const show = i => { btns.forEach((b, k) => b.classList.toggle('on', k === i)); setFrame($('hotMap'), gPin(d.hotspots[i], 15)); };
    $('hotspots').append(...btns); show(0);
  } else $('hotspots').append(h('p', { class: 'nodata' }, 'No located accidents in this period.'));

  // Stations
  const maxLed = Math.max(1, ...d.stations.map(s => s.handled));
  $('stationTable').textContent = '';
  if (d.stations.length) {
    const tbl = table(
      [{ t: 'Station' }, { t: 'Incidents led' }, { t: 'Resolved', num: 1 }, { t: 'False alarms', num: 1 }, { t: 'Supported others', num: 1 }, { t: 'Typical response', num: 1 }],
      d.stations.map(s => [h('span', null, s.name, s.id === me.id ? h('span', { class: 'you' }, 'YOU') : null, s.area ? h('div', { class: 'muted', style: 'font-size:12px' }, s.area) : null),
        h('span', null, h('span', { class: 'minibar', style: 'width:' + Math.round(s.handled / maxLed * 140) + 'px' }), s.handled),
        s.resolved, s.false_alarm, s.assisted, fmtMin(s.median_ack_min)]));
    tbl.querySelectorAll('tbody tr').forEach((r, i) => { if (d.stations[i].id === me.id) r.className = 'my-row'; });
    $('stationTable').append(tbl);
  } else $('stationTable').append(h('p', { class: 'nodata' }, 'No stations yet.'));

  // Outcomes
  hbars($('outChart'), Object.entries(d.outcomes).map(([s, v]) => ({ label: STATUS[s], value: v, sc: STATUSVAR[s], c: STATUSVAR[s] })));

  // Alert quality
  const pct = (n, of) => of ? ' (' + Math.round(n / of * 100) + '%)' : '';
  $('quality').textContent = '';
  [['Cancelled by the driver', 'Driver tapped "I am OK" in time', k.cancelled_by_driver, k.cancel_rate != null ? ' (' + Math.round(k.cancel_rate * 100) + '%)' : ''],
   ['Marked false alarm', 'Closed by a station as not a crash', k.false_alarm, pct(k.false_alarm, total)],
   ['Small impacts ignored', 'Bumps the device decided were not crashes', k.ignored_impacts, '']]
    .forEach(([t, s, n, p]) => $('quality').append(h('div', { class: 'q-row' }, h('span', null, t, h('small', null, s + p)), h('b', null, n))));

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
  const ul = $('insights'), k = d.kpis, li = (icon, ...c) => ul.append(h('li', null, h('span', { class: 'ic', 'aria-hidden': 'true' }, icon), h('span', null, ...c)));
  ul.textContent = '';
  if (!k.alerts) { li('✓', 'No accidents were recorded in this period.'); return; }
  if (k.unassigned) li('⚠', h('b', null, k.unassigned + ' incident' + (k.unassigned > 1 ? 's' : '')), ' from this period ', k.unassigned > 1 ? 'are' : 'is', ' still waiting for a station.');
  const busiest = d.series.reduce((b, r) => (r.minor + r.serious + r.critical) > (b.minor + b.serious + b.critical) ? r : b);
  const word = { year: 'month', month: 'day', day: 'hour' }[d.period];
  li('▲', 'Busiest ', word, ': ', h('b', null, d.period === 'month' ? busiest.label + ' ' + new Date(d.start + 'T12:00').toLocaleString([], { month: 'long' }) : busiest.label),
    ' with ', h('b', null, busiest.minor + busiest.serious + busiest.critical), ' accidents.');
  if (d.period !== 'day') {
    const best = peakWindow(d.by_hour);
    const share = Math.round((d.by_hour[best] + d.by_hour[(best + 1) % 24]) / k.alerts * 100);
    li('◷', 'Most crashes happen ', h('b', null, pad(best) + ':00 – ' + pad((best + 2) % 24) + ':00'), ' (' + share + '%). Good time for extra patrols.');
    const wd = d.by_weekday.indexOf(Math.max(...d.by_weekday));
    li('▦', h('b', null, WEEKDAYS[wd] + 's'), ' are the busiest day (' + d.by_weekday[wd] + ' accidents).');
  }
  if (d.hotspots.length && d.hotspots[0].count > 1) li('◎', 'Top hotspot: ', h('b', null, d.hotspots[0].count + ' accidents'), ' ' + nearestText(d.hotspots[0]) + '.');
  const fast = d.stations.filter(s => s.handled >= 3 && s.median_ack_min != null).sort((a, b) => a.median_ack_min - b.median_ack_min);
  if (fast.length > 1) li('⚡', 'Fastest response: ', h('b', null, fast[0].name), ' (typically ' + fmtMin(fast[0].median_ack_min) + ').');
  if (k.cancel_rate != null && k.cancel_rate >= .25) li('!', 'Drivers cancelled ', h('b', null, Math.round(k.cancel_rate * 100) + '%'), ' of detections. The detector may be too sensitive.');
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
// Columns, optionally stacked. Bars <= 28px, 4px rounded data-end, 2px surface gap between stacked segments.
// opts.barColor(i) recolours a single-series bar (emphasis); opts.hi(i) bolds its axis label.
function columnChart(el, cats, series, opts) {
  const W = Math.max(el.clientWidth || 600, 280), H = opts.h || 250, m = { l: 34, r: 4, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const totals = cats.map((_, i) => series.reduce((s, se) => s + se.values[i], 0));
  const step = niceStep(Math.max(...totals, 1) / 4), max = step * 4;
  const y = v => m.t + ph - v / max * ph;
  const band = pw / cats.length, bw = Math.min(28, Math.max(3, band * .62));
  const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / 42))));
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(opts.label)}">`;
  for (let i = 0; i <= 4; i++) {
    const yy = Math.round(y(step * i)) + .5;
    if (i) s += `<line class="gl" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    s += `<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${step * i}</text>`;
  }
  cats.forEach((c, i) => {
    const cx = m.l + band * i + band / 2, x = cx - bw / 2;
    const segs = series.map(se => ({ v: se.values[i], c: opts.barColor ? opts.barColor(i) : se.color })).filter(z => z.v > 0);
    let cum = 0;
    segs.forEach((z, k) => {
      let yb = y(cum); const yt = y(cum + z.v); if (k) yb -= 2; cum += z.v;
      const hgt = Math.max(1, yb - yt);
      s += k === segs.length - 1 ? roundTop(x, yb - hgt, bw, hgt, Math.min(4, hgt, bw / 2), z.c)
        : `<rect x="${x}" y="${yb - hgt}" width="${bw}" height="${hgt}" style="fill:${z.c}"/>`;
    });
    if (i % every === 0) s += `<text x="${cx}" y="${H - 6}" text-anchor="middle"${opts.hi && opts.hi(i) ? ' class="hi"' : ''}>${esc(c)}</text>`;
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
