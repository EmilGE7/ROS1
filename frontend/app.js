/**
 * RescueOS V3 — Client Application Logic & Event Orchestration
 * Light-theme. Offline-first. Zero External CDN. Real-Time SSE Integration.
 */

// Application State
let state = {
  stats: {},
  sos: [],
  volunteers: [],
  shelters: [],
  announcements: [],
  audit: [],
  incidents: [],
  missing_persons: [],
  medical_cases: [],
  resources: [],
  simulation: { status: 'IDLE' }
};

let currentUser = null;
let currentTab = 'dashboard';
let currentChatChannel = 'GENERAL';
let activeFilter = 'ALL';
let showSimData = true;
let databaseTable = '';
let databaseOffset = 0;
let databaseTotalRows = 0;
let hotspotGateway = null;
let activeCriticalAlert = null;
const seenAlertIds = new Set();
const queuedCriticalAlerts = [];
const localAlertDismissals = new Set(JSON.parse(sessionStorage.getItem('rescueos_dismissed_alerts') || '[]'));
let alertAudioContext = null;
let lastAlertFocus = null;
const databaseLimit = 50;
const alertPreferences = {
  flash: localStorage.getItem('rescueos_alert_flash') !== 'false',
  sound: localStorage.getItem('rescueos_alert_sound') === 'true'
};

// DOM Helper
const $ = id => document.getElementById(id);

// Safe HTML Escaping (XSS Prevention)
function esc(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

// Format date/time
function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// Priority Badge Helper
function priorityBadge(p) {
  const pri = (p || 'MEDIUM').toUpperCase();
  const cls = pri === 'CRITICAL' ? 'badge-critical' : pri === 'HIGH' ? 'badge-high' : pri === 'LOW' ? 'badge-low' : 'badge-medium';
  return `<span class="badge ${cls}">${esc(pri)}</span>`;
}

// Status Badge Helper
function statusBadge(s) {
  const st = (s || 'NEW').toUpperCase();
  let cls = 'badge-new';
  if (st === 'ASSIGNED') cls = 'badge-assigned';
  else if (st === 'IN_PROGRESS' || st === 'RESPONDING') cls = 'badge-progress';
  else if (st === 'RESOLVED' || st === 'REUNITED') cls = 'badge-resolved';
  return `<span class="badge ${cls}">${esc(st)}</span>`;
}

// API Call Wrapper with Authentication Token Header
async function api(url, options = {}) {
  const token = localStorage.getItem('rescueos_token');
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}: Request failed`);
  return data;
}

// Tab Switching
function showTab(tabId) {
  currentTab = tabId;
  closeMobileNavigation();
  document.querySelectorAll('main section').forEach(sec => sec.classList.add('hidden'));
  const target = $(tabId);
  if (target) target.classList.remove('hidden');

  document.querySelectorAll('.nav-tab').forEach(btn => {
    const isActive = btn.dataset.tab === tabId;
    btn.classList.toggle('active', isActive);
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  if (tabId === 'chat') loadChatMessages(currentChatChannel);
  else if (tabId === 'database') loadDatabase();
  else if (tabId === 'system') fetchSystemInfo();
  else if (tabId === 'network') fetchNetworkInfo();

  render();
}

// Initialize Application
async function initApp() {
  await checkAuthStatus();
  await loadState();
  initSSE();
  fetchNetworkInfo();
  fetchSystemInfo();
  checkApiHealth();
  loadAlertPreferences();
  presentPendingCriticalAlert();
  const rescueId = new URLSearchParams(location.search).get('rescue');
  if (rescueId) { showTab('citizen'); $('inputQrSearch').value = rescueId; viewQrModal(rescueId); }
}

async function checkApiHealth() {
  const indicator = $('liveIndicator');
  if (!indicator) return;
  try {
    const health = await api('/api/health');
    indicator.className = 'status-badge online';
    indicator.innerHTML = '<span class="pulse"></span> API OPERATIONAL';
    indicator.title = `Backend health confirmed · uptime ${Math.floor(health.uptime)}s`;
  } catch (err) {
    indicator.className = 'status-badge offline';
    indicator.innerHTML = '<span class="pulse"></span> API UNAVAILABLE';
    indicator.title = err.message;
  }
}

async function fetchSystemInfo() {
  const target = $('systemInfo');
  if (!target) return;
  target.textContent = 'Reading system information…';
  const formatBytes = value => {
    if (!Number.isFinite(value)) return 'Unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  try {
    const system = await api('/api/system');
    const uptime = Math.floor(system.uptimeSeconds / 60);
    const storage = system.storage
      ? `${formatBytes(system.storage.availableBytes)} available of ${formatBytes(system.storage.totalBytes)} (${esc(system.storage.path)})`
      : 'Unavailable on this platform';
    target.innerHTML = `<dl class="system-details">
      <div><dt>Operating system</dt><dd>${esc(system.os)}</dd></div>
      <div><dt>Uptime</dt><dd>${Math.floor(uptime / 1440)}d ${Math.floor((uptime % 1440) / 60)}h ${uptime % 60}m</dd></div>
      <div><dt>Processor</dt><dd>${esc(system.cpu.model)} · ${system.cpu.cores} cores · ${system.cpu.usagePercent == null ? 'usage unavailable' : `${system.cpu.usagePercent}% sampled`}</dd></div>
      <div><dt>Memory</dt><dd>${formatBytes(system.memory.availableBytes)} available of ${formatBytes(system.memory.totalBytes)}</dd></div>
      <div><dt>Root storage</dt><dd>${storage}</dd></div>
    </dl>`;
  } catch (err) {
    target.textContent = `System information unavailable: ${err.message}`;
  }
}

// Authentication Check
async function checkAuthStatus() {
  try {
    const res = await api('/api/auth/me');
    if (res.authenticated && res.user) currentUser = res.user;
    else { currentUser = null; localStorage.removeItem('rescueos_token'); }
  } catch { currentUser = null; }
  updateAuthUI();
}

function updateAuthUI() {
  const userPill = $('userStatusPill');
  if (currentUser) {
    userPill.innerHTML = `<span style="font-size:12px;font-weight:700;color:var(--text-secondary)">${esc(currentUser.username)} (${esc(currentUser.role)})</span><button class="btn btn-dark btn-sm" onclick="logout()">Logout</button>`;
  } else {
    userPill.innerHTML = `<button class="btn btn-dark btn-sm" onclick="openLoginModal()">Staff Sign In</button>`;
  }
  if (currentTab === 'network') refreshHotspotStatus();
}

// Fetch Full System State
async function loadState() {
  try {
    state = await api('/api/state');
    render();
  } catch (err) {
    console.error('Failed to load state:', err);
  }
}

// Fetch Local Network Information
async function fetchNetworkInfo() {
  try {
    const net = await api('/api/network');
    $('stationName').textContent = 'LOCAL OPERATIONS';

    // Update LAN pill in top bar
    if (net.interfaces && net.interfaces.length > 0) {
      const primary = net.interfaces.find(i => i.ipv4 && i.ipv4.length > 0) || net.interfaces[0];
      const addr = (primary.ipv4 && primary.ipv4[0]) ? primary.ipv4[0].split('/')[0] : '—';
      $('lanPill').innerHTML = `<span class="network-mark"></span> ${esc(addr)}`;
      $('lanPill').title = `Local interface: ${primary.name} · ${addr}`;
    } else {
      $('lanPill').innerHTML = '<span class="network-mark network-mark-down"></span> NO IPv4 LINK';
      $('lanPill').title = 'No non-loopback IPv4 address currently assigned';
    }

    // Render interfaces table
    const networkList = $('networkInterfaces');
    if (networkList) {
      const rows = net.details || [];
      if (rows.length === 0) {
        networkList.innerHTML = `<div class="empty-state">
          <strong>No network interfaces detected</strong>
          <span>Check adapter availability and NetworkManager status. Loopback is omitted.</span>
        </div>`;
      } else {
        networkList.innerHTML = `<div class="table-responsive"><table class="table">
          <thead><tr>
            <th>Interface</th><th>Type</th><th>State</th><th>MAC</th>
            <th>IPv4</th><th>IPv6</th><th>DHCP</th>
          </tr></thead>
          <tbody>
          ${rows.map(i => {
            const stateClass = i.operstate === 'up' ? 'state-good' : i.operstate === 'down' ? 'state-bad' : 'state-unknown';
            const ipv4List = (i.ipv4 && i.ipv4.length) ? i.ipv4.map(a => esc(a.split('/')[0])).join('<br>') : '—';
            const ipv6List = (i.ipv6 && i.ipv6.length) ? i.ipv6.map(esc).join('<br>') : '—';
            return `<tr>
              <td class="mono">${esc(i.name)}</td>
              <td>${esc(i.type)}</td>
              <td><span class="state-chip ${stateClass}">${esc((i.operstate || 'unknown').toUpperCase())}</span></td>
              <td class="mono">${esc(i.mac || '—')}</td>
              <td class="mono">${ipv4List}</td>
              <td class="mono" style="font-size:11px">${ipv6List}</td>
              <td class="mono">${esc(i.dhcpState || '—')}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table></div>
        <p class="panel-sub network-meta">
          Default route: <span class="mono">${esc(net.defaultRoute || 'not detected')}</span> ·
          DNS: <span class="mono">${net.dns?.length ? net.dns.map(esc).join(', ') : 'not configured'}</span>
        </p>`;
      }
    }

    // Populate hotspot interface selector
    const selector = $('hotspotInterface');
    if (selector) {
      const wifi = net.wifiInterfaces || [];
      const prior = selector.value;
      selector.innerHTML = wifi.length
        ? wifi.map(i => `<option value="${esc(i.name)}">${esc(i.name)} · ${esc(i.state)}</option>`).join('')
        : '<option value="">No Wi-Fi device found</option>';
      if (wifi.some(i => i.name === prior)) selector.value = prior;
    }

    await refreshHotspotStatus();
    if (currentTab === 'network') await runNetworkDiagnostics();
  } catch (err) {
    console.warn('Network info unavailable:', err.message);
    const list = $('networkInterfaces');
    if (list) list.innerHTML = `<div class="empty-state"><strong>Network information unavailable</strong><span>${esc(err.message)}</span></div>`;
  }
}

