const $ = id => document.getElementById(id);
let mode = 'mcp', hosts = [], saved = [], running = false, ready = false;
let devices = [], panelVisible = false, live = false;
function updateStageAccess() {
  const covered = panelVisible || live;
  document.querySelector('main').inert = covered;
  document.querySelector('main').setAttribute('aria-hidden', String(covered));
}
async function showPanel(visible, name = 'connection') {
  await window.mirror.panel(visible);
  panelVisible = visible;
  updateStageAccess();
  $('connectionPanel').hidden = !visible;
  $('connectionPanel').classList.toggle('activity-only', name === 'activity');
  $('panelTitle').textContent = name === 'activity' ? 'Activity' : 'Mac connection';
  if (visible) $('closePanel').focus();
}
window.mirror.onPanel(name => showPanel(true, name));
function log(message, error = false) {
  const line = document.createElement('p'); line.textContent = message;
  if (error) line.className = 'error';
  $('log').append(line); while ($('log').children.length > 60) $('log').firstChild.remove();
  $('log').scrollTop = $('log').scrollHeight;
  $('status').textContent = message.split('\n')[0].slice(0, 120);
  $('status').title = message;
  if (message.startsWith('Live video connected')) { live = true; updateStageAccess(); $('deviceState').textContent = $('deviceState').textContent.replace(/ · Live$/, '') + ' · Live'; }
  if (error) showPanel(true, 'activity');
}
window.mirror.onProgress(log);
function option(select, value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; select.append(o); }
function setBusy(value) {
  running = value;
  for (const id of ['connect','attach','import','managerTab','manualTab','hosts','saved','host','username','port','password','chooseKey','clearKey','remember']) $(id).disabled = value;
  for (const id of ['simulators','open','disconnect','stop','home','shake','screenshot']) $(id).disabled = value || !ready;
  $('connect').textContent = value ? 'Working…' : 'Connect & set up';
}
async function action(fn) {
  if (running) return;
  setBusy(true);
  try { await fn(); } catch (e) { log(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
  finally { setBusy(false); }
}
function setMode(next) {
  mode = next; $('managerPanel').hidden = next !== 'mcp'; $('manualPanel').hidden = next !== 'manual';
  $('managerTab').setAttribute('aria-selected', String(next === 'mcp'));
  $('manualTab').setAttribute('aria-selected', String(next === 'manual'));
}
$('managerTab').onclick = () => setMode('mcp'); $('manualTab').onclick = () => setMode('manual');
$('manualPanel').onsubmit = e => { e.preventDefault(); $('connect').click(); };
async function refreshSaved() {
  saved = await window.mirror.profiles(); $('saved').replaceChildren(); option($('saved'), '', 'New connection');
  saved.filter(p => p.kind === 'manual').forEach((p, i) => option($('saved'), String(i), p.name));
}
$('saved').onchange = () => {
  const profile = saved.filter(p => p.kind === 'manual')[Number($('saved').value)];
  if ($('saved').value === '' || !profile) return;
  for (const id of ['host','username','port','keyPath']) $(id).value = profile[id] || '';
  $('password').value = ''; $('remember').checked = true;
};
$('chooseKey').onclick = () => action(async () => { const file = await window.mirror.chooseKey(); if (file) $('keyPath').value = file; });
$('clearKey').onclick = () => { $('keyPath').value = ''; };
async function importHosts() {
  log('Reading Mac connections from SSH Resource Manager…');
  hosts = await window.mirror.importHosts(); $('hosts').replaceChildren();
  if (!hosts.length) option($('hosts'), '', 'No saved Macs found');
  hosts.forEach((h, i) => option($('hosts'), String(i), `${h.name} — ${h.target}`));
  const dot = document.createElement('span'); dot.textContent = hosts.length ? '●' : '○';
  $('emptyBadge').replaceChildren(dot, document.createTextNode(hosts.length ? 'Mac connection available' : 'Add your Mac connection'));
  log(`${hosts.length} Mac connection${hosts.length === 1 ? '' : 's'} imported. Choose Connect & set up.`);
}
$('import').onclick = () => action(importHosts);
$('connect').onclick = () => action(async () => {
  let profile;
  if (mode === 'mcp') {
    profile = hosts[Number($('hosts').value)]; if (!profile) throw Error('Import and select a Mac connection first.');
  } else {
    profile = { kind: 'manual' };
    for (const id of ['host','username','port','keyPath','password']) profile[id] = $(id).value;
    profile.remember = $('remember').checked;
  }
  ready = false;
  const info = await window.mirror.setup(profile);
  $('password').value = '';
  await refreshSaved();
  $('simulators').replaceChildren();
  devices = info.devices;
  devices.forEach(d => option($('simulators'), d.udid, d.name));
  const preferred = info.devices.find(d => d.state === 'Booted') || info.devices[0];
  $('simulators').value = preferred.udid; ready = true;
  updateDeviceState();
  await showPanel(false);
  await window.mirror.start(preferred.udid);
});
function updateDeviceState() {
  const d = devices.find(d => d.udid === $('simulators').value);
  $('deviceState').textContent = d ? 'iOS ' + d.runtime.split('.iOS-').pop().replaceAll('-', '.') : 'Not attached';
}
async function reconnect() { updateDeviceState(); await showPanel(false); await window.mirror.start($('simulators').value); }
$('open').onclick = () => action(reconnect);
$('simulators').onchange = () => action(reconnect);
$('attach').onclick = () => { if (ready) action(reconnect); else if (mode === 'mcp' && hosts.length) $('connect').click(); else showPanel(true); };
$('disconnect').onclick = () => action(async () => { await window.mirror.disconnect(); live = false; updateStageAccess(); updateDeviceState(); });
$('stop').onclick = () => action(async () => { await window.mirror.stop(); live = false; updateStageAccess(); updateDeviceState(); });
$('home').onclick = () => action(() => window.mirror.control('home'));
$('shake').onclick = () => action(() => window.mirror.control('shake'));
$('screenshot').onclick = () => action(() => window.mirror.screenshot());
$('settings').onclick = () => showPanel(true);
$('activity').onclick = () => showPanel(true, 'activity');
$('closePanel').onclick = () => showPanel(false);
$('maximize').onclick = () => window.mirror.windowAction('maximize');
$('closeWindow').onclick = () => window.mirror.windowAction('close');
document.querySelectorAll('[data-menu]').forEach(button => { button.onclick = () => window.mirror.menu(button.dataset.menu); });
document.querySelectorAll('[data-zoom]').forEach(button => { button.onclick = () => window.mirror.zoom(button.dataset.zoom); });
window.mirror.onAction(command => {
  if (command === 'reconnect') ready ? action(reconnect) : $('attach').click();
  else if (['home','shake','screenshot','disconnect','stop'].includes(command)) $(command).click();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && panelVisible) showPanel(false); });
refreshSaved().catch(e => log(e.message, true));
// Import metadata on launch; connecting and installing require the Connect button.
action(importHosts);
