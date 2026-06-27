// The dashboard SPA, embedded as one string so a packaged binary needs no asset paths. Vanilla JS:
// no framework, no client state machine, no websocket, no cache. Each page fetches its JSON endpoint
// and paints; the Dashboard polls /api/dashboard every 5s. The browser decides nothing.

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DOEH Hands</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#272b34; --txt:#e6e8ec; --dim:#9aa0aa; --grn:#3fb950; --amb:#d29922; --gry:#6e7681; --red:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--txt); }
  #app { display:flex; min-height:100vh; }
  nav { width:200px; background:var(--panel); border-right:1px solid var(--line); padding:18px 0; flex-shrink:0; }
  nav h1 { font-size:15px; margin:0 18px 18px; letter-spacing:.3px; }
  nav button { display:block; width:100%; text-align:left; padding:10px 18px; background:none; border:none; color:var(--dim); cursor:pointer; font-size:14px; }
  nav button.active, nav button:hover { color:var(--txt); background:#1f2430; }
  main { flex:1; padding:24px 28px; max-width:1000px; }
  h2 { margin:0 0 18px; font-size:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; text-transform:uppercase; letter-spacing:.4px; }
  .card .v { font-size:20px; margin-top:4px; }
  .card .s { font-size:13px; color:var(--dim); margin-top:2px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--line); font-size:13px; }
  th { color:var(--dim); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.3px; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:7px; vertical-align:middle; }
  .grn{background:var(--grn)} .amb{background:var(--amb)} .gry{background:var(--gry)} .red{background:var(--red)}
  .shield { color:var(--grn); font-weight:600; } .shield.bad { color:var(--red); }
  button.act { background:#21262d; color:var(--txt); border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; font-size:12px; margin-right:5px; }
  button.act:hover { border-color:#3d444d; }
  .hdr { display:flex; align-items:center; gap:14px; margin-bottom:20px; }
  .hdr .big { font-size:22px; font-weight:600; }
  .pill { padding:3px 11px; border-radius:20px; font-size:13px; background:#1f2430; }
  .details { color:var(--dim); font-size:12px; font-family:ui-monospace,monospace; }
  .muted { color:var(--dim); }
</style>
</head>
<body>
<div id="app">
  <nav>
    <h1>🖐 DOEH Hands</h1>
    <button data-page="dashboard" class="active">Dashboard</button>
    <button data-page="reports">Reports</button>
    <button data-page="schedule">Schedule</button>
    <button data-page="notifications">Notifications</button>
    <button data-page="health">Health</button>
  </nav>
  <main id="main">loading…</main>
</div>
<script>
const main = document.getElementById('main');
let pollTimer = null;

const api = {
  get: (p) => fetch(p).then(r => r.json()),
  post: (p, b) => fetch(p, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(b||{}) }).then(r => r.json()),
};
const esc = (s) => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const tm = (t) => t==null ? '—' : new Date(t).toISOString().replace('T',' ').slice(0,16);
const gb = (b) => b==null ? '—' : b>=2**30 ? (b/2**30).toFixed(1)+' GB' : b>=2**20 ? (b/2**20).toFixed(1)+' MB' : (b/1024).toFixed(1)+' KB';
const dotClass = (s) => (s==='connected'||s==='running'||s==='ok'||s==='healthy') ? 'grn' : (s==='absent') ? 'gry' : 'amb';
const dot = (s) => '<span class="dot '+dotClass(s)+'"></span>'+esc(s);

function setPage(name) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.page===name));
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  pages[name]();
}

