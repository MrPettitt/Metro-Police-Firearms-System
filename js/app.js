'use strict';

// ═══════════════════════ DATA STORE ═══════════════════════
const KEYS = { inv: 'fms_inventory', asgn: 'fms_assignments', maint: 'fms_maintenance', inc: 'fms_incidents', log: 'fms_log' };
const SEEDED_KEY = 'fms_seeded';
const memStore = {}; // fallback when localStorage is blocked

function rawGet(key) {
  try { return localStorage.getItem(key); } catch { return memStore[key] ?? null; }
}
function rawSet(key, value) {
  try { localStorage.setItem(key, value); } catch { memStore[key] = value; }
}
function rawRemove(key) {
  try { localStorage.removeItem(key); } catch { delete memStore[key]; }
}

const load = k => { try { return JSON.parse(rawGet(KEYS[k]) || '[]'); } catch { return []; } };
const save = (k, d) => rawSet(KEYS[k], JSON.stringify(d));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const daysFromNow = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const orNA = v => (v === undefined || v === null || v === '') ? '<span class="muted">-</span>' : esc(v);
const $ = id => document.getElementById(id);

function nextRef(prefix, records, start) {
  const max = records.reduce((m, r) => Math.max(m, parseInt(String(r.ref || '').replace(/\D/g, ''), 10) || 0), start - 1);
  return `${prefix}-${max + 1}`;
}

// Activity log
function logActivity(text, color = 'var(--accent)') {
  const logs = load('log');
  const time = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  logs.unshift({ text, color, time });
  save('log', logs.slice(0, 30));
}

// Toasts
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ═══════════════════════ HELPERS ═══════════════════════
const activeAsgnFor = serial => load('asgn').find(a => a.serial === serial && a.status === 'Active');
const isOverdueReturn = a => a.status === 'Active' && a.returnDate && a.returnDate < today();
const isOverdueMaint = m => (m.status === 'Scheduled' || m.status === 'In Progress') && m.scheduled && m.scheduled <= today();

function sortData(mod, data) {
  const s = sortState[mod];
  if (!s) return data;
  return [...data].sort((a, b) => {
    const av = String(a[s.key] ?? '').toLowerCase();
    const bv = String(b[s.key] ?? '').toLowerCase();
    return av.localeCompare(bv, undefined, { numeric: true }) * s.dir;
  });
}
const sortState = {};
const viewData = {}; // rows currently displayed, used for CSV export

function setCount(id, shown, total) {
  $(id).textContent = shown === total ? `${total} record${total === 1 ? '' : 's'}` : `${shown} of ${total}`;
}

// ═══════════════════════ NAVIGATION ═══════════════════════
const PAGES = {
  dashboard:   { title: 'DASHBOARD',                  add: null },
  inventory:   { title: 'FIREARM INVENTORY',          add: { mod: 'inv',   label: 'Register Firearm' } },
  assignment:  { title: 'OFFICER ASSIGNMENT',         add: { mod: 'asgn',  label: 'Issue Firearm' } },
  maintenance: { title: 'MAINTENANCE & INSPECTIONS',  add: { mod: 'maint', label: 'Log Maintenance' } },
  incidents:   { title: 'INCIDENT REPORTS',           add: { mod: 'inc',   label: 'Log Incident' } }
};
let currentPage = 'dashboard';