async function refreshNetwork() { await fetchNetworkInfo(); }

async function refreshHotspotStatus() {
  const chip = $('hotspotState');
  const details = $('hotspotDetails');
  if (!chip || !details) return;
  try {
    const status = await api('/api/network/hotspot');
    chip.className = `state-chip ${status.active ? 'state-good' : status.ready ? 'state-warn' : 'state-unknown'}`;
    chip.textContent = status.active ? 'ACTIVE' : status.ready ? 'READY' : 'UNAVAILABLE';

    if (status.active) {
      const addr = status.gateway || 'address pending';
      const clients = status.clients != null ? `${status.clients} client(s)` : 'client count unavailable';
      details.textContent = `SSID: ${status.ssid || '—'} · Interface: ${status.interface || '—'} · Gateway: ${addr} · ${clients}`;
    } else {
      details.textContent = status.message || (status.ready
        ? 'Wireless adapter and NetworkManager are available. Start the hotspot when ready.'
        : 'Hotspot capability is unavailable on this system.');
    }

    hotspotGateway = status.active ? status.gateway : null;
    $('copyGateway').disabled = !hotspotGateway;

    if ($('hotspotInterface') && status.interface) $('hotspotInterface').value = status.interface;

    const isAdmin = currentUser && currentUser.role === 'ADMIN';
    $('hotspotStart').disabled = !status.ready || status.active || !isAdmin;
    $('hotspotStop').disabled = !status.active || !isAdmin;
    $('hotspotStart').title = !currentUser ? 'Administrator sign-in required' : (status.message || '');
    $('hotspotStop').title = !currentUser ? 'Administrator sign-in required' : '';
  } catch (err) {
    hotspotGateway = null;
    $('copyGateway').disabled = true;
    $('hotspotStart').disabled = true;
    $('hotspotStop').disabled = true;
    chip.className = 'state-chip state-unknown';
    chip.textContent = 'STATUS ERROR';
    details.textContent = `Could not read hotspot status: ${err.message}`;
  }
}

function toggleHotspotPassword() {
  const input = $('hotspotPassword');
  input.type = input.type === 'password' ? 'text' : 'password';
  document.querySelector('[aria-label="Show or hide password"]').textContent = input.type === 'password' ? 'Show' : 'Hide';
}

async function copyHotspotGateway() {
  if (!hotspotGateway) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(hotspotGateway);
    else {
      const field = document.createElement('textarea');
      field.value = hotspotGateway; field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.appendChild(field); field.select();
      const copied = document.execCommand('copy'); field.remove();
      if (!copied) throw new Error('Clipboard access is unavailable');
    }
    $('copyGateway').textContent = 'Gateway copied';
    setTimeout(() => { if ($('copyGateway')) $('copyGateway').textContent = 'Copy gateway address'; }, 1600);
  } catch { $('hotspotDetails').textContent = `Clipboard access failed. Gateway: ${hotspotGateway}`; }
}

async function startHotspot() {
  const ssid = $('hotspotSsid').value.trim();
  const password = $('hotspotPassword').value;
  const iface = $('hotspotInterface').value;
  if (!iface) return alert('Select an available Wi-Fi interface.');
  if (!/^[A-Za-z0-9 _.-]{1,32}$/.test(ssid)) return alert('SSID must be 1–32 letters, numbers, spaces, dots, dashes, or underscores.');
  if (!/^[A-Za-z0-9]{8,63}$/.test(password)) return alert('Use 8–63 letters or numbers for the hotspot password.');

  $('hotspotStart').disabled = true;
  $('hotspotDetails').textContent = 'Starting hotspot and checking NetworkManager readiness…';
  try {
    const result = await api('/api/network/hotspot/start', { method: 'POST', body: JSON.stringify({ interface: iface, ssid, password }) });
    $('hotspotPassword').value = '';
    $('hotspotDetails').textContent = result.message;
    await fetchNetworkInfo();
  } catch (err) {
    $('hotspotPassword').value = '';
    await refreshHotspotStatus();
    $('hotspotDetails').textContent = `Hotspot did not start: ${err.message}`;
  }
}

async function stopHotspot() {
  if (!confirm('Stop the RescueOS hotspot and disconnect its clients?')) return;
  $('hotspotStop').disabled = true;
  $('hotspotDetails').textContent = 'Stopping RescueOS hotspot…';
  try {
    const result = await api('/api/network/hotspot/stop', { method: 'POST', body: '{}' });
    $('hotspotDetails').textContent = result.message;
    await fetchNetworkInfo();
  } catch (err) {
    await refreshHotspotStatus();
    $('hotspotDetails').textContent = `Could not stop hotspot: ${err.message}`;
  }
}

async function runNetworkDiagnostics() {
  const output = $('networkDiagnostics');
  if (!output) return;
  output.textContent = 'Checking interface, route, DNS, and external connectivity…';
  try {
    const result = await api('/api/network/diagnostics');
    output.innerHTML = `<ul class="diagnostic-list">${result.checks.map(check => `
      <li>
        <span class="diagnostic-state ${check.ok === true ? 'good' : check.ok === false ? 'bad' : 'unknown'}">
          ${check.ok === true ? 'OK' : check.ok === false ? 'FAIL' : 'N/A'}
        </span>
        <strong>${esc(check.label)}</strong>
        <span class="diagnostic-detail">${esc(check.detail)}</span>
      </li>`).join('')}</ul>`;
  } catch (err) {
    output.textContent = `Diagnostics failed: ${err.message}`;
  }
}

