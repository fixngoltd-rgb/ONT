/* Fix and Go Board - phone app prototype.
   Same Supabase project/data as the desktop board. This is a separate, phone-native
   front end: swipeable column pages, tap-through job cards, pull to refresh,
   camera-attached comments. Full field editing still lives on the desktop board -
   this app covers the day-to-day: check the list, call someone, move a job along,
   post a comment/photo from site.
*/

const SUPABASE_URL = 'https://ojxqplxgyfokhkoyacic.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9qeHFwbHhneWZva2hrb3lhY2ljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMzg4MDcsImV4cCI6MjA5MzcxNDgwN30.G1m4yBF3MDMmpScVj9GQRDzZdy5TR38MxBowPHROlNY';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let JOBS = [];
let CURRENT_USER = null;
let currentDetailId = null;
let activeTabIndex = 0;
let pendingPhoto = null;
let detailOpenedFromColumn = null;
let teamMembers = [];
let technicians = [];
let activeAssignedFilter = '';
let activeTechFilter = '';
let editMode = false;
let QUOTE_DATES = {};
let EMAIL_LINK;

function can(permKey){
  if(!CURRENT_USER) return false;
  if(CURRENT_USER.role === 'admin') return true;
  return !!(CURRENT_USER.permissions && CURRENT_USER.permissions[permKey]);
}

const COLUMNS = [
  {
    key: 'appointments_today',
    title: 'Today',
    filter: j => !j.quote_needed && j.scheduled_at && isDueToday(j.scheduled_at) && j.status !== 'completed' && j.status !== 'cancelled'
  },
  {
    key: 'awaiting_start',
    title: 'Needs a Date',
    filter: j => !j.quote_needed && ['active', 'contacted'].includes(j.status) && !j.scheduled_at
  },
  {
    // missed appointments (date passed, not done) sit here first, in red
    key: 'awaiting_completion',
    title: 'Booked',
    filter: j => !j.quote_needed && (j.status === 'booked' || (j.scheduled_at && j.status !== 'completed' && j.status !== 'cancelled')) && !isDueToday(j.scheduled_at)
  },
  {
    key: 'awaiting_invoice',
    title: 'Awaiting Invoice',
    filter: j => !j.quote_needed && j.status === 'completed' && !j.invoiced
  },
  {
    key: 'completed_invoiced',
    title: 'Done',
    filter: j => !j.quote_needed && j.status === 'completed' && j.invoiced
  },
  {
    key: 'revisit',
    title: 'Revisit',
    filter: j => !j.quote_needed && j.status === 'revisit'
  },
  {
    key: 'quote_needed',
    title: 'Quotes',
    filter: j => j.quote_needed === true && j.status !== 'cancelled'
  },
  {
    key: 'cancelled',
    title: 'Cancelled',
    filter: j => j.status === 'cancelled'
  }
];

/* ===== UK TIME (same rules as the desktop board) =====
   Appointments are always shown/entered in UK time, whatever the phone's timezone is.
   A value at exactly 00:00 UTC means "date only, no time set". */
const UK_TZ = 'Europe/London';
const _ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: UK_TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
function _toDate(iso){
  if(iso instanceof Date) return iso;
  let t = String(iso).replace(' ', 'T');
  if(!/(Z|[+-]\d\d(:?\d\d)?)$/.test(t)) t += (t.length <= 10 ? 'T00:00:00Z' : 'Z');
  return new Date(t);
}
function ukParts(iso){
  if(!iso) return null;
  const d = _toDate(iso);
  if(isNaN(d)) return null;
  const o = {};
  _ukFmt.formatToParts(d).forEach(p => { o[p.type] = p.value; });
  return { date: `${o.year}-${o.month}-${o.day}`, time: `${o.hour}:${o.minute}`,
           hasTime: !(d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0), ms: d.getTime() };
}
function ukDate(iso){ const p = ukParts(iso); return p ? p.date : ''; }
function ukTime(iso){ const p = ukParts(iso); return (p && p.hasTime) ? p.time : ''; }
function ukToIso(dateStr, timeStr){
  if(!dateStr) return null;
  if(!timeStr) return dateStr;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const wallMs = Date.UTC(y, mo-1, d, h, mi);
  const offsetAt = ms => { const p = ukParts(new Date(ms)); const [yy,mm,dd] = p.date.split('-').map(Number); const [hh,mn] = p.time.split(':').map(Number); return Date.UTC(yy,mm-1,dd,hh,mn) - ms; };
  let utc = wallMs - offsetAt(wallMs);
  utc = wallMs - offsetAt(utc);
  return new Date(utc).toISOString();
}
function apptSortKey(j){
  const p = ukParts(j.scheduled_at);
  if(!p) return '9999-99-99 99:99';
  return p.date + ' ' + (p.hasTime ? p.time : '99:99');
}
function todayDateStr(){ return ukDate(new Date()); }
function isDueToday(scheduledAt){ return !!scheduledAt && ukDate(scheduledAt) === todayDateStr(); }

// "New" tag: a job counts as new for 24h, and on a UK Monday back to Friday 00:00 so the weekend's jobs all show.
function isNewJob(j){
  const ca = j && j.created_at;
  if(!ca || String(ca).length <= 10) return false;
  const t = new Date(ca);
  if(isNaN(t)) return false;
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(now);
  const g = k => (parts.find(p => p.type === k) || {}).value;
  const hrs = (parseInt(g('hour'), 10) % 24) + parseInt(g('minute'), 10) / 60;
  const lookbackH = g('weekday') === 'Mon' ? hrs + 72 : 24;
  return (now - t) <= lookbackH * 3600000;
}
function newTagHtml(j){ return isNewJob(j) ? '<span class="new-tag" title="New - came in recently">new</span>' : ''; }

function daysSince(dateStr){
  if(!dateStr) return 0;
  return Math.max(0, Math.floor((new Date() - new Date(dateStr)) / 86400000));
}
function badgeColor(days){ return days <= 2 ? 'green' : (days <= 5 ? 'amber' : 'red'); }
function formatShortDate(dateStr){
  if(!dateStr) return '';
  return _toDate(dateStr).toLocaleDateString('en-GB', { timeZone: UK_TZ, day:'2-digit', month:'short' });
}
function formatApptFull(iso){
  if(!iso) return 'Not set';
  const t = ukTime(iso);
  return formatShortDate(iso) + (t ? ' at ' + t + ' UK' : '');
}
// newest job first: by the day it was added, then the exact time, then job number
function newestFirst(a, b){
  const d = (b.created || '').localeCompare(a.created || '');
  if(d !== 0) return d;
  const t = (b.created_at || '').localeCompare(a.created_at || '');
  if(t !== 0) return t;
  const n = r => { const m = (r || '').match(/(\d+)/); return m ? parseInt(m[1], 10) : 0; };
  return n(b.ref) - n(a.ref);
}
function escHtml(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ===== AUTH ===== */

async function doLogin(){
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errEl.textContent = '';
  if(!email || !password){ errEl.textContent = 'Enter your email and password.'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false; btn.textContent = 'Sign In';
  if(error){ errEl.textContent = error.message; return; }
  await boot();
}

async function doLogout(){
  await sb.auth.signOut();
  location.reload();
}

async function loadProfile(userId){
  const { data, error } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
  if(error || !data || !data.active) return null;
  return data;
}

async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){ return; }
  const profile = await loadProfile(session.user.id);
  if(!profile){
    document.getElementById('login-error').textContent = 'Account not set up or deactivated.';
    await sb.auth.signOut();
    return;
  }
  CURRENT_USER = profile;
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.add('visible');
  const nm = profile.name || '';
  document.getElementById('sb-name').textContent = nm;
  document.getElementById('sb-role').textContent = profile.role === 'admin' ? 'Admin' : 'Team member';
  document.getElementById('sb-avatar').textContent = (nm.trim().split(/\s+/).map(w => w[0]).join('').slice(0,2) || '?').toUpperCase();
  applyRoleUI();
  await Promise.all([fetchAllJobs(), fetchTeamAndTechnicians()]);
}

function applyRoleUI(){
  const isAdmin = CURRENT_USER.role === 'admin';
  // Employees only ever see their own jobs - team/filter/add-job are admin surfaces.
  ['sb-newjob','sb-team','sb-tech','sb-people-label','sb-desk'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = isAdmin ? '' : 'none';
  });
  document.getElementById('filter-btn').style.display = isAdmin ? '' : 'none';
}

/* ===== SIDEBAR ===== */

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.add('show');
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('show');
}
async function sbAction(what){
  closeSidebar();
  if(what === 'newjob') openNewJobScreen();
  else if(what === 'team') openTeamSheet('team');
  else if(what === 'tech') openTeamSheet('tech');
  else if(what === 'desk') openActionDesk();
  else if(what === 'theme') toggleTheme();
  else if(what === 'refresh'){
    showToast('Updating...');
    await Promise.all([fetchAllJobs(), fetchTeamAndTechnicians()]);
    showToast('Up to date');
  }
}

/* ===== DATA ===== */

async function fetchAllJobs(){
  const { data, error } = await sb.from('jobs').select('*').is('archived_at', null).order('created_at', { ascending: false });
  if(error){ showToast('Failed to load jobs'); return; }
  JOBS = (data || []).map(j => ({
    id: j.id, ref: j.ref, title: j.title, address: j.address, external_job_id: j.external_job_id,
    tenant: j.tenant, tenant_phone: j.tenant_phone,
    description: j.description, status: j.status, scheduled_at: j.scheduled_at, tech: j.tech, tech_phone: j.tech_phone,
    assigned_to: j.assigned_to, budget: j.budget, cost_to_us: j.cost_to_us, invoiced: !!j.invoiced,
    quote_needed: !!j.quote_needed, quoted: !!j.quoted, category: j.category, created: j.created,
    created_at: j.created_at || j.created,
    updated_at: j.updated_at, date_completed: j.date_completed, parent_job_id: j.parent_job_id
  }));
  renderTabs();
  renderPager();
  fetchQuoteDates();
}

async function fetchQuoteDates(){
  try {
    const { data, error } = await sb.from('board_comments').select('job_id,created_at')
      .or('message.ilike.QUOTATION%,message.ilike.%total cost%').order('created_at', { ascending: false }).limit(2000);
    if(error || !data) return;
    const m = {};
    data.forEach(r => { if(!m[r.job_id]) m[r.job_id] = r.created_at; });
    QUOTE_DATES = m;
    renderPager();
  } catch(e){}
}

