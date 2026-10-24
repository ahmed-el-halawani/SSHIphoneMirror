const $ = id => document.getElementById(id);
let mode = 'mcp', hosts = [], saved = [], running = false, ready = false;
let devices = [], panelVisible = false, live = false, viewing = '', revision = 0, refreshTask = null;
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
  if (message.startsWith('Live video connected')) { live = true; updateStageAccess(); updateDeviceState(); setBusy(running); }
  if (error) showPanel(true, 'activity');
}
window.mirror.onProgress(log);
function option(select, value, text) { const o = document.createElement('option'); o.value = value; o.textContent = text; select.append(o); }
function deviceValue(device) { return (device.kind==='real'?'real:':'')+device.udid; }
function selectedDevice() { return devices.find(device=>deviceValue(device)===$('simulators').value); }
function choosingDevice() { return $('simulators').matches(':open') || (document.hasFocus() && document.activeElement === $('simulators')); }
function setBusy(value) {
  running = value;
  const selected = selectedDevice();
  for (const id of ['connect','attach','import','managerTab','manualTab','hosts','saved','host','username','port','password','chooseKey','clearKey','remember']) $(id).disabled = value;
  $('simulators').disabled = value || !ready || !devices.length;
  $('refresh').disabled = value || !ready;
  $('open').disabled = value || !ready || !selected;
  for (const id of ['disconnect','stop']) $(id).disabled = value || !viewing;
  for (const id of ['home','screenshot']) $(id).disabled = value || !viewing || !live;
  $('shake').disabled = value || !viewing || !live || selected?.kind === 'real';
  $('shake').title = selected?.kind === 'real' ? 'Shake is available for simulators only' : 'Shake device';
  $('shutdown').disabled = value || !canShutdown(selected);
  $('connect').textContent = value ? 'Working…' : 'Connect to Mac';
}
async function action(fn) {
  if (running) return;
  setBusy(true);
  try { if (refreshTask) await refreshTask; await fn(); } catch (e) { log(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); }
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
  log(`${hosts.length} Mac connection${hosts.length === 1 ? '' : 's'} imported. Choose Connect to Mac.`);
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
  ready = false; revision++; viewing = ''; live = false; updateStageAccess();
  const info = await window.mirror.setup(profile);
  $('password').value = '';
  await refreshSaved();
  ready = true;
  renderDevices(info.devices, '');
  await showPanel(false);
  log('Mac connected. Choose a device; nothing has been opened.');
});
function canShutdown(device) { return !!device && device.kind !== 'real' && ['Booted','Booting'].includes(device.state); }
function renderDevices(next, preserve = $('simulators').value) {
  devices = next;
  $('simulators').replaceChildren();
  option($('simulators'), '', 'Choose device…');
  for (const [label, matches] of [
    ['Real iPhones', d => d.kind === 'real'],
    ['Running simulators', d => canShutdown(d)],
    ['Stopped simulators', d => d.kind !== 'real' && !canShutdown(d)]
  ]) {
    const group = document.createElement('optgroup'); group.label = label;
    for (const d of devices.filter(matches)) {
      const duplicate = devices.filter(other => other.name === d.name && other.kind === d.kind).length > 1;
      const state = d.kind === 'real' ? 'Connected' : d.state === 'Booted' ? 'Running' : d.state === 'Booting' ? 'Starting' : 'Stopped';
      option(group, deviceValue(d), `${d.name} — ${state}${viewing === deviceValue(d) ? ' · Viewing' : ''}${duplicate ? ' [' + (d.kind === 'real' ? d.udid.slice(-4) : d.udid.slice(0, 4)) + ']' : ''}`);
    }
    if (group.children.length) $('simulators').append(group);
  }
  $('simulators').value = devices.some(d => deviceValue(d) === preserve) ? preserve : '';
  updateDeviceState();
}
function updateDeviceState() {
  const d = selectedDevice();
  const state = d?.kind === 'real' ? 'Real iPhone' : canShutdown(d) ? 'Running simulator' : 'Stopped simulator';
  $('deviceState').textContent = d ? 'iOS ' + d.runtime.split('.iOS-').pop().replaceAll('-', '.') + ' · ' + state + (live && viewing === deviceValue(d) ? ' · Viewing' : '') : ready ? 'Mac connected · Choose a device' : 'Not connected';
  $('attach').textContent = !ready ? 'Connect to Mac' : d ? 'Open selected device' : 'Choose device';
  $('emptyTitle').textContent = ready ? 'Choose your device.' : 'Your iPhone, right here.';
  $('emptyMessage').textContent = ready ? 'Pick a running device to switch to it, or a stopped simulator to start it.' : 'Connect your Mac to see and control a real iPhone or simulator.';
}
async function refreshDevices(background = false) {
  const started = revision;
  const info = await window.mirror.devices();
  if (started !== revision || (background && (running || choosingDevice()))) return;
  const current = info.devices.find(d => deviceValue(d) === viewing);
  if (viewing && (!current || (current.kind !== 'real' && !canShutdown(current)))) {
    await window.mirror.disconnect(); viewing = ''; live = false; updateStageAccess();
  }
  renderDevices(info.devices);
  setBusy(running);
  if (!background) log('Device list refreshed. Running simulators are shown first.');
}
async function reconnect() {
  const d = selectedDevice();
  if (!d) { $('simulators').focus(); return; }
  const target = deviceValue(d);
  updateDeviceState(); await showPanel(false);
  try { await window.mirror.start(target); viewing = target; }
  catch (error) {
    await window.mirror.disconnect().catch(() => {});
    viewing = ''; live = false; updateStageAccess(); updateDeviceState();
    throw error;
  }
  await refreshDevices();
}
$('open').onclick = () => action(reconnect);
$('simulators').onchange = () => { if (selectedDevice()) return action(reconnect); updateDeviceState(); setBusy(running); };
$('refresh').onclick = () => action(() => refreshDevices());
$('attach').onclick = () => {
  if (ready && selectedDevice()) return action(reconnect);
  if (ready) { $('simulators').focus(); try { $('simulators').showPicker(); } catch {} return; }
  if (mode === 'mcp' && hosts.length) return $('connect').click();
  return showPanel(true);
};
$('disconnect').onclick = () => action(async () => { await window.mirror.disconnect(); viewing = ''; live = false; updateStageAccess(); await refreshDevices(); });
$('stop').onclick = () => action(async () => { await window.mirror.stop(); viewing = ''; live = false; updateStageAccess(); await refreshDevices(); });
$('shutdown').onclick = () => action(async () => {
  const d = selectedDevice();
  if (!canShutdown(d)) throw Error('Select a running simulator to shut down.');
  const target = deviceValue(d);
  if (viewing === target) { await window.mirror.disconnect(); viewing = ''; live = false; updateStageAccess(); }
  await window.mirror.shutdown(target);
  await refreshDevices();
});
$('home').onclick = () => action(() => window.mirror.control('home'));
$('shake').onclick = () => action(() => window.mirror.control('shake'));
$('screenshot').onclick = () => action(() => window.mirror.screenshot());
$('settings').onclick = () => showPanel(true);
$('activity').onclick = () => showPanel(true, 'activity');
$('closePanel').onclick = () => showPanel(false);
$('maximize').onclick = () => window.mirror.windowAction('maximize');
$('closeWindow').onclick = () => window.mirror.windowAction('close');
document.querySelectorAll('[data-menu]').forEach(button => { button.onclick = () => window.mirror.menu(button.dataset.menu, canShutdown(selectedDevice())); });
document.querySelectorAll('[data-zoom]').forEach(button => { button.onclick = () => window.mirror.zoom(button.dataset.zoom); });
window.mirror.onAction(command => {
  if (command === 'reconnect') ready ? action(reconnect) : $('attach').click();
  else if (['home','shake','screenshot','disconnect','stop','refresh','shutdown'].includes(command)) $(command).click();
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && panelVisible) showPanel(false); });
refreshSaved().catch(e => log(e.message, true));
// Import metadata on launch; connecting and installing require the Connect button.
action(importHosts);

// Poll only device state; discovery never boots or opens a device.
setInterval(() => {
  if (!ready || running || refreshTask || panelVisible || choosingDevice()) return;
  refreshTask = refreshDevices(true).catch(() => { $('status').textContent = 'Device list could not refresh. Use Refresh to retry.'; }).finally(() => { refreshTask = null; });
}, 15000);