async function loadDatabase(table = databaseTable, offset = databaseOffset) {
  const status = $('databaseStatus');
  if (!status) return;

  status.className = 'state-chip state-unknown';
  status.textContent = 'Connecting…';

  const params = new URLSearchParams();
  if (table) {
    params.set('table', table);
    params.set('limit', String(databaseLimit));
    params.set('offset', String(offset));
  }
  try {
    const data = await api(`/api/database${params.size ? `?${params}` : ''}`);
    status.className = 'state-chip state-good';
    status.textContent = `${data.engine || 'SQLite'} · read-only`;

    const tables = $('databaseTables');
    tables.innerHTML = data.tables.length
      ? data.tables.map(name => `<button class="database-table-button" type="button" data-table="${esc(name)}">${esc(name)}</button>`).join('')
      : '<p style="color:var(--text-secondary);font-size:13px">No application tables found.</p>';
    tables.querySelectorAll('[data-table]').forEach(button =>
      button.addEventListener('click', () => loadDatabase(button.dataset.table, 0)));

    if (!table) return;
    databaseTable = table; databaseOffset = offset; databaseTotalRows = data.totalRows;
    $('databaseTableTitle').textContent = table;
    $('databaseQueryTime').textContent = `Read in ${data.durationMs} ms`;
    $('databaseSchema').innerHTML = `<p class="panel-sub">${data.schema.map(column =>
      `${esc(column.name)} (${esc(column.type || 'any')}${column.primaryKey ? ', primary key' : ''}${column.required ? ', required' : ''})`
    ).join(' · ')}</p>`;

    const headers = data.schema.map(column => `<th>${esc(column.name)}</th>`).join('');
    const rows = data.rows.map(row => `<tr>${data.schema.map(column => {
      const value = row[column.name];
      return `<td>${esc(value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : value)}</td>`;
    }).join('')}</tr>`).join('');

    $('databaseRows').innerHTML = data.rows.length
      ? `<table class="table"><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`
      : '<p style="color:var(--text-secondary);font-size:13px;padding:10px 0">No rows in this page.</p>';
    $('databasePage').textContent = `${data.totalRows ? offset + 1 : 0}–${Math.min(offset + data.rows.length, data.totalRows)} of ${data.totalRows}`;
  } catch (err) {
    status.className = 'state-chip state-bad';
    status.textContent = 'Connection error';
    $('databaseTables').innerHTML = `<p style="color:var(--red);font-size:13px">Database unavailable: ${esc(err.message)}</p>`;
    if (err.message.includes('administrator')) $('databaseTables').textContent = 'Administrator sign-in is required.';
  }
}

function pageDatabase(direction) {
  const lastPage = databaseTotalRows ? Math.floor((databaseTotalRows - 1) / databaseLimit) * databaseLimit : 0;
  const next = Math.min(lastPage, Math.max(0, databaseOffset + direction * databaseLimit));
  if (next !== databaseOffset && databaseTable) loadDatabase(databaseTable, next);
}

// Real-Time SSE Connection Manager
function initSSE() {
  const indicator = $('liveIndicator');
  const es = new EventSource('/events');

  es.onopen = () => {
    indicator.className = 'status-badge online';
    indicator.innerHTML = '<span class="pulse"></span> LIVE STREAM';
  };

  es.onmessage = e => {
    try { handleRealtimeEvent(JSON.parse(e.data)); }
    catch (err) { console.warn('Malformed event:', err); }
  };

  es.onerror = () => {
    indicator.className = 'status-badge offline';
    indicator.innerHTML = '<span class="pulse"></span> STREAM OFFLINE';
    es.close();
    setTimeout(initSSE, 2000);
  };
}

// Handle Incoming Push Events
function handleRealtimeEvent(msg) {
  const { type, payload } = msg;

  if (type === 'state') state = payload;
  else if (type === 'sos_created') { state.sos.unshift(payload); flashAlert(`New SOS #${payload.id}: ${payload.name} (${payload.priority})`); }
  else if (type === 'sos_updated' || type === 'sos_assigned') {
    const idx = state.sos.findIndex(s => s.id === payload.id);
    if (idx >= 0) state.sos[idx] = payload; else state.sos.unshift(payload);
  } else if (type === 'shelter_updated') {
    const idx = state.shelters.findIndex(s => s.id === payload.id);
    if (idx >= 0) state.shelters[idx] = payload; else state.shelters.push(payload);
  } else if (type === 'announcement') {
    state.announcements.unshift(payload);
    flashAlert(`Broadcast: ${payload.title}`);
    if (payload.priority === 'CRITICAL' && !payload.is_simulation) presentCriticalAlert(payload);
  } else if (type === 'announcement_acknowledged') {
    const item = state.announcements.find(a => a.id === payload.id);
    if (item) item.acknowledged = 1;
    if (activeCriticalAlert && activeCriticalAlert.id === payload.id) closeCriticalAlert();
  } else if (type === 'incident_created' || type === 'incident_updated') {
    const idx = state.incidents.findIndex(i => i.id === payload.id);
    if (idx >= 0) state.incidents[idx] = payload; else state.incidents.unshift(payload);
  } else if (type === 'missing_updated') {
    const idx = state.missing_persons.findIndex(m => m.id === payload.id);
    if (idx >= 0) state.missing_persons[idx] = payload; else state.missing_persons.unshift(payload);
  } else if (type === 'medical_updated') {
    const idx = state.medical_cases.findIndex(m => m.id === payload.id);
    if (idx >= 0) state.medical_cases[idx] = payload; else state.medical_cases.unshift(payload);
  } else if (type === 'message_created') {
    if (currentTab === 'chat' && payload.channel === currentChatChannel) appendChatMessage(payload);
  } else if (type === 'simulation_event' || type === 'simulation_status') {
    loadState();
  } else if (type === 'audit') {
    state.audit.unshift(payload);
  }

  render();
}

