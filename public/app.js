// Automated Handling System — frontend. Vanilla JS, no dependencies.
'use strict';

const $ = (s) => document.querySelector(s);
const state = {
  data: null,
  archived: [],
  search: '',
  urgencyFilter: '',
  decisionProjectFilter: '',
  statusFilter: '',
  sort: 'default',
  automationStatusFilter: '',
  automationProjectFilter: '',
  showArchived: false,
};

const STATUS_LABELS = {
  running: 'Running',
  needs_word: 'Needs word',
  blocked: 'Blocked',
  idle: 'Idle',
  healthy: 'Healthy',
};
const URGENCY_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function ageBadge(iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return '<span class="age-badge age-fresh">today</span>';
  if (days === 1) return '<span class="age-badge age-fresh">1 day</span>';
  if (days <= 7) return `<span class="age-badge age-warm">${days} days</span>`;
  return `<span class="age-badge age-old">${days} days</span>`;
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' toast-error' : '');
  el.textContent = msg;
  $('#toastRegion').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ------------------------------------------------------------ confirm dialog
let confirmResolve = null;
function askConfirm(title, text, okLabel) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel || 'Confirm';
  $('#confirmDialog').hidden = false;
  $('#confirmCancel').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function closeConfirm(result) {
  $('#confirmDialog').hidden = true;
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}
$('#confirmCancel').addEventListener('click', () => closeConfirm(false));
$('#confirmOk').addEventListener('click', () => closeConfirm(true));

// ------------------------------------------------------------ form dialog
let formSubmit = null;
function openForm(title, fields, initial, onSubmit) {
  $('#formTitle').textContent = title;
  const wrap = $('#formFields');
  wrap.innerHTML = '';
  for (const f of fields) {
    const label = document.createElement('label');
    label.className = 'form-field';
    label.textContent = f.label;
    let input;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 4;
    } else if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = f.type || 'text';
    }
    input.name = f.name;
    input.value = initial[f.name] ?? '';
    if (f.required) input.required = true;
    label.appendChild(input);
    wrap.appendChild(label);
  }
  $('#formDialog').hidden = false;
  formSubmit = onSubmit;
  const first = wrap.querySelector('input, select, textarea');
  if (first) first.focus();
}
function closeForm() {
  $('#formDialog').hidden = true;
  formSubmit = null;
}
$('#formCancel').addEventListener('click', closeForm);
$('#formDialogForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  const fn = formSubmit;
  closeForm();
  if (fn) fn(data);
});

// ------------------------------------------------------------ rendering
function matchesSearch(text) {
  if (!state.search) return true;
  return String(text).toLowerCase().includes(state.search);
}

function renderCounts() {
  const c = state.data.counts;
  $('#statusPill').textContent = `${c.pendingDecisions} to decide · ${c.blocked} blocked · ${c.activeAutomations}/${c.totalAutomations} automations active`;
  $('#decisionsCount').textContent = c.pendingDecisions;
  $('#projectsCount').textContent = c.totalProjects;
  $('#automationsCount').textContent = c.totalAutomations;
  $('#archivedToggle').textContent = `Archived (${state.archived.length})`;
}

function renderDecisions() {
  const list = $('#decisionList');
  const items = state.data.decisions.filter((d) => {
    if (state.urgencyFilter && d.urgency !== state.urgencyFilter) return false;
    if (state.decisionProjectFilter && String(d.projectId) !== state.decisionProjectFilter) return false;
    return matchesSearch(`${d.title} ${d.context} ${d.projectName || ''}`);
  });
  $('#noDecisions').hidden = items.length > 0 || state.data.decisions.length === 0 ? items.length > 0 : true;
  list.innerHTML = items.map((d) => `
    <li class="decision-card urgency-${esc(d.urgency)}" data-id="${d.id}">
      <div class="decision-top">
        <span class="urgency-badge">${esc(URGENCY_LABELS[d.urgency] || d.urgency)}</span>
        ${ageBadge(d.createdAt)}
        <span class="decision-project">${esc(d.projectName || 'No project')}</span>
        <span class="decision-date">${esc(d.createdAt.slice(0, 10))}</span>
      </div>
      <h3>${esc(d.title)}</h3>
      <p class="decision-context">${esc(d.context)}</p>
      <div class="decision-actions">
        <button type="button" class="btn btn-small" data-action="approve">Approve</button>
        <button type="button" class="btn btn-small" data-action="done">Done</button>
        <button type="button" class="btn btn-small btn-ghost" data-action="defer">Defer</button>
        <button type="button" class="btn btn-small btn-ghost" data-action="dismiss">Dismiss</button>
        <button type="button" class="btn btn-small btn-danger-ghost" data-action="delete">Delete</button>
      </div>
    </li>`).join('');
}

