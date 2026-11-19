// Automated Handling System — standalone command center.
// Node.js standard library only. Serves public/ plus a JSON API.
// Data lives in data/data.json (created from data/seed.json on first run).
// Statuses shown here are last-known snapshots recorded by Paris's team —
// they are NOT live-polled from the underlying systems.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SEED_PATH = path.join(DATA_DIR, 'seed.json');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

const PROJECT_STATUSES = ['running', 'needs_word', 'blocked', 'idle', 'healthy'];
const AUTOMATION_STATUSES = ['active', 'paused', 'blocked'];
const DECISION_STATUSES = ['approved', 'done', 'deferred', 'dismissed'];
const URGENCIES = ['low', 'medium', 'high'];

// Store: file-backed locally (data/data.json, created from seed on first
// run — identical to the original behaviour), Vercel KV-backed when
// KV_REST_API_URL + KV_REST_API_TOKEN are set. See lib/store.js.
const { createStore } = require('./lib/store');
const store = createStore({
  key: 'ahs:state',
  seedPath: SEED_PATH,
  dataPath: DATA_PATH,
});

// In-memory state. File mode: loaded once, like the original server.
// KV mode: reloaded fresh from KV on every request (a serverless
// invocation must never trust a warm in-memory copy).
let db = null;

async function ensureDb() {
  if (db === null || store.useKv) db = await store.load();
  return db;
}

// Same save semantics as before: every mutation commits. File mode writes
// via tmp file + rename; KV mode writes the whole state to the KV key.
async function saveData(data) {
  await store.save(data);
}

function nextId(list) {
  return list.reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
}

function findProject(id) {
  return db.projects.find((p) => p.id === id);
}

function requireProject(id, res) {
  if (id === undefined || id === null || id === '') return true; // optional link
  const p = findProject(Number(id));
  if (!p) {
    sendJson(res, 400, { error: 'unknown project: no project with id ' + id });
    return false;
  }
  return true;
}

function projectName(id) {
  const p = findProject(Number(id));
  return p ? p.name : null;
}

function addActivity(projectId, text) {
  db.activity.unshift({
    id: nextId(db.activity),
    projectId: projectId === undefined || projectId === null ? null : Number(projectId),
    projectName: projectId ? projectName(projectId) : null,
    text,
    createdAt: new Date().toISOString(),
  });
  db.activity = db.activity.slice(0, 200);
}

function dashboard() {
  const projects = db.projects
    .filter((p) => !p.archived)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));
  const pending = db.decisions.filter((d) => d.status === 'pending');
  const resolved = db.decisions.filter((d) => d.status !== 'pending');
  const automations = db.automations.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || a.id - b.id);
  const counts = {
    totalProjects: projects.length,
    pendingDecisions: pending.length,
    highUrgencyPending: pending.filter((d) => d.urgency === 'high').length,
    totalAutomations: automations.length,
    activeAutomations: automations.filter((a) => a.status === 'active').length,
    blockedAutomations: automations.filter((a) => a.status === 'blocked').length,
    pausedAutomations: automations.filter((a) => a.status === 'paused').length,
    running: projects.filter((p) => p.status === 'running').length,
    needsWord: projects.filter((p) => p.status === 'needs_word').length,
    blocked: projects.filter((p) => p.status === 'blocked').length,
    idle: projects.filter((p) => p.status === 'idle').length,
    healthy: projects.filter((p) => p.status === 'healthy').length,
  };
  return {
    projects,
    decisions: pending,
    resolvedDecisions: resolved,
    automations,
    activity: db.activity.slice(0, 50),
    counts,
  };
}