function getVisibleJobs(){
  const q = (document.getElementById('search-input').value || '').toLowerCase().trim();
  return JOBS.filter(j => {
    if(CURRENT_USER.role !== 'admin' && (j.assigned_to||'').trim().toLowerCase() !== CURRENT_USER.name.trim().toLowerCase()) return false;
    if(activeAssignedFilter && (j.assigned_to||'') !== activeAssignedFilter) return false;
    if(activeTechFilter && (j.tech||'').trim().toLowerCase() !== activeTechFilter.trim().toLowerCase()) return false;
    if(q){
      const hay = [j.ref, j.address, j.tenant, j.tenant_phone, j.tech, j.tech_phone, j.assigned_to, j.title, j.description, j.external_job_id, j.category].filter(Boolean).join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}

function updateFilterDot(){
  const dot = document.getElementById('filter-dot');
  if(dot) dot.classList.toggle('on', !!(activeAssignedFilter || activeTechFilter));
}
function applyFilters(){
  updateFilterDot();
  renderTabs();
  renderPager();
}

/* ===== TEAM ===== */

async function fetchTeamAndTechnicians(){
  const [tm, tech] = await Promise.all([
    sb.from('team_members').select('*').is('archived_at', null).order('name'),
    sb.from('technicians').select('*').is('archived_at', null).order('name')
  ]);
  teamMembers = tm.data || [];
  technicians = tech.data || [];

  const dl = document.getElementById('tech-names-list');
  if(dl) dl.innerHTML = technicians.map(t => `<option value="${escHtml(t.name)}">`).join('');
}

function countFor(kind, name){
  const jobs = getVisibleJobsIgnoringFilters();
  const n = (name||'').trim().toLowerCase();
  return jobs.filter(j => ((kind === 'team' ? j.assigned_to : j.tech)||'').trim().toLowerCase() === n).length;
}
function getVisibleJobsIgnoringFilters(){
  const a = activeAssignedFilter, t = activeTechFilter;
  activeAssignedFilter = ''; activeTechFilter = '';
  const jobs = getVisibleJobs();
  activeAssignedFilter = a; activeTechFilter = t;
  return jobs;
}
function personRow(kind, p){
  const active = kind === 'team' ? activeAssignedFilter === p.name : activeTechFilter === p.name;
  const phone = p.phone ? `<a class="tr-phone" href="${telLink(p.phone)}" onclick="event.stopPropagation()">${escHtml(p.phone)}</a>` : '';
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  const extra = kind === 'tech' ? `
        ${p.specialty ? `<span class="tr-chip">${escHtml(p.specialty)}</span>` : ''}
        ${p.areas ? `<div class="tr-sub">&#128205; ${escHtml(p.areas)}</div>` : ''}
        ${p.notes ? `<div class="tr-notes">${escHtml(p.notes)}</div>` : ''}` : '';
  return `
    <div class="team-row ${active?'active':''}" onclick="pickPerson('${kind}','${escHtml(p.name).replace(/'/g,"\\'")}')">
      <div style="min-width:0;flex:1;">
        <div class="tr-name">${escHtml(p.name)}</div>
        ${phone}${extra}
      </div>
      ${(kind === 'tech' && isAdmin) ? `<button class="tr-edit" onclick="event.stopPropagation();openTechForm('${p.id}')" aria-label="Edit technician">&#9998;</button>` : ''}
      <div class="tr-count">${countFor(kind, p.name)}</div>
    </div>`;
}
let sheetMode = 'team';
function sheetMatch(kind, p, q){
  if(!q) return true;
  const fields = kind === 'tech' ? [p.name, p.phone, p.specialty, p.areas, p.notes] : [p.name, p.phone];
  return fields.some(v => (v || '').toLowerCase().includes(q));
}
function renderSheetList(){
  const mode = sheetMode;
  const q = ((document.getElementById('sheet-search') || {}).value || '').toLowerCase().trim();
  const list = document.getElementById('team-list');
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
  const teams = teamMembers.filter(t => sheetMatch('team', t, q)).sort(byName);
  const techs = technicians.filter(t => sheetMatch('tech', t, q)).sort(byName);
  let html = '';
  if(mode === 'filter'){
    document.getElementById('sheet-title').textContent = 'Filter';
    html += `<div class="sheet-section">Team member</div>`;
    html += `<div class="team-row-all" onclick="pickPerson('team','')">Everyone (${getVisibleJobsIgnoringFilters().length})</div>`;
    html += teams.map(t => personRow('team', t)).join('');
    html += `<div class="sheet-section">Technician</div>`;
    html += `<div class="team-row-all" onclick="pickPerson('tech','')">All technicians</div>`;
    html += techs.map(t => personRow('tech', t)).join('');
    if(activeAssignedFilter || activeTechFilter) html += `<button class="clear-filters" onclick="clearFilters()">Clear filters</button>`;
  } else if(mode === 'tech'){
    document.getElementById('sheet-title').textContent = 'Technicians';
    html += `<div class="team-row-all" onclick="pickPerson('tech','')">All technicians</div>`;
    html += techs.map(t => personRow('tech', t)).join('');
    if(!techs.length) html += `<div class="empty-state">${q ? 'No technicians match "' + escHtml(q) + '"' : 'No technicians added yet'}</div>`;
    if(isAdmin) html += `<button class="clear-filters" onclick="openTechForm('')">+ Add technician</button>`;
  } else {
    document.getElementById('sheet-title').textContent = 'Team';
    html += `<div class="team-row-all" onclick="pickPerson('team','')">Everyone (${getVisibleJobsIgnoringFilters().length})</div>`;
    html += teams.map(t => personRow('team', t)).join('');
    if(!teams.length) html += `<div class="empty-state">${q ? 'No team members match "' + escHtml(q) + '"' : 'No team members added yet'}</div>`;
  }
  list.innerHTML = html;
}
function openTeamSheet(mode){
  sheetMode = mode || 'team';
  const s = document.getElementById('sheet-search'); if(s) s.value = '';
  renderSheetList();
  document.getElementById('team-sheet').classList.add('open');
  document.getElementById('team-backdrop').classList.add('show');
}
function openFilterSheet(){ openTeamSheet('filter'); }
function closeTeamSheet(){
  document.getElementById('team-sheet').classList.remove('open');
  document.getElementById('team-backdrop').classList.remove('show');
}
function pickPerson(kind, name){
  if(kind === 'team') activeAssignedFilter = name; else activeTechFilter = name;
  closeTeamSheet();
  applyFilters();
}
function clearFilters(){
  activeAssignedFilter = ''; activeTechFilter = '';
  closeTeamSheet();
  applyFilters();
}

/* ===== NEW JOB ===== */

function openNewJobScreen(){
  ['nj-title','nj-address','nj-ticket-id','nj-tenant','nj-tenant-phone','nj-description','nj-category'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('nj-status').value = 'active';
  document.getElementById('nj-quote-needed').checked = false;
  document.getElementById('newjob-screen').classList.add('open');
}
function closeNewJobScreen(){
  document.getElementById('newjob-screen').classList.remove('open');
}
async function nextRef(prefix){
  // ask the database (archived jobs included) so a number is never reused
  const { data } = await sb.from('jobs').select('ref').like('ref', prefix + '-%');
  let max = 0;
  (data || []).forEach(r => {
    const m = (r.ref || '').match(new RegExp('^' + prefix + '-(\\d+)$'));
    if(m) max = Math.max(max, parseInt(m[1], 10));
  });
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

async function submitNewJob(){
  const title = document.getElementById('nj-title').value.trim();
  const address = document.getElementById('nj-address').value.trim();
  if(!title || !address){ showToast('Please enter at least a title and address'); return; }

  const newJob = {
    title, address,
    external_job_id: document.getElementById('nj-ticket-id').value.trim() || null,
    tenant: document.getElementById('nj-tenant').value.trim() || 'Not provided',
    tenant_phone: document.getElementById('nj-tenant-phone').value.trim() || null,
    description: document.getElementById('nj-description').value.trim() || null,
    status: document.getElementById('nj-status').value,
    priority: 'normal',
    category: document.getElementById('nj-category').value.trim() || null,
    quote_needed: document.getElementById('nj-quote-needed').checked,
    created: new Date().toISOString().split('T')[0]
  };

  newJob.ref = await nextRef(newJob.quote_needed ? 'QUO' : 'JOB');
  let { error } = await sb.from('jobs').insert([newJob]);
  if(error && error.code === '23505'){
    // someone else took that number a moment ago: take the next one
    newJob.ref = await nextRef(newJob.quote_needed ? 'QUO' : 'JOB');
    ({ error } = await sb.from('jobs').insert([newJob]));
  }
  if(error){ showToast('Failed to create job: ' + error.message); return; }

  closeNewJobScreen();
  showToast('Job created');
  await fetchAllJobs();
}

/* ===== TABS + PAGER ===== */

function renderTabs(){
  const visible = getVisibleJobs();
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = COLUMNS.map((col, i) => {
    const count = visible.filter(col.filter).length;
    return `<button class="tab-pill ${i===activeTabIndex?'active':''}" data-idx="${i}" onclick="goToTab(${i})">${col.title} <span class="count">${count}</span></button>`;
  }).join('');
}

function goToTab(i){
  activeTabIndex = i;
  const pager = document.getElementById('pager');
  pager.scrollTo({ left: i * pager.clientWidth, behavior: 'smooth' });
  renderTabs();
}

function quotedAgeTag(dateStr){
  const d = daysSince(dateStr);
  let cls = 'qa-ok', txt = d === 0 ? 'quoted today' : 'quoted ' + d + 'd ago';
  if(d >= 14){ cls = 'qa-chase'; txt += ' - chase?'; }
  else if(d >= 7){ cls = 'qa-follow'; txt += ' - follow up?'; }
  return `<div class="job-tag ${cls}">${txt}</div>`;
}

function renderPager(){
  const visible = getVisibleJobs();
  const pager = document.getElementById('pager');
  const todayStr = todayDateStr();
  pager.innerHTML = COLUMNS.map((col, idx) => {
    const jobs = visible.filter(col.filter);
    // every column: newest on top. Quotes: still-to-quote first. Today/Booked: by appointment.
    jobs.sort((a, b) => {
      if(col.key === 'quote_needed' && !!a.quoted !== !!b.quoted) return a.quoted ? 1 : -1;
      return newestFirst(a, b);
    });
    const isMissed = j => col.key === 'awaiting_completion' && j.scheduled_at && ukDate(j.scheduled_at) < todayStr;
    if(col.key === 'appointments_today'){
      jobs.sort((a, b) => apptSortKey(a).localeCompare(apptSortKey(b)));
    } else if(col.key === 'awaiting_completion'){
      const missedJobs = jobs.filter(isMissed).sort((a, b) => apptSortKey(a).localeCompare(apptSortKey(b)));
      const restJobs = jobs.filter(j => !isMissed(j)).sort((a, b) => apptSortKey(a).localeCompare(apptSortKey(b)));
      jobs.splice(0, jobs.length, ...missedJobs, ...restJobs);
    }
    let missedDone = false, upcomingDone = false, quotedDone = false;
    const cards = jobs.map(j => {
      let badge;
      if(col.key === 'completed_invoiced' || (col.key === 'quote_needed' && j.quoted)){
        badge = `<div class="badge green">&#10003;</div>`;
      } else if(col.key === 'appointments_today' && j.scheduled_at){
        badge = `<div class="badge date">${ukTime(j.scheduled_at) || 'Today'}</div>`;
      } else if(col.key === 'awaiting_completion' && j.scheduled_at){
        badge = `<div class="badge ${isMissed(j) ? 'red' : 'date'}">${formatShortDate(j.scheduled_at)}${ukTime(j.scheduled_at) ? '<br>' + ukTime(j.scheduled_at) : ''}</div>`;
      } else {
        const d = daysSince(j.created_at || j.created);
        badge = `<div class="badge ${badgeColor(d)}">${d}</div>`;
      }
      let divider = '';
      if(col.key === 'awaiting_completion'){
        if(isMissed(j) && !missedDone){ missedDone = true; divider = `<div class="list-divider red">Missed - needs a new date</div>`; }
        else if(!isMissed(j) && missedDone && !upcomingDone){ upcomingDone = true; divider = `<div class="list-divider">Booked</div>`; }
      }
      if(col.key === 'quote_needed' && j.quoted && !quotedDone){ quotedDone = true; divider = `<div class="list-divider green">Quoted</div>`; }
      let tag = '';
      if(col.key === 'quote_needed' && j.quoted && QUOTE_DATES[j.id]) tag = quotedAgeTag(QUOTE_DATES[j.id]);
      if(col.key === 'awaiting_start' && daysSince(j.created_at || j.created) >= 2) tag = `<div class="job-tag qa-follow">${daysSince(j.created_at || j.created)}d with no date - update the agent?</div>`;
      return `${divider}
        <div class="job-card${isMissed(j) ? ' missed' : ''}" onclick="openDetail('${j.id}','${col.key}')">
          <div class="job-main">
            <div class="job-ref">${escHtml(j.ref)}${col.key === 'awaiting_start' ? newTagHtml(j) : ''}</div>
            <div class="job-title">${escHtml(j.title || 'Untitled')}</div>
            <div class="job-address">${escHtml(j.address || '')}</div>
            ${tag}
          </div>
          ${badge}
        </div>`;
    }).join('') || `<div class="empty-state">No jobs here</div>`;
    return `<div class="page" data-idx="${idx}" ontouchstart="onPageTouchStart(event)" ontouchmove="onPageTouchMove(event)" ontouchend="onPageTouchEnd(event)">${cards}</div>`;
  }).join('');
  pager.onscroll = onPagerScroll;
  pager.scrollLeft = activeTabIndex * pager.clientWidth;
}