function renderProjects() {
  let projects = state.data.projects.slice();
  if (state.statusFilter) projects = projects.filter((p) => p.status === state.statusFilter);
  projects = projects.filter((p) => matchesSearch(`${p.name} ${p.summary} ${p.detail}`));
  if (state.sort === 'name') projects.sort((a, b) => a.name.localeCompare(b.name));
  else if (state.sort === 'status') projects.sort((a, b) => a.status.localeCompare(b.status) || a.sortOrder - b.sortOrder);
  else if (state.sort === 'urgency') {
    const pendingByProject = {};
    for (const d of state.data.decisions) pendingByProject[d.projectId] = (pendingByProject[d.projectId] || 0) + 1;
    projects.sort((a, b) => (pendingByProject[b.id] || 0) - (pendingByProject[a.id] || 0));
  } else projects.sort((a, b) => a.sortOrder - b.sortOrder);

  $('#projectGrid').innerHTML = projects.map((p) => {
    const autos = state.data.automations.filter((a) => a.projectId === p.id);
    const active = autos.filter((a) => a.status === 'active').length;
    const pending = state.data.decisions.filter((d) => d.projectId === p.id).length;
    return `
    <article class="project-card status-${esc(p.status)}" data-id="${p.id}">
      <div class="project-top">
        <h3>${esc(p.name)}</h3>
        <span class="status-badge">${esc(STATUS_LABELS[p.status] || p.status)}</span>
      </div>
      <p class="project-metric"><span class="metric-label">${esc(p.metricLabel)}</span> <strong>${esc(p.metricValue)}</strong></p>
      <p class="project-summary">${esc(p.summary)}</p>
      <details class="project-detail"><summary>Details</summary><p>${esc(p.detail)}</p></details>
      <p class="project-meta">Source: ${esc(p.sourceDate)} · ${autos.length} automations (${active} active) · ${pending} decision${pending === 1 ? '' : 's'} waiting</p>
      <div class="project-actions">
        <button type="button" class="btn btn-small btn-ghost" data-action="edit">Edit</button>
        <button type="button" class="btn btn-small btn-ghost" data-action="archive">Archive</button>
      </div>
    </article>`;
  }).join('') || '<p class="empty">No projects match the current filters.</p>';

  $('#archivedList').innerHTML = state.archived.map((p) => `
    <li data-id="${p.id}">
      <span>${esc(p.name)}</span>
      <span class="muted">${esc(p.sourceDate)}</span>
      <button type="button" class="btn btn-small" data-action="restore">Restore</button>
    </li>`).join('');
}

function renderAutomations() {
  const byProject = {};
  for (const p of state.data.projects) byProject[p.id] = { name: p.name, total: 0, active: 0 };
  for (const a of state.data.automations) {
    const bucket = byProject[a.projectId];
    if (!bucket) continue;
    bucket.total += 1;
    if (a.status === 'active') bucket.active += 1;
  }
  $('#healthBars').innerHTML = Object.values(byProject).map((b) => {
    const pct = b.total ? Math.round((b.active / b.total) * 100) : 0;
    return `<div class="health-bar" title="${esc(b.name)}: ${b.active}/${b.total} active">
      <span class="health-label">${esc(b.name)}</span>
      <span class="health-track"><span class="health-fill" style="width:${pct}%"></span></span>
      <span class="health-value">${b.active}/${b.total}</span>
    </div>`;
  }).join('');

  const items = state.data.automations.filter((a) => {
    if (state.automationStatusFilter && a.status !== state.automationStatusFilter) return false;
    if (state.automationProjectFilter && String(a.projectId) !== state.automationProjectFilter) return false;
    return matchesSearch(`${a.name} ${a.kind} ${a.detail} ${a.schedule}`);
  });
  $('#automationList').innerHTML = items.map((a) => `
    <li class="automation-row status-${esc(a.status)}" data-id="${a.id}">
      <span class="automation-status" title="Status: ${esc(a.status)}">${esc(a.status)}</span>
      <div class="automation-main">
        <strong>${esc(a.name)}</strong>
        <span class="muted">${esc(a.kind)} · ${esc(a.schedule)} · ${esc(state.data.projects.find((p) => p.id === a.projectId)?.name || '—')}</span>
        <span class="automation-detail">${esc(a.detail)}</span>
      </div>
      <div class="automation-actions">
        <button type="button" class="btn btn-small btn-ghost" data-action="edit">Edit</button>
        <button type="button" class="btn btn-small btn-ghost" data-action="toggle-status">${a.status === 'active' ? 'Pause' : 'Activate'}</button>
        <button type="button" class="btn btn-small btn-danger-ghost" data-action="delete">Delete</button>
      </div>
    </li>`).join('') || '<li class="empty">No automations match the current filters.</li>';
}