// ---------------------------------------------------------------- http helpers
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendText(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return sendText(res, 404, 'Not found', 'text/plain');
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- markdown export
function exportMarkdown() {
  const d = dashboard();
  const lines = [];
  lines.push('# Automated Handling System — export');
  lines.push('');
  lines.push('Exported ' + new Date().toISOString());
  lines.push('');
  lines.push('> Statuses below are last-known snapshots, not live data.');
  lines.push('');
  lines.push('## Projects');
  for (const p of d.projects) {
    lines.push('');
    lines.push(`### ${p.name} — ${p.status.replace('_', ' ')}`);
    lines.push(`- Metric: ${p.metricLabel}: ${p.metricValue}`);
    lines.push(`- Source: ${p.sourceDate}`);
    lines.push(`- ${p.summary}`);
  }
  lines.push('');
  lines.push('## Decisions needing your word');
  for (const dec of d.decisions) {
    lines.push('');
    lines.push(`### [${dec.urgency.toUpperCase()}] ${dec.title}`);
    lines.push(`- Project: ${dec.projectName || '—'} · Created: ${dec.createdAt.slice(0, 10)}`);
    lines.push(`- ${dec.context}`);
  }
  lines.push('');
  lines.push('## Automations');
  for (const a of d.automations) {
    lines.push(`- [${a.status}] ${a.name} (${a.kind}, ${a.schedule}) — ${projectName(a.projectId) || '—'}: ${a.detail}`);
  }
  lines.push('');
  lines.push('## Recent activity');
  for (const act of d.activity.slice(0, 20)) {
    lines.push(`- ${act.createdAt.slice(0, 10)} · ${act.projectName || '—'}: ${act.text}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------- routing
async function handle(req, res) {
  await ensureDb();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  // --- reads
  if (method === 'GET' && pathname === '/api/dashboard') return sendJson(res, 200, dashboard());
  if (method === 'GET' && pathname === '/api/archived') {
    return sendJson(res, 200, db.projects.filter((p) => p.archived));
  }
  if (method === 'GET' && pathname === '/api/export') {
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    if (format === 'md' || format === 'markdown') {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="automated-handling-system-export.md"',
      });
      return res.end(exportMarkdown());
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="automated-handling-system-export.json"',
    });
    return res.end(JSON.stringify(db, null, 2));
  }

  // --- decisions
  if (method === 'POST' && pathname === '/api/decisions') {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!b.title || typeof b.title !== 'string') return sendJson(res, 400, { error: 'title is required' });
    if (!requireProject(b.projectId, res)) return;
    const urgency = URGENCIES.includes(b.urgency) ? b.urgency : 'medium';
    const dec = {
      id: nextId(db.decisions),
      projectId: b.projectId ? Number(b.projectId) : null,
      projectName: b.projectId ? projectName(b.projectId) : null,
      title: b.title.trim(),
      context: typeof b.context === 'string' ? b.context : '',
      urgency,
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    db.decisions.push(dec);
    addActivity(dec.projectId, 'New decision added: ' + dec.title);
    await saveData(db);
    return sendJson(res, 201, dec);
  }
  const resolveMatch = pathname.match(/^\/api\/decisions\/(\d+)\/resolve$/);
  if (method === 'POST' && resolveMatch) {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    const dec = db.decisions.find((d) => d.id === Number(resolveMatch[1]));
    if (!dec) return sendJson(res, 404, { error: 'decision not found' });
    if (!DECISION_STATUSES.includes(b.status)) {
      return sendJson(res, 400, { error: 'status must be one of: ' + DECISION_STATUSES.join(', ') });
    }
    if (b.status === 'deferred') {
      // Deferred returns the decision to the queue.
      dec.status = 'pending';
      dec.resolvedAt = null;
      addActivity(dec.projectId, 'Decision deferred (back in queue): ' + dec.title);
    } else {
      dec.status = b.status;
      dec.resolvedAt = new Date().toISOString();
      addActivity(dec.projectId, `Decision ${b.status}: ${dec.title}`);
    }
    await saveData(db);
    return sendJson(res, 200, dec);
  }
  const deleteDecMatch = pathname.match(/^\/api\/decisions\/(\d+)\/delete$/);
  if (method === 'POST' && deleteDecMatch) {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    // Two-step confirm: the first call without confirm:true is refused.
    if (b.confirm !== true) {
      return sendJson(res, 409, { error: 'deletion needs confirmation', needsConfirm: true });
    }
    const idx = db.decisions.findIndex((d) => d.id === Number(deleteDecMatch[1]));
    if (idx === -1) return sendJson(res, 404, { error: 'decision not found' });
    const [removed] = db.decisions.splice(idx, 1);
    addActivity(removed.projectId, 'Decision permanently deleted: ' + removed.title);
    await saveData(db);
    return sendJson(res, 200, { deleted: removed.id });
  }

  // --- automations
  if (method === 'POST' && pathname === '/api/automations') {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!b.name || typeof b.name !== 'string') return sendJson(res, 400, { error: 'name is required' });
    if (!requireProject(b.projectId, res)) return;
    if (b.projectId === undefined || b.projectId === null || b.projectId === '') {
      return sendJson(res, 400, { error: 'projectId is required' });
    }
    const a = {
      id: nextId(db.automations),
      projectId: Number(b.projectId),
      name: b.name.trim(),
      kind: typeof b.kind === 'string' ? b.kind : '',
      schedule: typeof b.schedule === 'string' ? b.schedule : '',
      detail: typeof b.detail === 'string' ? b.detail : '',
      status: AUTOMATION_STATUSES.includes(b.status) ? b.status : 'active',
      sortOrder: db.automations.filter((x) => x.projectId === Number(b.projectId)).length + 1,
    };
    db.automations.push(a);
    addActivity(a.projectId, 'Automation added: ' + a.name);
    await saveData(db);
    return sendJson(res, 201, a);
  }
  const autoMatch = pathname.match(/^\/api\/automations\/(\d+)$/);
  if (method === 'PUT' && autoMatch) {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    const a = db.automations.find((x) => x.id === Number(autoMatch[1]));
    if (!a) return sendJson(res, 404, { error: 'automation not found' });
    if (b.projectId !== undefined && !requireProject(b.projectId, res)) return;
    if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim();
    if (typeof b.kind === 'string') a.kind = b.kind;
    if (typeof b.schedule === 'string') a.schedule = b.schedule;
    if (typeof b.detail === 'string') a.detail = b.detail;
    if (b.status !== undefined) {
      if (!AUTOMATION_STATUSES.includes(b.status)) {
        return sendJson(res, 400, { error: 'status must be one of: ' + AUTOMATION_STATUSES.join(', ') });
      }
      a.status = b.status;
    }
    if (b.projectId !== undefined) a.projectId = Number(b.projectId);
    if (typeof b.sortOrder === 'number') a.sortOrder = b.sortOrder;
    await saveData(db);
    return sendJson(res, 200, a);
  }
  const autoDelMatch = pathname.match(/^\/api\/automations\/(\d+)\/delete$/);
  if (method === 'POST' && autoDelMatch) {
    const idx = db.automations.findIndex((x) => x.id === Number(autoDelMatch[1]));
    if (idx === -1) return sendJson(res, 404, { error: 'automation not found' });
    const [removed] = db.automations.splice(idx, 1);
    addActivity(removed.projectId, 'Automation deleted: ' + removed.name);
    await saveData(db);
    return sendJson(res, 200, { deleted: removed.id });
  }

  // --- projects
  if (method === 'POST' && pathname === '/api/projects') {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!b.name || typeof b.name !== 'string') return sendJson(res, 400, { error: 'name is required' });
    const status = PROJECT_STATUSES.includes(b.status) ? b.status : 'idle';
    const slug = (typeof b.slug === 'string' && b.slug.trim())
      ? b.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
      : b.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const p = {
      id: nextId(db.projects),
      name: b.name.trim(),
      slug,
      status,
      summary: typeof b.summary === 'string' ? b.summary : '',
      detail: typeof b.detail === 'string' ? b.detail : '',
      metricLabel: typeof b.metricLabel === 'string' ? b.metricLabel : 'STATUS',
      metricValue: typeof b.metricValue === 'string' ? b.metricValue : '',
      sourceDate: typeof b.sourceDate === 'string' ? b.sourceDate : 'Last known ' + new Date().toISOString().slice(0, 10),
      sortOrder: db.projects.length + 1,
      updatedAt: new Date().toISOString(),
      archived: false,
    };
    db.projects.push(p);
    addActivity(p.id, 'Project added: ' + p.name);
    await saveData(db);
    return sendJson(res, 201, p);
  }
  const projMatch = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (method === 'PUT' && projMatch) {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    const p = findProject(Number(projMatch[1]));
    if (!p) return sendJson(res, 404, { error: 'project not found' });
    if (typeof b.name === 'string' && b.name.trim()) p.name = b.name.trim();
    if (b.status !== undefined) {
      if (!PROJECT_STATUSES.includes(b.status)) {
        return sendJson(res, 400, { error: 'status must be one of: ' + PROJECT_STATUSES.join(', ') });
      }
      p.status = b.status;
    }
    if (typeof b.summary === 'string') p.summary = b.summary;
    if (typeof b.detail === 'string') p.detail = b.detail;
    if (typeof b.metricLabel === 'string') p.metricLabel = b.metricLabel;
    if (typeof b.metricValue === 'string') p.metricValue = b.metricValue;
    if (typeof b.sourceDate === 'string') p.sourceDate = b.sourceDate;
    if (typeof b.sortOrder === 'number') p.sortOrder = b.sortOrder;
    p.updatedAt = new Date().toISOString();
    await saveData(db);
    return sendJson(res, 200, p);
  }
  const archiveMatch = pathname.match(/^\/api\/projects\/(\d+)\/archive$/);
  if (method === 'POST' && archiveMatch) {
    const p = findProject(Number(archiveMatch[1]));
    if (!p) return sendJson(res, 404, { error: 'project not found' });
    p.archived = true;
    p.updatedAt = new Date().toISOString();
    addActivity(p.id, 'Project archived: ' + p.name);
    await saveData(db);
    return sendJson(res, 200, p);
  }
  const restoreMatch = pathname.match(/^\/api\/projects\/(\d+)\/restore$/);
  if (method === 'POST' && restoreMatch) {
    const p = findProject(Number(restoreMatch[1]));
    if (!p) return sendJson(res, 404, { error: 'project not found' });
    p.archived = false;
    p.updatedAt = new Date().toISOString();
    addActivity(p.id, 'Project restored: ' + p.name);
    await saveData(db);
    return sendJson(res, 200, p);
  }

  // --- activity
  if (method === 'POST' && pathname === '/api/activity') {
    const b = await readBody(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'invalid JSON' });
    if (!b.text || typeof b.text !== 'string') return sendJson(res, 400, { error: 'text is required' });
    if (!requireProject(b.projectId, res)) return;
    addActivity(b.projectId, b.text.trim());
    await saveData(db);
    return sendJson(res, 201, db.activity[0]);
  }

  if (method === 'GET') return serveStatic(req, res);
  return sendJson(res, 404, { error: 'not found' });
}

// The request handler is exported so Vercel can run it serverless
// (api/index.js). `node server.js` still starts the standalone server.
function handler(req, res) {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  });
}

module.exports = handler;

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, () => {
    console.log(`Automated Handling System listening on http://localhost:${PORT}`);
  });
}