let pagerScrollTimer = null;
function onPagerScroll(){
  clearTimeout(pagerScrollTimer);
  pagerScrollTimer = setTimeout(() => {
    const pager = document.getElementById('pager');
    const idx = Math.round(pager.scrollLeft / pager.clientWidth);
    if(idx !== activeTabIndex){ activeTabIndex = idx; renderTabs(); }
  }, 80);
}

let searchDebounce = null;
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('search-input').addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { renderTabs(); renderPager(); }, 200);
  });
});

/* ===== PULL TO REFRESH =====
   Lives alongside the horizontally-swiping pager, so every gesture must be
   axis-locked: a diagonal thumb movement must not let a stray vertical delta
   trigger (or leave stuck) the pull indicator while the pager is actually
   being swiped sideways. State is always reset on touchstart/touchend so a
   gesture that bails out early (e.g. scrollTop was > 0, or the axis turned
   out to be horizontal) never leaves the indicator showing. */

let pullStartX = null, pullStartY = null, pullActive = null, pullAxisLocked = false, isRefreshing = false;

function resetPullIndicator(){
  document.getElementById('pull-indicator').classList.remove('show');
}

function onPageTouchStart(e){
  resetPullIndicator();
  pullAxisLocked = false;
  const page = e.currentTarget;
  const t = e.touches[0];
  pullStartX = t.clientX;
  pullStartY = t.clientY;
  pullActive = (page.scrollTop <= 0) && !isRefreshing;
}
function onPageTouchMove(e){
  if(!pullActive || isRefreshing) return;
  const t = e.touches[0];
  const dx = t.clientX - pullStartX;
  const dy = t.clientY - pullStartY;

  if(!pullAxisLocked){
    // Wait until the gesture is clearly one direction or the other before acting.
    if(Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    pullAxisLocked = true;
    if(Math.abs(dx) >= Math.abs(dy)){
      // Horizontal swipe - this is the pager's gesture, not ours. Stand down.
      pullActive = false;
      resetPullIndicator();
      return;
    }
  }

  const ind = document.getElementById('pull-indicator');
  ind.classList.toggle('show', dy > 30);
}
async function onPageTouchEnd(e){
  const ind = document.getElementById('pull-indicator');
  if(!pullActive || isRefreshing){ pullActive = false; resetPullIndicator(); return; }

  const dy = (e.changedTouches[0].clientY - pullStartY);
  pullActive = false;

  if(pullAxisLocked && dy > 70){
    isRefreshing = true;
    ind.classList.add('show');
    ind.textContent = 'Refreshing...';
    try {
      await fetchAllJobs();
    } finally {
      isRefreshing = false;
      resetPullIndicator();
    }
  } else {
    resetPullIndicator();
  }
}

/* ===== DETAIL SCREEN ===== */

function telLink(num){ return num ? `tel:${num.replace(/\s+/g,'')}` : null; }

function openDetail(jobId, columnKey){
  const j = JOBS.find(x => x.id === jobId);
  if(!j) return;
  currentDetailId = jobId;
  EMAIL_LINK = undefined;
  if(columnKey === 'desk'){ const c = COLUMNS.find(c => c.filter(j)); columnKey = c ? c.key : null; }
  detailOpenedFromColumn = columnKey;
  editMode = false;

  document.getElementById('d-ref').textContent = j.ref;
  document.getElementById('d-title').textContent = j.title || 'Untitled Job';
  document.getElementById('d-edit-btn').style.display = '';
  document.getElementById('d-save-btn').style.display = 'none';
  document.getElementById('d-cancel-btn').style.display = 'none';

  renderInfoView(j, columnKey);
  switchDetailTab('info');
  loadComments(jobId);
  document.getElementById('detail-screen').classList.add('open');
  loadEmailLink(jobId);
}

function renderInfoView(j, columnKey){
  const tenantCall = telLink(j.tenant_phone);
  const techCall = telLink(j.tech_phone);
  const isAdmin = CURRENT_USER.role === 'admin';

  let actionBoxHtml = '';
  if(j.quote_needed){
    if(!j.quoted){
      actionBoxHtml += `<div class="action-box purple"><p>Quote needed - have you sent it yet?</p><button style="background:#7c3aed;" onclick="markQuoted()">Mark as Quoted</button></div>`;
    } else {
      actionBoxHtml += `<div class="action-box amber"><p>This is marked as quoted. Marked by mistake?</p><button style="background:#d97706;" onclick="unmarkQuoted()">Mark as Not Quoted</button></div>`;
    }
    actionBoxHtml += `<div class="action-box teal"><p>Has the client approved this quote?</p><button style="background:#059669;" onclick="markQuoteApproved()">Quote Approved - Make it a Job</button></div>`;
  } else {
    const inAwaitingCompletion = (columnKey === 'awaiting_completion' || columnKey === 'appointments_today');
    if(inAwaitingCompletion){
      actionBoxHtml += `<div class="action-box"><p>Job finished on site, but no invoice sent yet?</p><button style="background:var(--green);" onclick="markCompletedAwaitingInvoice()">Mark Completed - Awaiting Invoice</button></div>`;
    }
    if(isAdmin && columnKey === 'awaiting_invoice'){
      actionBoxHtml += `<div class="action-box blue"><p>Completed - have you invoiced this yet?</p><button style="background:var(--accent);" onclick="markInvoiced()">Mark Invoiced</button></div>`;
    }
  }

  document.getElementById('panel-info').innerHTML = `
    <div class="call-row">
      <a class="call-btn ${tenantCall?'':'disabled'}" href="${tenantCall||'javascript:void(0)'}">&#128222; Tenant${j.tenant ? ' - '+escHtml(j.tenant) : ''}</a>
      <a class="call-btn ${techCall?'':'disabled'}" href="${techCall||'javascript:void(0)'}">&#128222; Tech${j.tech ? ' - '+escHtml(j.tech) : ''}</a>
    </div>
    ${actionBoxHtml}
    ${isAdmin ? `<button class="wr-open" onclick="openWorkReport()">&#128196; Work Report PDF</button>
    <div class="info-field"><label>Email thread (admin)</label><div class="val" id="email-link-box">Loading...</div></div>` : ''}
    <div class="info-field"><label>Status</label><div class="val"><span class="status-pill status-${j.status}">${escHtml(j.status)}</span></div></div>
    <div class="info-field"><label>Address</label><div class="val">${escHtml(j.address || '—')}</div></div>
    <div class="info-field"><label>Ticket ID</label><div class="val">${escHtml(j.external_job_id || '—')}</div></div>
    <div class="info-field"><label>Tenant</label><div class="val">${escHtml(j.tenant || '—')}${j.tenant_phone ? ' · '+escHtml(j.tenant_phone) : ''}</div></div>
    <div class="info-field"><label>Description</label><div class="val">${escHtml(j.description || '—')}</div></div>
    <div class="info-field"><label>Photos &amp; Files <span id="pf-count"></span></label>
      <div id="pf-grid" class="pf-grid"><div class="pf-none">Loading...</div></div>
      <div class="pf-upload"><input type="file" id="pf-input" multiple accept="image/*,video/*,.pdf" style="display:none;" onchange="uploadJobFiles(event)">
        <button class="mini-btn primary" id="pf-upload-btn" onclick="document.getElementById('pf-input').click()">+ Add photos / files</button></div></div>
    <div class="info-field"><label>Received</label><div class="val">${j.created ? formatShortDate(j.created) : '—'}</div></div>
    <div class="info-field"><label>Appointment</label><div class="val">${formatApptFull(j.scheduled_at)}</div></div>
    <div class="info-field"><label>Technician</label><div class="val">${escHtml(j.tech || '—')}${j.tech_phone ? ' · '+escHtml(j.tech_phone) : ''}</div></div>
    <div class="info-field"><label>Assigned To</label><div class="val">${escHtml(j.assigned_to || 'Unassigned')}</div></div>
    <div class="info-field"><label>Category</label><div class="val">${escHtml(j.category || '—')}</div></div>
    ${isAdmin ? `
    <div class="info-field"><label>Budget</label><div class="val">${j.budget != null ? '£'+Number(j.budget).toFixed(2) : '—'}</div></div>
    <div class="info-field"><label>Cost to Us</label><div class="val">${j.cost_to_us != null ? '£'+Number(j.cost_to_us).toFixed(2) : '—'}</div></div>
    <div class="info-field"><label>Invoiced</label><div class="val">${j.invoiced ? 'Yes' : 'No'}</div></div>
    ` : ''}
    <div class="info-field"><label>Linked jobs</label><div id="linked-list"></div>
      ${isAdmin ? `<div class="mini-row" style="margin-top:8px;"><input class="field-input" id="link-job-input" placeholder="Link a job (e.g. JOB-120)"><button class="mini-btn primary" onclick="linkJobFromInput()">Link</button></div>` : ''}</div>
    ${can('can_delete_jobs') ? `<button id="delete-job-btn" style="width:100%;padding:12px;border-radius:9px;border:1px solid #fecaca;background:#fef2f2;color:var(--red);font-weight:700;margin-top:10px;" onclick="deleteJob()">Delete Job</button>` : ''}
  `;
  if(isAdmin && EMAIL_LINK !== undefined) renderEmailLink();
  loadJobFiles(j.id);
  renderLinkedJobs(j);
}

function renderInfoEdit(j){
  const isAdmin = CURRENT_USER.role === 'admin';
  const lockIdentity = !isAdmin; // title/address/ticket id/cost-to-us are locked for non-admins
  const canReassign = can('can_reassign_jobs');

  const assignedOptions = ['<option value="">Unassigned</option>'].concat(
    teamMembers.map(t => `<option value="${escHtml(t.name)}" ${j.assigned_to===t.name?'selected':''}>${escHtml(t.name)}</option>`)
  ).join('');

  document.getElementById('panel-info').innerHTML = `
    <div class="info-field"><label>Title</label><input class="field-input" id="d-title-input" value="${escHtml(j.title||'')}" ${lockIdentity?'readonly':''}></div>
    <div class="info-field"><label>Address</label><input class="field-input" id="d-address-input" value="${escHtml(j.address||'')}" ${lockIdentity?'readonly':''}></div>
    <div class="info-field"><label>Ticket ID</label><input class="field-input" id="d-ticket-id-input" value="${escHtml(j.external_job_id||'')}" ${lockIdentity?'readonly':''}></div>
    <div class="info-field"><label>Tenant</label><input class="field-input" id="d-tenant-input" value="${escHtml(j.tenant||'')}"></div>
    <div class="info-field"><label>Tenant Phone</label><input class="field-input" id="d-tenant-phone-input" value="${escHtml(j.tenant_phone||'')}"></div>
    <div class="info-field"><label>Description</label><textarea class="field-input" id="d-desc-input" rows="4">${escHtml(j.description||'')}</textarea></div>
    <div class="info-field"><label>Status</label>
      <select class="field-input" id="d-status-input">
        ${['active','contacted','booked','completed','revisit','cancelled'].map(s => `<option value="${s}" ${j.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
      </select>
    </div>
    <div class="info-field"><label>Appointment Date</label><input class="field-input" type="date" id="d-scheduled-input" value="${j.scheduled_at ? ukDate(j.scheduled_at) : ''}"></div>
    <div class="info-field"><label>Appointment Time (UK, optional)</label><input class="field-input" type="time" id="d-scheduled-time-input" value="${j.scheduled_at ? ukTime(j.scheduled_at) : ''}"></div>
    <div class="info-field"><label>Technician</label><input class="field-input" id="d-tech-input" list="tech-names-list" value="${escHtml(j.tech||'')}" placeholder="Start typing a technician name..."></div>
    <div class="info-field"><label>Technician Phone</label><input class="field-input" id="d-tech-phone-input" value="${escHtml(j.tech_phone||'')}"></div>
    <div class="info-field" id="d-assigned-wrap">
      ${canReassign
        ? `<label>Assigned To (Team)</label><select class="field-input" id="d-assigned-input">${assignedOptions}</select>`
        : `<label>Assigned To (Team)</label><div class="val">${escHtml(j.assigned_to || 'Unassigned')}</div>`}
    </div>
    <div class="info-field"><label>Category</label><input class="field-input" id="d-category-input" value="${escHtml(j.category||'')}"></div>
    ${isAdmin ? `
    <div class="info-field"><label>Budget</label><input class="field-input" type="number" step="0.01" id="d-budget" value="${j.budget != null ? j.budget : ''}"></div>
    <div class="info-field"><label>Cost to Us</label><input class="field-input" type="number" step="0.01" id="d-cost" value="${j.cost_to_us != null ? j.cost_to_us : ''}"></div>
    <div class="info-field checkbox-field"><label><input type="checkbox" id="d-invoiced" ${j.invoiced?'checked':''}> Invoiced</label></div>
    ` : (lockIdentity ? `<input type="hidden" id="d-cost" value="${j.cost_to_us != null ? j.cost_to_us : ''}">` : '')}
  `;
}

function enterEditMode(){
  const j = JOBS.find(x => x.id === currentDetailId);
  if(!j) return;
  editMode = true;
  renderInfoEdit(j);
  document.getElementById('d-edit-btn').style.display = 'none';
  document.getElementById('d-save-btn').style.display = '';
  document.getElementById('d-cancel-btn').style.display = '';
}

function cancelEditMode(){
  const j = JOBS.find(x => x.id === currentDetailId);
  if(!j) return;
  editMode = false;
  renderInfoView(j, detailOpenedFromColumn);
  document.getElementById('d-edit-btn').style.display = '';
  document.getElementById('d-save-btn').style.display = 'none';
  document.getElementById('d-cancel-btn').style.display = 'none';
}

async function saveJobEdits(){
  if(!currentDetailId) return;
  const scheduledVal = document.getElementById('d-scheduled-input').value;
  const budgetEl = document.getElementById('d-budget');
  const costEl = document.getElementById('d-cost');
  const invoicedEl = document.getElementById('d-invoiced');

  const updates = {
    title: document.getElementById('d-title-input').value.trim() || 'Untitled Job',
    address: document.getElementById('d-address-input').value.trim(),
    external_job_id: document.getElementById('d-ticket-id-input').value.trim() || null,
    tenant: document.getElementById('d-tenant-input').value.trim() || null,
    tenant_phone: document.getElementById('d-tenant-phone-input').value.trim() || null,
    description: document.getElementById('d-desc-input').value.trim() || null,
    status: document.getElementById('d-status-input').value,
    scheduled_at: ukToIso(scheduledVal, (document.getElementById('d-scheduled-time-input') || {}).value || ''),
    tech: document.getElementById('d-tech-input').value.trim() || null,
    tech_phone: document.getElementById('d-tech-phone-input').value.trim() || null,
    category: document.getElementById('d-category-input').value.trim() || null
  };
  if(budgetEl) updates.budget = budgetEl.value !== '' ? parseFloat(budgetEl.value) : 200;
  if(costEl) updates.cost_to_us = costEl.value !== '' ? parseFloat(costEl.value) : null;
  if(invoicedEl) updates.invoiced = invoicedEl.checked;

  const assignSel = document.getElementById('d-assigned-input');
  if(assignSel) updates.assigned_to = assignSel.value.trim() || null;

  const { error } = await sb.from('jobs').update(updates).eq('id', currentDetailId);
  if(error){ showToast('Failed to save: ' + error.message); return; }

  await autoAddTechnicianIfNew(updates.tech, updates.tech_phone);

  const j = JOBS.find(x => x.id === currentDetailId);
  if(j) Object.assign(j, updates);

  editMode = false;
  showToast('Saved');
  document.getElementById('d-title').textContent = updates.title;
  document.getElementById('d-edit-btn').style.display = '';
  document.getElementById('d-save-btn').style.display = 'none';
  document.getElementById('d-cancel-btn').style.display = 'none';
  renderInfoView(j, detailOpenedFromColumn);
  renderTabs();
  renderPager();
}

async function autoAddTechnicianIfNew(techName, techPhone){
  if(!techName) return;
  const alreadyExists = technicians.some(t => (t.name || '').trim().toLowerCase() === techName.trim().toLowerCase());
  if(alreadyExists) return;
  const { error } = await sb.from('technicians').insert([{ name: techName, phone: techPhone || null }]);
  if(error){ console.error('Failed to auto-add technician:', error.message); return; }
  await fetchTeamAndTechnicians();
}

async function deleteJob(){
  if(!currentDetailId) return;
  if(!can('can_delete_jobs')){ showToast('You do not have permission to delete jobs'); return; }
  if(!confirm('Delete this job? It will be archived, not permanently erased, and will disappear from the board.')) return;

  const { error } = await sb.from('jobs').update({ archived_at: new Date().toISOString() }).eq('id', currentDetailId);
  if(error){ showToast('Failed to delete: ' + error.message); return; }

  JOBS = JOBS.filter(j => j.id !== currentDetailId);
  closeDetail();
  renderTabs();
  renderPager();
}

function closeDetail(){
  document.getElementById('detail-screen').classList.remove('open');
  if(document.getElementById('desk-screen').classList.contains('open')) renderActionDesk();
  currentDetailId = null;
  editMode = false;
  pendingPhoto = null;
  renderPhotoPreview();
}

function switchDetailTab(tab){
  document.querySelectorAll('.detail-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.detail-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  document.getElementById('comment-compose').style.display = tab === 'comments' ? 'flex' : 'none';
}

window.onBack = function(){
  if(document.getElementById('tech-form-screen').classList.contains('open')){ closeTechForm(); return 'false'; }
  if(document.getElementById('viewer-screen').classList.contains('open')){ closeViewer(); return 'false'; }
  if(document.getElementById('wr-preview-screen').classList.contains('open')){ closeWrPreview(); return 'false'; }
  if(document.getElementById('wr-screen').classList.contains('open')){ closeWorkReport(); return 'false'; }
  if(document.getElementById('newjob-screen').classList.contains('open')){
    closeNewJobScreen();
    return 'false';
  }
  if(document.getElementById('desk-screen').classList.contains('open') && !document.getElementById('detail-screen').classList.contains('open')){ closeActionDesk(); return 'false'; }
  if(document.getElementById('team-sheet').classList.contains('open')){
    closeTeamSheet();
    return 'false';
  }
  if(document.getElementById('detail-screen').classList.contains('open')){
    if(editMode){ cancelEditMode(); return 'false'; }
    closeDetail();
    return 'false';
  }
  return 'true';
};

/* ===== JOB ACTIONS ===== */

async function refreshAfterAction(updates){
  const j = JOBS.find(x => x.id === currentDetailId);
  if(j) Object.assign(j, updates);
  closeDetail();
  renderTabs();
  renderPager();
}

async function markCompletedAwaitingInvoice(){
  const { error } = await sb.from('jobs').update({ status: 'completed', invoiced: false }).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Marked completed');
  refreshAfterAction({ status: 'completed', invoiced: false });
}
async function markInvoiced(){
  const { error } = await sb.from('jobs').update({ invoiced: true }).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Marked invoiced');
  refreshAfterAction({ invoiced: true });
}
async function markQuoted(){
  const { error } = await sb.from('jobs').update({ quoted: true }).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Marked quoted');
  refreshAfterAction({ quoted: true });
}
async function unmarkQuoted(){
  const { error } = await sb.from('jobs').update({ quoted: false }).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Unmarked quoted');
  refreshAfterAction({ quoted: false });
}
async function markQuoteApproved(){
  const updates = { quote_needed: false, quoted: false, status: 'active', scheduled_at: null };
  const cur = JOBS.find(x => x.id === currentDetailId);
  if(cur && cur.quote_needed) updates.ref = await nextRef('JOB');   // approved quote becomes a real job number
  const { error } = await sb.from('jobs').update(updates).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Quote approved - now ' + (updates.ref || 'a job'));
  refreshAfterAction(updates);
}

/* ===== COMMENTS ===== */

async function loadComments(jobId){
  const list = document.getElementById('comment-list');
  const { data, error } = await sb.from('board_comments').select('*').eq('job_id', jobId).order('created_at', { ascending: false });
  if(error){ list.innerHTML = '<div class="no-comments">Failed to load comments.</div>'; return; }
  if(!data || !data.length){ list.innerHTML = '<div class="no-comments">No comments yet.</div>'; return; }

  const ids = data.map(c => c.id);
  const { data: attachData } = await sb.from('comment_attachments').select('*').in('comment_id', ids);
  const byComment = {};
  (attachData || []).forEach(a => { (byComment[a.comment_id] = byComment[a.comment_id] || []).push(a); });

  list.innerHTML = data.map(c => {
    const time = new Date(c.created_at).toLocaleString('en-GB', { timeZone: UK_TZ, day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    let attachments = byComment[c.id] || [];
    if(c.file_url && !attachments.length) attachments = [{ file_url: c.file_url, file_name: c.file_name }];
    const photos = attachments.filter(a => /\.(jpe?g|png|webp|gif)$/i.test(a.file_name||'')).map(a =>
      `<img class="comment-photo" src="${escHtml(a.file_url)}" onclick="openViewer('${escHtml(a.file_url)}','${escHtml(a.file_name||'')}','image/jpeg')">`
    ).join('');
    const docs = attachments.filter(a => /\.pdf$/i.test(a.file_name||'')).map(a =>
      `<div class="comment-doc" onclick="openViewer('${escHtml(a.file_url)}','${escHtml(a.file_name||'')}','application/pdf')">&#128196; ${escHtml(a.file_name)} <span>tap to open</span></div>`
    ).join('');
    const canEdit = CURRENT_USER && (CURRENT_USER.role === 'admin' || c.author_user_id === CURRENT_USER.id);
    return `
      <div class="comment-item">
        <div class="comment-head"><div><div class="comment-author">${escHtml(c.author)}</div><div class="comment-time">${time}</div></div>
          ${canEdit ? `<button class="comment-edit-btn" onclick="startEditComment('${c.id}')" aria-label="Edit comment">&#9998;</button>` : ''}</div>
        <div class="comment-text" id="comment-text-${c.id}">${escHtml(c.message)}</div>
        ${photos}${docs}
      </div>`;
  }).join('');
  list.scrollTop = 0;
}

function startEditComment(id){
  const box = document.getElementById('comment-text-' + id);
  if(!box) return;
  const current = box.textContent;
  box.innerHTML = `<textarea id="comment-edit-${id}" class="field-input" rows="7"></textarea>
    <div class="edit-actions"><button class="save-btn" onclick="saveEditComment('${id}', this)">Save</button>
    <button class="cancel-btn" onclick="loadComments(currentDetailId)">Cancel</button></div>`;
  const ta = document.getElementById('comment-edit-' + id);
  ta.value = current; ta.focus();
}
async function saveEditComment(id, btn){
  const ta = document.getElementById('comment-edit-' + id);
  if(!ta) return;
  const message = ta.value.trim();
  if(!message){ showToast('A comment cannot be empty'); return; }
  if(btn){ btn.disabled = true; btn.textContent = 'Saving...'; }
  let q = sb.from('board_comments').update({ message }).eq('id', id);
  if(CURRENT_USER.role !== 'admin') q = q.eq('author_user_id', CURRENT_USER.id);
  const { data, error } = await q.select();
  if(error){ showToast('Failed to save: ' + error.message); if(btn){ btn.disabled = false; btn.textContent = 'Save'; } return; }
  if(!data || !data.length){ showToast('You can only edit your own comments'); }
  loadComments(currentDetailId);
}

function onPhotoChosen(e){
  const file = e.target.files[0];
  if(!file) return;
  pendingPhoto = file;
  renderPhotoPreview();
}

function renderPhotoPreview(){
  const wrap = document.getElementById('photo-preview');
  if(!pendingPhoto){ wrap.style.display = 'none'; wrap.innerHTML = ''; return; }
  const url = URL.createObjectURL(pendingPhoto);
  wrap.style.display = 'flex';
  wrap.innerHTML = `<img src="${url}">`;
}

async function postComment(){
  const input = document.getElementById('comment-input');
  const message = input.value.trim();
  if(!message && !pendingPhoto){ showToast('Write something or attach a photo'); return; }
  if(!currentDetailId) return;

  const author = CURRENT_USER.name;
  let uploaded = null;

  if(pendingPhoto){
    const fileName = `${Date.now()}_${pendingPhoto.name || 'photo.jpg'}`;
    const filePath = `${currentDetailId}/${fileName}`;
    const { error: upErr } = await sb.storage.from('job-files').upload(filePath, pendingPhoto);
    if(upErr){ showToast('Photo upload failed: ' + upErr.message); return; }
    const { data: urlData } = sb.storage.from('job-files').getPublicUrl(filePath);
    await sb.from('job_files').insert([{ job_id: currentDetailId, file_name: pendingPhoto.name || fileName, file_url: urlData.publicUrl, mime_type: pendingPhoto.type || null }]);
    uploaded = { file_url: urlData.publicUrl, file_name: pendingPhoto.name || fileName, mime_type: pendingPhoto.type || null };
  }

  const fullMessage = message || '[Photo attached]';
  const { data: newComment, error } = await sb.from('board_comments').insert([{
    job_id: currentDetailId, author, message: fullMessage, author_user_id: CURRENT_USER.id
  }]).select().single();
  if(error){ showToast('Failed to post: ' + error.message); return; }

  if(uploaded){
    await sb.from('comment_attachments').insert([{ comment_id: newComment.id, file_url: uploaded.file_url, file_name: uploaded.file_name, mime_type: uploaded.mime_type }]);
  }

  const now = new Date();
  await sb.from('notes').insert([{
    job_id: currentDetailId, note_date: now.toISOString().split('T')[0],
    note_time: now.toTimeString().split(' ')[0].slice(0,5), text: fullMessage, author
  }]);

  input.value = '';
  pendingPhoto = null;
  renderPhotoPreview();
  loadComments(currentDetailId);
}

/* ===== ACTION DESK (admin) =====
   Everything that needs a nudge, in one scrolling list. The normal tabs still show everything. */
function openActionDesk(){
  renderActionDesk();
  document.getElementById('desk-screen').classList.add('open');
}
function closeActionDesk(){ document.getElementById('desk-screen').classList.remove('open'); }

function renderActionDesk(){
  const el = document.getElementById('desk-body');
  const jobs = JOBS;
  const today = todayDateStr();
  const norm = a => (a || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sev = (d, warn, bad) => d >= bad ? 'bad' : (d >= warn ? 'warn' : '');
  const byAgeDesc = (a, b) => b.days - a.days;
  const sections = [];

  const sent = jobs.filter(j => j.quote_needed && j.quoted && j.status !== 'cancelled')
    .map(j => ({ j, days: QUOTE_DATES[j.id] ? daysSince(QUOTE_DATES[j.id]) : daysSince(j.created_at) })).sort(byAgeDesc);
  sections.push({ title: 'Quotes sent, waiting on a reply', hint: 'chase after 7 days',
    rows: sent.map(x => ({ j: x.j, note: 'quoted ' + (x.days === 0 ? 'today' : x.days + 'd ago'), cls: sev(x.days, 7, 14) })) });

  const toQuote = jobs.filter(j => j.quote_needed && !j.quoted && j.status !== 'cancelled')
    .map(j => ({ j, days: daysSince(j.created_at) })).sort(byAgeDesc);
  sections.push({ title: 'Quotes still to send', hint: 'waiting since the request came in',
    rows: toQuote.map(x => ({ j: x.j, note: 'asked ' + (x.days === 0 ? 'today' : x.days + 'd ago'), cls: sev(x.days, 2, 5) })) });

  const missed = jobs.filter(j => !j.quote_needed && j.scheduled_at && ukDate(j.scheduled_at) < today && j.status !== 'completed' && j.status !== 'cancelled')
    .map(j => ({ j, days: daysSince(j.scheduled_at) })).sort(byAgeDesc);
  sections.push({ title: 'Missed appointments', hint: 'rebook or close off',
    rows: missed.map(x => ({ j: x.j, note: 'was ' + formatShortDate(x.j.scheduled_at) + (x.j.tech ? ' - ' + x.j.tech : ''), cls: 'bad' })) });

  const noDate = jobs.filter(j => !j.quote_needed && ['active','contacted'].includes(j.status) && !j.scheduled_at && daysSince(j.created_at) >= 2)
    .map(j => ({ j, days: daysSince(j.created_at) })).sort(byAgeDesc);
  sections.push({ title: 'No start date yet', hint: 'update the agent',
    rows: noDate.map(x => ({ j: x.j, note: x.days + 'd with no date', cls: sev(x.days, 3, 6) })) });

  const toInvoice = jobs.filter(j => !j.quote_needed && j.status === 'completed' && !j.invoiced)
    .map(j => ({ j, days: daysSince(j.date_completed || j.updated_at || j.created_at) })).sort(byAgeDesc);
  sections.push({ title: 'Completed, not invoiced', hint: 'oldest first',
    rows: toInvoice.map(x => ({ j: x.j, note: 'done ' + (x.days === 0 ? 'today' : x.days + 'd ago'), cls: sev(x.days, 3, 7) })) });

  const doneAt = {};
  jobs.filter(j => !j.quote_needed && j.status === 'completed').forEach(j => { const k = norm(j.address); if(k) (doneAt[k] = doneAt[k] || []).push(j); });
  const upsell = jobs.filter(j => j.quote_needed && j.status !== 'cancelled' && doneAt[norm(j.address)]);
  sections.push({ title: 'Upsell: open quotes where we already worked', hint: 'not yet approved',
    rows: upsell.map(j => ({ j, note: (j.quoted ? 'quoted' : 'not quoted yet') + ' - ' + doneAt[norm(j.address)].length + ' done', cls: '' })) });

  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  el.innerHTML = `<div class="desk-sub">${total} item${total === 1 ? '' : 's'} that need a nudge. The tabs still show everything.</div>` +
    sections.map(s => `
    <div class="desk-section">
      <h3>${escHtml(s.title)} <span class="desk-count">${s.rows.length}</span></h3>
      <div class="desk-hint">${escHtml(s.hint)}</div>
      ${s.rows.length ? s.rows.map(r => `
        <div class="desk-row" onclick="openDetail('${r.j.id}','desk')">
          <div class="desk-main"><div class="job-ref">${escHtml(r.j.ref)}</div><div class="job-title">${escHtml(r.j.title || 'Untitled')}</div><div class="job-address">${escHtml(r.j.address || '')}</div></div>
          <div class="desk-note ${r.cls}">${escHtml(r.note)}</div>
        </div>`).join('') : '<div class="desk-empty">Nothing here.</div>'}
    </div>`).join('');
}

/* ===== EMAIL THREAD LINK (admin only; stored in job_email_links) =====
   The phone app cannot open Gmail itself, so the link is copied for pasting into Gmail/Chrome. */
function copyText(txt){
  try {
    if(navigator.clipboard && navigator.clipboard.writeText){ return navigator.clipboard.writeText(txt).then(() => true).catch(() => legacyCopy(txt)); }
  } catch(e){}
  return Promise.resolve(legacyCopy(txt));
}
function legacyCopy(txt){
  try {
    const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch(e){ return false; }
}

async function loadEmailLink(jobId){
  const box = document.getElementById('email-link-box');
  if(!box || !(CURRENT_USER && CURRENT_USER.role === 'admin')) return;
  const { data } = await sb.from('job_email_links').select('*').eq('job_id', jobId).maybeSingle();
  if(currentDetailId !== jobId) return;
  EMAIL_LINK = data || null;
  renderEmailLink();
}
function renderEmailLink(){
  const box = document.getElementById('email-link-box');
  if(!box) return;
  if(EMAIL_LINK){
    box.innerHTML = `<button class="mini-btn" onclick="copyEmailLink()">Copy Gmail link</button> <button class="mini-btn danger" onclick="removeEmailLink()">Remove</button>`;
  } else {
    box.innerHTML = `<div class="mini-row"><input class="field-input" id="email-link-input" placeholder="Paste Gmail link or thread id"><button class="mini-btn primary" onclick="saveEmailLink()">Save</button></div>`;
  }
}
async function copyEmailLink(){
  if(!EMAIL_LINK) return;
  const ok = await copyText(EMAIL_LINK.gmail_url);
  showToast(ok ? 'Link copied - paste it in Chrome or Gmail' : 'Could not copy the link');
}
async function saveEmailLink(){
  if(!currentDetailId) return;
  const raw = (document.getElementById('email-link-input').value || '').trim();
  if(!raw) return;
  const m = raw.match(/([0-9a-f]{16})(?![0-9a-f])/i);
  if(!m){ showToast('Could not find a Gmail thread id in that link'); return; }
  const threadId = m[1].toLowerCase();
  const url = 'https://mail.google.com/mail/?authuser=fixngoltd@gmail.com#all/' + threadId;
  const { error } = await sb.from('job_email_links').upsert({ job_id: currentDetailId, thread_id: threadId, gmail_url: url }, { onConflict: 'job_id' });
  if(error){ showToast('Failed to save link: ' + error.message); return; }
  EMAIL_LINK = { job_id: currentDetailId, thread_id: threadId, gmail_url: url };
  renderEmailLink();
}
async function removeEmailLink(){
  if(!currentDetailId || !confirm('Remove the email thread link from this job?')) return;
  const { error } = await sb.from('job_email_links').delete().eq('job_id', currentDetailId);
  if(error){ showToast('Failed to remove link: ' + error.message); return; }
  EMAIL_LINK = null; renderEmailLink();
}

/* ===== WORK REPORT PDF (admin) =====
   Same report maker as the desktop board. The PDF code and fonts are downloaded the first time
   it is needed (not at app start), so the rest of the app never depends on them. The PDF is
   attached to the job, since a phone WebView cannot save files directly. */
const WR_REMOTE_BASE = 'https://raw.githubusercontent.com/fixngoltd-rgb/ont/main/testing-fix-and-go-app/app/src/main/assets/www/wr/';
let WR_PHOTOS = [], WR_LAST_SAVED = '', WR_LOADING = null, WR_LAST_URL = '', WR_LABELS = {};

function loadWrLib(){
  if(window.WorkReport && window.WorkReport2 && window.jspdf) return Promise.resolve();
  if(WR_LOADING) return WR_LOADING;
  window.WR_BASE = window.WR_BASE_OVERRIDE || WR_REMOTE_BASE;
  const inject = async name => {
    const r = await fetch(window.WR_BASE + name);
    if(!r.ok) throw new Error('Could not download the report tools (' + r.status + ')');
    const s = document.createElement('script'); s.textContent = await r.text(); document.head.appendChild(s);
  };
  WR_LOADING = (async () => { await inject('jspdf.umd.min.js'); await inject('workreport.js'); await inject('workreport2.js'); })();
  WR_LOADING.catch(() => { WR_LOADING = null; });
  return WR_LOADING;
}

async function openWorkReport(){
  if(!currentDetailId || !(CURRENT_USER && CURRENT_USER.role === 'admin')) return;
  const j = JOBS.find(x => x.id === currentDetailId); if(!j) return;
  document.getElementById('wr-addr').textContent = (j.ref || '') + ' - ' + (j.address || '');
  const st = document.getElementById('wr-status'); st.textContent = ''; st.className = 'wr-status';
  document.getElementById('wr-screen').classList.add('open');
  document.getElementById('wr-link-row').style.display = 'none';
  const ta = document.getElementById('wr-text'); ta.value = '';
  const { data: saved } = await sb.from('job_work_reports').select('body').eq('job_id', j.id).maybeSingle();
  WR_LAST_SAVED = (saved && saved.body) || '';
  ta.value = WR_LAST_SAVED;
  const { data: files } = await sb.from('job_files').select('file_url,file_name,mime_type,uploaded_at').eq('job_id', j.id).order('uploaded_at', { ascending: true });
  const seen = new Set(); WR_PHOTOS = [];
  (files || []).filter(f => (f.mime_type || '').startsWith('image/')).forEach(f => {
    if(seen.has(f.file_url)) return; seen.add(f.file_url);
    WR_PHOTOS.push({ url: f.file_url, name: f.file_name, selected: true, _t: wrPhotoTime(f), _u: f.uploaded_at || '' });
  });
  // oldest first, newest last (capture time from the file name first, then upload time)
  WR_PHOTOS.sort((a, b) => (a._t - b._t) || String(a._u).localeCompare(String(b._u)));
  WR_PHOTOS.forEach((p, i) => { p._n = i + 1; });
  WR_LABELS = {};
  try {
    const { data: lb, error: le } = await sb.from('job_photo_labels').select('file_url,section,tag,caption').eq('job_id', j.id);
    if(!le) (lb || []).forEach(r => { WR_LABELS[r.file_url] = r; });
  } catch(e){}
  document.getElementById('wr-version').value = 'v1'; wrVersionChanged();
  renderWrPhotos();
}
function wrPhotoTime(f){
  const n = f.file_name || '';
  let m = n.match(/(\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2})\s*([AP]M)?(?:\s*\((\d+)\))?/i);
  if(m){
    let h = parseInt(m[4], 10); const ap = (m[7] || '').toUpperCase();
    if(ap === 'PM' && h < 12) h += 12; if(ap === 'AM' && h === 12) h = 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], h, +m[5], +m[6]) + (m[8] ? parseInt(m[8], 10) : 0);
  }
  m = n.match(/(\d{4})-(\d{2})-(\d{2})[ _-]?(\d{2})(\d{2})(\d{2})/);
  if(m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = n.match(/(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/);
  if(m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return f.uploaded_at ? Date.parse(f.uploaded_at) : 0;
}
function wrVersionChanged(){
  const v2 = document.getElementById('wr-version').value === 'v2';
  document.getElementById('wr-date-wrap').style.display = v2 ? 'inline-flex' : 'none';
  const d = document.getElementById('wr-date');
  if(v2 && d && !d.value){ d.value = new Date().toLocaleDateString('en-CA', { timeZone: UK_TZ }); }
}
function toggleAllWrPhotos(){
  const all = WR_PHOTOS.length && WR_PHOTOS.every(p => p.selected);
  if(all){ WR_PHOTOS.forEach(p => p.selected = false); }
  else {
    WR_PHOTOS.forEach(p => p.selected = true);
    WR_PHOTOS.sort((a, b) => ((a._t || 0) - (b._t || 0)) || String(a._u || '').localeCompare(String(b._u || '')));
  }
  renderWrPhotos();
}
async function saveWorkReportText(){
  if(!currentDetailId) return;
  const v = document.getElementById('wr-text').value;
  if(v === WR_LAST_SAVED || !v.trim()) return;
  const { error } = await sb.from('job_work_reports').upsert({ job_id: currentDetailId, body: v, updated_at: new Date().toISOString(), updated_by: CURRENT_USER ? CURRENT_USER.name : null });
  if(!error) WR_LAST_SAVED = v;
}
async function closeWorkReport(){ await saveWorkReportText(); document.getElementById('wr-screen').classList.remove('open'); }
function renderWrPhotos(){
  const g = document.getElementById('wr-photos');
  const order = WR_PHOTOS.filter(p => p.selected);
  const nLab = WR_PHOTOS.filter(p => WR_LABELS[p.url] && WR_LABELS[p.url].caption).length;
  document.getElementById('wr-photo-count').textContent = '(' + order.length + ' selected' + (nLab ? ', ' + nLab + ' labelled' : '') + ', in the order you tick them)';
  const allBtn = document.getElementById('wr-all-btn');
  if(allBtn){ allBtn.textContent = (WR_PHOTOS.length && order.length === WR_PHOTOS.length) ? 'Deselect all' : 'Select all'; allBtn.style.display = WR_PHOTOS.length ? '' : 'none'; }
  if(!WR_PHOTOS.length){ g.innerHTML = '<div class="empty-state" style="padding:16px;">No photos yet. Use Add photos.</div>'; return; }
  g.innerHTML = WR_PHOTOS.map((p, i) => {
    const n = p.selected ? order.indexOf(p) + 1 : 0;
    const lab = WR_LABELS[p.url] && WR_LABELS[p.url].caption ? ' ' + escHtml(WR_LABELS[p.url].caption) : '';
    return `<div class="wr-photo${p.selected ? ' on' : ''}" onclick="toggleWrPhoto(${i})"><img src="${escHtml(p.url)}">${p.selected ? `<span>${n}</span>` : ''}<em class="wr-cap"><b>#${p._n || ''}</b>${lab}</em></div>`;
  }).join('');
}
async function addWrPhotos(e){
  const files = Array.from(e.target.files || []); e.target.value = '';
  if(!files.length || !currentDetailId) return;
  const jobId = currentDetailId, btn = document.getElementById('wr-add-btn'); let ok = 0;
  for(let i = 0; i < files.length; i++){
    const f = files[i];
    if(btn){ btn.disabled = true; btn.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '...'; }
    const path = `${jobId}/${Date.now()}_${i}_${f.name}`;
    const { error: ue } = await sb.storage.from('job-files').upload(path, f);
    if(ue){ showToast('Upload failed: ' + ue.message); continue; }
    const url = sb.storage.from('job-files').getPublicUrl(path).data.publicUrl;
    const { error: de } = await sb.from('job_files').insert([{ job_id: jobId, file_name: f.name, file_url: url, mime_type: f.type || 'image/jpeg' }]);
    if(de){ showToast('Saved the photo but not its record: ' + de.message); continue; }
    WR_PHOTOS.push({ url, name: f.name, selected: true, _n: WR_PHOTOS.reduce((m, q) => Math.max(m, q._n || 0), 0) + 1, _t: wrPhotoTime({ file_name: f.name, uploaded_at: new Date().toISOString() }), _u: new Date().toISOString() }); ok++; renderWrPhotos();
  }
  if(btn){ btn.disabled = false; btn.textContent = '+ Add photos'; }
  if(ok){ showToast(ok + ' photo' + (ok > 1 ? 's' : '') + ' added to the job'); loadJobFiles(jobId); }
}
function toggleWrPhoto(i){
  const p = WR_PHOTOS[i]; p.selected = !p.selected;
  if(p.selected){ WR_PHOTOS.splice(i, 1); WR_PHOTOS.push(p); }
  renderWrPhotos();
}
let WR_BLOB = null, WR_BLOB_NAME = '';
async function buildWrBlob(){
  const j = JOBS.find(x => x.id === currentDetailId); if(!j) throw new Error('No job open');
  await saveWorkReportText();
  await loadWrLib();
  const text = document.getElementById('wr-text').value;
  if(document.getElementById('wr-version').value === 'v2'){
    const dv = document.getElementById('wr-date').value;
    const date = dv ? new Date(dv + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    WR_BLOB = await window.WorkReport2.makePdf({ address: j.address, text, date, photos: WR_PHOTOS.filter(p => p.selected).map(p => Object.assign({ url: p.url }, WR_LABELS[p.url] ? { section: WR_LABELS[p.url].section || undefined, tag: WR_LABELS[p.url].tag || undefined, caption: WR_LABELS[p.url].caption || undefined } : {})) });
  } else {
    WR_BLOB = await window.WorkReport.makePdf({ address: j.address, text, photos: WR_PHOTOS.filter(p => p.selected).map(p => p.url) });
  }
  WR_BLOB_NAME = (j.address || j.ref).replace(/[\\/:*?"<>|]+/g, '').trim() + '.pdf';
  return WR_BLOB;
}

/* In-app preview: a phone WebView cannot show a PDF, so each page is drawn as a picture (pdf.js). */
async function loadPdfJs(){
  if(window.pdfjsLib) return;
  const base = window.WR_BASE || WR_REMOTE_BASE;
  const get = async n => { const r = await fetch(base + n); if(!r.ok) throw new Error('Could not download the preview tools (' + r.status + ')'); return r.text(); };
  const lib = await get('pdf.min.js');
  const s = document.createElement('script'); s.textContent = lib; document.head.appendChild(s);
  const worker = await get('pdf.worker.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([worker], { type: 'application/javascript' }));
}
async function previewWorkReport(){
  const st = document.getElementById('wr-status'); const btns = ['wr-preview-btn','wr-make-btn'].map(i => document.getElementById(i));
  btns.forEach(b => b.disabled = true); st.className = 'wr-status'; st.textContent = 'Building the preview...';
  try {
    const blob = await buildWrBlob();
    await loadPdfJs();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const holder = document.getElementById('wr-pages'); holder.innerHTML = '';
    const targetW = Math.min(window.innerWidth, 900) * Math.min(window.devicePixelRatio || 2, 2.5);
    for(let n = 1; n <= pdf.numPages; n++){
      const page = await pdf.getPage(n);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: targetW / vp0.width });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const img = document.createElement('img'); img.src = c.toDataURL('image/jpeg', 0.88); img.className = 'wr-page-img';
      holder.appendChild(img);
    }
    document.getElementById('wr-preview-screen').classList.add('open');
    st.textContent = '';
  } catch(e){ st.className = 'wr-status err'; st.textContent = e.message || String(e); }
  btns.forEach(b => b.disabled = false);
}
function closeWrPreview(){ document.getElementById('wr-preview-screen').classList.remove('open'); }

async function makeWorkReport(){
  const j = JOBS.find(x => x.id === currentDetailId); if(!j) return;
  const st = document.getElementById('wr-status'); const btns = ['wr-preview-btn','wr-make-btn','wr-attach-btn'].map(i => document.getElementById(i));
  btns.forEach(b => b && (b.disabled = true)); st.className = 'wr-status'; st.textContent = 'Building the PDF...';
  try {
    const blob = await buildWrBlob();
    const fname = WR_BLOB_NAME;
    const filePath = `${j.id}/${Date.now()}_${fname}`;
    const { error: upErr } = await sb.storage.from('job-files').upload(filePath, blob, { contentType: 'application/pdf' });
    if(upErr) throw new Error('Upload failed: ' + upErr.message);
    const { data: urlData } = sb.storage.from('job-files').getPublicUrl(filePath);
    await sb.from('job_files').insert([{ job_id: j.id, file_name: fname, file_url: urlData.publicUrl, mime_type: 'application/pdf' }]);
    const { data: nc, error: cErr } = await sb.from('board_comments').insert([{
      job_id: j.id, author: (CURRENT_USER.name || 'Ilyas').replace(/\s*\(Admin\)$/, ''),
      message: 'work report [1 attachment: ' + fname + ']', author_user_id: CURRENT_USER.id }]).select().single();
    if(!cErr && nc) await sb.from('comment_attachments').insert([{ comment_id: nc.id, file_url: urlData.publicUrl, file_name: fname, mime_type: 'application/pdf' }]);
    WR_LAST_URL = urlData.publicUrl;
    closeWrPreview();
    document.getElementById('wr-link-row').style.display = '';
    st.className = 'wr-status ok'; st.textContent = 'Done - attached to the job as "' + fname + '".';
    loadComments(j.id);
  } catch(e){ st.className = 'wr-status err'; st.textContent = e.message || String(e); }
  btns.forEach(b => b && (b.disabled = false));
}
async function copyWrLink(){
  const ok = await copyText(WR_LAST_URL);
  showToast(ok ? 'PDF link copied' : 'Could not copy the link');
}

/* ===== THEME (light / dark, remembered) ===== */
function applyTheme(){
  let t = 'light';
  try { t = localStorage.getItem('fg-theme') || 'light'; } catch(e){}
  document.documentElement.setAttribute('data-theme', t);
  const lbl = document.getElementById('theme-label');
  if(lbl) lbl.textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
}
function toggleTheme(){
  let t = 'light';
  try { t = localStorage.getItem('fg-theme') || 'light'; } catch(e){}
  t = t === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('fg-theme', t); } catch(e){}
  applyTheme();
}
applyTheme();

/* ===== UK CLOCK ===== */
function tickUkClock(){
  const el = document.getElementById('uk-clock'); if(!el) return;
  const now = new Date();
  const t = now.toLocaleTimeString('en-GB', { timeZone: UK_TZ, hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  const d = now.toLocaleDateString('en-GB', { timeZone: UK_TZ, weekday: 'short', day: 'numeric', month: 'short' });
  el.innerHTML = `<b>${t}</b> <span>UK</span><br><small>${d}</small>`;
}
tickUkClock(); setInterval(tickUkClock, 15000);

/* ===== PHOTOS & FILES (on the job's Info page) ===== */
let JOB_FILES = [];
async function loadJobFiles(jobId){
  const grid = document.getElementById('pf-grid'); if(!grid) return;
  const { data, error } = await sb.from('job_files').select('*').eq('job_id', jobId).order('uploaded_at', { ascending: false });
  if(currentDetailId !== jobId) return;
  const g = document.getElementById('pf-grid'); if(!g) return;
  if(error){ g.innerHTML = '<div class="pf-none">Failed to load files.</div>'; return; }
  const all = data || [];
  const cnt = document.getElementById('pf-count'); if(cnt) cnt.textContent = all.length ? '(' + all.length + ')' : '';
  if(!all.length){ JOB_FILES = []; g.innerHTML = '<div class="pf-none">No files uploaded yet.</div>'; return; }
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  const isImg = f => (f.mime_type || '').startsWith('image/'), isVid = f => (f.mime_type || '').startsWith('video/');
  const docs = all.filter(f => !isImg(f) && !isVid(f)), vids = all.filter(isVid);
  // photos oldest first, same order and numbers as the work report picker
  const imgs = all.filter(isImg).sort((a, b) => (wrPhotoTime(a) - wrPhotoTime(b)) || String(a.uploaded_at || '').localeCompare(String(b.uploaded_at || '')));
  JOB_FILES = docs.concat(imgs, vids);
  const idx = f => JOB_FILES.indexOf(f);
  const del = f => isAdmin ? `<button class="pf-del" onclick="event.stopPropagation();deleteJobFile('${f.id}')" aria-label="Delete">&times;</button>` : '';
  const head = (label, n) => `<div class="pf-head">${label}<span>${n}</span></div>`;
  const tile = (f, inner) => `<div class="pf-thumb" onclick="openViewerFile(${idx(f)})">${inner}<div class="pf-name">${escHtml(f.file_name || '')}</div>${del(f)}</div>`;
  let html = '';
  if(docs.length) html += head('Documents', docs.length) + docs.map(f => {
    const when = f.uploaded_at ? new Date(f.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    return `<div class="pf-doc" onclick="openViewerFile(${idx(f)})"><span class="pf-doc-ic">${f.mime_type === 'application/pdf' ? '&#128196;' : '&#128206;'}</span><span class="pf-doc-n">${escHtml(f.file_name || '')}</span><span class="pf-doc-d">${when}</span>${isAdmin ? `<button class="pf-doc-x" onclick="event.stopPropagation();deleteJobFile('${f.id}')" aria-label="Delete">&times;</button>` : ''}</div>`;
  }).join('');
  if(imgs.length) html += head('Photos', imgs.length) + '<div class="pf-sub">' + imgs.map(f => tile(f, `<img src="${escHtml(f.file_url)}" loading="lazy">`)).join('') + '</div>';
  if(vids.length) html += head('Videos', vids.length) + '<div class="pf-sub">' + vids.map(f => tile(f, '<span class="pf-icon">&#127916;</span>')).join('') + '</div>';
  g.innerHTML = html;
}
function openViewerFile(i){ const f = JOB_FILES[i]; if(f) openViewer(f.file_url, f.file_name || '', f.mime_type || ''); }

async function uploadJobFiles(e){
  const files = Array.from(e.target.files || []); e.target.value = '';
  if(!files.length || !currentDetailId) return;
  const btn = document.getElementById('pf-upload-btn'); const jobId = currentDetailId;
  const allowed = ['jpg','jpeg','png','webp','gif','pdf','mp4','mov','webm'];
  let done = 0;
  for(const file of files){
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if(!allowed.includes(ext)){ showToast('Skipped ' + file.name + ' (type not allowed)'); continue; }
    if(btn){ btn.disabled = true; btn.textContent = 'Uploading ' + (done + 1) + ' of ' + files.length + '...'; }
    const filePath = `${jobId}/${Date.now()}_${file.name}`;
    const { error: upErr } = await sb.storage.from('job-files').upload(filePath, file);
    if(upErr){ showToast('Upload failed: ' + upErr.message); continue; }
    const { data: urlData } = sb.storage.from('job-files').getPublicUrl(filePath);
    const { error: dbErr } = await sb.from('job_files').insert([{ job_id: jobId, file_name: file.name, file_url: urlData.publicUrl, mime_type: file.type || null }]);
    if(dbErr){ showToast('Saved the file but not its record: ' + dbErr.message); continue; }
    done++;
  }
  if(btn){ btn.disabled = false; btn.textContent = '+ Add photos / files'; }
  if(done) showToast(done + ' file' + (done > 1 ? 's' : '') + ' added');
  loadJobFiles(jobId);
}
async function deleteJobFile(fileId){
  if(!confirm('Delete this file from the job?')) return;
  const { error } = await sb.from('job_files').delete().eq('id', fileId);
  if(error){ showToast('Failed to delete: ' + error.message); return; }
  loadJobFiles(currentDetailId);
}

/* ===== FILE VIEWER (photos with pinch-zoom, videos, PDFs drawn as pages) ===== */
let VW = { s: 1, x: 0, y: 0 };
function closeViewer(){
  const v = document.getElementById('viewer-screen'); v.classList.remove('open');
  const body = document.getElementById('viewer-body'); const vid = body.querySelector('video'); if(vid) vid.pause();
  body.innerHTML = '';
}
async function openViewer(url, name, mime){
  const v = document.getElementById('viewer-screen'); const body = document.getElementById('viewer-body');
  document.getElementById('viewer-title').textContent = name || '';
  body.innerHTML = ''; body.style.touchAction = ''; v.classList.add('open');
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name || '');
  const isVideo = (mime || '').startsWith('video/') || /\.(mp4|mov|webm)$/i.test(name || '');
  const isImage = (mime || '').startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(name || '');
  if(isImage){
    const img = document.createElement('img'); img.src = url; img.className = 'viewer-img'; img.draggable = false;
    body.style.touchAction = 'none'; body.appendChild(img); VW = { s: 1, x: 0, y: 0 }; attachPinch(body, img);
  } else if(isVideo){
    body.innerHTML = `<video src="${escHtml(url)}" controls playsinline autoplay class="viewer-video"></video>`;
  } else if(isPdf){
    body.innerHTML = '<div class="viewer-msg">Opening PDF...</div>';
    try {
      await loadPdfJs();
      const r = await fetch(url); if(!r.ok) throw new Error('Could not download the PDF (' + r.status + ')');
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await r.arrayBuffer()) }).promise;
      const holder = document.createElement('div'); holder.className = 'viewer-pdf';
      const targetW = Math.min(window.innerWidth, 900) * Math.min(window.devicePixelRatio || 2, 2.5);
      for(let n = 1; n <= pdf.numPages; n++){
        const page = await pdf.getPage(n); const vp0 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: targetW / vp0.width });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        const im = document.createElement('img'); im.src = c.toDataURL('image/jpeg', 0.88); im.className = 'wr-page-img'; holder.appendChild(im);
      }
      if(!v.classList.contains('open')) return;
      body.innerHTML = ''; body.appendChild(holder);
    } catch(e){ body.innerHTML = `<div class="viewer-msg">${escHtml(e.message || 'Could not open this PDF')}<br><button class="mini-btn" onclick="copyViewerLink('${escHtml(url)}')">Copy link</button></div>`; }
  } else {
    body.innerHTML = `<div class="viewer-msg">This file type cannot be shown in the app.<br><button class="mini-btn" onclick="copyViewerLink('${escHtml(url)}')">Copy link</button></div>`;
  }
}
async function copyViewerLink(url){ showToast((await copyText(url)) ? 'Link copied' : 'Could not copy the link'); }