const pages = {
  async dashboard() {
    const paint = async () => {
      const d = await api.get('/api/dashboard');
      const h = d.health, c = h.coordinator, lr = d.lastReport;
      const enabled = d.schedules.filter(s => s.enabled).length;
      const overall = h.ok ? 'Healthy' : 'Attention';
      main.innerHTML = '<div class="hdr"><span class="big">DOEH Hands</span>'
        + '<span class="pill">'+dot(h.ok?'healthy':'attention')+'</span>'
        + '<span class="muted">'+esc(d.version)+'</span></div>'
        + '<div class="grid">'
        + card('Last Report', lr ? esc(lr.job) : 'none', lr ? (tm(lr.at)+' · '+esc(lr.renderer)) : '', lr ? (lr.verified?'<span class="shield">✓ Verified</span>':'<span class="shield bad">✗ Unverified</span>') : '')
        + card('Notifications', d.notifications.unread+' unread', '')
        + card('Schedules', enabled+' enabled', d.schedules.length+' total')
        + card('BusinessAI', dot(h.businessai.status), '')
        + card('Scheduler', dot(h.scheduler.status), h.scheduler.lastTickAt?('last tick '+tm(h.scheduler.lastTickAt)):'')
        + card('Coordinator', c.pending+' / '+c.queueLimit, c.collapses24h+' collapses prevented (24h)')
        + card('Disk', gb(h.artifacts.diskBytes)+' / '+gb(h.retention.maxDiskBytes), h.artifacts.count+' artifacts')
        + card('Cache hit', Math.round(h.cacheHitRatio*100)+'%', '')
        + '</div>';
    };
    await paint();
    pollTimer = setInterval(paint, 5000);
  },

  async reports() {
    const runs = await api.get('/api/runs?limit=50');
    const rows = runs.filter(r => r.artifact).map(r =>
      '<tr><td>'+esc(r.jobName||r.capability)+'</td><td>'+tm(r.startedAt)+'</td><td>'+esc(r.artifact.type)+'</td>'
      + '<td id="v-'+esc(r.id)+'"><button class="act" onclick="verifyReport(\\''+esc(r.artifact.sha256)+'\\',\\''+esc(r.id)+'\\')">Verify</button></td>'
      + '<td>'+(r.durationMs!=null?r.durationMs+'ms':'—')+'</td><td>'+(r.cacheHit?'yes':'no')+'</td>'
      + '<td><a class="act" href="/api/artifact?sha='+esc(r.artifact.sha256)+'">Open</a>'
      + '<button class="act" onclick="toggleDetails(\\''+esc(r.id)+'\\')">Details</button></td></tr>'
      + '<tr id="d-'+esc(r.id)+'" style="display:none"><td colspan="7" class="details">sha '+esc(r.artifact.sha256)+' · '+r.artifact.size+' bytes</td></tr>'
    ).join('');
    main.innerHTML = '<h2>Reports</h2>' + (rows ? '<table><tr><th>Name</th><th>Date</th><th>Renderer</th><th>Verified</th><th>Duration</th><th>Cache</th><th>Actions</th></tr>'+rows+'</table>' : '<p class="muted">No reports yet.</p>');
  },

  async schedule() {
    const ss = await api.get('/api/schedules');
    const rows = ss.map(s =>
      '<tr><td>'+esc(s.name)+'</td><td>'+dot(s.enabled?'running':'absent').replace(/running|absent/, s.enabled?'enabled':'disabled')+'</td>'
      + '<td class="details">'+esc(s.cron||'manual')+'</td><td>'+tm(s.nextRunAt)+'</td>'
      + '<td>'+esc(s.lastStatus||'—')+'</td>'
      + '<td><button class="act" onclick="runSchedule(\\''+esc(s.id)+'\\')">Run Now</button>'
      + '<button class="act" onclick="toggleSchedule(\\''+esc(s.id)+'\\','+(!s.enabled)+')">'+(s.enabled?'Disable':'Enable')+'</button></td></tr>'
    ).join('');
    main.innerHTML = '<h2>Schedule</h2>' + (rows ? '<table><tr><th>Name</th><th>State</th><th>Cron</th><th>Next</th><th>Last</th><th>Actions</th></tr>'+rows+'</table>' : '<p class="muted">No schedules.</p>');
  },

  async notifications() {
    const n = await api.get('/api/notifications?limit=50');
    const rows = n.items.map(i =>
      '<tr><td>'+(i.readAt?'○':'<span class="dot grn"></span>')+'</td><td>'+esc(i.type)+'</td><td>'+esc(i.title)+'</td>'
      + '<td class="muted">'+tm(i.receivedAt)+'</td>'
      + '<td>'+(i.readAt?'':'<button class="act" onclick="markRead(\\''+esc(i.id)+'\\')">Mark Read</button>')+'</td></tr>'
    ).join('');
    main.innerHTML = '<h2>Notifications <span class="muted">('+n.unread+' unread)</span> '
      + '<button class="act" onclick="markAllRead()">Mark all read</button></h2>'
      + (rows ? '<table>'+rows+'</table>' : '<p class="muted">No notifications.</p>');
  },

  async health() {
    const h = await api.get('/api/health');
    const c = h.coordinator, rt = h.retention;
    main.innerHTML = '<h2>Health <span class="muted">'+esc(h.version)+'</span></h2><div class="grid">'
      + card('Scheduler', dot(h.scheduler.status), h.scheduler.lastTickAt?('last tick '+tm(h.scheduler.lastTickAt)+' · '+(h.scheduler.ticks||0)+' ticks'):'')
      + card('Notifications', dot(h.notifications.status), h.notifications.detail||'')
      + card('BusinessAI', dot(h.businessai.status), '')
      + card('Coordinator', c.pending+' / '+c.queueLimit, 'timeout '+Math.round(c.timeoutMs/60000)+'m · '+c.maxRows.toLocaleString()+' rows · '+c.collapses24h+' collapses/24h')
      + card('Cleanup', gb(h.artifacts.diskBytes)+' / '+gb(rt.maxDiskBytes), h.artifacts.count+'/'+rt.maxArtifacts+' artifacts · '+rt.notifications+'/'+rt.maxNotifications+' notif')
      + card('Cache hit', Math.round(h.cacheHitRatio*100)+'%', '')
      + card('DB', dot(h.db), '')
      + card('Disk free', gb(h.diskFreeBytes), '')
      + '</div>';
  },
};

function card(k, v, s, extra) {
  return '<div class="card"><div class="k">'+esc(k)+'</div><div class="v">'+(v||'')+'</div>'
    + (s ? '<div class="s">'+esc(s)+'</div>' : '') + (extra ? '<div class="s">'+extra+'</div>' : '') + '</div>';
}

window.verifyReport = async (sha, id) => {
  const r = await api.post('/api/verify', { sha });
  document.getElementById('v-'+id).innerHTML = r.ok ? '<span class="shield">✓ Verified</span>' : '<span class="shield bad">✗ '+esc((r.checks||[]).filter(c=>!c.ok).map(c=>c.name).join(', ')||'Failed')+'</span>';
};
window.toggleDetails = (id) => { const e = document.getElementById('d-'+id); e.style.display = e.style.display==='none'?'table-row':'none'; };
window.runSchedule = async (id) => { await api.post('/api/schedule/run', { id }); pages.schedule(); };
window.toggleSchedule = async (id, enable) => { await api.post('/api/schedule/'+(enable?'enable':'disable'), { id }); pages.schedule(); };
window.markRead = async (id) => { await api.post('/api/notifications/read', { id }); pages.notifications(); };
window.markAllRead = async () => { await api.post('/api/notifications/read', { all:true }); pages.notifications(); };

document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => setPage(b.dataset.page)));
setPage('dashboard');
</script>
</body>
</html>`;
