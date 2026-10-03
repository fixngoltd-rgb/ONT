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
let editMode = false;

function can(permKey){
  if(!CURRENT_USER) return false;
  if(CURRENT_USER.role === 'admin') return true;
  return !!(CURRENT_USER.permissions && CURRENT_USER.permissions[permKey]);
}

const COLUMNS = [
  {
    key: 'appointments_today',
    title: 'Today',
    filter: j => !j.quote_needed && j.scheduled_at && isDueTodayOrOverdue(j.scheduled_at) && j.status !== 'completed' && j.status !== 'cancelled'
  },
  {
    key: 'awaiting_start',
    title: 'Needs a Date',
    filter: j => !j.quote_needed && ['active', 'contacted'].includes(j.status) && !j.scheduled_at
  },
  {
    key: 'awaiting_completion',
    title: 'Booked',
    filter: j => !j.quote_needed && (j.status === 'booked' || (j.scheduled_at && j.status !== 'completed' && j.status !== 'cancelled')) && !isDueTodayOrOverdue(j.scheduled_at)
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
    filter: j => j.quote_needed === true
  }
];

function todayDateStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isDueTodayOrOverdue(scheduledAt){
  if(!scheduledAt) return false;
  return scheduledAt.split('T')[0] <= todayDateStr();
}
function daysSince(dateStr){
  if(!dateStr) return 0;
  return Math.max(0, Math.floor((new Date() - new Date(dateStr)) / 86400000));
}
function badgeColor(days){ return days <= 2 ? 'green' : (days <= 5 ? 'amber' : 'red'); }
function formatShortDate(dateStr){
  if(!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-GB', { day:'2-digit', month:'short' });
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
  document.getElementById('user-name').textContent = profile.name + (profile.role === 'admin' ? ' (Admin)' : '');
  applyRoleUI();
  await Promise.all([fetchAllJobs(), fetchTeamAndTechnicians()]);
}

function applyRoleUI(){
  const isAdmin = CURRENT_USER.role === 'admin';
  // Employees only ever see their own jobs - team/filter/add-job are admin surfaces.
  document.getElementById('team-btn').style.display = isAdmin ? '' : 'none';
  document.getElementById('new-job-btn').style.display = isAdmin ? '' : 'none';
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
    created_at: j.created_at || j.created
  }));
  renderTabs();
  renderPager();
}