function attachPinch(box, img){
  const apply = () => { img.style.transform = `translate(${VW.x}px, ${VW.y}px) scale(${VW.s})`; };
  let t0 = null, lastTap = 0;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  box.ontouchstart = e => {
    if(e.touches.length === 2){ t0 = { d: dist(e.touches), s: VW.s }; }
    else if(e.touches.length === 1){
      t0 = { px: e.touches[0].clientX, py: e.touches[0].clientY, x: VW.x, y: VW.y };
      const now = Date.now();
      if(now - lastTap < 280){ VW = VW.s > 1 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }; apply(); }
      lastTap = now;
    }
  };
  box.ontouchmove = e => {
    if(!t0) return;
    if(e.touches.length === 2 && t0.d){ VW.s = Math.min(6, Math.max(1, t0.s * dist(e.touches) / t0.d)); if(VW.s === 1){ VW.x = 0; VW.y = 0; } apply(); e.preventDefault(); }
    else if(e.touches.length === 1 && VW.s > 1 && t0.px !== undefined){ VW.x = t0.x + (e.touches[0].clientX - t0.px); VW.y = t0.y + (e.touches[0].clientY - t0.py); apply(); e.preventDefault(); }
  };
  box.ontouchend = () => { if(VW.s <= 1){ VW.s = 1; VW.x = 0; VW.y = 0; apply(); } };
}