function renderActivity() {
  $('#activityList').innerHTML = state.data.activity.map((a) => `
    <li><span class="activity-date">${esc(a.createdAt.slice(0, 16).replace('T', ' '))}</span>
    <strong>${esc(a.projectName || 'System')}</strong> — ${esc(a.text)}</li>`).join('');
}

function fillProjectSelects() {
  const opts = state.data.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#decisionProjectFilter').innerHTML = '<option value="">All projects</option>' + opts;
  $('#automationProjectFilter').innerHTML = '<option value="">All projects</option>' + opts;
  $('#activityProject').innerHTML = '<option value="">No project</option>' + opts;
}

function render() {
  renderCounts();
  renderDecisions();
  renderProjects();
  renderAutomations();
  renderActivity();
}

async function refresh() {
  const data = await api('/api/dashboard');
  const archived = await api('/api/archived');
  state.data = data;
  state.archived = archived;
  $('#skeleton').hidden = true;
  $('#app').hidden = false;
  fillProjectSelects();
  render();
}

// ------------------------------------------------------------ actions
async function resolveDecision(id, status) {
  try {
    await api(`/api/decisions/${id}/resolve`, { method: 'POST', body: JSON.stringify({ status }) });
    toast(status === 'deferred' ? 'Decision deferred — back in the queue.' : `Decision ${status}.`);
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteDecision(id, title) {
  try {
    await api(`/api/decisions/${id}/delete`, { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    if (e.status === 409 && e.body && e.body.needsConfirm) {
      const ok = await askConfirm('Permanently delete this decision?', `"${title}" will be deleted for good. This cannot be undone.`, 'Delete permanently');
      if (!ok) return;
      try {
        await api(`/api/decisions/${id}/delete`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
        toast('Decision permanently deleted.');
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    toast(e.message, 'error');
  }
}

async function deleteAutomation(id, name) {
  const ok = await askConfirm('Delete this automation?', `"${name}" will be removed.`, 'Delete');
  if (!ok) return;
  try {
    await api(`/api/automations/${id}/delete`, { method: 'POST', body: JSON.stringify({}) });
    toast('Automation deleted.');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

async function archiveProject(id, name) {
  const ok = await askConfirm('Archive this project?', `"${name}" will leave the dashboard. You can restore it any time from the Archived list.`, 'Archive');
  if (!ok) return;
  try {
    await api(`/api/projects/${id}/archive`, { method: 'POST', body: JSON.stringify({}) });
    toast('Project archived.');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
}

function editAutomation(a) {
  openForm('Edit automation', [
    { name: 'name', label: 'Name', required: true },
    { name: 'kind', label: 'Kind' },
    { name: 'schedule', label: 'Schedule' },
    { name: 'detail', label: 'Detail', type: 'textarea' },
    { name: 'status', label: 'Status', type: 'select', options: [
      { value: 'active', label: 'Active' },
      { value: 'paused', label: 'Paused' },
      { value: 'blocked', label: 'Blocked' },
    ] },
  ], a, async (data) => {
    try {
      await api(`/api/automations/${a.id}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Automation updated.');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  });
}

function editProject(p) {
  openForm('Edit project', [
    { name: 'name', label: 'Name', required: true },
    { name: 'status', label: 'Status', type: 'select', options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })) },
    { name: 'metricLabel', label: 'Metric label' },
    { name: 'metricValue', label: 'Metric value' },
    { name: 'sourceDate', label: 'Source date' },
    { name: 'summary', label: 'Summary', type: 'textarea' },
    { name: 'detail', label: 'Detail', type: 'textarea' },
  ], p, async (data) => {
    try {
      await api(`/api/projects/${p.id}`, { method: 'PUT', body: JSON.stringify(data) });
      toast('Project updated.');
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ------------------------------------------------------------ events
$('#decisionList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const li = btn.closest('li[data-id]');
  const id = Number(li.dataset.id);
  const title = li.querySelector('h3')?.textContent || '';
  const action = btn.dataset.action;
  if (action === 'delete') return deleteDecision(id, title);
  resolveDecision(id, action);
});

$('#projectGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = btn.closest('[data-id]');
  const id = Number(card.dataset.id);
  const p = state.data.projects.find((x) => x.id === id);
  if (!p) return;
  if (btn.dataset.action === 'archive') return archiveProject(id, p.name);
  if (btn.dataset.action === 'edit') return editProject(p);
});

$('#archivedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="restore"]');
  if (!btn) return;
  const id = Number(btn.closest('li[data-id]').dataset.id);
  try {
    await api(`/api/projects/${id}/restore`, { method: 'POST', body: JSON.stringify({}) });
    toast('Project restored.');
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
});

$('#automationList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const li = btn.closest('li[data-id]');
  const id = Number(li.dataset.id);
  const a = state.data.automations.find((x) => x.id === id);
  if (!a) return;
  const action = btn.dataset.action;
  if (action === 'delete') return deleteAutomation(id, a.name);
  if (action === 'edit') return editAutomation(a);
  if (action === 'toggle-status') {
    try {
      await api(`/api/automations/${id}`, { method: 'PUT', body: JSON.stringify({ status: a.status === 'active' ? 'paused' : 'active' }) });
      toast(a.status === 'active' ? 'Automation paused.' : 'Automation activated.');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  }
});

$('#activityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#activityText').value.trim();
  const projectId = $('#activityProject').value ? Number($('#activityProject').value) : null;
  if (!text) return;
  try {
    await api('/api/activity', { method: 'POST', body: JSON.stringify({ text, projectId }) });
    $('#activityText').value = '';
    toast('Note added.');
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
});

$('#search').addEventListener('input', (e) => { state.search = e.target.value.trim().toLowerCase(); render(); });
$('#urgencyFilter').addEventListener('change', (e) => { state.urgencyFilter = e.target.value; renderDecisions(); });
$('#decisionProjectFilter').addEventListener('change', (e) => { state.decisionProjectFilter = e.target.value; renderDecisions(); });
$('#statusFilter').addEventListener('change', (e) => { state.statusFilter = e.target.value; renderProjects(); });
$('#sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderProjects(); });
$('#automationStatusFilter').addEventListener('change', (e) => { state.automationStatusFilter = e.target.value; renderAutomations(); });
$('#automationProjectFilter').addEventListener('change', (e) => { state.automationProjectFilter = e.target.value; renderAutomations(); });
$('#archivedToggle').addEventListener('click', () => {
  state.showArchived = !state.showArchived;
  $('#archivedWrap').hidden = !state.showArchived;
  $('#archivedToggle').setAttribute('aria-expanded', String(state.showArchived));
});

$('#exportJsonBtn').addEventListener('click', () => { window.location.href = '/api/export?format=json'; });
$('#exportMdBtn').addEventListener('click', () => { window.location.href = '/api/export?format=md'; });

$('#themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('ahs-theme', dark ? 'dark' : 'light');
  $('#themeToggle').setAttribute('aria-pressed', String(dark));
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
    e.preventDefault();
    $('#search').focus();
  }
  if (e.key === 'Escape') {
    if (!$('#confirmDialog').hidden) closeConfirm(false);
    if (!$('#formDialog').hidden) closeForm();
  }
});

// ------------------------------------------------------------ init
if (localStorage.getItem('ahs-theme') === 'dark') {
  document.documentElement.dataset.theme = 'dark';
  $('#themeToggle').setAttribute('aria-pressed', 'true');
}
refresh().catch((e) => {
  $('#skeleton').innerHTML = `<p class="empty">Could not load the dashboard: ${esc(e.message)}</p>`;
});