// Toast Flash
function flashAlert(text) {
  const banner = $('flashBanner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.remove('hidden');
  setTimeout(() => banner.classList.add('hidden'), 5000);
}

// Master Render
function render() {
  renderStats();
  renderSimulationBanner();
  renderTopBroadcast();
  renderCommandCenter();
  renderVolunteerOps();
  renderShelters();
  renderResources();
  renderIncidents();
  renderMissingPersons();
  renderMedical();
  renderTimeline();
  renderAuditLogs();
}

// Render Stats
function renderStats() {
  const activeSos = state.sos.filter(s => !['RESOLVED', 'CANCELLED'].includes(s.status) && (showSimData || !s.is_simulation)).length;
  const criticalSos = state.sos.filter(s => s.priority === 'CRITICAL' && !['RESOLVED', 'CANCELLED'].includes(s.status) && (showSimData || !s.is_simulation)).length;
  const activeInc = state.incidents.filter(i => i.status !== 'RESOLVED' && (showSimData || !i.is_simulation)).length;
  const totalCap = state.shelters.reduce((acc, s) => acc + s.capacity, 0) || 1;
  const totalOcc = state.shelters.reduce((acc, s) => acc + s.occupancy, 0);
  const occPct = Math.round((totalOcc / totalCap) * 100);
  const missingCount = state.missing_persons.filter(m => m.status === 'MISSING').length;
  const medicalWaiting = state.medical_cases.filter(m => ['WAITING', 'TRIAGED'].includes(m.triage_status)).length;
  const lowStockCount = state.resources.filter(r => ['OUT_OF_STOCK', 'CRITICAL', 'LOW_STOCK'].includes(r.stock_status)).length;

  $('statActiveSos').textContent = activeSos;
  $('statCritical').textContent = criticalSos;
  $('statIncidents').textContent = activeInc;
  $('statVolunteers').textContent = state.volunteers.length;
  $('statShelterOcc').textContent = `${occPct}%`;
  $('statResources').textContent = lowStockCount;
  $('statMissing').textContent = missingCount;
  $('statMedical').textContent = medicalWaiting;

  $('badgeSos').textContent = activeSos;
  $('badgeVol').textContent = state.sos.filter(s => s.assigned_to).length;
  $('badgeMed').textContent = medicalWaiting;
  $('badgeInc').textContent = activeInc;
}

function renderSimulationBanner() {
  const sim = state.simulation || {};
  const isRunning = sim.status === 'RUNNING';
  const banner = $('simActiveBanner');
  if (banner) {
    if (isRunning) {
      banner.classList.remove('hidden');
      $('simStatusText').textContent = `[SIMULATION MODE ACTIVE] Scenario: ${sim.scenario || 'FLOOD'} (Step ${sim.stepIndex + 1}/${sim.totalSteps})`;
    } else {
      banner.classList.add('hidden');
    }
  }
}

function renderTopBroadcast() {
  const banner = $('topBroadcastBanner');
  const critical = state.announcements.find(a => a.priority === 'CRITICAL' && !a.is_simulation && !a.acknowledged);
  if (banner) {
    if (critical) {
      banner.classList.remove('hidden');
      $('topBroadcastMsg').innerHTML = `<strong>${esc(critical.title)}:</strong> ${esc(critical.message)}`;
    } else {
      banner.classList.add('hidden');
    }
  }
}

// Render Command Center
function renderCommandCenter() {
  const container = $('sosList');
  if (!container) return;

  let list = state.sos.filter(s => showSimData || !s.is_simulation);
  if (activeFilter === 'CRITICAL') list = list.filter(s => s.priority === 'CRITICAL');
  else if (activeFilter === 'ACTIVE') list = list.filter(s => !['RESOLVED', 'CANCELLED'].includes(s.status));
  else if (activeFilter === 'RESOLVED') list = list.filter(s => s.status === 'RESOLVED');

  if (!list.length) {
    container.innerHTML = '<p class="panel-sub" style="padding:16px 0">No emergency requests matching current filter.</p>';
    return;
  }

  container.innerHTML = list.map(s => {
    const isCrit = s.priority === 'CRITICAL';
    const simBadge = s.is_simulation ? '<span class="badge badge-simulation">SIMULATION</span>' : '';
    const assignedText = s.assigned_to
      ? `<span style="color:var(--amber)">Assigned: ${esc(s.assigned_to)}</span>`
      : '<span style="color:var(--text-muted)">Unassigned</span>';

    return `
      <div class="incident-item ${isCrit ? 'critical' : ''} ${s.status === 'NEW' ? 'new-alert' : ''}">
        <div class="incident-top">
          <div class="incident-id">
            <span style="font-weight:800">#${s.id}</span>
            <span class="mono" style="color:var(--blue)">${esc(s.rescue_id || ('RSC-' + s.id))}</span>
            ${priorityBadge(s.priority)}
            ${statusBadge(s.status)}
            ${simBadge}
          </div>
          <span style="font-size:12px;color:var(--text-muted)">${formatTime(s.created_at)}</span>
        </div>
        <div class="incident-body"><strong>${esc(s.name)}</strong>: ${esc(s.emergency || s.description)}</div>
        <div class="incident-meta">
          <span>${esc(s.location)}</span>
          <span>${s.people} affected</span>
          <span>Category: ${esc(s.emergency_type || 'GENERAL')}</span>
          <span>${assignedText}</span>
        </div>
        <div class="incident-actions">
          ${s.status === 'NEW' ? `
            <select id="selVol_${s.id}" class="form-control" style="width:auto;display:inline-block;min-height:36px;font-size:12px">
              ${state.volunteers.map(v => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.status)})</option>`).join('')}
            </select>
            <button class="btn btn-amber btn-sm" onclick="assignSos(${s.id})">Dispatch Team</button>
          ` : ''}
          ${s.status === 'ASSIGNED' ? `<button class="btn btn-green btn-sm" onclick="updateSosStatus(${s.id}, 'IN_PROGRESS')">Start Rescue</button>` : ''}
          ${s.status === 'IN_PROGRESS' ? `<button class="btn btn-green btn-sm" onclick="promptResolveSos(${s.id})">Mark Resolved</button>` : ''}
          <button class="btn btn-dark btn-sm" onclick="viewQrModal('${esc(s.rescue_id || s.id)}')">View QR Card</button>
        </div>
      </div>
    `;
  }).join('');

  // Announcements
  const annBox = $('announcementsList');
  if (annBox) {
    annBox.innerHTML = state.announcements.slice(0, 4).map(a => `
      <div style="background:var(--bg-surface-2);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <strong style="font-size:13px;color:var(--text-main)">${esc(a.title)}</strong>
          ${priorityBadge(a.priority)}
        </div>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">${esc(a.message)}</div>
        <div style="font-size:11px;color:var(--text-muted)">Issued by: ${esc(a.issuer)} · ${formatTime(a.created_at)}</div>
      </div>
    `).join('') || '<p class="panel-sub">No official announcements.</p>';
  }
}

function setSosFilter(filter) {
  activeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('btn-primary', btn.dataset.filter === filter);
    btn.classList.toggle('btn-dark', btn.dataset.filter !== filter);
  });
  renderCommandCenter();
}

function toggleSimData() {
  showSimData = !showSimData;
  $('btnToggleSim').textContent = showSimData ? 'Simulation: Visible' : 'Simulation: Hidden';
  render();
}

// Volunteer Ops
function renderVolunteerOps() {
  const container = $('volunteerTaskList');
  if (!container) return;

  const assigned = state.sos.filter(s => s.assigned_to && (showSimData || !s.is_simulation));
  if (!assigned.length) {
    container.innerHTML = '<p class="panel-sub">No volunteer tasks currently active.</p>';
    return;
  }

  container.innerHTML = assigned.map(s => `
    <div class="incident-item">
      <div class="incident-top">
        <div class="incident-id">
          <span>SOS #${s.id}</span>
          <span class="mono" style="color:var(--blue)">${esc(s.rescue_id)}</span>
          ${statusBadge(s.status)}
          ${priorityBadge(s.priority)}
        </div>
        <span style="font-size:12px;color:var(--amber);font-weight:700">Team: ${esc(s.assigned_to)}</span>
      </div>
      <p style="margin:8px 0;font-size:14px;color:var(--text-main)">${esc(s.emergency || s.description)}</p>
      <div class="incident-meta">
        <span>${esc(s.location)}</span>
        <span>${s.people} persons</span>
        ${s.notes ? `<span>Notes: ${esc(s.notes)}</span>` : ''}
      </div>
      <div class="incident-actions">
        ${s.status === 'ASSIGNED' ? `<button class="btn btn-green btn-sm" onclick="updateSosStatus(${s.id}, 'IN_PROGRESS')">Accept & En Route</button>` : ''}
        ${s.status === 'IN_PROGRESS' ? `
          <button class="btn btn-outline btn-sm" onclick="promptAddNotes(${s.id})">Add Field Notes</button>
          <button class="btn btn-green btn-sm" onclick="promptResolveSos(${s.id})">Complete Rescue</button>
        ` : ''}
        ${s.status === 'RESOLVED' ? `<span style="font-size:12px;color:var(--green);font-weight:600">Rescue Successfully Completed</span>` : ''}
      </div>
    </div>
  `).join('');
}

// Shelters
function renderShelters() {
  const container = $('sheltersGrid');
  if (!container) return;

  container.innerHTML = state.shelters.map(s => {
    const pct = Math.round((s.occupancy / s.capacity) * 100);
    const isFull = s.occupancy >= s.capacity;
    const isLowCap = pct >= 85;
    const barColor = isFull ? 'var(--red)' : isLowCap ? 'var(--amber)' : 'var(--green)';

    return `
      <div class="panel" style="margin-bottom:0">
        <div class="panel-header">
          <div>
            <h3 style="font-size:15px;font-weight:700;color:var(--text-main)">${esc(s.name)}</h3>
            <span style="font-size:12px;color:var(--text-secondary)">${esc(s.location)}</span>
          </div>
          <span class="badge ${isFull ? 'badge-critical' : isLowCap ? 'badge-high' : 'badge-resolved'}">${isFull ? 'FULL' : isLowCap ? 'LOW CAPACITY' : esc(s.status)}</span>
        </div>
        <div style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;color:var(--text-secondary)">
            <span>Occupancy (${s.occupancy} / ${s.capacity})</span>
            <strong style="color:var(--text-main)">${pct}%</strong>
          </div>
          <div style="background:var(--bg-surface-2);border-radius:4px;height:6px;overflow:hidden;border:1px solid var(--border)">
            <div style="background:${barColor};width:${Math.min(100, pct)}%;height:100%;transition:width .3s"></div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px;margin-bottom:12px;color:var(--text-secondary)">
          <div>Water: <strong style="color:var(--text-main)">${s.water || s.water_liters || 0} L</strong></div>
          <div>Food: <strong style="color:var(--text-main)">${s.food || s.food_rations || 0} units</strong></div>
          <div>Medical Kits: <strong style="color:var(--text-main)">${s.medical_kits || 0}</strong></div>
          <div>Blankets: <strong style="color:var(--text-main)">${s.blankets || 0}</strong></div>
        </div>
        <div class="incident-actions">
          <button class="btn btn-dark btn-sm" onclick="shelterCheckin(${s.id}, 1)">+1 Check-in</button>
          <button class="btn btn-dark btn-sm" onclick="shelterCheckout(${s.id}, 1)">-1 Check-out</button>
          <button class="btn btn-outline btn-sm" onclick="openShelterModal(${s.id})">Manage Stock</button>
        </div>
      </div>
    `;
  }).join('');
}

// Resources
function renderResources() {
  const container = $('resourcesTableBody');
  if (!container) return;

  container.innerHTML = state.resources.map(r => {
    let badgeCls = 'badge-resolved';
    if (r.stock_status === 'OUT_OF_STOCK' || r.stock_status === 'CRITICAL') badgeCls = 'badge-critical';
    else if (r.stock_status === 'LOW_STOCK') badgeCls = 'badge-high';

    return `
      <tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td>${esc(r.category)}</td>
        <td>${esc(r.shelter_name || 'Central Logistics Depot')}</td>
        <td><strong>${r.quantity}</strong> ${esc(r.unit)}</td>
        <td>${r.minimum_threshold} ${esc(r.unit)}</td>
        <td><span class="badge ${badgeCls}">${esc(r.stock_status)}</span></td>
        <td>
          <button class="btn btn-dark btn-sm" onclick="openResourceTxModal(${r.id}, '${esc(r.name)}')">Record Movement</button>
        </td>
      </tr>
    `;
  }).join('');
}

// Incidents
function renderIncidents() {
  const container = $('incidentsFeed');
  if (!container) return;

  container.innerHTML = state.incidents.map(i => `
    <div class="incident-item">
      <div class="incident-top">
        <div class="incident-id">
          <span style="font-weight:800">${esc(i.title)}</span>
          ${priorityBadge(i.severity)}
          ${statusBadge(i.status)}
        </div>
        <span style="font-size:12px;color:var(--text-muted)">${formatTime(i.created_at)}</span>
      </div>
      <p style="margin:6px 0;font-size:13px;color:var(--text-secondary)">${esc(i.description)}</p>
      <div class="incident-meta">
        <span>${esc(i.location)}</span>
        <span>Type: ${esc(i.incident_type)}</span>
        <span>Reporter: ${esc(i.reporter)}</span>
      </div>
      <div class="incident-actions">
        ${i.status === 'REPORTED' ? `<button class="btn btn-amber btn-sm" onclick="updateIncidentStatus(${i.id}, 'VERIFIED')">Verify Hazard</button>` : ''}
        ${i.status === 'VERIFIED' ? `<button class="btn btn-blue btn-sm" onclick="updateIncidentStatus(${i.id}, 'RESPONDING')">Dispatch Units</button>` : ''}
        ${i.status !== 'RESOLVED' ? `<button class="btn btn-green btn-sm" onclick="updateIncidentStatus(${i.id}, 'RESOLVED')">Mark Cleared</button>` : ''}
      </div>
    </div>
  `).join('');
}

// Missing Persons
function renderMissingPersons() {
  const container = $('missingPersonsGrid');
  if (!container) return;

  container.innerHTML = state.missing_persons.map(m => `
    <div class="panel" style="margin-bottom:0">
      <div class="panel-header">
        <div>
          <h3 style="font-size:15px;font-weight:700;color:var(--text-main)">${esc(m.full_name)}</h3>
          <span class="mono" style="font-size:12px;color:var(--blue)">${esc(m.tracking_code)}</span>
        </div>
        ${statusBadge(m.status)}
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
        <div><strong>Age:</strong> ${m.age || 'Unknown'} · <strong>Gender:</strong> ${esc(m.gender)}</div>
        <div><strong>Last Seen:</strong> ${esc(m.last_seen_location)} (${esc(m.last_seen_time)})</div>
        ${m.identifying_features ? `<div><strong>Features:</strong> ${esc(m.identifying_features)}</div>` : ''}
        ${m.notes ? `<div style="color:var(--text-muted);margin-top:4px">Notes: ${esc(m.notes)}</div>` : ''}
      </div>
      <div class="incident-actions">
        ${m.status === 'MISSING' ? `<button class="btn btn-green btn-sm" onclick="updateMissingStatus(${m.id}, 'FOUND')">Mark Located</button>` : ''}
        ${m.status === 'FOUND' ? `<button class="btn btn-blue btn-sm" onclick="updateMissingStatus(${m.id}, 'REUNITED')">Mark Reunited</button>` : ''}
      </div>
    </div>
  `).join('');
}

// Medical
function renderMedical() {
  const container = $('medicalCasesList');
  if (!container) return;

  container.innerHTML = state.medical_cases.map(m => {
    let triCls = 'badge-high';
    if (m.triage_priority === 'RED_IMMEDIATE') triCls = 'badge-critical';
    else if (m.triage_priority === 'GREEN_MINOR') triCls = 'badge-resolved';
    else if (m.triage_priority === 'BLACK_EXPECTANT') triCls = 'badge-low';

    return `
      <div class="incident-item">
        <div class="incident-top">
          <div class="incident-id">
            <span>Patient: <strong>${esc(m.patient_name)}</strong></span>
            <span class="badge ${triCls}">${esc(m.triage_priority)}</span>
            ${statusBadge(m.triage_status)}
          </div>
          <span style="font-size:12px;color:var(--text-muted)">${formatTime(m.created_at)}</span>
        </div>
        <div style="font-size:13px;margin:6px 0;color:var(--text-secondary)">
          <div><strong>Symptoms / Injury:</strong> ${esc(m.symptoms)}</div>
          ${m.vitals_summary ? `<div style="color:var(--info);margin-top:3px">Vitals: ${esc(m.vitals_summary)}</div>` : ''}
          ${m.resource_requests ? `<div style="color:var(--amber);margin-top:3px">Supply Requests: ${esc(m.resource_requests)}</div>` : ''}
        </div>
        <div class="incident-actions">
          <button class="btn btn-dark btn-sm" onclick="updateMedicalTriage(${m.id}, 'TREATMENT')">Initiate Treatment</button>
          <button class="btn btn-green btn-sm" onclick="updateMedicalTriage(${m.id}, 'STABILIZED')">Mark Stabilized</button>
          <button class="btn btn-outline btn-sm" onclick="updateMedicalTriage(${m.id}, 'RESOLVED')">Discharge</button>
        </div>
      </div>
    `;
  }).join('');
}

// Timeline
async function renderTimeline() {
  const container = $('timelineFeed');
  if (!container) return;
  try {
    const list = await api('/api/timeline');
    container.innerHTML = list.map(item => `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:3px">
          <strong style="color:var(--text-main)">${esc(item.title)}</strong>
          <span>${formatTime(item.time)}</span>
        </div>
        <div style="font-size:13px;color:var(--text-secondary)">${esc(item.detail)}</div>
      </div>
    `).join('') || '<p class="panel-sub">No operational milestones yet.</p>';
  } catch (err) {
    console.warn('Timeline error:', err);
  }
}

// Audit Logs
function renderAuditLogs() {
  const container = $('auditFeed');
  if (!container) return;
  container.innerHTML = state.audit.slice(0, 30).map(a => `
    <div style="border-left:2px solid var(--border);padding:6px 0 6px 10px;margin-bottom:8px">
      <div style="font-size:12px;font-weight:700;color:var(--text-main)">${esc(a.actor)}: <span style="color:var(--amber)">${esc(a.action)}</span> [${esc(a.target)}]</div>
      ${a.detail ? `<div style="font-size:11px;color:var(--text-secondary)">${esc(a.detail)}</div>` : ''}
      <div style="font-size:10px;color:var(--text-muted)">${formatTime(a.created_at)}</div>
    </div>
  `).join('') || '<span class="panel-sub">No audit events logged.</span>';
}

// =========================================================================
// ACTION HANDLERS
// =========================================================================

async function submitSOS() {
  const name = $('sosName').value.trim();
  const emergency = $('sosEmergency').value.trim();
  const people = $('sosPeople').value;
  const location = $('sosLocation').value.trim();
  const priority = $('sosPriority').value;
  const type = $('sosType').value;

  if (!name || !emergency || !location) {
    alert('Please enter your Name, Emergency description, and Location.');
    return;
  }

  try {
    const s = await api('/api/sos', {
      method: 'POST',
      body: JSON.stringify({ name, emergency, emergency_type: type, people, location, priority })
    });
    $('sosName').value = ''; $('sosEmergency').value = ''; $('sosLocation').value = '';
    viewQrModal(s.rescue_id || s.id);
  } catch (err) {
    alert('SOS submission error: ' + err.message);
  }
}

async function assignSos(id) {
  const sel = $(`selVol_${id}`);
  if (!sel || !sel.value) return;
  try {
    await api(`/api/sos/${id}/assign`, { method: 'POST', body: JSON.stringify({ volunteer: sel.value }) });
  } catch (err) { alert('Assignment error: ' + err.message); }
}

async function updateSosStatus(id, status, notes = '', resolution = '') {
  try {
    await api(`/api/sos/${id}/status`, { method: 'POST', body: JSON.stringify({ status, notes, resolution }) });
  } catch (err) { alert('Status update error: ' + err.message); }
}

function promptResolveSos(id) {
  const resolution = prompt('Enter rescue completion summary / outcome:');
  if (resolution !== null) updateSosStatus(id, 'RESOLVED', '', resolution);
}

function promptAddNotes(id) {
  const notes = prompt('Enter field rescue observations / notes:');
  if (notes !== null) updateSosStatus(id, 'IN_PROGRESS', notes);
}

// =========================================================================
// QR CODE — Build reachable URL (not localhost)
// =========================================================================

async function buildRescueQrUrl(rescueId) {
  let base = null;

  // Try to get public URL from backend config (uses hotspot gateway if active)
  try {
    const config = await api('/api/config');
    if (config.publicUrl) {
      const parsed = new URL(config.publicUrl);
      if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        base = parsed.origin;
      }
    }
  } catch { /* Config endpoint unavailable — continue to fallback */ }

  // If backend did not give us a valid non-loopback URL, try current origin
  if (!base) {
    try {
      const parsed = new URL(location.origin);
      if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
        base = location.origin;
      }
    } catch { /* Invalid origin */ }
  }

  // Final fallback: try to get the gateway IP from network status
  if (!base) {
    try {
      const hotspot = await api('/api/network/hotspot');
      if (hotspot.active && hotspot.gateway) {
        base = `http://${hotspot.gateway}:8080`;
      }
    } catch { /* Hotspot status unavailable */ }
  }

  if (!base) {
    throw new Error(
      'This device is using a loopback address. ' +
      'Connect to the RescueOS hotspot (RESCUEOS-LOCAL) first, or set RESCUEOS_PUBLIC_URL on the server.'
    );
  }

  const url = new URL('/');
  url.href = base + '/';
  url.searchParams.set('rescue', rescueId);
  return url.toString();
}

