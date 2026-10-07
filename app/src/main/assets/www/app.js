'use strict';
const UI_VER = '20';
/* HG8347R — clean front end for the Huawei HG8347R portal.
   All router traffic goes through the native bridge (window.ONT). */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

/* ------------------------------------------------------------ native bridge */
const cbs = {};
let seq = 0;
window.__cb = (id, res) => { const f = cbs[id]; delete cbs[id]; if (f) f(JSON.parse(res)); };
function native(method, path, headers, body) {
  return new Promise((resolve) => {
    if (!window.ONT) return resolve({ status: 0, body: '', error: 'Not running inside the app' });
    const id = ++seq;
    cbs[id] = resolve;
    ONT.request(id, method, path, JSON.stringify(headers || {}), body || '');
  });
}
const pref = (k, d) => (window.ONT ? ONT.getPref(k, d) : d);
const setPref = (k, v) => window.ONT && ONT.setPref(k, v);
const PV = (t) => '<span class="pv">' + esc(t) + '</span>';
const applyPriv = () => { const on = pref('priv', '0') === '1'; document.documentElement.classList.toggle('priv', on); const b = document.getElementById('priv'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); } };
const applyTheme = () => { document.documentElement.setAttribute('data-theme', pref('theme', 'dark')); };
applyTheme();

/* ------------------------------------------------------------ session + api */
let loggedIn = false;
const clean = (t) => String(t || '').replace(/^﻿/, '').trim();

