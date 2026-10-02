'use strict';
const UI_VER = '10';
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
const looksLoggedOut = (r) => [301, 302, 401, 403].includes(r.status) || /name=["']?UserName/i.test(r.body || '');

async function api(method, path, headers, body) {
  if (!loggedIn) await login();
  const withCk = () => Object.assign({}, headers || {}, sessionCookie ? { Cookie: sessionCookie } : {});
  let r = await native(method, path, withCk(), body);
  if (r.status === 0) throw new Error('Cannot reach the router (' + (r.error || 'no reply') + ')');
  if (looksLoggedOut(r)) { await login(); r = await native(method, path, withCk(), body); }
  return r;
}
async function token() { return clean((await api('POST', '/asp/GetRandCount.asp')).body); }
async function postForm(path, fields) {
  const p = new URLSearchParams();
  Object.keys(fields).forEach((k) => p.append(k, fields[k]));
  p.append('x.X_HW_Token', await token());
  return api('POST', path, FORM, p.toString());
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

/* ------------------------------------------------------------ ui helpers */
let current = 'devices';
const TITLES = { devices: 'Devices', wifi: 'Wi-Fi', block: 'Blocking', tools: 'Tools' };

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms || 2600);
}
function sheet(html) { $('#panel').innerHTML = html; $('#sheet').hidden = false; }
function closeSheet() { $('#sheet').hidden = true; }
$('#sheet .scrim').onclick = closeSheet;
window.onBack = () => { if (!$('#sheet').hidden) closeSheet(); else if (current !== 'devices') go('devices'); else ONT.exit(); };
const showBannerIfPending = () => { try { if (window.ONT && ONT.getPref('uiPending', '0') === '1') $('#banner').hidden = false; } catch (e) {} };
window.onUiUpdated = showBannerIfPending;
window.onUiStatus = () => { showBannerIfPending(); const el = $('#uistat'); if (el) el.textContent = ONT.getPref('uiStatus', 'not checked yet'); };
setInterval(showBannerIfPending, 2000);
$('#reload').onclick = () => { try { ONT.ackUi(); } catch (e) {} location.reload(); };
$('#refresh').onclick = () => go(current);
document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => go(b.dataset.t); });