async function viewQrModal(identifier) {
  const errorEl = $('qrError');
  if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
  $('modalQrImage').src = '';
  $('modalQrOverlay').classList.remove('hidden');

  try {
    const d = await api(`/api/qr/${encodeURIComponent(identifier)}`);
    $('modalQrTitle').textContent = `Rescue ID Card: ${d.rescueId}`;

    let qrUrl;
    try {
      qrUrl = await buildRescueQrUrl(d.rescueId);
    } catch (urlErr) {
      // Show partial info but display the error prominently
      if (errorEl) {
        errorEl.style.display = 'block';
        errorEl.textContent = urlErr.message;
      }
      // Use a fallback payload that encodes just the rescue ID text so the QR is still useful
      qrUrl = `RESCUEOS:${d.rescueId}`;
    }

    if (qrUrl.length > 2000) {
      throw new Error('The local link is too long to encode safely. Configure a shorter RESCUEOS_PUBLIC_URL.');
    }

    // Generate QR — use the bundled qrcode.min.js library
    const qr = qrcode(0, 'M');
    qr.addData(qrUrl, 'Byte');
    qr.make();
    const img = $('modalQrImage');
    img.src = qr.createDataURL(6, 4);
    img.dataset.payload = qrUrl;

    $('printRescueId').textContent = d.rescueId;
    $('printRequesterName').textContent = d.record.name || 'Unknown';
    $('printStatus').textContent = d.record.status || 'NEW';
    $('printCategory').textContent = d.record.emergencyCategory || 'GENERAL';
    $('printLocation').textContent = 'Location on record';
    $('printTimestamp').textContent = new Date().toLocaleString();
  } catch (err) {
    if (errorEl) {
      errorEl.style.display = 'block';
      errorEl.textContent = `Error: ${err.message}`;
    } else {
      alert('Error resolving Rescue ID: ' + err.message);
    }
  }
}