/* ===== LINKED JOBS (same rules as the board) ===== */
function renderLinkedJobs(j){
  const listEl = document.getElementById('linked-list'); if(!listEl) return;
  const isAdmin = CURRENT_USER && CURRENT_USER.role === 'admin';
  const visibleToMe = job => isAdmin || (job.assigned_to || '').trim().toLowerCase() === (CURRENT_USER.name || '').trim().toLowerCase();
  const seen = new Set([j.id]); const links = [];
  const add = (job, rel, unlinkFrom) => { if(!job || seen.has(job.id) || !visibleToMe(job)) return; seen.add(job.id); links.push({ job, rel, unlinkFrom }); };
  const parent = j.parent_job_id ? JOBS.find(x => x.id === j.parent_job_id) : null;
  add(parent, 'Parent', j.id);
  JOBS.filter(x => x.parent_job_id === j.id).forEach(c => add(c, 'Follow-up', c.id));
  if(j.parent_job_id) JOBS.filter(x => x.parent_job_id === j.parent_job_id).forEach(s => add(s, 'Related', null));
  if(j.external_job_id) JOBS.filter(x => x.external_job_id && x.external_job_id === j.external_job_id).forEach(s => add(s, 'Same ticket', null));
  if(!links.length){ listEl.innerHTML = '<div class="pf-none">No linked jobs</div>'; return; }
  listEl.innerHTML = links.map(l => `
    <div class="link-item" onclick="openDetail('${l.job.id}')">
      <div class="link-main"><div class="link-rel">${escHtml(l.rel)}</div>
        <div class="job-title">${escHtml(l.job.title || 'Untitled Job')}</div>
        <div class="job-ref">${escHtml(l.job.ref)} &middot; ${escHtml(l.job.status)}</div></div>
      ${(isAdmin && l.unlinkFrom) ? `<button class="pf-del static" onclick="event.stopPropagation();unlinkJob('${l.unlinkFrom}')" aria-label="Unlink">&times;</button>` : ''}
    </div>`).join('');
}
async function linkJobFromInput(){
  const input = document.getElementById('link-job-input'); const raw = (input.value || '').trim().toUpperCase();
  if(!raw) return;
  const ref = /^\d+$/.test(raw) ? 'JOB-' + raw : raw;
  const j = JOBS.find(x => x.id === currentDetailId); const target = JOBS.find(x => (x.ref || '').toUpperCase() === ref);
  if(!j) return;
  if(!target){ showToast('No job found with reference ' + ref); return; }
  if(target.id === j.id){ showToast('A job cannot be linked to itself'); return; }
  let cursor = target, guard = 0;
  while(cursor && cursor.parent_job_id && guard++ < 50){
    if(cursor.parent_job_id === j.id){ showToast(target.ref + ' is already a follow-up of this job'); return; }
    cursor = JOBS.find(x => x.id === cursor.parent_job_id);
  }
  if(j.parent_job_id && j.parent_job_id !== target.id){
    const cur = JOBS.find(x => x.id === j.parent_job_id);
    if(!confirm('This job is already linked to ' + (cur ? cur.ref : 'another job') + '. Replace that link with ' + target.ref + '?')) return;
  }
  const { error } = await sb.from('jobs').update({ parent_job_id: target.id }).eq('id', j.id);
  if(error){ showToast('Failed to link: ' + error.message); return; }
  j.parent_job_id = target.id; input.value = ''; renderLinkedJobs(j);
}
async function unlinkJob(childId){
  const child = JOBS.find(x => x.id === childId); if(!child) return;
  if(!confirm('Remove the link on ' + child.ref + '?')) return;
  const { error } = await sb.from('jobs').update({ parent_job_id: null }).eq('id', childId);
  if(error){ showToast('Failed to unlink: ' + error.message); return; }
  child.parent_job_id = null;
  const j = JOBS.find(x => x.id === currentDetailId); if(j) renderLinkedJobs(j);
}

