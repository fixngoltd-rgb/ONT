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
      const hay = [j.ref, j.address, j.tenant, j.tech, j.assigned_to, j.title, j.description].filter(Boolean).join(' ').toLowerCase();
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
  return `
    <div class="team-row ${active?'active':''}" onclick="pickPerson('${kind}','${escHtml(p.name).replace(/'/g,"\\'")}')">
      <div>
        <div class="tr-name">${escHtml(p.name)}</div>
        ${phone}
      </div>
      <div class="tr-count">${countFor(kind, p.name)}</div>
    </div>`;
}
function openTeamSheet(mode){
  mode = mode || 'team';
  const list = document.getElementById('team-list');
  let html = '';
  if(mode === 'filter'){
    document.getElementById('sheet-title').textContent = 'Filter';
    html += `<div class="sheet-section">Team member</div>`;
    html += `<div class="team-row-all" onclick="pickPerson('team','')">Everyone (${getVisibleJobsIgnoringFilters().length})</div>`;
    html += teamMembers.map(t => personRow('team', t)).join('');
    html += `<div class="sheet-section">Technician</div>`;
    html += `<div class="team-row-all" onclick="pickPerson('tech','')">All technicians</div>`;
    html += technicians.map(t => personRow('tech', t)).join('');
    if(activeAssignedFilter || activeTechFilter) html += `<button class="clear-filters" onclick="clearFilters()">Clear filters</button>`;
  } else if(mode === 'tech'){
    document.getElementById('sheet-title').textContent = 'Technicians';
    html += `<div class="team-row-all" onclick="pickPerson('tech','')">All technicians</div>`;
    html += technicians.map(t => personRow('tech', t)).join('');
    if(!technicians.length) html += `<div class="empty-state">No technicians added yet</div>`;
  } else {
    document.getElementById('sheet-title').textContent = 'Team';
    html += `<div class="team-row-all" onclick="pickPerson('team','')">Everyone (${getVisibleJobsIgnoringFilters().length})</div>`;
    html += teamMembers.map(t => personRow('team', t)).join('');
    if(!teamMembers.length) html += `<div class="empty-state">No team members added yet</div>`;
  }
  list.innerHTML = html;
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
            <div class="job-ref">${escHtml(j.ref)}</div>
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
    <div class="info-field"><label>Appointment</label><div class="val">${formatApptFull(j.scheduled_at)}</div></div>
    <div class="info-field"><label>Technician</label><div class="val">${escHtml(j.tech || '—')}${j.tech_phone ? ' · '+escHtml(j.tech_phone) : ''}</div></div>
    <div class="info-field"><label>Assigned To</label><div class="val">${escHtml(j.assigned_to || 'Unassigned')}</div></div>
    <div class="info-field"><label>Category</label><div class="val">${escHtml(j.category || '—')}</div></div>
    ${isAdmin ? `
    <div class="info-field"><label>Budget</label><div class="val">${j.budget != null ? '£'+Number(j.budget).toFixed(2) : '—'}</div></div>
    <div class="info-field"><label>Cost to Us</label><div class="val">${j.cost_to_us != null ? '£'+Number(j.cost_to_us).toFixed(2) : '—'}</div></div>
    <div class="info-field"><label>Invoiced</label><div class="val">${j.invoiced ? 'Yes' : 'No'}</div></div>
    ` : ''}
    ${can('can_delete_jobs') ? `<button id="delete-job-btn" style="width:100%;padding:12px;border-radius:9px;border:1px solid #fecaca;background:#fef2f2;color:var(--red);font-weight:700;margin-top:10px;" onclick="deleteJob()">Delete Job</button>` : ''}
  `;
  if(isAdmin && EMAIL_LINK !== undefined) renderEmailLink();
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
    const photos = attachments.filter(a => /\.(jpe?g|png)$/i.test(a.file_name||'')).map(a =>
      `<img class="comment-photo" src="${escHtml(a.file_url)}">`
    ).join('');
    const docs = attachments.filter(a => /\.pdf$/i.test(a.file_name||'')).map(a =>
      `<div class="comment-doc">&#128196; ${escHtml(a.file_name)}</div>`
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
let WR_PHOTOS = [], WR_LAST_SAVED = '', WR_LOADING = null, WR_LAST_URL = '';

function loadWrLib(){
  if(window.WorkReport && window.jspdf) return Promise.resolve();
  if(WR_LOADING) return WR_LOADING;
  window.WR_BASE = window.WR_BASE_OVERRIDE || WR_REMOTE_BASE;
  const inject = async name => {
    const r = await fetch(window.WR_BASE + name);
    if(!r.ok) throw new Error('Could not download the report tools (' + r.status + ')');
    const s = document.createElement('script'); s.textContent = await r.text(); document.head.appendChild(s);
  };
  WR_LOADING = (async () => { await inject('jspdf.umd.min.js'); await inject('workreport.js'); })();
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
    WR_PHOTOS.push({ url: f.file_url, name: f.file_name, selected: true });
  });
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
  document.getElementById('wr-photo-count').textContent = '(' + order.length + ' selected, in the order you tick them)';
  if(!WR_PHOTOS.length){ g.innerHTML = '<div class="empty-state" style="padding:16px;">No photos on this job.</div>'; return; }
  g.innerHTML = WR_PHOTOS.map((p, i) => {
    const n = p.selected ? order.indexOf(p) + 1 : 0;
    return `<div class="wr-photo${p.selected ? ' on' : ''}" onclick="toggleWrPhoto(${i})"><img src="${escHtml(p.url)}">${p.selected ? `<span>${n}</span>` : ''}</div>`;
  }).join('');
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
  const photos = WR_PHOTOS.filter(p => p.selected).map(p => p.url);
  WR_BLOB = await window.WorkReport.makePdf({ address: j.address, text: document.getElementById('wr-text').value, photos });
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

/* ===== INIT ===== */
boot();