function searchQrId() {
  const val = $('inputQrSearch').value.trim();
  if (!val) return alert('Enter a Rescue ID (e.g., RSC-A8F29C1B)');
  viewQrModal(val);
}

function downloadRescueQr() {
  const image = $('modalQrImage');
  if (!image.src || !image.src.startsWith('data:')) return alert('Generate a QR code first.');
  const link = document.createElement('a');
  link.href = image.src;
  link.download = `rescueos-${$('printRescueId').textContent}.gif`;
  document.body.appendChild(link); link.click(); link.remove();
}

function printRescueCard() { window.print(); }

function closeModal(id) { $(id).classList.add('hidden'); }

// Announcement
async function submitAnnouncement() {
  const title = $('annTitle').value.trim();
  const message = $('annMessage').value.trim();
  const priority = $('annPriority').value;
  if (!title || !message) { alert('Please enter an Announcement Title and Emergency Message'); return; }
  try {
    await api('/api/announcements', { method: 'POST', body: JSON.stringify({ title, message, priority }) });
    $('annTitle').value = ''; $('annMessage').value = '';
    alert('Emergency announcement broadcast successfully.');
  } catch (err) { alert('Broadcast error: ' + err.message); }
}

// Shelter Actions
async function shelterCheckin(id, count = 1) {
  try { await api(`/api/shelters/${id}/checkin`, { method: 'POST', body: JSON.stringify({ count }) }); }
  catch (err) { alert('Check-in error: ' + err.message); }
}

async function shelterCheckout(id, count = 1) {
  try { await api(`/api/shelters/${id}/checkout`, { method: 'POST', body: JSON.stringify({ count }) }); }
  catch (err) { alert('Check-out error: ' + err.message); }
}

function openShelterModal(id) {
  const s = state.shelters.find(x => x.id === id);
  if (!s) return;
  const newWater = prompt(`Update Water Stock for ${s.name} (Liters):`, s.water || s.water_liters);
  if (newWater !== null) {
    api(`/api/shelters/${id}`, { method: 'PATCH', body: JSON.stringify({ water: Number(newWater) }) })
      .catch(err => alert(err.message));
  }
}