/* ===== TECHNICIAN ADD / EDIT (admin) ===== */
let editingTechId = null;
function openTechForm(id){
  const t = id ? technicians.find(x => x.id === id) : null;
  editingTechId = t ? t.id : null;
  document.getElementById('tf-title').textContent = t ? 'Edit Technician' : 'New Technician';
  document.getElementById('tf-name').value = (t && t.name) || '';
  document.getElementById('tf-phone').value = (t && t.phone) || '';
  document.getElementById('tf-specialty').value = (t && t.specialty) || '';
  document.getElementById('tf-areas').value = (t && t.areas) || '';
  document.getElementById('tf-notes').value = (t && t.notes) || '';
  document.getElementById('tf-remove').style.display = t ? '' : 'none';
  document.getElementById('tech-form-screen').classList.add('open');
}
function closeTechForm(){ document.getElementById('tech-form-screen').classList.remove('open'); editingTechId = null; }
async function saveTechForm(){
  const name = document.getElementById('tf-name').value.trim();
  if(!name){ showToast('Please enter a name'); return; }
  const row = { name,
    phone: document.getElementById('tf-phone').value.trim() || null,
    specialty: document.getElementById('tf-specialty').value.trim() || null,
    areas: document.getElementById('tf-areas').value.trim() || null,
    notes: document.getElementById('tf-notes').value.trim() || null };
  const q = editingTechId ? sb.from('technicians').update(row).eq('id', editingTechId) : sb.from('technicians').insert([row]);
  const { error } = await q;
  if(error){ showToast('Failed to save: ' + error.message); return; }
  closeTechForm(); showToast('Saved');
  await fetchTeamAndTechnicians(); renderSheetList();
}
async function removeTechForm(){
  if(!editingTechId || !confirm('Remove this technician from the list?')) return;
  const { error } = await sb.from('technicians').update({ archived_at: new Date().toISOString() }).eq('id', editingTechId);
  if(error){ showToast('Failed: ' + error.message); return; }
  closeTechForm(); showToast('Removed');
  await fetchTeamAndTechnicians(); renderSheetList();
}

/* ===== INIT ===== */
boot();