function showPage(page) {
  if (!PAGES[page]) page = 'dashboard';
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  document.querySelectorAll('.nav-item').forEach(n => {
    const on = n.dataset.page === page;
    n.classList.toggle('active', on);
    if (on) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
  $('page-title').textContent = PAGES[page].title;
  document.title = `${PAGES[page].title.replace('&', 'and')} | Metro Police Firearms`;
  const add = PAGES[page].add;
  $('topbar-add-btn').hidden = !add;
  if (add) $('topbar-add-label').textContent = add.label;
  renderCurrent();
  updateBadges();
  $('content').scrollTop = 0;
  closeNav();
}

function renderCurrent() {
  ({ dashboard: renderDashboard, inventory: renderInventory, assignment: renderAssignment,
     maintenance: renderMaintenance, incidents: renderIncidents })[currentPage]();
}

function route() {
  const [page, action] = location.hash.replace('#', '').split('/');
  showPage(page || 'dashboard');
  if (action === 'add' && PAGES[page]?.add) {
    history.replaceState(null, '', '#' + page);
    openModal(PAGES[page].add.mod);
  }
}

function openNav() { $('shell').classList.add('nav-open'); $('menu-btn').setAttribute('aria-expanded', 'true'); }
function closeNav() { $('shell').classList.remove('nav-open'); $('menu-btn').setAttribute('aria-expanded', 'false'); }

// ═══════════════════════ MODAL HELPERS ═══════════════════════
let editId = null;
let confirmAction = null;

function openModal(module, id = null) {
  editId = id;
  const titles = { inv: 'REGISTER FIREARM', asgn: 'ISSUE FIREARM', maint: 'LOG MAINTENANCE', inc: 'LOG INCIDENT REPORT' };
  $(module + '-modal-title').textContent = id ? 'EDIT RECORD' : titles[module];
  const form = $('form-' + module);
  form.querySelectorAll('.invalid').forEach(el => el.classList.remove('invalid'));
  ({ inv: prefillInv, asgn: prefillAsgn, maint: prefillMaint, inc: prefillInc })[module](id);
  showOverlay('modal-' + module);
  form.querySelector('input:not(:disabled), select:not(:disabled)')?.focus();
}
let lastFocus = null;
function showOverlay(id) {
  lastFocus = document.activeElement;
  $(id).classList.add('show');
}
function closeModal(id) {
  $(id).classList.remove('show');
  if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus();
}
function closeAllModals() {
  document.querySelectorAll('.overlay.show').forEach(o => closeModal(o.id));
}

function askConfirm(title, text, okLabel, action) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = okLabel;
  confirmAction = action;
  showOverlay('modal-confirm');
  $('confirm-ok').focus();
}

// Validate required fields in a form. Returns true when all are filled.
function validateForm(form) {
  let ok = true;
  form.querySelectorAll('[required]').forEach(el => {
    const bad = !el.disabled && !String(el.value).trim();
    el.classList.toggle('invalid', bad);
    if (bad) ok = false;
  });
  if (!ok) {
    toast('Please fill in the highlighted fields.', 'err');
    form.querySelector('.invalid')?.focus();
  }
  return ok;
}
function flagInvalid(id, msg) {
  $(id).classList.add('invalid');
  $(id).focus();
  toast(msg, 'err');
}
const val = id => $(id).value.trim();

// ═══════════════════════ INVENTORY ═══════════════════════
function prefillInv(id) {
  const d = id ? load('inv').find(r => r.id === id) : {};
  $('inv-serial').value = d.serial || '';
  $('inv-make').value = d.make || '';
  $('inv-model').value = d.model || '';
  $('inv-type').value = d.type || '';
  $('inv-calibre').value = d.calibre || '';
  $('inv-condition').value = d.condition || 'Good';
  $('inv-location').value = d.location || '';
  $('inv-date').value = d.date || '';
  $('inv-supplier').value = d.supplier || '';
  $('inv-notes').value = d.notes || '';

  // Status is driven by assignments: "Issued" only exists while a firearm is actively assigned.
  const sel = $('inv-status'), hint = $('inv-status-hint');
  const active = id && activeAsgnFor(d.serial);
  if (active) {
    sel.innerHTML = '<option>Issued</option>';
    sel.disabled = true;
    hint.textContent = `Issued to ${active.officer}. Return the firearm on the Assignment page to change its status.`;
  } else {
    sel.innerHTML = ['Available', 'Maintenance', 'Decommissioned'].map(s => `<option>${s}</option>`).join('');
    sel.disabled = false;
    sel.value = (d.status && d.status !== 'Issued') ? d.status : 'Available';
    hint.textContent = '';
  }
}

function saveFirearm() {
  const serial = val('inv-serial');
  const inv = load('inv');
  if (inv.some(r => r.id !== editId && r.serial.toLowerCase() === serial.toLowerCase())) {
    flagInvalid('inv-serial', `Serial number ${serial} is already registered.`); return;
  }
  const old = editId ? inv.find(r => r.id === editId) : null;
  const rec = {
    id: editId || uid(),
    serial, make: val('inv-make'), model: val('inv-model'),
    type: val('inv-type'), calibre: val('inv-calibre'),
    condition: val('inv-condition'), status: $('inv-status').value,
    location: val('inv-location'), date: val('inv-date'),
    supplier: val('inv-supplier'), notes: val('inv-notes')
  };
  if (old) {
    inv[inv.indexOf(old)] = rec;
    // keep linked records pointing at the renamed serial
    if (old.serial !== serial) {
      ['asgn', 'maint', 'inc'].forEach(k => {
        const rows = load(k);
        let changed = false;
        rows.forEach(r => { if (r.serial === old.serial) { r.serial = serial; changed = true; } });
        if (changed) save(k, rows);
      });
    }
  } else {
    inv.push(rec);
  }
  save('inv', inv);
  logActivity(`Firearm ${serial} ${old ? 'updated' : 'registered'}`, 'var(--green)');
  closeModal('modal-inv'); renderCurrent(); updateBadges();
  toast(`Firearm ${serial} ${old ? 'updated' : 'registered'}.`);
}

function deleteFirearm(id) {
  const r = load('inv').find(x => x.id === id);
  if (!r) return;
  if (activeAsgnFor(r.serial)) { toast(`${r.serial} is currently issued. Return it before deleting.`, 'err'); return; }
  askConfirm('DELETE FIREARM', `Delete ${r.make} ${r.model} (${r.serial})? Its assignment, maintenance and incident history will stay on file.`, 'Delete', () => {
    save('inv', load('inv').filter(x => x.id !== id));
    logActivity(`Firearm ${r.serial} deleted`, 'var(--red)');
    renderCurrent(); updateBadges();
    toast(`Firearm ${r.serial} deleted.`);
  });
}

function renderInventory() {
  const all = load('inv');
  const allAsgn = load('asgn');
  const q = $('inv-search').value.toLowerCase().trim();
  const ft = $('inv-filter-type').value;
  const fs = $('inv-filter-status').value;
  let data = all;
  if (q) data = data.filter(r => {
    const a = allAsgn.find(x => x.serial === r.serial && x.status === 'Active');
    return [r.serial, r.make, r.model, r.calibre, r.location, a ? a.officer : '', a ? a.badge : ''].join(' ').toLowerCase().includes(q);
  });
  if (ft) data = data.filter(r => r.type === ft);
  if (fs) data = data.filter(r => r.status === fs);
  data = sortData('inv', data);
  viewData.inv = data;
  setCount('inv-count', data.length, all.length);

  const cond = { Excellent: 'badge-green', Good: 'badge-blue', Fair: 'badge-amber', Poor: 'badge-red' };
  const stat = { Available: 'badge-green', Issued: 'badge-blue', Maintenance: 'badge-amber', Decommissioned: 'badge-red' };
  const tbody = $('inv-tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">${all.length ? 'No firearms match your filters.' : 'No firearms registered. Click "Register Firearm" to begin.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => {
    const a = allAsgn.find(x => x.serial === r.serial && x.status === 'Active');
    const officerCell = a
      ? `<div class="officer-name">${esc(a.officer)}</div><div class="officer-badge">${esc(a.badge)}</div>`
      : '<span class="muted">-</span>';
    return `<tr>
      <td class="mono">${esc(r.serial)}</td>
      <td><strong>${esc(r.make)}</strong> ${esc(r.model)}</td>
      <td>${esc(r.type)}</td><td>${orNA(r.calibre)}</td>
      <td><span class="badge ${cond[r.condition] || 'badge-grey'}">${esc(r.condition)}</span></td>
      <td><span class="badge ${stat[r.status] || 'badge-grey'}">${esc(r.status)}</span></td>
      <td class="sec">${orNA(r.location)}</td>
      <td>${officerCell}</td>
      <td class="actions">
        <button class="act-btn" data-act="view" data-mod="inv" data-id="${esc(r.id)}">View</button>
        <button class="act-btn" data-act="edit" data-mod="inv" data-id="${esc(r.id)}">Edit</button>
        <button class="act-btn del" data-act="del" data-mod="inv" data-id="${esc(r.id)}">Del</button>
      </td>
    </tr>`;
  }).join('');
}

function detailField(label, valueHtml) {
  return `<div><div class="detail-label">${esc(label)}</div><div class="detail-value">${valueHtml}</div></div>`;
}

function viewFirearm(id) {
  const r = load('inv').find(x => x.id === id);
  if (!r) return;
  const stat = { Available: 'badge-green', Issued: 'badge-blue', Maintenance: 'badge-amber', Decommissioned: 'badge-red' };
  const a = activeAsgnFor(r.serial);
  const history = load('asgn').filter(x => x.serial === r.serial && x.status === 'Returned').length;
  const incidents = load('inc').filter(x => x.serial === r.serial).length;
  $('view-title').textContent = `${r.make} ${r.model} (${r.serial})`;
  $('view-content').innerHTML = `
    <div class="detail-grid">
      ${detailField('Serial', esc(r.serial))}
      ${detailField('Make', esc(r.make))}
      ${detailField('Model', esc(r.model))}
      ${detailField('Type', esc(r.type))}
      ${detailField('Calibre', orNA(r.calibre))}
      ${detailField('Condition', esc(r.condition))}
      ${detailField('Status', `<span class="badge ${stat[r.status] || 'badge-grey'}">${esc(r.status)}</span>`)}
      ${detailField('Storage Location', orNA(r.location))}
      ${detailField('Acquired', orNA(r.date))}
      ${detailField('Supplier', orNA(r.supplier))}
      ${detailField('Past Issues', history)}
      ${detailField('Incidents on File', incidents)}
    </div>
    ${a ? `<div class="detail-box">
      <div class="detail-box-title">&#9679; Currently Issued To</div>
      <div class="detail-grid">
        ${detailField('Officer', `<strong>${esc(a.officer)}</strong>`)}
        ${detailField('Badge No.', `<span class="officer-badge">${esc(a.badge)}</span>`)}
        ${detailField('Issue Date', orNA(a.issueDate))}
        ${detailField('Expected Return', orNA(a.returnDate))}
        ${a.auth ? detailField('Authorised By', esc(a.auth)) : ''}
        ${a.notes ? detailField('Purpose', esc(a.notes)) : ''}
      </div></div>` : ''}
    ${r.notes ? `<div class="detail-notes"><div class="detail-label">Notes</div><div class="detail-value">${esc(r.notes)}</div></div>` : ''}`;
  showOverlay('modal-view');
}

// ═══════════════════════ ASSIGNMENT ═══════════════════════
function populateSerialSelect(selId, { onlyAvailable = false, keep = '', blank = 'Select firearm...' } = {}) {
  const inv = load('inv').filter(r => !onlyAvailable || r.status === 'Available' || r.serial === keep);
  $(selId).innerHTML = `<option value="">${blank}</option>` +
    inv.map(r => `<option value="${esc(r.serial)}">${esc(r.serial)}: ${esc(r.make)} ${esc(r.model)}</option>`).join('');
}

function prefillAsgn(id) {
  const d = id ? load('asgn').find(r => r.id === id) : {};
  populateSerialSelect('asgn-serial', { onlyAvailable: !id, keep: d.serial });
  const hint = $('asgn-serial-hint');
  $('asgn-serial').disabled = !!id;
  if (id) hint.textContent = 'The firearm cannot be changed on an existing issue. Return it and issue a new one instead.';
  else if (!load('inv').some(r => r.status === 'Available')) hint.textContent = 'No firearms are currently available for issue.';
  else hint.textContent = 'Only available firearms are listed.';
  $('asgn-officer').value = d.officer || '';
  $('asgn-badge').value = d.badge || '';
  $('asgn-serial').value = d.serial || '';
  $('asgn-issue-date').value = d.issueDate || today();
  $('asgn-return-date').value = d.returnDate || '';
  $('asgn-auth').value = d.auth || '';
  $('asgn-notes').value = d.notes || '';
  $('asgn-submit').textContent = id ? 'Save Changes' : 'Issue Firearm';
}

function saveAssignment() {
  const issue = val('asgn-issue-date'), ret = val('asgn-return-date');
  if (ret && ret < issue) { flagInvalid('asgn-return-date', 'Expected return cannot be before the issue date.'); return; }
  const asgn = load('asgn');
  const old = editId ? asgn.find(r => r.id === editId) : null;
  const serial = old ? old.serial : val('asgn-serial');
  if (!old && activeAsgnFor(serial)) { flagInvalid('asgn-serial', `${serial} is already issued.`); return; }

  const rec = {
    ...(old || {}),
    id: editId || uid(),
    ref: old ? old.ref : nextRef('ISS', asgn, 1001),
    officer: val('asgn-officer'), badge: val('asgn-badge'), serial,
    issueDate: issue, returnDate: ret,
    auth: val('asgn-auth'), notes: val('asgn-notes'),
    status: old ? old.status : 'Active'
  };
  if (old) {
    asgn[asgn.indexOf(old)] = rec;
  } else {
    asgn.push(rec);
    const inv = load('inv');
    const f = inv.find(r => r.serial === serial);
    if (f) { f.status = 'Issued'; save('inv', inv); }
  }
  save('asgn', asgn);
  logActivity(old ? `Issue ${rec.ref} updated` : `${serial} issued to ${rec.officer}`, 'var(--blue)');
  closeModal('modal-asgn'); renderCurrent(); updateBadges();
  toast(old ? `Issue ${rec.ref} updated.` : `${serial} issued to ${rec.officer}.`);
}

// Put a firearm back to the right status once it is no longer actively issued.
function releaseFirearm(serial) {
  const inv = load('inv');
  const f = inv.find(r => r.serial === serial);
  if (f && f.status === 'Issued') {
    f.status = load('maint').some(m => m.serial === serial && m.status === 'In Progress') ? 'Maintenance' : 'Available';
    save('inv', inv);
  }
}

function returnFirearm(id) {
  const asgn = load('asgn');
  const rec = asgn.find(r => r.id === id);
  if (!rec || rec.status !== 'Active') return;
  rec.status = 'Returned';
  rec.actualReturn = today();
  save('asgn', asgn);
  releaseFirearm(rec.serial);
  logActivity(`${rec.serial} returned by ${rec.officer}`, 'var(--green)');
  renderCurrent(); updateBadges();
  toast(`${rec.serial} returned by ${rec.officer}.`);
}

function deleteAssignment(id) {
  const rec = load('asgn').find(r => r.id === id);
  if (!rec) return;
  const extra = rec.status === 'Active' ? ' The firearm will be marked as no longer issued.' : '';
  askConfirm('DELETE ASSIGNMENT', `Delete issue record ${rec.ref} for ${rec.officer}?${extra}`, 'Delete', () => {
    save('asgn', load('asgn').filter(r => r.id !== id));
    if (rec.status === 'Active') releaseFirearm(rec.serial);
    logActivity(`Issue record ${rec.ref} deleted`, 'var(--red)');
    renderCurrent(); updateBadges();
    toast(`Issue record ${rec.ref} deleted.`);
  });
}

function renderAssignment() {
  const all = load('asgn');
  const q = $('asgn-search').value.toLowerCase().trim();
  const f = $('asgn-filter').value;
  let data = all;
  if (q) data = data.filter(r => [r.officer, r.badge, r.serial, r.ref].join(' ').toLowerCase().includes(q));
  if (f) data = data.filter(r => r.status === f);
  data = sortData('asgn', data);
  viewData.asgn = data;
  setCount('asgn-count', data.length, all.length);

  const inv = load('inv');
  const tbody = $('asgn-tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">${all.length ? 'No assignments match your filters.' : 'No assignments recorded.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => {
    const fw = inv.find(x => x.serial === r.serial);
    const overdue = isOverdueReturn(r);
    const retCell = r.status === 'Returned' ? orNA(r.actualReturn || r.returnDate) : orNA(r.returnDate);
    return `<tr>
      <td class="mono">${esc(r.ref)}</td>
      <td>${esc(r.officer)}</td>
      <td class="mono">${esc(r.badge)}</td>
      <td class="mono">${esc(r.serial)}</td>
      <td class="small">${fw ? esc(`${fw.make} ${fw.model}`) : '<span class="muted">-</span>'}</td>
      <td class="small">${orNA(r.issueDate)}</td>
      <td class="small">${retCell}</td>
      <td><span class="badge ${r.status === 'Active' ? 'badge-blue' : 'badge-green'}">${esc(r.status)}</span>${overdue ? ' <span class="badge badge-red">Overdue</span>' : ''}</td>
      <td class="actions">
        ${r.status === 'Active' ? `<button class="act-btn ret" data-act="return" data-mod="asgn" data-id="${esc(r.id)}">Return</button>` : ''}
        <button class="act-btn" data-act="edit" data-mod="asgn" data-id="${esc(r.id)}">Edit</button>
        <button class="act-btn del" data-act="del" data-mod="asgn" data-id="${esc(r.id)}">Del</button>
      </td>
    </tr>`;
  }).join('');
}

// ═══════════════════════ MAINTENANCE ═══════════════════════
function prefillMaint(id) {
  const d = id ? load('maint').find(r => r.id === id) : {};
  populateSerialSelect('maint-serial');
  $('maint-serial').value = d.serial || '';
  $('maint-type').value = d.type || '';
  $('maint-tech').value = d.tech || '';
  $('maint-scheduled').value = d.scheduled || today();
  $('maint-completed').value = d.completed || '';
  $('maint-status').value = d.status || 'Scheduled';
  $('maint-cost').value = d.cost || '';
  $('maint-next').value = d.next || '';
  $('maint-notes').value = d.notes || '';
}

// Keep a firearm's status in step with its maintenance records.
function syncMaintStatus(serial) {
  const inv = load('inv');
  const f = inv.find(r => r.serial === serial);
  if (!f) return;
  const inProgress = load('maint').some(m => m.serial === serial && m.status === 'In Progress');
  if (inProgress && f.status === 'Available') f.status = 'Maintenance';
  else if (!inProgress && f.status === 'Maintenance') f.status = 'Available';
  else return;
  save('inv', inv);
}

function saveMaintenance() {
  const sched = val('maint-scheduled');
  let completed = val('maint-completed');
  const status = val('maint-status');
  if (completed && sched && completed < sched) { flagInvalid('maint-completed', 'Completed date cannot be before the scheduled date.'); return; }
  if (status === 'Completed' && !completed) completed = today();
  const maint = load('maint');
  const old = editId ? maint.find(r => r.id === editId) : null;
  const rec = {
    ...(old || {}),
    id: editId || uid(),
    ref: old ? old.ref : nextRef('MNT', maint, 1001),
    serial: val('maint-serial'), type: val('maint-type'), tech: val('maint-tech'),
    scheduled: sched, completed, status, cost: val('maint-cost'),
    next: val('maint-next'), notes: val('maint-notes')
  };
  if (old) maint[maint.indexOf(old)] = rec; else maint.push(rec);
  save('maint', maint);
  syncMaintStatus(rec.serial);
  if (old && old.serial !== rec.serial) syncMaintStatus(old.serial);
  logActivity(`Maintenance ${rec.ref} ${old ? 'updated' : 'logged'} for ${rec.serial}`, 'var(--accent)');
  closeModal('modal-maint'); renderCurrent(); updateBadges();
  toast(`Maintenance ${rec.ref} ${old ? 'updated' : 'logged'}.`);
}

function deleteMaintenance(id) {
  const rec = load('maint').find(r => r.id === id);
  if (!rec) return;
  askConfirm('DELETE MAINTENANCE', `Delete maintenance record ${rec.ref} for ${rec.serial}?`, 'Delete', () => {
    save('maint', load('maint').filter(r => r.id !== id));
    syncMaintStatus(rec.serial);
    logActivity(`Maintenance ${rec.ref} deleted`, 'var(--red)');
    renderCurrent(); updateBadges();
    toast(`Maintenance ${rec.ref} deleted.`);
  });
}

function renderMaintenance() {
  const all = load('maint');
  const q = $('maint-search').value.toLowerCase().trim();
  const f = $('maint-filter').value;
  let data = all;
  if (q) data = data.filter(r => [r.serial, r.tech, r.ref].join(' ').toLowerCase().includes(q));
  if (f) data = data.filter(r => r.type === f);
  data = sortData('maint', data);
  viewData.maint = data;
  setCount('maint-count', data.length, all.length);

  const inv = load('inv');
  const stat = { Scheduled: 'badge-grey', 'In Progress': 'badge-amber', Completed: 'badge-green', Cancelled: 'badge-red' };
  const tbody = $('maint-tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">${all.length ? 'No records match your filters.' : 'No maintenance records logged.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => {
    const fw = inv.find(x => x.serial === r.serial);
    return `<tr>
      <td class="mono">${esc(r.ref)}</td>
      <td class="mono">${esc(r.serial)}</td>
      <td class="small">${fw ? esc(`${fw.make} ${fw.model}`) : '<span class="muted">-</span>'}</td>
      <td>${esc(r.type)}</td>
      <td>${esc(r.tech)}</td>
      <td class="small">${orNA(r.scheduled)}</td>
      <td class="small">${orNA(r.completed)}</td>
      <td><span class="badge ${stat[r.status] || 'badge-grey'}">${esc(r.status)}</span>${isOverdueMaint(r) ? ' <span class="badge badge-red">Due</span>' : ''}</td>
      <td class="actions">
        <button class="act-btn" data-act="edit" data-mod="maint" data-id="${esc(r.id)}">Edit</button>
        <button class="act-btn del" data-act="del" data-mod="maint" data-id="${esc(r.id)}">Del</button>
      </td>
    </tr>`;
  }).join('');
}

// ═══════════════════════ INCIDENTS ═══════════════════════
function prefillInc(id) {
  const d = id ? load('inc').find(r => r.id === id) : {};
  populateSerialSelect('inc-serial', { blank: 'None / not applicable' });
  $('inc-case').value = d.caseNo || nextRef('INC', load('inc').map(r => ({ ref: r.caseNo })), 1001);
  $('inc-date').value = d.date || today();
  $('inc-officer').value = d.officer || '';
  $('inc-badge').value = d.badge || '';
  $('inc-serial').value = d.serial || '';
  $('inc-type').value = d.type || '';
  $('inc-location').value = d.location || '';
  $('inc-outcome').value = d.outcome || 'No Injuries';
  $('inc-status').value = d.status || 'Open';
  $('inc-rounds').value = d.rounds || '';
  $('inc-desc').value = d.desc || '';
}

function saveIncident() {
  const caseNo = val('inc-case');
  const inc = load('inc');
  if (inc.some(r => r.id !== editId && r.caseNo.toLowerCase() === caseNo.toLowerCase())) {
    flagInvalid('inc-case', `Case number ${caseNo} already exists.`); return;
  }
  if (val('inc-date') > today()) { flagInvalid('inc-date', 'Incident date cannot be in the future.'); return; }
  const old = editId ? inc.find(r => r.id === editId) : null;
  const rec = {
    id: editId || uid(), caseNo, date: val('inc-date'),
    officer: val('inc-officer'), badge: val('inc-badge'), serial: val('inc-serial'),
    type: val('inc-type'), location: val('inc-location'), outcome: val('inc-outcome'),
    status: val('inc-status'), rounds: val('inc-rounds'), desc: val('inc-desc')
  };
  if (old) inc[inc.indexOf(old)] = rec; else inc.push(rec);
  save('inc', inc);
  logActivity(`Incident ${caseNo} ${old ? 'updated' : 'reported'} by ${rec.officer}`, 'var(--red)');
  closeModal('modal-inc'); renderCurrent(); updateBadges();
  toast(`Incident ${caseNo} ${old ? 'updated' : 'submitted'}.`);
}

function deleteIncident(id) {
  const rec = load('inc').find(r => r.id === id);
  if (!rec) return;
  askConfirm('DELETE INCIDENT', `Delete incident report ${rec.caseNo}? This cannot be undone.`, 'Delete', () => {
    save('inc', load('inc').filter(r => r.id !== id));
    logActivity(`Incident ${rec.caseNo} deleted`, 'var(--red)');
    renderCurrent(); updateBadges();
    toast(`Incident ${rec.caseNo} deleted.`);
  });
}

function viewIncident(id) {
  const r = load('inc').find(x => x.id === id);
  if (!r) return;
  $('view-title').textContent = `INCIDENT ${r.caseNo}`;
  $('view-content').innerHTML = `
    <div class="detail-grid">
      ${detailField('Case No.', esc(r.caseNo))}
      ${detailField('Date', orNA(r.date))}
      ${detailField('Officer', esc(r.officer))}
      ${detailField('Badge No.', orNA(r.badge))}
      ${detailField('Firearm Serial', orNA(r.serial))}
      ${detailField('Type', esc(r.type))}
      ${detailField('Location', orNA(r.location))}
      ${detailField('Outcome', esc(r.outcome))}
      ${detailField('Investigation', esc(r.status))}
      ${detailField('Rounds Discharged', orNA(r.rounds))}
    </div>
    <div class="detail-notes"><div class="detail-label">Description</div><div class="detail-value">${orNA(r.desc)}</div></div>`;
  showOverlay('modal-view');
}

function renderIncidents() {
  const all = load('inc');
  const q = $('inc-search').value.toLowerCase().trim();
  const f = $('inc-filter').value;
  let data = all;
  if (q) data = data.filter(r => [r.caseNo, r.officer, r.location, r.serial].join(' ').toLowerCase().includes(q));
  if (f) data = data.filter(r => r.type === f);
  data = sortData('inc', data);
  viewData.inc = data;
  setCount('inc-count', data.length, all.length);

  const istat = { Open: 'badge-red', 'Under Investigation': 'badge-amber', 'Closed - No Action': 'badge-green', 'Closed - Disciplinary': 'badge-blue' };
  const out = { 'No Injuries': 'badge-green', 'Minor Injuries': 'badge-amber', 'Serious Injuries': 'badge-red', Fatality: 'badge-red', 'Property Damage': 'badge-grey' };
  const tbody = $('inc-tbody');
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">${all.length ? 'No incidents match your filters.' : 'No incident reports on file.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map(r => `
    <tr>
      <td class="mono">${esc(r.caseNo)}</td>
      <td class="small">${orNA(r.date)}</td>
      <td>${esc(r.officer)}</td>
      <td class="mono">${r.serial ? esc(r.serial) : '<span class="muted">-</span>'}</td>
      <td class="small">${esc(r.type)}</td>
      <td class="sec">${orNA(r.location)}</td>
      <td><span class="badge ${out[r.outcome] || 'badge-grey'}">${esc(r.outcome)}</span></td>
      <td><span class="badge ${istat[r.status] || 'badge-grey'}">${esc(r.status)}</span></td>
      <td class="actions">
        <button class="act-btn" data-act="view" data-mod="inc" data-id="${esc(r.id)}">View</button>
        <button class="act-btn" data-act="edit" data-mod="inc" data-id="${esc(r.id)}">Edit</button>
        <button class="act-btn del" data-act="del" data-mod="inc" data-id="${esc(r.id)}">Del</button>
      </td>
    </tr>`).join('');
}

// ═══════════════════════ DASHBOARD ═══════════════════════
function barRows(labels, counts, colors) {
  const max = Math.max(...counts, 1);
  return labels.map((l, i) => `
    <div class="bar-row">
      <div class="bar-label">${esc(l)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${counts[i] / max * 100}%;background:${colors[i]}"></div></div>
      <div class="bar-val">${counts[i]}</div>
    </div>`).join('');
}

function listRows(rows, emptyMsg) {
  return rows.length ? rows.map(([color, text, sub]) => `
    <div class="activity-item">
      <div class="activity-dot" style="background:${color}"></div>
      <div>
        <div class="activity-text">${text}</div>
        <div class="activity-time">${sub}</div>
      </div>
    </div>`).join('') : `<div class="empty-note">${emptyMsg}</div>`;
}

function renderDashboard() {
  const inv = load('inv'), asgn = load('asgn'), maint = load('maint'), inc = load('inc');
  $('ds-total').textContent = inv.length;
  $('ds-avail').textContent = inv.filter(r => r.status === 'Available').length;
  $('ds-issued').textContent = inv.filter(r => r.status === 'Issued').length;
  $('ds-incidents').textContent = inc.length;
  $('ds-open-inc').textContent = inc.filter(r => r.status === 'Open').length;

  const types = ['Pistol', 'Revolver', 'Shotgun', 'Rifle', 'Submachine Gun'];
  $('type-bars').innerHTML = barRows(types, types.map(t => inv.filter(r => r.type === t).length),
    ['var(--accent)', 'var(--blue)', 'var(--green)', '#9b59b6', '#e67e22']);

  const statuses = ['Available', 'Issued', 'Maintenance', 'Decommissioned'];
  $('status-bars').innerHTML = barRows(statuses, statuses.map(s => inv.filter(r => r.status === s).length),
    ['var(--green)', 'var(--blue)', 'var(--accent)', 'var(--red)']);

  const due = maint.filter(isOverdueMaint).sort((a, b) => a.scheduled.localeCompare(b.scheduled));
  $('maint-due-list').innerHTML = listRows(
    due.slice(0, 5).map(r => ['var(--accent)', `${esc(r.serial)}: ${esc(r.type)}`, `Due: ${esc(r.scheduled)} · Tech: ${esc(r.tech)}`]),
    'No overdue inspections');

  const late = asgn.filter(isOverdueReturn).sort((a, b) => a.returnDate.localeCompare(b.returnDate));
  $('overdue-list').innerHTML = listRows(
    late.slice(0, 5).map(r => ['var(--red)', `${esc(r.serial)}: ${esc(r.officer)} (${esc(r.badge)})`, `Expected back: ${esc(r.returnDate)}`]),
    'No overdue returns');

  $('activity-log').innerHTML = listRows(
    load('log').slice(0, 8).map(r => [esc(r.color), esc(r.text), esc(r.time)]),
    'No recent activity');
}

// ═══════════════════════ BADGES ═══════════════════════
function setBadge(id, n) {
  const el = $(id);
  el.textContent = n;
  el.classList.toggle('zero', n === 0);
}
function updateBadges() {
  setBadge('nav-inv-count', load('inv').length);
  setBadge('nav-asgn-count', load('asgn').filter(r => r.status === 'Active').length);
  setBadge('nav-maint-count', load('maint').filter(r => r.status === 'Scheduled' || r.status === 'In Progress').length);
  setBadge('nav-inc-count', load('inc').filter(r => r.status === 'Open').length);
}

// ═══════════════════════ CSV EXPORT ═══════════════════════
const CSV_COLS = {
  inv:   [['Serial', 'serial'], ['Make', 'make'], ['Model', 'model'], ['Type', 'type'], ['Calibre', 'calibre'], ['Condition', 'condition'], ['Status', 'status'], ['Location', 'location'], ['Acquired', 'date'], ['Supplier', 'supplier'], ['Notes', 'notes']],
  asgn:  [['Ref', 'ref'], ['Officer', 'officer'], ['Badge', 'badge'], ['Serial', 'serial'], ['Issue Date', 'issueDate'], ['Expected Return', 'returnDate'], ['Actual Return', 'actualReturn'], ['Status', 'status'], ['Authorised By', 'auth'], ['Notes', 'notes']],
  maint: [['Ref', 'ref'], ['Serial', 'serial'], ['Type', 'type'], ['Technician', 'tech'], ['Scheduled', 'scheduled'], ['Completed', 'completed'], ['Status', 'status'], ['Cost (R)', 'cost'], ['Next Due', 'next'], ['Notes', 'notes']],
  inc:   [['Case No', 'caseNo'], ['Date', 'date'], ['Officer', 'officer'], ['Badge', 'badge'], ['Serial', 'serial'], ['Type', 'type'], ['Location', 'location'], ['Outcome', 'outcome'], ['Status', 'status'], ['Rounds', 'rounds'], ['Description', 'desc']]
};
const CSV_NAMES = { inv: 'inventory', asgn: 'assignments', maint: 'maintenance', inc: 'incidents' };

function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv(mod) {
  const rows = viewData[mod] || [];
  if (!rows.length) { toast('Nothing to export.', 'err'); return; }
  const cols = CSV_COLS[mod];
  const csv = [cols.map(c => csvCell(c[0])).join(','), ...rows.map(r => cols.map(c => csvCell(r[c[1]])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `metro-pd-${CSV_NAMES[mod]}-${today()}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${rows.length} record${rows.length === 1 ? '' : 's'}.`);
}

// ═══════════════════════ DEMO DATA ═══════════════════════
function seedDemo() {
  const inv = [
    { id: uid(), serial: 'ZA-2024-001', make: 'Glock', model: '17 Gen5', type: 'Pistol', calibre: '9mm', condition: 'Excellent', status: 'Available', location: 'Armoury A, Rack 1', date: '2024-01-15', supplier: 'SAPS Procurement', notes: 'Issued from national stock' },
    { id: uid(), serial: 'ZA-2024-002', make: 'Beretta', model: '92FS', type: 'Pistol', calibre: '9mm', condition: 'Good', status: 'Issued', location: 'Assigned to Cst. Dlamini', date: '2024-01-20', supplier: 'SAPS Procurement', notes: '' },
    { id: uid(), serial: 'ZA-2023-018', make: 'Remington', model: '870', type: 'Shotgun', calibre: '12-gauge', condition: 'Good', status: 'Available', location: 'Armoury B, Rack 3', date: '2023-06-10', supplier: 'Defence Armaments', notes: 'Patrol vehicle shotgun' },
    { id: uid(), serial: 'ZA-2022-045', make: 'Heckler & Koch', model: 'MP5', type: 'Submachine Gun', calibre: '9mm', condition: 'Excellent', status: 'Maintenance', location: 'Workshop', date: '2022-11-01', supplier: 'HK Defence', notes: 'Tactical unit weapon' },
    { id: uid(), serial: 'ZA-2024-003', make: 'Glock', model: '19', type: 'Pistol', calibre: '9mm', condition: 'Excellent', status: 'Available', location: 'Armoury A, Rack 2', date: '2024-02-10', supplier: 'SAPS Procurement', notes: '' },
    { id: uid(), serial: 'ZA-2019-088', make: 'Smith & Wesson', model: 'Model 10', type: 'Revolver', calibre: '.38 Special', condition: 'Fair', status: 'Decommissioned', location: 'Storage Vault', date: '2019-04-05', supplier: 'Legacy Stock', notes: 'Pending disposal' },
    { id: uid(), serial: 'ZA-2021-077', make: 'Vektor', model: 'R5', type: 'Rifle', calibre: '5.56mm', condition: 'Good', status: 'Issued', location: 'Assigned to Sgt. Mokoena', date: '2021-08-23', supplier: 'Denel', notes: 'Tactical response vehicle' }
  ];
  const asgn = [
    { id: uid(), ref: 'ISS-1001', officer: 'Cst. T. Dlamini', badge: 'MP-0042', serial: 'ZA-2024-002', issueDate: daysFromNow(-30), returnDate: daysFromNow(30), auth: 'Capt. Nkosi', notes: 'Beat patrol assignment', status: 'Active' },
    { id: uid(), ref: 'ISS-1002', officer: 'Sgt. L. Mokoena', badge: 'MP-0031', serial: 'ZA-2021-077', issueDate: daysFromNow(-45), returnDate: daysFromNow(-5), auth: 'Capt. Nkosi', notes: 'Tactical response shift', status: 'Active' },
    { id: uid(), ref: 'ISS-1003', officer: 'Cst. A. Naidoo', badge: 'MP-0057', serial: 'ZA-2024-003', issueDate: daysFromNow(-90), returnDate: daysFromNow(-60), actualReturn: daysFromNow(-61), auth: 'Capt. Nkosi', notes: 'Training course', status: 'Returned' }
  ];
  const maint = [
    { id: uid(), ref: 'MNT-1001', serial: 'ZA-2022-045', type: 'Annual Service', tech: 'Armourer K. Botha', scheduled: daysFromNow(-5), completed: '', status: 'In Progress', cost: '850', next: daysFromNow(360), notes: 'Full strip and oil, spring replacement required' },
    { id: uid(), ref: 'MNT-1002', serial: 'ZA-2024-001', type: 'Routine Inspection', tech: 'Armourer K. Botha', scheduled: daysFromNow(10), completed: '', status: 'Scheduled', cost: '', next: '', notes: 'Annual scheduled inspection' },
    { id: uid(), ref: 'MNT-1003', serial: 'ZA-2023-018', type: 'Cleaning', tech: 'Armourer S. Pillay', scheduled: daysFromNow(-40), completed: daysFromNow(-40), status: 'Completed', cost: '120', next: daysFromNow(140), notes: 'Post-range cleaning' }
  ];
  const inc = [
    { id: uid(), caseNo: 'INC-1001', date: daysFromNow(-60), officer: 'Sgt. P. van Wyk', badge: 'MP-0019', serial: 'ZA-2024-002', type: 'Justified Use of Force', location: 'N1 Freeway, Johannesburg', outcome: 'No Injuries', status: 'Closed - No Action', rounds: '2', desc: 'Firearm discharged during high-speed pursuit. No injuries. Reviewed by IPID.' },
    { id: uid(), caseNo: 'INC-1002', date: daysFromNow(-3), officer: 'Cst. A. Naidoo', badge: 'MP-0057', serial: 'ZA-2024-003', type: 'Training Incident', location: 'Metro Police Shooting Range', outcome: 'Property Damage', status: 'Open', rounds: '1', desc: 'Negligent discharge into range baffle during a holster drill. No injuries. Range officer notified.' }
  ];
  save('inv', inv); save('asgn', asgn); save('maint', maint); save('inc', inc); save('log', []);
  logActivity('System initialised with demo data', 'var(--accent)');
  rawSet(SEEDED_KEY, '1');
}

// Replace dash punctuation saved by older versions so filters and badges still match.
function migrateStoredDashes() {
  Object.values(KEYS).forEach(key => {
    const raw = rawGet(key);
    const dashes = new RegExp(' ?[' + String.fromCharCode(8211, 8212) + '] ?', 'g');
    if (raw && raw.search(dashes) > -1) rawSet(key, raw.replace(dashes, ' - '));
  });
}

// ═══════════════════════ EVENTS ═══════════════════════
const formHandlers = { 'form-inv': saveFirearm, 'form-asgn': saveAssignment, 'form-maint': saveMaintenance, 'form-inc': saveIncident };

document.addEventListener('submit', e => {
  e.preventDefault();
  const handler = formHandlers[e.target.id];
  if (handler && validateForm(e.target)) handler();
});

document.addEventListener('input', e => e.target.classList?.remove('invalid'));
document.addEventListener('change', e => e.target.classList?.remove('invalid'));

document.addEventListener('click', e => {
  const t = e.target;

  // table row actions
  const act = t.closest('[data-act]');
  if (act) {
    const { act: a, mod, id } = act.dataset;
    if (a === 'view') (mod === 'inv' ? viewFirearm : viewIncident)(id);
    else if (a === 'edit') openModal(mod, id);
    else if (a === 'return') returnFirearm(id);
    else if (a === 'del') ({ inv: deleteFirearm, asgn: deleteAssignment, maint: deleteMaintenance, inc: deleteIncident })[mod](id);
    return;
  }

  // close buttons and backdrop
  if (t.closest('[data-close]')) { closeModal(t.closest('.overlay').id); return; }
  if (t.classList.contains('overlay')) { closeModal(t.id); return; }

  // sortable headers
  const th = t.closest('th.sortable');
  if (th) {
    const mod = { 'page-inventory': 'inv', 'page-assignment': 'asgn', 'page-maintenance': 'maint', 'page-incidents': 'inc' }[th.closest('.page').id];
    const key = th.dataset.sort;
    const cur = sortState[mod];
    sortState[mod] = { key, dir: cur && cur.key === key ? -cur.dir : 1 };
    th.closest('tr').querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
    th.classList.add(sortState[mod].dir === 1 ? 'sort-asc' : 'sort-desc');
    renderCurrent();
    return;
  }

  const exp = t.closest('[data-export]');
  if (exp) { exportCsv(exp.dataset.export); return; }

  // dashboard cards can pre-apply a filter
  const card = t.closest('.stat-card');
  if (card) {
    $('inv-filter-status').value = card.dataset.filterStatus || '';
    $('asgn-filter').value = card.dataset.filterAsgn || '';
  }
});

$('confirm-ok').addEventListener('click', () => {
  const fn = confirmAction;
  confirmAction = null;
  closeModal('modal-confirm');
  if (fn) fn();
});

$('topbar-add-btn').addEventListener('click', () => {
  const add = PAGES[currentPage].add;
  if (add) openModal(add.mod);
});

$('reset-demo').addEventListener('click', () => {
  askConfirm('RESET DEMO DATA', 'This replaces every record in the system with the original demo data. Your own entries will be lost.', 'Reset', () => {
    seedDemo();
    ['inv-search', 'asgn-search', 'maint-search', 'inc-search', 'inv-filter-type', 'inv-filter-status', 'asgn-filter', 'maint-filter', 'inc-filter'].forEach(id => $(id).value = '');
    renderCurrent(); updateBadges();
    toast('Demo data restored.');
  });
});

['inv-search', 'inv-filter-type', 'inv-filter-status', 'asgn-search', 'asgn-filter', 'maint-search', 'maint-filter', 'inc-search', 'inc-filter']
  .forEach(id => $(id).addEventListener('input', renderCurrent));

$('menu-btn').addEventListener('click', () => $('shell').classList.contains('nav-open') ? closeNav() : openNav());
$('scrim').addEventListener('click', closeNav);

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.overlay.show')) closeAllModals(); else closeNav();
});

window.addEventListener('hashchange', route);

// ═══════════════════════ CLOCK ═══════════════════════
function tick() {
  const now = new Date();
  $('clock').textContent = now.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('sb-date').textContent = now.toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
setInterval(tick, 1000); tick();

// ═══════════════════════ INIT ═══════════════════════
migrateStoredDashes();
if (!rawGet(SEEDED_KEY)) seedDemo();
route();