function openResourceTxModal(id, name) {
  const type = prompt(`Record Transaction for "${name}":\nEnter INCOMING, OUTGOING, or TRANSFER:`, 'INCOMING');
  if (!type) return;
  const qty = prompt('Enter quantity:');
  if (!qty) return;
  const notes = prompt('Enter notes / source or destination:');
  api(`/api/resources/${id}/transaction`, {
    method: 'POST',
    body: JSON.stringify({ type: type.toUpperCase(), quantity: Number(qty), notes: notes || '', source_or_destination: 'Field Operation' })
  }).catch(err => alert('Transaction failed: ' + err.message));
}

async function updateIncidentStatus(id, status) {
  try { await api(`/api/incidents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); }
  catch (err) { alert(err.message); }
}

async function submitIncident() {
  const title = $('incTitle').value.trim();
  const type = $('incType').value;
  const severity = $('incSeverity').value;
  const location = $('incLocation').value.trim();
  const description = $('incDescription').value.trim();
  if (!title || !location || !description) return alert('Fill in all required fields');
  try {
    await api('/api/incidents', { method: 'POST', body: JSON.stringify({ title, incident_type: type, severity, location, description }) });
    $('incTitle').value = ''; $('incLocation').value = ''; $('incDescription').value = '';
    alert('Hazard incident reported.');
  } catch (err) { alert(err.message); }
}

async function updateMissingStatus(id, status) {
  const notes = prompt(`Update status to ${status}. Enter location/notes:`, '');
  try {
    await api(`/api/missing/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, notes }) });
  } catch (err) { alert(err.message); }
}

async function submitMissingPerson() {
  const full_name = $('mpName').value.trim();
  const age = $('mpAge').value;
  const gender = $('mpGender').value;
  const last_seen_location = $('mpLocation').value.trim();
  const identifying_features = $('mpFeatures').value.trim();
  const contact_info = $('mpContact').value.trim();
  if (!full_name || !last_seen_location) return alert('Name and Last Seen Location required');
  try {
    await api('/api/missing', { method: 'POST', body: JSON.stringify({ full_name, age, gender, last_seen_location, identifying_features, contact_info }) });
    $('mpName').value = ''; $('mpLocation').value = ''; $('mpFeatures').value = ''; $('mpContact').value = '';
    alert('Missing person registered into search registry.');
  } catch (err) { alert(err.message); }
}

function searchMissing(query) {
  const q = (query || '').toLowerCase().trim();
  const container = $('missingPersonsGrid');
  if (!container) return;

  const filtered = state.missing_persons.filter(m =>
    !q ||
    (m.full_name && m.full_name.toLowerCase().includes(q)) ||
    (m.last_seen_location && m.last_seen_location.toLowerCase().includes(q)) ||
    (m.identifying_features && m.identifying_features.toLowerCase().includes(q)) ||
    (m.tracking_code && m.tracking_code.toLowerCase().includes(q))
  );

  container.innerHTML = filtered.map(m => `
    <div class="panel" style="margin-bottom:0">
      <div class="panel-header">
        <div>
          <h3 style="font-size:15px;font-weight:700;color:var(--text-main)">${esc(m.full_name)}</h3>
          <span class="mono" style="font-size:12px;color:var(--blue)">${esc(m.tracking_code)}</span>
        </div>
        ${statusBadge(m.status)}
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
        <div><strong>Age:</strong> ${m.age || 'Unknown'} · <strong>Gender:</strong> ${esc(m.gender)}</div>
        <div><strong>Last Seen:</strong> ${esc(m.last_seen_location)} (${esc(m.last_seen_time)})</div>
        ${m.identifying_features ? `<div><strong>Features:</strong> ${esc(m.identifying_features)}</div>` : ''}
      </div>
      <div class="incident-actions">
        ${m.status === 'MISSING' ? `<button class="btn btn-green btn-sm" onclick="updateMissingStatus(${m.id}, 'FOUND')">Mark Located</button>` : ''}
        ${m.status === 'FOUND' ? `<button class="btn btn-blue btn-sm" onclick="updateMissingStatus(${m.id}, 'REUNITED')">Mark Reunited</button>` : ''}
      </div>
    </div>
  `).join('') || '<p class="panel-sub">No matching records found.</p>';
}

async function updateMedicalTriage(id, status) {
  try { await api(`/api/medical/${id}`, { method: 'PATCH', body: JSON.stringify({ triage_status: status }) }); }
  catch (err) { alert(err.message); }
}

async function submitMedicalIntake() {
  const patient_name = $('medPatient').value.trim();
  const triage_priority = $('medPriority').value;
  const symptoms = $('medSymptoms').value.trim();
  const vitals_summary = $('medVitals').value.trim();
  const resource_requests = $('medSupplies').value.trim();
  if (!patient_name || !symptoms) return alert('Patient name and clinical symptoms required');
  try {
    await api('/api/medical', { method: 'POST', body: JSON.stringify({ patient_name, triage_priority, symptoms, vitals_summary, resource_requests }) });
    $('medPatient').value = ''; $('medSymptoms').value = ''; $('medVitals').value = ''; $('medSupplies').value = '';
    alert('Medical triage intake recorded.');
  } catch (err) { alert(err.message); }
}

// Chat
function selectChatChannel(channel) {
  currentChatChannel = channel;
  document.querySelectorAll('.chat-channel-btn').forEach(b => b.classList.toggle('active', b.dataset.channel === channel));
  $('chatChannelHeader').textContent = `#${channel} Channel`;
  loadChatMessages(channel);
}

async function loadChatMessages(channel) {
  const box = $('chatMessagesFeed');
  if (!box) return;
  try {
    const msgs = await api(`/api/chat/${channel}`);
    box.innerHTML = msgs.map(m => {
      const isMine = currentUser && m.sender_id === currentUser.id;
      return `
        <div class="chat-msg ${isMine ? 'mine' : ''}">
          <div class="chat-msg-header">
            <strong>${esc(m.sender_name)}</strong>
            <span>(${esc(m.sender_role)})</span>
            <span>· ${formatTime(m.created_at)}</span>
          </div>
          <div class="chat-msg-text">${esc(m.message)}</div>
        </div>
      `;
    }).join('') || '<p class="panel-sub">No messages in this channel yet.</p>';
    box.scrollTop = box.scrollHeight;
  } catch (err) { console.warn('Chat load error:', err); }
}

function appendChatMessage(m) {
  const box = $('chatMessagesFeed');
  if (!box) return;
  const isMine = currentUser && m.sender_id === currentUser.id;
  const div = document.createElement('div');
  div.className = `chat-msg ${isMine ? 'mine' : ''}`;
  div.innerHTML = `
    <div class="chat-msg-header">
      <strong>${esc(m.sender_name)}</strong>
      <span>(${esc(m.sender_role)})</span>
      <span>· ${formatTime(m.created_at)}</span>
    </div>
    <div class="chat-msg-text">${esc(m.message)}</div>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendChatMessage() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api(`/api/chat/${currentChatChannel}`, { method: 'POST', body: JSON.stringify({ message: text }) });
    input.value = '';
  } catch (err) { alert('Message failed: ' + err.message); }
}

// Simulation
async function startSimulation(scenario) {
  try { await api('/api/simulation/start', { method: 'POST', body: JSON.stringify({ scenario, speedMs: 7000 }) }); loadState(); }
  catch (err) { alert(err.message); }
}

async function pauseSimulation() {
  try { await api('/api/simulation/pause', { method: 'POST' }); loadState(); }
  catch (err) { alert(err.message); }
}

async function resumeSimulation() {
  try { await api('/api/simulation/resume', { method: 'POST' }); loadState(); }
  catch (err) { alert(err.message); }
}

async function resetSimulation() {
  try { await api('/api/simulation/reset', { method: 'POST' }); loadState(); }
  catch (err) { alert(err.message); }
}

async function resetDemoData() {
  if (!confirm('Reset entire system database back to standard competition demo dataset?')) return;
  try {
    await api('/api/demo/reset', { method: 'POST' });
    await loadState();
    alert('System successfully reset to clean demo dataset.');
  } catch (err) { alert(err.message); }
}

// USB Sync
async function exportDisasterPackage() {
  try {
    const pkg = await api('/api/sync/export');
    const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `RescueOS-DisasterPackage-${pkg.stationId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
  } catch (err) { alert('Export failed: ' + err.message); }
}