function getVisibleJobs(){
  const q = (document.getElementById('search-input').value || '').toLowerCase().trim();
  return JOBS.filter(j => {
    if(CURRENT_USER.role !== 'admin' && (j.assigned_to||'').trim().toLowerCase() !== CURRENT_USER.name.trim().toLowerCase()) return false;
    if(activeAssignedFilter && (j.assigned_to||'') !== activeAssignedFilter) return false;
    if(q){
      const hay = [j.ref, j.address, j.tenant, j.tech, j.assigned_to, j.title, j.description].filter(Boolean).join(' ').toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });
}

function onAssignedFilterChange(){
  activeAssignedFilter = document.getElementById('assigned-filter').value;
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

  const filterSel = document.getElementById('assigned-filter');
  if(filterSel && CURRENT_USER.role === 'admin'){
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">Everyone</option>' +
      teamMembers.map(t => `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`).join('');
    filterSel.value = current;
    filterSel.classList.add('visible');
  }
}

function openTeamSheet(){
  const list = document.getElementById('team-list');
  const allCount = getVisibleJobsIgnoringAssignedFilter().length;
  let html = `<div class="team-row-all" onclick="filterByTeamMember('')">All Team (${allCount})</div>`;
  html += teamMembers.map(t => {
    const count = getVisibleJobsIgnoringAssignedFilter().filter(j => (j.assigned_to||'') === t.name).length;
    const active = activeAssignedFilter === t.name;
    return `
      <div class="team-row ${active?'active':''}" onclick="filterByTeamMember('${escHtml(t.name)}')">
        <div>
          <div class="tr-name">${escHtml(t.name)}</div>
          ${t.phone ? `<div class="tr-phone">${escHtml(t.phone)}</div>` : ''}
        </div>
        <div class="tr-count">${count}</div>
      </div>`;
  }).join('');
  if(!teamMembers.length) html += `<div class="empty-state">No team members added yet</div>`;
  list.innerHTML = html;
  document.getElementById('team-sheet').classList.add('open');
  document.getElementById('team-backdrop').classList.add('show');
}
function closeTeamSheet(){
  document.getElementById('team-sheet').classList.remove('open');
  document.getElementById('team-backdrop').classList.remove('show');
}
function getVisibleJobsIgnoringAssignedFilter(){
  const saved = activeAssignedFilter;
  activeAssignedFilter = '';
  const jobs = getVisibleJobs();
  activeAssignedFilter = saved;
  return jobs;
}
function filterByTeamMember(name){
  activeAssignedFilter = name;
  document.getElementById('assigned-filter').value = name;
  closeTeamSheet();
  renderTabs();
  renderPager();
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

  const { error } = await sb.from('jobs').insert([newJob]);
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

function renderPager(){
  const visible = getVisibleJobs();
  const pager = document.getElementById('pager');
  // Rebuilding innerHTML resets scrollLeft to 0, which would yank the user back
  // to the first tab mid-swipe whenever a refresh happens to land at the same
  // moment. Keep the currently active tab in view across the rebuild.
  pager.innerHTML = COLUMNS.map((col, idx) => {
    const jobs = visible.filter(col.filter);
    const cards = jobs.map(j => {
      let badge;
      if(col.key === 'completed_invoiced' || (col.key === 'quote_needed' && j.quoted)){
        badge = `<div class="badge green">&#10003;</div>`;
      } else if((col.key === 'awaiting_completion' || col.key === 'appointments_today') && j.scheduled_at){
        const overdue = col.key === 'appointments_today' && j.scheduled_at.split('T')[0] < todayDateStr();
        badge = `<div class="badge ${overdue?'red':'date'}">${formatShortDate(j.scheduled_at)}</div>`;
      } else {
        const d = daysSince(j.created_at || j.created);
        badge = `<div class="badge ${badgeColor(d)}">${d}</div>`;
      }
      return `
        <div class="job-card" onclick="openDetail('${j.id}','${col.key}')">
          <div class="job-main">
            <div class="job-ref">${escHtml(j.ref)}</div>
            <div class="job-title">${escHtml(j.title || 'Untitled')}</div>
            <div class="job-address">${escHtml(j.address || '')}</div>
          </div>
          ${badge}
        </div>`;
    }).join('') || `<div class="empty-state">No jobs here</div>`;
    return `<div class="page" data-idx="${idx}" ontouchstart="onPageTouchStart(event)" ontouchmove="onPageTouchMove(event)" ontouchend="onPageTouchEnd(event)">${cards}</div>`;
  }).join('');
  pager.onscroll = onPagerScroll;
  // Restore scroll position to the active tab without animating - this runs
  // after every data refresh, not just on first load, so it must be instant.
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
    <div class="info-field"><label>Status</label><div class="val"><span class="status-pill status-${j.status}">${escHtml(j.status)}</span></div></div>
    <div class="info-field"><label>Address</label><div class="val">${escHtml(j.address || '—')}</div></div>
    <div class="info-field"><label>Ticket ID</label><div class="val">${escHtml(j.external_job_id || '—')}</div></div>
    <div class="info-field"><label>Tenant</label><div class="val">${escHtml(j.tenant || '—')}${j.tenant_phone ? ' · '+escHtml(j.tenant_phone) : ''}</div></div>
    <div class="info-field"><label>Description</label><div class="val">${escHtml(j.description || '—')}</div></div>
    <div class="info-field"><label>Appointment</label><div class="val">${j.scheduled_at ? formatShortDate(j.scheduled_at) : 'Not set'}</div></div>
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
    <div class="info-field"><label>Appointment Date</label><input class="field-input" type="date" id="d-scheduled-input" value="${j.scheduled_at ? j.scheduled_at.split('T')[0] : ''}"></div>
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
    scheduled_at: scheduledVal || null,
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
  if(document.getElementById('newjob-screen').classList.contains('open')){
    closeNewJobScreen();
    return 'false';
  }
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
  const { error } = await sb.from('jobs').update(updates).eq('id', currentDetailId);
  if(error){ showToast('Failed: ' + error.message); return; }
  showToast('Quote approved - now a job');
  refreshAfterAction(updates);
}

/* ===== COMMENTS ===== */

async function loadComments(jobId){
  const list = document.getElementById('comment-list');
  const { data, error } = await sb.from('board_comments').select('*').eq('job_id', jobId).order('created_at', { ascending: true });
  if(error){ list.innerHTML = '<div class="no-comments">Failed to load comments.</div>'; return; }
  if(!data || !data.length){ list.innerHTML = '<div class="no-comments">No comments yet.</div>'; return; }

  const ids = data.map(c => c.id);
  const { data: attachData } = await sb.from('comment_attachments').select('*').in('comment_id', ids);
  const byComment = {};
  (attachData || []).forEach(a => { (byComment[a.comment_id] = byComment[a.comment_id] || []).push(a); });

  list.innerHTML = data.map(c => {
    const time = new Date(c.created_at).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    let attachments = byComment[c.id] || [];
    if(c.file_url && !attachments.length) attachments = [{ file_url: c.file_url, file_name: c.file_name }];
    const photos = attachments.filter(a => /\.(jpe?g|png)$/i.test(a.file_name||'')).map(a =>
      `<img class="comment-photo" src="${escHtml(a.file_url)}">`
    ).join('');
    return `
      <div class="comment-item">
        <div class="comment-author">${escHtml(c.author)}</div>
        <div class="comment-time">${time}</div>
        <div class="comment-text">${escHtml(c.message)}</div>
        ${photos}
      </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
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

/* ===== INIT ===== */
boot();