let sessionCookie = '';
async function login() {
  ONT.clearSession();
  sessionCookie = '';
  await native('GET', '/');                       // picks up the first cookie, like a browser
  const tok = clean((await native('POST', '/asp/GetRandCount.asp')).body);
  const user = pref('user', 'root');
  const pass = pref('pass', 'admin');
  const body = 'UserName=' + encodeURIComponent(user) +
    '&PassWord=' + encodeURIComponent(btoa(pass)) +
    '&x.X_HW_Token=' + encodeURIComponent(tok);
  // The portal's own login page sets this cookie with script before posting; without it the router rejects the login.
  const r = await native('POST', '/login.cgi', Object.assign({}, FORM, { Cookie: 'Cookie=body:Language:chinese:id=-1' }), body);
  loggedIn = !!r.sid;
  if (!loggedIn && r.status !== 0) {
    // Don't trust cookie detection alone: ask for a protected page and see if the router answers it.
    const probe = await native('POST', '/html/bbsp/common/GetLanUserDevInfo.asp', {}, '');
    if (probe.status === 200 && /new\s+\w+\s*\(/.test(probe.body || '') && !/UserName|Waiting/i.test(probe.body || '')) { loggedIn = true; return; }
    // Some firmware hands the session id to the page's script instead of a header. Read it from there.
    const txt = r.body || '';
    let m = txt.match(/Cookie\s*=\s*["']?(sid=[^"';\s<]+)/i);
    if (m) sessionCookie = 'Cookie=' + m[1];
    else if ((m = txt.match(/sid[^0-9a-f]{1,6}([0-9a-f]{32,})/i))) sessionCookie = 'Cookie=sid=' + m[1] + ':Language:chinese:id=1';
    loggedIn = !!sessionCookie;
  }
  if (!loggedIn) {
    const snip = (r.body || '').replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(r.status === 0
      ? 'Cannot reach the router at ' + pref('host', '192.168.100.1') + ' (' + (r.error || 'no reply') + ')'
      : 'Login failed: HTTP ' + r.status + (r.location ? ' → ' + r.location : '') + '. Router said: ' + snip + ' || headers: ' + (r.headers || '').slice(0, 400) + ' || ui v' + UI_VER);
  }
}
const looksLoggedOut = (r) => [301, 302, 401, 403].includes(r.status) || /name=["']?UserName/i.test(r.body || '') || /<title>\s*Waiting\.\.\./i.test(r.body || '') || /top\.location\.replace\(\s*pageName/.test(r.body || '');

async function api(method, path, headers, body) {
  if (!loggedIn) await login();
  const withCk = () => Object.assign({}, headers || {}, sessionCookie ? { Cookie: sessionCookie } : {});
  let r = await native(method, path, withCk(), body);
  if (r.status === 0) throw new Error('Cannot reach the router (' + (r.error || 'no reply') + ')');
  if (looksLoggedOut(r)) { await login(); r = await native(method, path, withCk(), body); }
  return r;
}
async function token() { return clean((await api('POST', '/asp/GetRandCount.asp')).body); }
let lastWrite = null;
const plain = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const BRH = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Upgrade-Insecure-Requests': '1' };
const pageToken = (t) => { const m = /name=["']?onttoken["']?[^>]*value=["']?([0-9a-f]{20,})/i.exec(t) || /value=["']?([0-9a-f]{32})["']?[^>]*name=["']?onttoken/i.exec(t) || /id=["']?hwonttoken["']?[^>]*value=["']?([0-9a-f]{20,})/i.exec(t); return m ? m[1] : ''; };
async function postForm(path, fields) {
  const p = new URLSearchParams();
  Object.keys(fields).forEach((k) => p.append(k, fields[k]));
  const host = pref('host', '192.168.100.1');
  const rf = /[?&]RequestFile=([^&]+)/.exec(path);
  // The router only accepts the token that is printed inside the page the form lives on, so load that page first.
  let tok = '';
  if (rf) tok = pageToken((await api('GET', '/' + rf[1], BRH)).body || '');
  if (!tok) tok = await token();
  p.append('x.X_HW_Token', tok);
  const hdrs = Object.assign({}, BRH, FORM, { Origin: 'http://' + host });
  if (rf) hdrs.Referer = 'http://' + host + '/' + rf[1];
  const body = p.toString();
  const r = await api('POST', path, hdrs, body);
  lastWrite = {
    url: path.replace(/^.*\//, ''), body: body.replace(tok, '<token>'),
    status: r.status, loc: r.location || '', hdrs: (r.headers || '').slice(0, 300), reply: plain(r.body).slice(0, 500) || '(empty reply)',
  };
  return r;
}

/* ------------------------------------------------------------ parsing */
const unesc = (s) => s
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/\\(.)/g, '$1');
// The portal returns JS like: new Array(new Thing("a","b"), ..., null). Read it without running it.
function parseObjs(text) {
  const out = [];
  const re = /new\s+(?!Array\b)(\w+)\s*\(((?:[^()"']|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')*)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const f = [];
    const ar = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^,\s][^,]*)/g;
    let a;
    while ((a = ar.exec(m[2]))) f.push(unesc(a[1] !== undefined ? a[1] : a[2] !== undefined ? a[2] : a[3].trim()));
    out.push({ type: m[1], f });
  }
  return out;
}

/* ------------------------------------------------------------ data */
const MF = '/html/bbsp/macfilter/';
let blockedMacs = [];

async function loadBlocked() {
  const r = await api('GET', MF + 'macfilter.asp');
  const list = [];
  parseObjs(r.body).forEach((o) => {
    const mac = o.f.find((x) => MAC_RE.test(x));
    if (mac) list.push({ mac: mac.toLowerCase(), domain: o.f.find((x) => /^InternetGatewayDevice\./.test(x)) || '' });
  });
  blockedMacs = list;
  return list;
}

async function loadDevices() {
  const [dev, dhcp] = await Promise.all([
    api('POST', '/html/bbsp/common/GetLanUserDevInfo.asp'),
    api('POST', '/html/bbsp/common/GetLanUserDhcpInfo.asp'),
  ]);
  const byKey = {};
  const list = [];
  const get = (mac, ip) => {
    const key = (mac || ip).toLowerCase();
    let d = byKey[key];
    if (!d) { d = byKey[key] = { mac: null, ip: null, name: '', status: '', portType: '', port: '', ipType: '', devType: '', time: '', other: [] }; list.push(d); }
    d.mac = d.mac || mac || null; d.ip = d.ip || ip || null;
    return d;
  };
  const dash = (x) => (x && x !== '--' ? x : '');
  // Field order comes from the router's own USERDevice(...) definition.
  parseObjs(dev.body).forEach((o) => {
    if (o.type !== 'USERDevice') return;
    const f = o.f;
    const mac = MAC_RE.test(f[2] || '') ? f[2] : null, ip = IP_RE.test(f[1] || '') ? f[1] : null;
    if (!mac && !ip) return;
    const d = get(mac, ip);
    d.port = dash(f[3]); d.ipType = dash(f[4]); d.devType = dash(f[5]); d.status = dash(f[6]);
    d.portType = dash(f[7]); d.time = dash(f[8]); d.name = dash(f[9]);
  });
  // The DHCP list: pick up anything the first list didn't have (e.g. devices not currently connected).
  parseObjs(dhcp.body).forEach((o) => {
    const mac = o.f.find((x) => MAC_RE.test(x)), ip = o.f.find((x) => IP_RE.test(x));
    if (!mac && !ip) return;
    const d = get(mac, ip);
    o.f.forEach((x) => {
      if (x && x !== d.mac && x !== d.ip && !/^InternetGatewayDevice/.test(x) && x !== '--' && !d.other.includes(x) && !/^-?\d+$/.test(x)) d.other.push(x);
    });
    if (!d.name) d.name = d.other.find((x) => /[a-z]/i.test(x) && !/^[0-9a-f:.-]+$/i.test(x) && !/^(dhcp|static|lan\d*|ssid\d*|wifi)$/i.test(x)) || '';
  });
  list.forEach((d) => { d.online = /^(online|active)$/i.test(d.status); });
  return list;
}

async function blockMac(mac) {
  return postForm(MF + 'add.cgi?x=InternetGatewayDevice.X_HW_Security.MacFilter&RequestFile=html/bbsp/macfilter/macfilter.asp',
    { 'x.SourceMACAddress': mac });
}
async function unblockMac(mac) {
  // Request copied from the router's own Delete button (captured in the old portal).
  const list = await loadBlocked();
  const e = list.find((x) => x.mac === mac.toLowerCase());
  if (!e || !e.domain) throw new Error('That MAC is not in the router\'s filter list');
  const f = {};
  f[e.domain] = '';
  return postForm(MF + 'del.cgi?x=InternetGatewayDevice.X_HW_Security.MacFilter&RequestFile=html/bbsp/macfilter/macfilter.asp', f);
}
function filterState(body) {
  const e = /var\s+enableFilter\s*=\s*['"](\d*)['"]/.exec(body || '');
  const m = /var\s+Mode\s*=\s*['"](\d*)['"]/.exec(body || '');
  return { on: e ? e[1] === '1' : null, mode: m ? m[1] : null };
}
const stateText = (st) => st.on === null ? 'unknown' : (st.on ? 'ON' : 'OFF') + (st.mode === '0' ? ' · blocklist' : st.mode === '1' ? ' · allowlist' : '');
const FURL = MF + 'set.cgi?x=InternetGatewayDevice.X_HW_Security&RequestFile=html/bbsp/macfilter/macfilter.asp';

/* ------------------------------------------------------------ ui helpers */
let current = 'home';
const TITLES = { home: 'Home', devices: 'Devices', wifi: 'Wi-Fi', block: 'Blocking', tools: 'More' };
const views = {};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const jget = (k, d) => { try { return JSON.parse(pref(k, '')) || d; } catch (e) { return d; } };
const jset = (k, v) => setPref(k, JSON.stringify(v));

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms || 2800);
}
function sheet(html) { $('#panel').innerHTML = '<div class="grab"></div>' + html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet .scrim').onclick = closeSheet;
window.onBack = () => { if (!$('#sheet').hidden) closeSheet(); else if (current !== 'home') go('home'); else ONT.exit(); };
const showBannerIfPending = () => { try { if (window.ONT && ONT.getPref('uiPending', '0') === '1') $('#banner').hidden = false; } catch (e) {} };
window.onUiUpdated = showBannerIfPending;
window.onUiStatus = () => { showBannerIfPending(); const el = $('#uistat'); if (el) el.textContent = ONT.getPref('uiStatus', 'not checked yet'); };
setInterval(showBannerIfPending, 2000);
$('#reload').onclick = () => { try { ONT.ackUi(); } catch (e) {} location.reload(); };
$('#refresh').onclick = () => go(current);
$('#priv').onclick = () => { setPref('priv', pref('priv', '0') === '1' ? '0' : '1'); applyPriv(); toast(pref('priv', '0') === '1' ? 'Details hidden' : 'Details shown', 1600); };
applyPriv();
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => go(b.dataset.t); });

let navId = 0;
function go(tab) {
  current = tab;
  const my = ++navId;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  $('#view').classList.remove('go');
  $('#title').textContent = TITLES[tab];
  $('#sub').textContent = '';
  $('#view').innerHTML = '<div class="empty"><span class="spin"></span></div>';
  views[tab](() => my === navId).then(() => { if (my === navId) { const v = $('#view'); v.classList.remove('go'); void v.offsetWidth; v.classList.add('go'); v.scrollTop = 0; } }).catch((e) => {
    if (my !== navId) return;
    $('#view').innerHTML = '<div class="card pad"><b class="err">Something went wrong</b><div class="sm" style="margin-top:6px">' +
      esc(e.message || e) + '</div><div style="margin-top:14px"><button class="b" id="retry">Try again</button></div></div>';
    $('#retry').onclick = () => go(tab);
  });
}
const copyText = (t) => { if (window.ONT && ONT.copy) ONT.copy(t); else if (navigator.clipboard) navigator.clipboard.writeText(t); toast('Copied'); };
const getNicks = () => jget('nicks', {});
const ipNum = (ip) => (ip || '').split('.').reduce((a, x) => a * 256 + (+x || 0), 0);
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);

/* ------------------------------------------------------------ timed blocks */
async function sweepTimers() {
  const t = jget('timers', {});
  const due = Object.keys(t).filter((m) => t[m] <= Date.now());
  if (!due.length) return;
  for (const m of due) {
    try { await unblockMac(m); } catch (e) { /* not in the list any more */ }
    delete t[m];
  }
  jset('timers', t);
}
const left = (ts) => { const m = Math.max(1, Math.round((ts - Date.now()) / 60000)); return m >= 60 ? Math.round(m / 6) / 10 + ' h left' : m + ' min left'; };

/* ------------------------------------------------------------ network health */
async function pingOnce() {
  const t0 = performance.now();
  const c = new AbortController(); const to = setTimeout(() => c.abort(), 4000);
  try { await fetch('https://www.gstatic.com/generate_204?' + Date.now(), { mode: 'no-cors', cache: 'no-store', signal: c.signal }); return performance.now() - t0; }
  catch (e) { return null; } finally { clearTimeout(to); }
}
async function pingTest() {
  const v = [];
  for (let i = 0; i < 4; i++) { const x = await pingOnce(); if (x != null) v.push(x); }
  if (!v.length) return { ok: false };
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  return { ok: true, ms: Math.round(avg), jitter: Math.round(Math.max(...v) - Math.min(...v)), lost: 4 - v.length };
}
const OPTIC_PATHS = ['/html/amp/opticinfo/opticinfo.asp', '/html/ssmp/opticinfo/opticinfo.asp', '/html/status/opticinfo.asp'];
async function readOptical() {
  const known = pref('opticPath', '');
  const paths = known ? [known] : OPTIC_PATHS;
  for (const p of paths) {
    try {
      const r = await api('GET', p);
      if (r.status !== 200) continue;
      const o = parseObjs(r.body).find((x) => /optic/i.test(x.type));
      if (!o) continue;
      setPref('opticPath', p);
      const nums = o.f.filter((x) => !/^InternetGatewayDevice/.test(x)).map((x) => ({ raw: x, n: parseFloat(x) })).filter((x) => isFinite(x.n));
      const rxI = nums.findIndex((x) => x.n < -3 && x.n > -45);
      const rx = rxI >= 0 ? nums[rxI] : null;
      const rest = nums.filter((_, i) => i !== rxI);
      return { rx, tx: rest[0] || null, others: rest.slice(1), fields: o.f, path: p };
    } catch (e) { /* try next */ }
  }
  return null;
}
const rxVerdict = (v) => v > -8 ? ['Too strong', 'warn', 100] : v >= -25 ? ['Good', 'ok', 100 - Math.max(0, (-v - 8) * 2)] : v >= -27.5 ? ['Marginal', 'warn', 25] : ['Weak', 'bad', 10];
function spark(vals) {
  if (vals.length < 2) return '';
  const w = 300, h = 44, lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
  const pts = vals.map((v, i) => (i * w / (vals.length - 1)).toFixed(1) + ',' + (h - (v - lo) / (hi - lo) * h).toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
async function speedTest(onProgress) {
  const c = new AbortController(); const to = setTimeout(() => c.abort(), 9000);
  const t0 = performance.now(); let bytes = 0;
  try {
    const r = await fetch('https://speed.cloudflare.com/__down?bytes=40000000', { cache: 'no-store', signal: c.signal });
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      bytes += value.length;
      onProgress((bytes * 8 / 1e6) / ((performance.now() - t0) / 1000));
    }
  } catch (e) { if (!bytes) throw e; } finally { clearTimeout(to); }
  return (bytes * 8 / 1e6) / ((performance.now() - t0) / 1000);
}

/* ------------------------------------------------------------ home */
views.home = async function (alive) {
  sweepTimers().catch(() => {});
  $('#view').innerHTML = '<div class="empty"><span class="spin"></span></div>';
  const [net, opt, devs, mf] = await Promise.all([
    pingTest(),
    readOptical().catch(() => null),
    loadDevices().catch(() => []),
    api('GET', MF + 'macfilter.asp').then((r) => filterState(r.body)).catch(() => ({ on: null })),
  ]);
  if (!alive()) return;
  const hist = jget('hist', []);
  hist.push({ t: Date.now(), rx: opt && opt.rx ? opt.rx.n : null, ms: net.ok ? net.ms : null });
  jset('hist', hist.slice(-80));
  const rxs = hist.map((h) => h.rx).filter((x) => x != null);
  const online = devs.filter((d) => d.online).length;
  const quality = !net.ok ? ['No internet', 'var(--bad)'] : net.ms > 150 || net.lost ? ['Unstable', 'var(--warn)'] : ['Connected', 'var(--ok)'];
  $('#sub').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let optHtml;
  if (opt && opt.rx) {
    const [vt, vc, pct] = rxVerdict(opt.rx.n);
    optHtml = '<div class="card pad"><h2>Fibre signal</h2>' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline"><div style="font-size:34px;font-weight:700;letter-spacing:-.03em">' + esc(opt.rx.raw) + ' <span style="font-size:15px;color:var(--mut);font-weight:500">dBm</span></div><span class="chip ' + vc + '" style="margin:0">' + vt + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%;background:var(--' + (vc === 'ok' ? 'ok' : vc === 'warn' ? 'warn' : 'bad') + ')"></i></div>' +
      '<div class="sm">Received power. Between −8 and −25 is healthy.</div>' +
      (opt.tx ? '<div class="kv" style="margin-top:12px"><span>Transmit</span><span>' + esc(opt.tx.raw) + '</span></div>' : '') +
      opt.others.map((x, i) => '<div class="kv"><span>Reading ' + (i + 3) + '</span><span>' + esc(x.raw) + '</span></div>').join('') +
      (rxs.length > 2 ? '<div style="color:var(--ink)">' + spark(rxs) + '</div><div class="sm">Last ' + rxs.length + ' checks</div>' : '') + '</div>';
  } else {
    optHtml = '<div class="card pad"><h2>Fibre signal</h2><div class="sm">Could not find the optical page on this router. Open More → Scan router pages and send me the result.</div></div>';
  }
  $('#view').innerHTML =
    '<div class="hero"><div class="lab">Internet</div><div class="big"><span class="dot" style="background:' + quality[1] + '"></span>' + quality[0] + '</div>' +
    '<div class="s2">' + (net.ok ? net.ms + ' ms' + (net.jitter > 40 ? ' · jittery' : '') + (net.lost ? ' · ' + net.lost + ' of 4 lost' : '') : 'Checked from this phone') + '</div></div>' +
    '<div class="tiles"><div class="tile" data-go="devices"><div class="lab">Online</div><div class="v">' + online + '</div><div class="sm">of ' + devs.length + ' known</div></div>' +
    '<div class="tile" data-go="block"><div class="lab">Blocking</div><div class="v">' + (mf.on === null ? '—' : mf.on ? 'On' : 'Off') + '</div><div class="sm">' + (mf.on ? (mf.mode === '1' ? 'allowlist' : 'blocklist') : 'filter') + '</div></div></div>' +
    optHtml +
    '<div class="card pad"><h2>Speed</h2><div id="spd" style="font-size:34px;font-weight:700;letter-spacing:-.03em">—</div><div class="sm" id="spds">Measures download speed from this phone.</div>' +
    '<div style="margin-top:14px"><button class="b soft full" id="spdgo">Run speed test</button></div></div>' +
    '<div class="card pad"><h2>Restart</h2><div class="sm">Reboots the router. Everything is offline for about two minutes.</div><div style="margin-top:14px"><button class="b soft full" id="rb">Restart router…</button></div></div>';
  document.querySelectorAll('[data-go]').forEach((t) => { t.onclick = () => go(t.dataset.go); });
  $('#spdgo').onclick = async () => {
    const b = $('#spdgo'); b.disabled = true; b.textContent = 'Testing…';
    try {
      const v = await speedTest((x) => { $('#spd').innerHTML = x.toFixed(1) + ' <span style="font-size:15px;color:var(--mut);font-weight:500">Mbps</span>'; });
      $('#spds').textContent = 'Download. Wi-Fi distance and other devices affect this.';
      $('#spd').innerHTML = v.toFixed(1) + ' <span style="font-size:15px;color:var(--mut);font-weight:500">Mbps</span>';
    } catch (e) { $('#spds').textContent = 'Test failed: ' + (e.message || e); }
    b.disabled = false; b.textContent = 'Run again';
  };
  $('#rb').onclick = restartRouter;
};

async function restartRouter() {
  sheet('<h2 style="margin:0 0 6px;font-size:22px">Restart the router?</h2><div class="sm" style="margin-bottom:18px">All devices lose internet for about two minutes.</div>' +
    '<button class="b bad full" id="rbgo">Restart now</button><button class="b ghost full" id="x" style="margin-top:8px">Cancel</button>');
  $('#x').onclick = closeSheet;
  $('#rbgo').onclick = async () => {
    closeSheet();
    try {
      const r = await postForm('/html/ssmp/devmanage/set.cgi?x=InternetGatewayDevice.X_HW_DEBUG.SMP.DM.ResetBoard&RequestFile=html/ssmp/devmanage/devmanage.asp', { 'x.X_HW_Reset': '1' });
      toast('Sent (HTTP ' + r.status + '). Checking…', 4000);
      await sleep(10000);
      const p = await native('GET', '/', {}, '');
      toast(p.status === 0 ? 'Router is restarting' : 'The router ignored the restart request', 6000);
    } catch (e) { toast(e.message); }
  };
}

/* ------------------------------------------------------------ devices */
let devQuery = '';
views.devices = async function (alive) {
  await sweepTimers().catch(() => {});
  const [list, blocked] = await Promise.all([loadDevices(), loadBlocked().catch(() => [])]);
  if (!alive()) return;
  const nicks = getNicks(), timers = jget('timers', {});
  const firstRun = !pref('seen', '');
  const seen = jget('seen', {});
  list.forEach((d) => { if (d.mac && seen[d.mac.toLowerCase()] === undefined) seen[d.mac.toLowerCase()] = firstRun ? 0 : Date.now(); });
  jset('seen', seen);
  const isNew = (d) => d.mac && seen[d.mac.toLowerCase()] && Date.now() - seen[d.mac.toLowerCase()] < 86400000;
  const isBlocked = (m) => m && blocked.some((b) => b.mac === m.toLowerCase());
  const dn = (d) => (d.mac && nicks[d.mac.toLowerCase()]) || d.name || d.devType || d.ip || d.mac || '?';
  list.sort((x, y) => (y.online - x.online) || (ipNum(x.ip) - ipNum(y.ip)));
  const newOnes = list.filter(isNew);
  $('#sub').textContent = list.filter((d) => d.online).length + ' online · ' + list.length + ' known' + (newOnes.length ? ' · ' + newOnes.length + ' new' : '');
  $('#view').innerHTML = '<input class="pv" id="q" placeholder="Search" autocapitalize="off" value="' + esc(devQuery) + '" style="margin-bottom:14px"><div id="devs"></div>';
  const draw = () => {
    const q = devQuery.trim().toLowerCase();
    const shown = list.filter((d) => !q || [dn(d), d.ip, d.mac].some((x) => (x || '').toLowerCase().includes(q)));
    $('#devs').innerHTML = shown.length ? '<div class="card">' + shown.map((d) =>
      '<div class="row tap" data-i="' + list.indexOf(d) + '"><div class="av' + (d.online ? ' on' : '') + '" style="' + (d.online ? '' : 'opacity:.55') + '">' + PV(((dn(d)).replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase()) + '</div><div class="grow">' +
      '<div class="name">' + PV(dn(d)) + '</div>' +
      '<div class="sm">' + PV([d.ip, d.mac].filter(Boolean).join(' · ')) + '</div>' +
      (isNew(d) ? '<span class="chip new">New</span>' : '') +
      (isBlocked(d.mac) ? '<span class="chip blocked">Blocked' + (timers[d.mac.toLowerCase()] ? ' · ' + left(timers[d.mac.toLowerCase()]) : '') + '</span>' : '') +
      [d.portType, d.port].filter(Boolean).map((x) => '<span class="chip">' + esc(x) + '</span>').join('') +
      '</div><span class="chev">›</span></div>').join('') + '</div>'
      : '<div class="empty">' + (list.length ? 'No match' : 'No devices found') + '</div>';
    document.querySelectorAll('#devs .row').forEach((row) => { row.onclick = () => deviceSheet(list[+row.dataset.i], isBlocked, dn); });
  };
  $('#q').oninput = (e) => { devQuery = e.target.value; draw(); };
  draw();
};

function deviceSheet(d, isBlocked, dn) {
  const blocked = isBlocked(d.mac);
  let dur = 0;
  sheet('<h2 style="margin:0 0 4px;font-size:24px;letter-spacing:-.02em">' + PV(dn(d)) + '</h2>' +
    '<div class="sm">' + PV([d.ip, d.mac].filter(Boolean).join(' · ')) + '</div>' +
    '<div style="margin:10px 0 4px">' + [d.status, d.portType, d.port, d.ipType, d.devType, d.time].concat(d.other).filter(Boolean).map((x) => '<span class="chip pv">' + esc(x) + '</span>').join('') + '</div>' +
    (d.mac ? '<label>Nickname (kept on this phone)</label><div class="seg" style="flex-wrap:nowrap"><input class="pv" id="nick" value="' + esc(getNicks()[d.mac.toLowerCase()] || '') + '" placeholder="e.g. Ali\'s iPhone"><button class="b soft" id="nsave">Save</button></div>' : '') +
    (d.mac && !blocked ? '<label>Block for</label><div class="segc" id="dur"><button data-h="0" class="on">Forever</button><button data-h="1">1 h</button><button data-h="2">2 h</button><button data-h="8">8 h</button><button data-h="24">24 h</button></div>' : '') +
    '<div style="height:18px"></div>' +
    (d.mac ? (blocked
      ? '<button class="b soft full" id="act">Unblock this device</button>'
      : '<button class="b bad full" id="act">Block this device</button>') : '') +
    '<button class="b ghost full" id="x" style="margin-top:6px">Close</button>');
  $('#x').onclick = closeSheet;
  document.querySelectorAll('#dur button').forEach((b) => b.onclick = () => {
    dur = +b.dataset.h; document.querySelectorAll('#dur button').forEach((x) => x.classList.toggle('on', x === b));
    if (dur) $('#act').textContent = 'Block for ' + dur + ' h'; else $('#act').textContent = 'Block this device';
  });
  const ns = $('#nsave');
  if (ns) ns.onclick = () => {
    const n = getNicks(); const v = $('#nick').value.trim();
    if (v) n[d.mac.toLowerCase()] = v; else delete n[d.mac.toLowerCase()];
    jset('nicks', n); closeSheet(); toast('Saved'); go('devices');
  };
  const act = $('#act');
  if (act) act.onclick = async () => {
    if (act.dataset.c !== '1') { act.dataset.c = '1'; act.textContent = 'Tap again to confirm'; return; }
    act.disabled = true;
    try {
      const key = d.mac.toLowerCase();
      if (blocked) {
        await unblockMac(d.mac);
        const t = jget('timers', {}); delete t[key]; jset('timers', t);
        closeSheet(); toast('Unblocked'); go('devices');
      } else {
        const st = filterState((await api('GET', MF + 'macfilter.asp')).body);
        if (!(st.on && st.mode === '0')) await postForm(FURL, { 'x.MacFilterPolicy': '0', 'x.MacFilterRight': '1' });
        await blockMac(d.mac);
        await sleep(1500);
        const ok = (await loadBlocked()).some((x) => x.mac === key);
        const on = filterState((await api('GET', MF + 'macfilter.asp')).body).on;
        if (ok && dur) { const t = jget('timers', {}); t[key] = Date.now() + dur * 3600000; jset('timers', t); }
        closeSheet(); toast(ok && on ? (dur ? 'Blocked for ' + dur + ' h' : 'Blocked') : ok ? 'Added, but the filter is still off' : 'The router did not add it', 4500); go('devices');
      }
    } catch (e) { toast(e.message); act.disabled = false; }
  };
}

/* ------------------------------------------------------------ wi-fi */
views.wifi = async function (alive) {
  const l = await api('GET', '/html/amp/common/wlan_list.asp');
  if (!alive()) return;
  const nets = parseObjs(l.body).filter((o) => o.type === 'stWlanInfo').map((o) => {
    const m = /WLANConfiguration\.(\d+)$/.exec(o.f[0] || '');
    return { idx: m ? +m[1] : 0, ssid: o.f[2] || '', f: o.f };
  }).filter((n) => n.idx);
  const main = nets.find((n) => n.idx === 1);
  const ssid = main ? main.ssid : pref('ssid', '');
  $('#sub').textContent = nets.length + ' network' + (nets.length === 1 ? '' : 's');
  $('#view').innerHTML =
    '<div class="card pad"><h2>2.4 GHz network</h2>' +
    '<label>Network name</label><input class="pv" id="ssid" value="' + esc(ssid) + '" autocapitalize="off">' +
    '<label>New password (8–63 characters)</label><input class="pv" id="pw" autocapitalize="off" autocomplete="off" placeholder="Type the new password">' +
    '<div style="margin-top:18px"><button class="b full" id="go">Save changes</button></div>' +
    '<div class="sm" style="margin-top:12px">Everything on Wi-Fi, including this phone, drops and has to rejoin.</div></div>' +
    '<div class="sec">All networks on the router</div><div class="card">' +
    (nets.length ? nets.map((n) => '<div class="row"><div class="grow"><div class="name">' + PV(n.ssid || '(no name)') + '</div><div class="sm">' + (n.idx <= 4 ? '2.4 GHz' : '5 GHz') + ' · network ' + n.idx + '</div></div></div>').join('') : '<div class="empty">None found</div>') + '</div>' +
    '<div class="sm" style="margin:0 8px 14px">Only the 2.4 GHz network can be edited here for now. 5 GHz and guest need one recording from the old portal (More → Record).</div>';
  $('#go').onclick = async () => {
    const pw = $('#pw').value, name = $('#ssid').value.trim();
    if (pw.length < 8 || pw.length > 63) return toast('Password must be 8–63 characters');
    if (!name) return toast('Network name is empty');
    const b = $('#go');
    if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = 'Tap again to confirm'; return; }
    b.disabled = true;
    try {
      const r = await postForm('/html/amp/wlanbasic/set.cgi?w=InternetGatewayDevice.X_HW_DEBUG.AMP.WifiCoverSetWlanBasic' +
        '&y=InternetGatewayDevice.LANDevice.1.WLANConfiguration.1' +
        '&z=InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.WPS' +
        '&k=InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1' +
        '&RequestFile=html/amp/wlanbasic/WlanBasic.asp', {
        'y.Enable': '1', 'y.SSIDAdvertisementEnabled': '1', 'y.SSID': name, 'y.X_HW_AssociateNum': '32',
        'y.BeaconType': 'WPAand11i', 'y.X_HW_WPAand11iAuthenticationMode': 'PSKAuthentication',
        'y.X_HW_WPAand11iEncryptionModes': 'TKIPandAESEncryption', 'k.PreSharedKey': pw,
        'y.X_HW_GroupRekey': '3600', 'z.Enable': '0', 'z.X_HW_ConfigMethod': 'PushButton',
        'w.SsidInst': '1', 'w.SSID': name, 'w.Enable': '1', 'w.Standard': '11bgn',
        'w.BasicAuthenticationMode': 'None', 'w.BasicEncryptionModes': 'TKIPandAESEncryption',
        'w.WPAAuthenticationMode': 'EAPAuthentication', 'w.WPAEncryptionModes': 'TKIPandAESEncryption',
        'w.IEEE11iAuthenticationMode': 'EAPAuthentication', 'w.IEEE11iEncryptionModes': 'TKIPandAESEncryption',
        'w.MixAuthenticationMode': 'PSKAuthentication', 'w.MixEncryptionModes': 'TKIPandAESEncryption',
        'w.BeaconType': 'WPAand11i', 'w.WEPEncryptionLevel': '104-bit', 'w.WEPKeyIndex': '1', 'w.Key': pw,
      });
      toast(r.status < 400 ? 'Sent. Rejoin Wi-Fi with the new password.' : 'Router said HTTP ' + r.status, 5000);
    } catch (e) { toast(e.message); }
    b.disabled = false; b.dataset.c = ''; b.textContent = 'Save changes';
  };
};

/* ------------------------------------------------------------ blocking */
views.block = async function (alive) {
  await sweepTimers().catch(() => {});
  const list = await loadBlocked();
  const page = await api('GET', MF + 'macfilter.asp');
  if (!alive()) return;
  const st = filterState(page.body), timers = jget('timers', {});
  const mode = !st.on ? 'off' : st.mode === '1' ? 'allow' : 'block';
  $('#sub').textContent = list.length + ' in the list';
  $('#view').innerHTML =
    '<div class="card pad"><h2>Filter</h2><div class="segc" id="fsw">' +
    '<button data-m="off" class="' + (mode === 'off' ? 'on' : '') + '">Off</button><button data-m="block" class="' + (mode === 'block' ? 'on' : '') + '">Blocklist</button><button data-m="allow" class="' + (mode === 'allow' ? 'on' : '') + '">Allowlist</button></div>' +
    '<div class="sm" style="margin-top:12px">Blocklist: listed devices have no internet. Allowlist: only listed devices do, so be careful. The filter must be on for any blocking to work.</div></div>' +
    '<div class="sec">Blocked devices</div><div class="card">' +
    (list.length ? list.map((x, i) => '<div class="row"><div class="grow"><div class="name">' + PV(((getNicks()[x.mac]) || x.mac)) + '</div><div class="sm">' + PV(x.mac) + (timers[x.mac] ? ' · ' + left(timers[x.mac]) : '') + '</div></div>' +
      '<button class="b soft sm2" data-u="' + i + '">Remove</button></div>').join('') : '<div class="empty">Nothing blocked</div>') + '</div>' +
    '<div class="card pad"><h2>Add by MAC address</h2><input class="pv" id="mac" placeholder="aa:bb:cc:dd:ee:ff" autocapitalize="off"><div style="margin-top:12px"><button class="b full" id="add">Add to list</button></div></div>';
  document.querySelectorAll('#fsw button').forEach((b) => b.onclick = async () => {
    const m = b.dataset.m;
    if (m === 'allow' && b.dataset.c !== '1') { b.dataset.c = '1'; toast('Allowlist cuts off everyone not listed. Tap again to confirm.', 4500); return; }
    const p = m === 'allow' ? '1' : '0', r = m === 'off' ? '0' : '1';
    try {
      await postForm(FURL, { 'x.MacFilterPolicy': p, 'x.MacFilterRight': r });
      await sleep(1500);
      const after = filterState((await api('GET', MF + 'macfilter.asp')).body);
      toast((after.on === (r === '1')) ? 'Filter is now ' + stateText(after) : 'The router did not change the filter', 4500);
      go('block');
    } catch (e) { toast(e.message); }
  });
  $('#add').onclick = async () => {
    const mac = $('#mac').value.trim();
    if (!MAC_RE.test(mac)) return toast('That is not a valid MAC address');
    try {
      await blockMac(mac); await sleep(1500);
      toast((await loadBlocked()).some((x) => x.mac === mac.toLowerCase()) ? 'Added' : 'The router did not add it', 4000);
      go('block');
    } catch (e) { toast(e.message); }
  };
  document.querySelectorAll('button[data-u]').forEach((b) => b.onclick = async () => {
    if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = 'Sure?'; return; }
    try { const m = list[+b.dataset.u].mac; await unblockMac(m); const t = jget('timers', {}); delete t[m]; jset('timers', t); toast('Removed'); go('block'); } catch (e) { toast(e.message); }
  });
};

/* ------------------------------------------------------------ more */
const SCAN = [
  '/html/amp/opticinfo/opticinfo.asp', '/html/ssmp/opticinfo/opticinfo.asp', '/html/status/opticinfo.asp',
  '/html/ssmp/deviceinfo/deviceinfo.asp', '/html/bbsp/waninfo/waninfo.asp', '/html/bbsp/wan/wan.asp', '/html/bbsp/common/GetWanInfo.asp',
  '/html/bbsp/dhcpservercfg/dhcpservercfg.asp', '/html/bbsp/dns/dns.asp', '/html/bbsp/portmapping/portmapping.asp', '/html/bbsp/dmz/dmz.asp',
  '/html/amp/wlanbasic/WlanBasic.asp', '/html/amp/wlanadvance/wlanadvance.asp', '/html/amp/common/wlan_list.asp',
  '/html/ssmp/devmanage/devmanage.asp', '/html/ssmp/accoutcfg/accountcfg.asp', '/html/ssmp/syslog/syslog.asp', '/html/ssmp/time/time.asp',
];
views.tools = async function () {
  const canCapture = window.ONT && typeof ONT.openCapture === 'function';
  $('#view').innerHTML =
    '<div class="sec">Appearance</div><div class="card pad"><div class="segc" id="thm"><button data-v="dark">Black</button><button data-v="light">Light</button><button data-v="auto">Auto</button></div></div>' +
    '<div class="sec">Router</div><div class="card pad">' +
    '<label style="margin-top:0">Address</label><input class="pv" id="host" value="' + esc(pref('host', '192.168.100.1')) + '" autocapitalize="off">' +
    '<label>Username</label><input class="pv" id="user" value="' + esc(pref('user', 'root')) + '" autocapitalize="off">' +
    '<label>Password</label><input class="pv" id="pass" type="password" value="' + esc(pref('pass', 'admin')) + '">' +
    '<div style="margin-top:16px"><button class="b full" id="save">Save</button></div></div>' +
    '<div class="sec">Add more features</div><div class="card pad"><div class="sm">Opens the router\'s original pages in here and records what each button sends, so I can build it. Passwords are hidden in the log.</div>' +
    '<div style="margin-top:14px"><button class="b soft full" id="cap">' + (canCapture ? 'Record from the old portal' : 'Needs the latest app install') + '</button></div>' +
    '<div style="margin-top:10px"><button class="b soft full" id="scan">Scan router pages</button></div><pre class="pv" id="scanout" hidden></pre><button class="b ghost sm2" id="scancp" hidden>Copy result</button></div>' +
    '<div class="sec">Collect router details</div><div class="card pad"><div class="sm">Reads the router\'s own pages for DHCP, DNS, WAN, guest Wi-Fi, port forwarding and more, and pulls out the request names they use. Takes about a minute. Copy the result and send it to me.</div><div style="margin-top:12px"><button class="b soft full" id="col">Collect</button></div><div class="sm" id="colst" style="margin-top:10px"></div><pre class="pv" id="colout" hidden></pre><button class="b ghost sm2" id="colcp" hidden>Copy result</button></div>' +
    '<div class="sec">Diagnose</div><div class="card pad"><div class="sm">Tries the filter switch several ways and reports which the router accepts.</div><div style="margin-top:12px"><button class="b soft full" id="diag">Run filter diagnose</button></div><pre class="pv" id="diagout" hidden></pre><button class="b ghost sm2" id="diagcp" hidden>Copy result</button></div>' +
    '<div class="card pad"><h2>Raw request</h2>' +
    '<input class="pv" id="rp" value="/html/bbsp/common/GetLanUserDevInfo.asp" autocapitalize="off">' +
    '<div class="seg" style="margin-top:10px"><select id="rm" style="width:auto"><option>POST</option><option>GET</option></select>' +
    '<button class="b" id="rs">Send</button><button class="b soft" id="rc">Copy</button></div>' +
    '<textarea class="pv" id="rb" placeholder="Body (POST): a=1&b=2" style="margin-top:10px"></textarea><pre class="pv" id="out">—</pre></div>' +
    '<div class="sec">App</div><div class="card pad"><div class="kv"><span>UI version</span><span>' + UI_VER + '</span></div><div class="kv"><span>Update check</span><span id="uistat" style="font-weight:500;font-size:13px">' + esc(pref('uiStatus', 'not checked yet')) + '</span></div>' +
    '<div style="margin-top:12px" class="seg"><button class="b soft sm2" id="chk">Check for update</button><button class="b ghost sm2" id="rst">Reset UI</button></div></div>';
  const markTheme = () => document.querySelectorAll('#thm button').forEach((b) => b.classList.toggle('on', b.dataset.v === pref('theme', 'dark')));
  markTheme();
  document.querySelectorAll('#thm button').forEach((b) => b.onclick = () => { setPref('theme', b.dataset.v); applyTheme(); markTheme(); });
  $('#cap').onclick = () => { if (canCapture) ONT.openCapture(); else toast('Install the latest HG8347R.apk first'); };
  $('#save').onclick = () => {
    setPref('host', $('#host').value.trim()); setPref('user', $('#user').value.trim()); setPref('pass', $('#pass').value);
    loggedIn = false; toast('Saved');
  };
  $('#col').onclick = async () => {
    const b = $('#col'), st = $('#colst'), out = $('#colout'); b.disabled = true; out.hidden = false; out.textContent = '';
    const KEEP = /cgi|RequestFile|\bx\.|\by\.|\bz\.|\bw\.|\bk\.|new\s+st\w+|new\s+\w*(Dhcp|Dns|Wan|Info)\w*\(|InternetGatewayDevice|\.asp|Parameter\.|SpecPara|HWGet|HWSet|AddSubmit|SubmitForm|enable|Enable/;
    const seeds = ['/', '/frame.asp', '/index.asp', '/menu.asp', '/html/ssmp/common/menu.asp', '/html/ssmp/common/menu.html', '/html/ssmp/mainpage/mainpage.asp'];
    const found = new Set(); let rep = '';
    try {
      for (const p of seeds) {
        st.textContent = 'Looking for pages: ' + p;
        try { const r = await api('GET', p, BRH); (r.body || '').replace(/["'(]((?:\/)?html\/[A-Za-z0-9_\/.-]+\.asp)/g, (_, m) => { found.add('/' + m.replace(/^\//, '')); return _; }); } catch (e) { /* skip */ }
      }
      const want = /dhcp|dns|wan|optic|guest|forward|portmap|mapping|dmz|reset|devmanage|deviceinfo|wlanbasic|wlanadv|lan|upnp|time|account|ddns|firewall|acl|qos|route/i;
      let list = [...found].filter((p) => want.test(p) && !/GetLanUser|refreshTime|GetRandCount/.test(p));
      SCAN.forEach((p) => { if (!list.includes(p)) list.push(p); });
      list = list.slice(0, 45);
      rep += 'PAGES FOUND IN MENU: ' + found.size + '\n' + [...found].join('\n') + '\n\n';
      let i = 0;
      for (const p of list) {
        st.textContent = 'Reading ' + (++i) + ' of ' + list.length + ': ' + p;
        let r; try { r = await api('GET', p, BRH); } catch (e) { continue; }
        const body = r.body || '';
        if (r.status !== 200 || body.length < 300 || /<title>\s*Waiting/i.test(body)) { rep += '## ' + p + '  [no: ' + r.status + ', ' + body.length + ']\n\n'; continue; }
        const lines = [];
        body.split(/\r?\n/).forEach((l) => { const t = l.trim(); if (t.length > 2 && KEEP.test(t) && !/language\[|_language\.|\.css|\.js"/i.test(t)) lines.push(t.slice(0, 230)); });
        rep += '## ' + p + '  [' + body.length + ' bytes]\n' + lines.slice(0, 70).join('\n') + '\n\n';
        out.textContent = rep;
      }
      st.textContent = 'Done. ' + rep.length + ' characters. Tap Copy.';
    } catch (e) { st.textContent = 'Stopped: ' + (e.message || e); }
    out.textContent = rep; b.disabled = false; const cp = $('#colcp'); cp.hidden = false; cp.onclick = () => copyText(rep);
  };
  $('#scan').onclick = async () => {
    const out = $('#scanout'); out.hidden = false; out.textContent = 'Scanning…'; let rep = '';
    for (const p of SCAN) {
      try {
        const r = await api('GET', p);
        const types = [...new Set(parseObjs(r.body).map((o) => o.type))].join(',');
        const looksReal = r.status === 200 && !/<title>\s*Waiting/i.test(r.body || '') && (r.body || '').length > 300;
        rep += (looksReal ? 'FOUND ' : 'no    ') + p + '  [' + r.status + ', ' + (r.body || '').length + ' bytes' + (types ? ', ' + types : '') + ']\n';
      } catch (e) { rep += 'err   ' + p + '\n'; }
      out.textContent = rep + '…';
    }
    out.textContent = rep; const cp = $('#scancp'); cp.hidden = false; cp.onclick = () => copyText(rep);
  };
  $('#diag').onclick = async () => {
    const out = $('#diagout'); out.hidden = false; out.textContent = 'Running…';
    const BR = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Upgrade-Insecure-Requests': '1' };
    const host = 'http://' + pref('host', '192.168.100.1');
    const pageTok = (t) => { const m = /name=["']?onttoken["']?[^>]*value=["']?([0-9a-f]{20,})/i.exec(t) || /value=["']?([0-9a-f]{32})["']?[^>]*name=["']?onttoken/i.exec(t) || /id=["']?hwonttoken["']?[^>]*value=["']?([0-9a-f]{20,})/i.exec(t); return m ? m[1] : ''; };
    const BH = () => Object.assign({}, BR, FORM, { Referer: host + '/html/bbsp/macfilter/macfilter.asp', Origin: host });
    const B = (tok) => 'x.MacFilterRight=1&x.MacFilterPolicy=0&x.X_HW_Token=' + tok;
    const variants = [
      ['plain', () => postForm(FURL, { 'x.MacFilterPolicy': '0', 'x.MacFilterRight': '1' })],
      ['browser headers after page load', async () => { await api('GET', MF + 'macfilter.asp', BR); return api('POST', FURL, BH(), B(await token())); }],
      ['token from page', async () => {
        const pg = await api('GET', MF + 'macfilter.asp', BR); const tok = pageTok(pg.body || '');
        if (!tok) return { status: 'no onttoken in page', body: '' };
        return api('POST', FURL, BH(), B(tok));
      }],
      ['token fetched twice, 2nd used', async () => { await token(); return api('POST', FURL, BH(), B(await token())); }],
      ['fresh login first', async () => { await login(); await api('GET', MF + 'macfilter.asp', BR); return api('POST', FURL, BH(), B(await token())); }],
    ];
    let rep = ''; let won = '';
    for (const [name, fn] of variants) {
      try {
        const r = await fn();
        await new Promise((ok) => setTimeout(ok, 1500));
        const st = filterState((await api('GET', MF + 'macfilter.asp')).body);
        rep += name + ': HTTP ' + r.status + ', reply "' + plain(r.body).slice(0, 80) + '", filter now ' + stateText(st) + '\n';
        if (st.on) { won = name; break; }
      } catch (e) { rep += name + ': error ' + e.message + '\n'; }
      out.textContent = rep + '…';
    }
    rep += won ? '\nWORKED: ' + won : '\nNone of them turned it on.';
    out.textContent = rep; const cp = $('#diagcp'); cp.hidden = false; cp.onclick = () => { if (window.ONT && ONT.copy) ONT.copy(rep); toast('Copied'); };
  };
  const run = async () => {
    $('#out').textContent = '…';
    try {
      const r = await api($('#rm').value, $('#rp').value, $('#rm').value === 'POST' ? FORM : {}, $('#rb').value);
      $('#out').textContent = 'HTTP ' + r.status + '\n\n' + r.body.slice(0, 60000);
    } catch (e) { $('#out').textContent = String(e.message || e); }
  };
  $('#rs').onclick = run;
  $('#rc').onclick = () => copyText($('#out').textContent);
  $('#rst').onclick = () => ONT.resetUi();
  $('#chk').onclick = () => { if (ONT.checkUiNow) { $('#uistat').textContent = 'checking…'; ONT.checkUiNow(); } else toast('Needs the latest app install'); };
};

go('home');