async function importDisasterPackage(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const json = JSON.parse(e.target.result);
      const res = await api('/api/sync/import', { method: 'POST', body: JSON.stringify(json) });
      alert(`Package merged! Station: ${res.stationId}\nImported: ${res.imported.sos} SOS, ${res.imported.incidents} Incidents`);
      loadState();
    } catch (err) { alert('Import failed: ' + err.message); }
  };
  reader.readAsText(file);
}

// =========================================================================
// AUTHENTICATION
// =========================================================================
function openLoginModal() { $('loginModalOverlay').classList.remove('hidden'); }

async function submitLogin() {
  const u = $('loginUsername').value.trim();
  const p = $('loginPassword').value.trim();
  if (!u || !p) return alert('Enter username and password');
  try {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: u, password: p }) });
    localStorage.setItem('rescueos_token', res.token);
    currentUser = res.user;
    updateAuthUI();
    closeModal('loginModalOverlay');
    alert(`Logged in as ${currentUser.username} (${currentUser.role})`);
    loadState();
  } catch (err) { alert('Login failed: ' + err.message); }
}

async function quickRoleLogin(username) {
  $('loginUsername').value = username;
  $('loginPassword').value = 'rescueos2026';
  await submitLogin();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { console.warn(e); }
  currentUser = null;
  localStorage.removeItem('rescueos_token');
  updateAuthUI();
  alert('Logged out.');
  loadState();
}

// =========================================================================
// MOBILE NAVIGATION
// =========================================================================
function toggleMobileNavigation() {
  const nav = $('primaryNavigation'), button = $('mobileMenuButton');
  const opened = nav.classList.toggle('mobile-open');
  button.setAttribute('aria-expanded', String(opened));
}

function closeMobileNavigation() {
  const nav = $('primaryNavigation'), button = $('mobileMenuButton');
  if (nav && button) { nav.classList.remove('mobile-open'); button.setAttribute('aria-expanded', 'false'); }
}

// =========================================================================
// EMERGENCY ALERT SYSTEM
// =========================================================================
function loadAlertPreferences() {
  $('alertFlashEnabled').checked = alertPreferences.flash;
  $('alertSoundEnabled').checked = alertPreferences.sound;
  $('alertFlashEnabled').addEventListener('change', e => {
    alertPreferences.flash = e.target.checked;
    localStorage.setItem('rescueos_alert_flash', String(e.target.checked));
  });
  $('alertSoundEnabled').addEventListener('change', e => {
    alertPreferences.sound = e.target.checked;
    localStorage.setItem('rescueos_alert_sound', String(e.target.checked));
  });
}

function presentPendingCriticalAlert() {
  const pending = (state.announcements || []).find(item =>
    item.priority === 'CRITICAL' && !item.is_simulation && !item.acknowledged && !localAlertDismissals.has(String(item.id))
  );
  if (pending) presentCriticalAlert(pending);
}

function presentCriticalAlert(alertData) {
  const id = String(alertData.id);
  if (alertData.acknowledged || alertData.is_simulation || seenAlertIds.has(id)) return;
  if (activeCriticalAlert) {
    if (String(activeCriticalAlert.id) !== id && !queuedCriticalAlerts.some(item => String(item.id) === id)) {
      queuedCriticalAlerts.push(alertData);
    }
    return;
  }

  seenAlertIds.add(id);
  activeCriticalAlert = alertData;
  lastAlertFocus = document.activeElement;

  $('criticalAlertHeading').textContent = alertData.title || 'Critical emergency alert';
  $('criticalAlertMessage').textContent = alertData.message || 'No message provided.';
  $('criticalAlertLocation').textContent = alertData.location || alertData.incident_location || 'Not provided';
  $('criticalAlertTime').textContent = alertData.created_at ? new Date(alertData.created_at).toLocaleString() : 'Time unavailable';
  $('criticalAlertFeedback').textContent = '';

  const overlay = $('criticalAlertOverlay');
  overlay.classList.remove('hidden');

  // Visual pulse effect
  if (alertPreferences.flash && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    overlay.classList.add('alert-pulse');
    setTimeout(() => overlay.classList.remove('alert-pulse'), 1800);
  }

  // Sound
  if (alertPreferences.sound && alertAudioContext) playEmergencyTone();

  // Focus management
  const firstBtn = overlay.querySelector('button:not(:disabled)');
  if (firstBtn) firstBtn.focus();
}

function dismissCriticalAlert() {
  if (!activeCriticalAlert) return;
  localAlertDismissals.add(String(activeCriticalAlert.id));
  sessionStorage.setItem('rescueos_dismissed_alerts', JSON.stringify([...localAlertDismissals]));
  closeCriticalAlert();
}

function closeCriticalAlert() {
  $('criticalAlertOverlay').classList.add('hidden');
  $('criticalAlertOverlay').classList.remove('alert-pulse');
  activeCriticalAlert = null;
  if (lastAlertFocus && lastAlertFocus.focus) lastAlertFocus.focus();
  const next = queuedCriticalAlerts.shift();
  if (next) presentCriticalAlert(next); else presentPendingCriticalAlert();
}

async function acknowledgeCriticalAlert() {
  if (!activeCriticalAlert) return;
  const id = activeCriticalAlert.id;
  const button = $('criticalAlertOverlay').querySelector('.emergency-dialog-actions button');
  button.disabled = true;
  $('criticalAlertFeedback').textContent = 'Saving acknowledgement…';
  try {
    await api(`/api/announcements/${encodeURIComponent(id)}/acknowledge`, { method: 'POST', body: '{}' });
    const item = state.announcements.find(a => String(a.id) === String(id));
    if (item) item.acknowledged = 1;
    closeCriticalAlert(); render(); presentPendingCriticalAlert();
  } catch (err) {
    $('criticalAlertFeedback').textContent = `Acknowledgement could not be saved: ${err.message}. Retry when the connection is available.`;
  } finally { button.disabled = false; }
}

async function enableEmergencySound() {
  try {
    alertAudioContext = alertAudioContext || new (window.AudioContext || window.webkitAudioContext)();
    await alertAudioContext.resume();
    alertPreferences.sound = true;
    localStorage.setItem('rescueos_alert_sound', 'true');
    $('alertSoundEnabled').checked = true;
    $('enableAlertSound').textContent = 'Sound enabled';
    playEmergencyTone();
  } catch {
    $('criticalAlertFeedback').textContent = 'Audio is unavailable in this browser. Visual alerts remain enabled.';
  }
}

function testEmergencySound() { enableEmergencySound(); }

function playEmergencyTone() {
  if (!alertAudioContext || alertAudioContext.state !== 'running') return;
  const oscillator = alertAudioContext.createOscillator();
  const gain = alertAudioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, alertAudioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, alertAudioContext.currentTime + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, alertAudioContext.currentTime + 0.45);
  oscillator.connect(gain);
  gain.connect(alertAudioContext.destination);
  oscillator.start();
  oscillator.stop(alertAudioContext.currentTime + 0.46);
}

// =========================================================================
// DOM READY
// =========================================================================
window.addEventListener('DOMContentLoaded', () => {
  // Keyboard trap for emergency alert dialog
  document.addEventListener('keydown', event => {
    if (!activeCriticalAlert) return;
    if (event.key === 'Escape') { event.preventDefault(); dismissCriticalAlert(); return; }
    if (event.key === 'Tab') {
      const controls = [...$('criticalAlertOverlay').querySelectorAll('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  // Click outside mobile nav to close
  document.addEventListener('click', event => {
    const nav = $('primaryNavigation');
    const btn = $('mobileMenuButton');
    if (nav && nav.classList.contains('mobile-open') && !nav.contains(event.target) && btn && !btn.contains(event.target)) {
      closeMobileNavigation();
    }
  });

  initApp();
});