function go(tab) {
  current = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  $('#title').textContent = TITLES[tab];
  $('#sub').textContent = '';
  $('#view').innerHTML = '<div class="empty"><span class="spin"></span></div>';
  views[tab]().catch((e) => {
    $('#view').innerHTML = '<div class="card pad"><b class="err">Something went wrong</b><div class="sm" style="margin-top:6px">' +
      esc(e.message || e) + '</div><div style="margin-top:12px"><button class="b" id="retry">Try again</button></div></div>';
    $('#retry').onclick = () => go(tab);
  });
}
const initials = (d) => ((d.name || d.ip || '?').replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase();

/* ------------------------------------------------------------ views */
const views = {};

let devQuery = '';
const getNicks = () => { try { return JSON.parse(pref('nicks', '{}')); } catch (e) { return {}; } };
const ipNum = (ip) => (ip || '').split('.').reduce((a, x) => a * 256 + (+x || 0), 0);

views.devices = async function () {
  const [list, blocked] = await Promise.all([loadDevices(), loadBlocked().catch(() => [])]);
  const nicks = getNicks();
  const isBlocked = (m) => m && blocked.some((b) => b.mac === m.toLowerCase());
  const dn = (d) => (d.mac && nicks[d.mac.toLowerCase()]) || d.name || d.devType || d.ip || d.mac || '?';
  list.sort((x, y) => (y.online - x.online) || (ipNum(x.ip) - ipNum(y.ip)));
  $('#sub').textContent = list.filter((d) => d.online).length + ' online · ' + list.length + ' known';
  $('#view').innerHTML = '<input id="q" placeholder="Search name, IP or MAC" autocapitalize="off" value="' + esc(devQuery) + '" style="margin-bottom:12px"><div id="devs"></div>';
  const draw = () => {
    const q = devQuery.trim().toLowerCase();
    const shown = list.filter((d) => !q || [dn(d), d.ip, d.mac].some((x) => (x || '').toLowerCase().includes(q)));
    $('#devs').innerHTML = shown.length ? '<div class="card">' + shown.map((d) =>
      '<div class="row" data-i="' + list.indexOf(d) + '"><div class="av" style="' + (d.online ? '' : 'opacity:.45') + '">' + esc(((dn(d)).replace(/[^a-z0-9]/gi, '').slice(0, 2) || '?').toUpperCase()) + '</div><div class="grow">' +
      '<div class="name">' + esc(dn(d)) + '</div>' +
      '<div class="sm">' + esc([d.ip, d.mac].filter(Boolean).join(' · ')) + '</div>' +
      '<span class="chip" style="' + (d.online ? 'color:var(--ok);border-color:var(--ok)' : '') + '">' + (d.online ? 'online' : (d.status ? esc(d.status.toLowerCase()) : 'offline')) + '</span>' +
      (isBlocked(d.mac) ? '<span class="chip blocked">blocked</span>' : '') +
      [d.portType, d.port, d.ipType].filter(Boolean).map((x) => '<span class="chip">' + esc(x) + '</span>').join('') +
      '</div><span class="sm">›</span></div>').join('') + '</div>'
      : '<div class="empty">' + (list.length ? 'No match' : 'No devices parsed.<br>Open Tools → Raw to see what the router sent.') + '</div>';
    document.querySelectorAll('#devs .row').forEach((row) => {
      row.onclick = () => deviceSheet(list[+row.dataset.i], isBlocked, dn);
    });
  };
  $('#q').oninput = (e) => { devQuery = e.target.value; draw(); };
  draw();
};

function deviceSheet(d, isBlocked, dn) {
  const blocked = isBlocked(d.mac);
  sheet('<h2 style="margin:0 0 4px;font-size:22px">' + esc(dn(d)) + '</h2>' +
    '<div class="sm">' + esc([d.ip, d.mac].filter(Boolean).join(' · ')) + '</div>' +
    '<div style="margin:12px 0">' + [d.status, d.portType, d.port, d.ipType, d.devType, d.time].concat(d.other).filter(Boolean).map((x) => '<span class="chip">' + esc(x) + '</span>').join('') + '</div>' +
    (d.mac ? '<label>Nickname (kept on this phone)</label><div class="seg" style="flex-wrap:nowrap"><input id="nick" value="' + esc(getNicks()[d.mac.toLowerCase()] || '') + '" placeholder="e.g. Ali\'s iPhone"><button class="b soft" id="nsave">Save</button></div>' : '') +
    '<div style="height:14px"></div>' +
    (d.mac ? (blocked
      ? '<button class="b soft" id="act" style="width:100%">Unblock this device</button>'
      : '<button class="b bad" id="act" style="width:100%">Block this device</button>') : '') +
    '<button class="b ghost" id="x" style="width:100%;margin-top:10px">Close</button>');
  $('#x').onclick = closeSheet;
  const ns = $('#nsave');
  if (ns) ns.onclick = () => {
    const n = getNicks(); const v = $('#nick').value.trim();
    if (v) n[d.mac.toLowerCase()] = v; else delete n[d.mac.toLowerCase()];
    setPref('nicks', JSON.stringify(n)); closeSheet(); toast('Saved'); go('devices');
  };
  const act = $('#act');
  if (act) act.onclick = async () => {
    if (act.dataset.c !== '1') { act.dataset.c = '1'; act.textContent = 'Tap again to confirm'; return; }
    act.disabled = true;
    try {
      if (blocked) await unblockMac(d.mac); else await blockMac(d.mac);
      closeSheet(); toast(blocked ? 'Unblocked' : 'Added to the list. Blocking only works while the filter is On (Blocking tab).', 4500); go('devices');
    } catch (e) { toast(e.message); act.disabled = false; }
  };
}

views.wifi = async function () {
  // Read the current SSID from the router so nothing is hard-coded.
  const l = await api('GET', '/html/amp/common/wlan_list.asp');
  const info = parseObjs(l.body).find((o) => o.type === 'stWlanInfo' && /WLANConfiguration\.1$/.test(o.f[0]));
  const ssid = info ? info.f[2] : pref('ssid', '');
  $('#view').innerHTML = '<div class="card pad"><h2>2.4 GHz network</h2>' +
    '<label>Network name</label><input id="ssid" value="' + esc(ssid) + '" autocapitalize="off">' +
    '<label>New password (8–63 characters)</label><input id="pw" autocapitalize="off" autocomplete="off" placeholder="Type the new password">' +
    '<div style="margin-top:16px"><button class="b" id="go" style="width:100%">Change password</button></div>' +
    '<div class="sm" style="margin-top:10px">Everything connected over Wi-Fi, including this phone, drops and has to rejoin with the new password.</div></div>';
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
    b.disabled = false; b.dataset.c = ''; b.textContent = 'Change password';
  };
};

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

views.block = async function () {
  const list = await loadBlocked();
  const page = await api('GET', MF + 'macfilter.asp');
  const dbg = (page.body || '').split(/\r?\n/).filter((l) => /MacFilter|Right|Policy|Enable|[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/i.test(l)).map((l) => l.trim().slice(0, 220)).slice(0, 40).join('\n');
  $('#sub').textContent = list.length + ' in the filter list';
  const st0 = filterState(page.body);
  $('#view').innerHTML =
    '<div class="card pad" style="border-left:5px solid ' + (st0.on ? 'var(--ok)' : 'var(--bad)') + '"><h2>Router says</h2><div class="name" id="fstate" style="font-size:20px">Filter is ' + esc(stateText(st0)) + '</div></div>' +
    '<div class="card pad"><h2>Filter switch</h2><div class="seg" style="margin-top:8px">' +
    '<button class="b soft sm2" data-p="0" data-r="1">On · blocklist</button>' +
    '<button class="b soft sm2" data-p="1" data-r="1">On · allowlist</button>' +
    '<button class="b ghost sm2" data-p="0" data-r="0">Off</button></div>' +
    '<div class="sm" style="margin-top:10px">Blocklist: listed devices are blocked. Allowlist: only listed devices get internet, so be careful. The filter must be On for any blocking to work.</div></div>' +
    '<div class="card pad"><h2>Add a MAC address</h2><input id="mac" placeholder="aa:bb:cc:dd:ee:ff" autocapitalize="off">' +
    '<div style="margin-top:12px"><button class="b" id="add" style="width:100%">Add to list</button></div></div>' +
    '<div class="card"><h2 style="padding-top:12px">In the list</h2>' +
    (list.length ? list.map((x, i) => '<div class="row"><div class="grow"><div class="name">' + esc(x.mac) + '</div></div>' +
      '<button class="b ghost sm2" data-u="' + i + '">Remove</button></div>').join('') : '<div class="empty">Empty</div>') + '</div>' +
    '<div class="card pad"><h2>Debug: what the router says</h2><pre>' + esc(dbg || '(nothing matched)') + '</pre></div>';
  document.querySelectorAll('button[data-p]').forEach((b) => b.onclick = async () => {
    try {
      const r = await postForm(FURL, { 'x.MacFilterPolicy': b.dataset.p, 'x.MacFilterRight': b.dataset.r });
      await new Promise((ok) => setTimeout(ok, 1500));
      const after = filterState((await api('GET', MF + 'macfilter.asp')).body);
      const want = b.dataset.r === '1';
      toast(after.on === want ? 'Confirmed: filter is now ' + stateText(after) : 'Router replied HTTP ' + r.status + ' but the filter is still ' + stateText(after), 6000);
      go('block');
    } catch (e) { toast(e.message); }
  });
  $('#add').onclick = async () => {
    const mac = $('#mac').value.trim();
    if (!MAC_RE.test(mac)) return toast('That is not a valid MAC address');
    try { await blockMac(mac); toast('Added'); go('block'); } catch (e) { toast(e.message); }
  };
  document.querySelectorAll('button[data-u]').forEach((b) => b.onclick = async () => {
    if (b.dataset.c !== '1') { b.dataset.c = '1'; b.textContent = 'Sure?'; return; }
    try { await unblockMac(list[+b.dataset.u].mac); toast('Remove sent'); go('block'); } catch (e) { toast(e.message); }
  });
};

views.tools = async function () {
  const canCapture = window.ONT && typeof ONT.openCapture === 'function';
  $('#view').innerHTML =
    '<div class="card pad"><h2>Record from the old portal</h2>' +
    '<div class="sm">Opens the router\'s original pages inside this app and logs what each button sends, so I can build it here. Passwords and keys are hidden in the log.</div>' +
    '<div style="margin-top:12px"><button class="b" id="cap">' + (canCapture ? 'Open the old portal' : 'Needs the latest app install') + '</button></div></div>' +
    '<div class="card pad"><h2>Router</h2>' +
    '<label>Address</label><input id="host" value="' + esc(pref('host', '192.168.100.1')) + '" autocapitalize="off">' +
    '<label>Username</label><input id="user" value="' + esc(pref('user', 'root')) + '" autocapitalize="off">' +
    '<label>Password</label><input id="pass" type="password" value="' + esc(pref('pass', 'admin')) + '">' +
    '<div style="margin-top:14px"><button class="b" id="save">Save</button></div></div>' +
    '<div class="card pad"><h2>Raw request</h2>' +
    '<label>Path</label><input id="rp" value="/html/bbsp/common/GetLanUserDevInfo.asp" autocapitalize="off">' +
    '<div class="seg" style="margin-top:10px"><select id="rm" style="width:auto"><option>POST</option><option>GET</option></select>' +
    '<button class="b" id="rs">Send</button><button class="b ghost" id="rc">Copy</button></div>' +
    '<label>Body (POST, form-encoded)</label><textarea id="rb" placeholder="a=1&b=2"></textarea>' +
    '<div class="seg" style="margin-top:8px">' +
    '<button class="b soft sm2" data-q="/html/bbsp/common/GetLanUserDhcpInfo.asp|POST">DHCP list</button>' +
    '<button class="b soft sm2" data-q="/html/bbsp/macfilter/macfilter.asp|GET">MAC filter page</button>' +
    '<button class="b soft sm2" data-q="/html/amp/wlanbasic/WlanBasic.asp|GET">Wi-Fi page</button></div>' +
    '<pre id="out">—</pre></div>' +
    '<div class="card pad"><h2>App</h2><div class="sm">UI version ' + UI_VER + '</div><div class="sm">Update check: <span id="uistat">' + esc(pref('uiStatus', 'not checked yet')) + '</span></div>' +
    '<div style="margin:10px 0"><button class="b soft sm2" id="chk">Check for update now</button></div><div class="sm">UI source: ' + esc(pref('uiBase', 'GitHub (default)')) + '</div>' +
    '<div style="margin-top:12px"><button class="b ghost" id="rst">Reset UI to built-in</button></div></div>';
  $('#cap').onclick = () => { if (canCapture) ONT.openCapture(); else toast('Install the latest HG8347R.apk first'); };
  $('#save').onclick = () => {
    setPref('host', $('#host').value.trim()); setPref('user', $('#user').value.trim()); setPref('pass', $('#pass').value);
    loggedIn = false; toast('Saved');
  };
  const run = async () => {
    $('#out').textContent = '…';
    try {
      const r = await api($('#rm').value, $('#rp').value, $('#rm').value === 'POST' ? FORM : {}, $('#rb').value);
      $('#out').textContent = 'HTTP ' + r.status + '\n\n' + r.body.slice(0, 60000);
    } catch (e) { $('#out').textContent = String(e.message || e); }
  };
  $('#rs').onclick = run;
  $('#rc').onclick = () => { const t = $('#out').textContent; if (window.ONT && ONT.copy) { ONT.copy(t); toast('Copied'); } else if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copied')); };
  document.querySelectorAll('button[data-q]').forEach((b) => b.onclick = () => {
    const [p, m] = b.dataset.q.split('|'); $('#rp').value = p; $('#rm').value = m; run();
  });
  $('#rst').onclick = () => ONT.resetUi();
  $('#chk').onclick = () => { if (ONT.checkUiNow) { $('#uistat').textContent = 'checking…'; ONT.checkUiNow(); } else toast('Needs the latest app install'); };
};

go('devices');
