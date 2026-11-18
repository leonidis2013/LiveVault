// LiveVault UI: sign-in, library, session pages (tracks, preview player, versions, mixes, recordings), users and settings.
const $ = s => document.querySelector(s);
const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem('lv-' + k); localStorage.setItem('lv-' + k, v); } catch {} return null; };
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el[k] = v; else if (k === 'class') el.className = v; else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-livevault': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && S.user && !url.startsWith('/api/login')) { S.user = null; render(); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const fmtTime = s => { s = Math.max(0, s || 0); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(Math.floor(s % 60)).padStart(2, '0'); return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const fmtMB = b => b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + ' MB';
const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const fmtDay = d => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
const fmtWhen = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const DIFF = { '': 'Not set', beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const KIND = { channel: 'Mixer channel', reference: 'Reference mix', off: 'Not used' };
const PERM = { upload: ['Add and edit', 'Create sessions, upload tracks, save versions'], edit: ['Edit info', 'Session info, training notes, license, reference mixes, review notes'],
  delete: ['Delete', 'Delete sessions and other people\'s mixes and recordings'], download: ['Download', 'Download the audio files'], mix: ['Mix', 'Open sessions in LiveWebMixer, save mixes and recordings'],
  seeMixes: ['See all mixes', 'See everyone\'s mixes and recordings, not only their own'], licensed: ['Licensed sessions', 'See sessions marked as license-restricted'] };

let newTok = '';
const S = { st: null, user: null, sessions: [], s: null, view: null, mixes: [], recs: [], people: [], q: '', msg: '', up: '', edit: false, licOpen: false };

// =====================================================================================
// Routing
// =====================================================================================
const route = () => { const p = location.hash.replace(/^#\/?/, '').split('/'); return { page: p[0] || 'library', a: p[1], b: p[2] }; };
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => render());
const act = async (fn, rerender = true) => { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; } if (rerender) render(); };

async function render() {
  const main = $('#main');
  if (!S.user) { player.stop(); recPlayer.stop(); $('#nav').classList.add('hide'); $('#meBtn').classList.add('hide'); return fill(main, loginPage()); }
  renderNav();
  const r = route();
  if (r.page !== 's') { player.stop(); recPlayer.stop(); main.dataset.sid = ''; }
  if (r.page !== 'me') newTok = '';
  try {
    if (r.page === 's' && r.a) return await sessionPage(main, r.a, r.b ? decodeURIComponent(r.b) : null);
    if (r.page === 'users') return await usersPage(main);
    if (r.page === 'settings') return await settingsPage(main);
    if (r.page === 'me') return await mePage(main);
    return await libraryPage(main);
  } catch (e) { fill(main, h('div', { class: 'page one' }, h('div', { class: 'errbox' }, e.message), h('div', {}, h('button', { onclick: () => go('#/') }, 'Back to the library')))); }
}
function renderNav() {
  const r = route(), nav = $('#nav'); nav.classList.remove('hide');
  fill(nav, h('button', { class: r.page === 'library' || r.page === 's' ? 'on' : '', onclick: () => go('#/') }, 'Library'),
    S.user.admin && h('button', { class: r.page === 'users' ? 'on' : '', onclick: () => go('#/users') }, 'Users'),
    S.user.admin && h('button', { class: r.page === 'settings' ? 'on' : '', onclick: () => go('#/settings') }, 'Settings'),
    S.st && S.st.lwm && h('a', { href: S.st.lwm, target: '_blank', rel: 'noopener' }, h('button', { title: 'Open LiveWebMixer in a new tab' }, 'LiveWebMixer ↗')));
  const me = $('#meBtn'); me.classList.remove('hide'); me.textContent = S.user.display; me.onclick = () => go('#/me');
}
function status(busy) {
  fill($('#status'), busy ? h('span', { class: 'st warn' }, `Converting ${busy} track${busy > 1 ? 's' : ''}`) : null);
}

// =====================================================================================
// Sign in / first run
// =====================================================================================
function loginPage() {
  const setup = S.st && S.st.needsSetup;
  // A real <form> with named fields, so phone password managers and keyboards (iOS "strong password", Android autofill) behave.
  const un = h('input', { type: 'text', name: 'username', id: 'lv-user', placeholder: 'User name', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: false, required: true });
  const dn = h('input', { type: 'text', name: 'display', placeholder: 'Display name (shown to others)', autocomplete: 'name' });
  const pw = h('input', { type: 'password', name: 'password', id: 'lv-pass', placeholder: setup ? 'Password (8+ characters)' : 'Password', autocomplete: setup ? 'new-password' : 'current-password', autocapitalize: 'none', autocorrect: 'off', spellcheck: false, required: true });
  const show = h('button', { type: 'button', class: 'sm', onclick: () => { pw.type = pw.type === 'password' ? 'text' : 'password'; show.textContent = pw.type === 'password' ? 'Show' : 'Hide'; pw.focus(); } }, 'Show');
  const err = h('div', { class: 'errbox hide' }), go = h('button', { type: 'submit', class: 'on grow' }, setup ? 'Create admin account' : 'Sign in');
  const form = h('form', { class: 'login card', method: 'post', action: '#', autocomplete: 'on' }, h('h2', {}, setup ? 'Set up LiveVault' : 'Sign in'),
    setup && h('div', { class: 'note', style: 'margin-bottom:10px' }, 'Create the first account. It is an admin and can add everyone else under Users.'),
    un, setup && dn, h('div', { class: 'pwrow' }, pw, show), h('div', { class: 'row' }, go), h('div', { style: 'margin-top:8px' }, err));
  form.onsubmit = async e => {
    e.preventDefault(); go.disabled = true; err.classList.add('hide');
    try {
      const j = await api('POST', setup ? '/api/setup' : '/api/login', { username: un.value.trim(), password: pw.value, display: dn.value });
      S.user = j.user; S.st = await api('GET', '/api/state'); render();
    } catch (ex) { err.textContent = ex.message; err.classList.remove('hide'); go.disabled = false; }
  };
  return form;
}

// =====================================================================================
// Library
// =====================================================================================
const TYPE = { service: 'Service', rehearsal: 'Rehearsal', purchased: 'Purchased', training: 'Training pack', studio: 'Studio', other: 'Other' };
const GROUP = { drums: 'Drums', perc: 'Percussion', bass: 'Bass', guitars: 'Guitars', keys: 'Keys', vocals: 'Vocals', tracks: 'Click & tracks', other: 'Other' };
const GCOLOR = { drums: '#e5484d', perc: '#f76b15', bass: '#ffc53d', guitars: '#46a758', keys: '#12a594', vocals: '#4c8dff', tracks: '#8e4ec6', other: '#8b8d98' };
const F = { band: '', type: '', tag: '', diff: '' };   // library filters
const canAdd = () => S.user.admin || S.user.perms.upload;
const canMix = () => S.st && S.st.lwm && (S.user.admin || S.user.perms.mix);

// Open a session version in LiveWebMixer (a new tab, connected as you, straight into the mixer).
async function openInMixer(sid, version) {
  const w = window.open('', '_blank');
  try { const j = await api('POST', `/api/sessions/${sid}/open`, { version }); if (w) w.location = j.url; else location.href = j.url; }
  catch (e) { if (w) w.close(); S.msg = e.message; render(); }
}
function mixButton(sid, version, ready, big) {
  if (!canMix() || !version) return null;
  const prep = ready && ready.ready < ready.total;
  return h('button', { class: (big ? '' : 'sm ') + 'on', title: prep ? `Getting ${ready.total - ready.ready} of ${ready.total} tracks ready for the mixer; it opens anyway and they load as they finish` : 'Open in LiveWebMixer',
    onclick: e => { e.stopPropagation(); openInMixer(sid, version); } }, big ? (prep ? `Open in LiveWebMixer · preparing ${ready.ready}/${ready.total}` : 'Open in LiveWebMixer') : (prep ? `Mix · ${ready.ready}/${ready.total}` : 'Mix ▸'));
}

async function libraryPage(main) {
  const [j, st] = await Promise.all([api('GET', '/api/sessions'), api('GET', '/api/state')]);
  S.sessions = j.sessions; S.st = { ...S.st, ...st }; status(st.busy);
  const all = S.sessions, q = S.q.toLowerCase();
  const match = (s, skip) => (!q || (s.name + ' ' + s.artist + ' ' + s.tags.join(' ')).toLowerCase().includes(q)) && (skip === 'band' || !F.band || s.artist === F.band)
    && (skip === 'type' || !F.type || s.source === F.type) && (skip === 'tag' || !F.tag || s.tags.includes(F.tag)) && (skip === 'diff' || !F.diff || s.difficulty === F.diff);
  const list = all.filter(s => match(s));
  const sortBy = ls('sort') || 'name';
  if (sortBy === 'date') list.sort((a, b) => (b.recorded || '').localeCompare(a.recorded || '') || a.name.localeCompare(b.name));
  if (sortBy === 'band') list.sort((a, b) => (a.artist || '~').localeCompare(b.artist || '~') || a.name.localeCompare(b.name));
  // a facet: the values with how many sessions each has (counted with the other filters applied)
  const facet = (key, label, field, names) => {
    const counts = new Map();
    for (const s of all.filter(s => match(s, key))) for (const v of [].concat(s[field] || [])) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    if (F[key] && !counts.has(F[key])) counts.set(F[key], 0);
    if (!counts.size) return null;
    const vals = [...counts].sort((a, b) => key === 'band' || key === 'tag' ? a[0].localeCompare(b[0]) : 0);
    return h('div', { class: 'facet' }, h('div', { class: 'note' }, label),
      h('div', { class: 'chips filters' }, vals.map(([v, n]) => h('span', { class: 'chip' + (F[key] === v ? ' on' : ''), onclick: () => { F[key] = F[key] === v ? '' : v; render(); } }, (names ? names[v] || v : v) + ' ', h('small', {}, String(n))))));
  };
  const search = h('input', { type: 'search', placeholder: 'Search name, band, tag', value: S.q, style: 'width:100%' });
  search.oninput = () => { S.q = search.value; const pos = search.selectionStart; libraryPage(main).then(() => { const n = $('#main input[type=search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
  const anyF = S.q || F.band || F.type || F.tag || F.diff;
  const sortSel = h('select', { class: 'sm', onchange: () => { ls('sort', sortSel.value); render(); } }, [['name', 'Sort by name'], ['date', 'Newest first'], ['band', 'By band']].map(([v, l]) => h('option', { value: v, selected: sortBy === v }, l)));
  const page = h('div', { class: 'page' },
    h('div', { class: 'col' },
      h('div', { class: 'card' }, h('h2', {}, 'Find'), search,
        facet('band', 'Band / artist', 'artist'), facet('type', 'Type', 'source', TYPE), facet('tag', 'Tags', 'tags'), facet('diff', 'Difficulty', 'difficulty', DIFF),
        anyF && h('button', { class: 'sm', style: 'margin-top:10px', onclick: () => { S.q = ''; Object.keys(F).forEach(k => F[k] = ''); render(); } }, 'Clear filters'))),
    h('div', { class: 'col' }, S.msg && h('div', { class: 'errbox' }, S.msg),
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:8px' }, h('h2', { class: 'grow', style: 'margin:0' }, `Sessions · ${list.length}${list.length !== all.length ? ' of ' + all.length : ''}`), sortSel,
          canAdd() && h('button', { class: 'sm on', onclick: importChooser }, '+ Import'), canAdd() && h('button', { class: 'sm', onclick: newSessionDialog }, 'New empty session')),
        !all.length ? h('div', { class: 'note' }, canAdd() ? 'No sessions yet. Press Import, or drag a folder of multitracks anywhere onto this page.' : 'No sessions yet.') :
        !list.length ? h('div', { class: 'note' }, 'Nothing matches those filters.') :
        h('div', { style: 'overflow-x:auto' }, h('table', { class: 'tr lib' }, h('thead', {}, h('tr', {}, ['Session', 'Type', 'Date', 'Version', 'Tracks', 'Length', '', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, list.map(s => h('tr', { class: 'click', onclick: () => go('#/s/' + s.id) },
            h('td', {}, h('b', {}, s.name), h('div', { class: 'note' }, [s.artist, ...s.tags.slice(0, 3)].filter(Boolean).join(' · '))),
            h('td', {}, h('span', { class: 'chip' }, TYPE[s.source] || s.source)),
            h('td', { class: 'num' }, s.recorded ? fmtDay(s.recorded) : '–'),
            h('td', { class: 'num' }, s.version ? 'v' + s.version : '–', s.draft && h('span', { class: 'chip warn', style: 'margin-left:6px', title: 'Has unsaved changes' }, 'Draft')),
            h('td', { class: 'num' }, String(s.tracks)), h('td', { class: 'num' }, fmtTime(s.duration)),
            h('td', {}, h('div', { class: 'chips' }, s.difficulty && h('span', { class: 'chip teal' }, DIFF[s.difficulty]), s.restricted && h('span', { class: 'chip warn', title: 'License-restricted' }, 'Licensed'))),
            h('td', { style: 'text-align:right' }, mixButton(s.id, s.version, s.ready))))))))));
  // drop folders anywhere on the library to import them
  if (canAdd()) {
    page.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); page.classList.add('dropping'); } };
    page.ondragleave = e => { if (e.target === page) page.classList.remove('dropping'); };
    page.ondrop = e => { e.preventDefault(); page.classList.remove('dropping'); droppedFiles(e.dataTransfer).then(importDialog).catch(err => { S.msg = err.message; render(); }); };
  }
  fill(main, page);
}
function newSessionDialog() {
  const d = $('#dlg'), nm = h('input', { type: 'text', class: 'grow', placeholder: 'Session name' }), band = h('input', { type: 'text', placeholder: 'Band / artist' });
  const add = () => nm.value.trim() && act(async () => { const s = await api('POST', '/api/sessions', { name: nm.value.trim(), artist: band.value.trim() }); d.close(); go('#/s/' + s.id); }, false);
  nm.onkeydown = e => { if (e.key === 'Enter') add(); };
  fill(d, h('h2', {}, 'New empty session'), h('div', { class: 'row', style: 'margin-bottom:10px' }, nm, band), h('div', { class: 'row' }, h('button', { class: 'on', onclick: add }, 'Add'), h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Cancel')));
  d.showModal(); nm.focus();
}

// ---- importing: from the master folder on TrueNAS, or from this computer ----
function importChooser() {
  const d = $('#dlg');
  const files = h('input', { type: 'file', multiple: true, accept: 'audio/*,.zip,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus,.caf', class: 'hide', onchange: () => { d.close(); importDialog(pickedFiles(files)); } });
  const dir = h('input', { type: 'file', webkitdirectory: true, multiple: true, class: 'hide', onchange: () => { d.close(); importDialog(pickedFiles(dir)); } });
  const opt = (title, text, btn) => h('div', { class: 'li', style: 'align-items:flex-start;padding:10px 0' }, h('div', { class: 'grow' }, h('b', {}, title), h('div', { class: 'note' }, text)), btn);
  fill(d, h('h2', {}, 'Import'), files, dir,
    opt('From the master folder on TrueNAS', S.st.import ? 'Nothing uploads: LiveVault reads the files where they are. Best for big imports.' : 'Not set up: mount your master folder as /import in the YAML (see Settings).',
      h('button', { class: 'on', disabled: !S.st.import, onclick: () => { d.close(); serverImport(''); } }, 'Browse')),
    opt('From this computer', 'Choose a folder (a song, a band, or your whole master folder) or some files. You can also drag folders onto the library page.',
      h('div', { class: 'row' }, h('button', { onclick: () => dir.click() }, 'Choose a folder…'), h('button', { onclick: () => files.click() }, 'Files…'))),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Cancel')));
  d.showModal();
}
// Which folders are songs: a folder with audio in it, or one whose subfolders are all parts of a song (Stems, Drums, Click…).
const STEM_DIR = /^(stems?|multi ?tracks?|tracks?|audio( files)?|bounced ?files|bounces?|exports?|renders?|drums?|perc(ussion)?|bass|guitars?|gtrs?|keys|keyboards?|synths?|pads?|vocals?|vox|bgvs?|choir|strings|horns|brass|fx|sfx|click( ?track)?|guides?|cues?|loops?|misc|other|extras?|mono|stereo|wavs?|aiff?|flac|mp3s?|(44\.1|48|88\.2|96) ?k?(hz)?( wav)?|(16|24|32)[ -]?bit)$/i;
function planLocal(list, mode) {
  const root = { name: '', path: '', files: [], dirs: new Map() };
  for (const x of list) { let n = root; const parts = x.path.split('/'); parts.slice(0, -1).forEach((p, i) => { if (!n.dirs.has(p)) n.dirs.set(p, { name: p, path: parts.slice(0, i + 1).join('/'), files: [], dirs: new Map() }); n = n.dirs.get(p); }); n.files.push(x); }
  const all = n => [...n.files, ...[...n.dirs.values()].flatMap(all)], kids = n => [...n.dirs.values()];
  const isSong = n => n.files.length > 0 || (n.dirs.size > 0 && kids(n).every(d => STEM_DIR.test(d.name.trim())));
  const out = [], tidy = n => n.replace(/[_]+/g, ' ').trim();
  const add = (n, parent, items) => out.push({ name: tidy(n.name) || 'Dropped tracks', band: parent && parent !== root && parent !== top ? tidy(parent.name) : '', items: [...items].sort(byPath) });
  // a single dropped folder is the "master": its name is never a band
  const top = root.files.length === 0 && root.dirs.size === 1 ? kids(root)[0] : root;
  const walk = (n, parent) => {
    if (mode === 'folder') { if (n.files.length) add(n, parent, n.files); kids(n).forEach(d => walk(d, n)); return; }
    if (n !== root && isSong(n)) return add(n, parent, all(n));
    if (n === root && n.files.length) add({ name: '' }, null, n.files);
    kids(n).forEach(d => walk(d, n));
  };
  if (mode === 'one') add(top === root ? { name: '' } : top, null, all(root)); else walk(root, null);
  return out;
}
function importDialog(list) {
  if (!list.length) { S.msg = 'No audio files in what you dropped'; render(); return; }
  const d = $('#dlg'); let mode = 'auto', groups = planLocal(list, mode), busy = false, msg = '', stop = false;
  const type = h('select', {}, Object.entries(TYPE).map(([v, l]) => h('option', { value: v, selected: v === 'other' }, l)));
  const save = h('input', { type: 'checkbox', checked: true });
  const draw = () => {
    const size = list.reduce((n, x) => n + x.file.size, 0);
    fill(d, h('h2', {}, 'Import from this computer'),
      h('div', { class: 'note', style: 'margin-bottom:8px' }, `${list.length} audio files · ${fmtMB(size)} · ${groups.length} session${groups.length === 1 ? '' : 's'}`),
      modeSeg(mode, k => { mode = k; groups = planLocal(list, mode); draw(); }, busy),
      h('div', { style: 'max-height:44vh;overflow:auto;margin-bottom:8px' }, groups.map(g => {
        const nm = h('input', { type: 'text', class: 'grow', value: g.name, disabled: busy, oninput: () => { g.name = nm.value; } });
        const bd = h('input', { type: 'text', placeholder: 'Band / artist', value: g.band, disabled: busy, style: 'width:30%', oninput: () => { g.band = bd.value; } });
        const oldest = g.items.reduce((m, x) => Math.min(m, x.file.lastModified || Infinity), Infinity);
        return h('div', { class: 'li' }, nm, bd, h('span', { class: 'note', style: 'white-space:nowrap', title: g.items.slice(0, 8).map(x => x.path).join('\n') }, `${g.items.length} track${g.items.length === 1 ? '' : 's'}${oldest < Infinity ? ' · ' + fmtDay(fileDate({ lastModified: oldest })) : ''}`),
          g.status && h('span', { class: g.err ? 'bad note' : 'ok note', style: 'white-space:nowrap' }, g.status));
      })),
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Type'), type, h('label', { class: 'row note', style: 'flex-wrap:nowrap' }, save, 'Save version 1.0.0 when converted')),
      busy && h('div', { class: 'bar' }, h('i', { id: 'impBar' })), msg && h('div', { class: busy ? 'note' : 'errbox', id: 'impMsg', style: 'margin-bottom:8px' }, msg),
      h('div', { class: 'row' }, h('button', { class: 'on', disabled: busy, onclick: run }, `Import ${groups.length} session${groups.length > 1 ? 's' : ''}`), h('span', { class: 'grow' }),
        h('button', { onclick: () => { if (busy && !confirm('Stop after the file that is uploading now?')) return; stop = true; if (!busy) d.close(); } }, busy ? 'Stop' : 'Cancel')));
  };
  const run = async () => {
    busy = true; stop = false; msg = 'Starting…'; draw();
    const total = list.reduce((n, x) => n + x.file.size, 0); let done = 0; const made = [];
    const prog = (f, extra) => { const b = $('#impBar'); if (b) b.style.width = Math.round((done + f) / Math.max(1, total) * 100) + '%'; const m = $('#impMsg'); if (m && extra) m.textContent = extra; };
    for (const g of groups) {
      if (stop) break;
      try {
        const sObj = await api('POST', '/api/sessions', { name: g.name.trim() || 'New session', artist: g.band.trim(), source: type.value }); made.push(sObj.id);
        for (let i = 0; i < g.items.length && !stop; i++) {
          const x = g.items[i];
          await putFile(sObj.id, x.file, '', f => prog(f * x.file.size, `${g.name}: ${i + 1} of ${g.items.length} · ${x.file.name}`));
          done += x.file.size;
        }
        if (save.checked && !stop) await api('POST', `/api/sessions/${sObj.id}/draft/finish`, { message: 'Imported from a dropped folder' });
        g.status = stop ? 'stopped' : 'uploaded';
      } catch (e) { g.status = e.message; g.err = true; }
      draw(); prog(0);
    }
    busy = false; msg = groups.some(g => g.err) ? 'Some sessions had problems; see above.' : '';
    if (!msg) { d.close(); S.msg = ''; if (made.length === 1) go('#/s/' + made[0]); else render(); } else draw();
  };
  d.onclose = () => { stop = true; };
  draw(); d.showModal();
}
const modeSeg = (mode, set, busy) => [h('div', { class: 'note', style: 'margin-bottom:4px' }, 'What becomes a session?'),
  h('div', { class: 'seg', style: 'margin-bottom:8px;flex-wrap:wrap' }, [['auto', 'Find the songs'], ['folder', 'Every folder with audio'], ['one', 'All one session']]
    .map(([k, l]) => h('button', { class: mode === k ? 'on' : '', disabled: busy, title: k === 'auto' ? 'A song is a folder with audio in it, or a folder whose subfolders are parts of a song (Stems, Drums, Click…). The folder above a song becomes its band.' : '', onclick: () => set(k) }, l)))];
// Import from the folder mounted at /import: browse to the master folder (or part of it), check the plan, run it on the server.
async function serverImport(pathRel) {
  const d = $('#dlg'); let st = await api('GET', '/api/import/status');
  if (st.job && st.job.running) return importProgress();
  let cur = pathRel || ls('importPath') || '', br;
  try { br = await api('GET', '/api/import/browse?path=' + encodeURIComponent(cur)); } catch { cur = ''; br = await api('GET', '/api/import/browse?path='); }
  const crumbs = ['', ...br.path.split('/').filter(Boolean).map((_, i, a) => a.slice(0, i + 1).join('/'))];
  fill(d, h('h2', {}, 'Import from the master folder'),
    h('div', { class: 'note', style: 'margin-bottom:8px' }, 'Go to the folder to import: the whole master folder, a band, or a single song. Nothing is copied off TrueNAS until you confirm.'),
    h('div', { class: 'row', style: 'margin-bottom:6px;flex-wrap:wrap' }, crumbs.map((c, i) => h('button', { class: 'sm' + (c === br.path ? ' on' : ''), onclick: () => serverImport(c) }, i ? c.split('/').pop() : 'Import folder'))),
    h('div', { style: 'max-height:44vh;overflow:auto;margin-bottom:8px' }, br.folders.length ? br.folders.map(f => h('div', { class: 'li click', style: 'cursor:pointer', onclick: () => serverImport(f.path) }, h('span', { class: 'grow' }, '📁 ' + f.name), h('span', { class: 'note' }, '›'))) : h('div', { class: 'note' }, 'No folders in here.')),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: () => { ls('importPath', br.path); serverPlan(br.path, 'auto'); } }, `Import ${br.path ? '"' + br.path.split('/').pop() + '"' : 'everything'}…`), h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Cancel')));
  if (!d.open) d.showModal();
}
async function serverPlan(pathRel, mode) {
  const d = $('#dlg');
  fill(d, h('h2', {}, 'Import from the master folder'), h('div', { class: 'note' }, 'Looking through the folders…'));
  let plan; try { plan = await api('GET', `/api/import/plan?path=${encodeURIComponent(pathRel)}&mode=${mode}`); } catch (e) { fill(d, h('h2', {}, 'Import'), h('div', { class: 'errbox' }, e.message), h('button', { onclick: () => d.close() }, 'Close')); return; }
  const items = plan.sessions.map(x => ({ ...x, pick: !x.imported }));
  const type = h('select', {}, Object.entries(TYPE).map(([v, l]) => h('option', { value: v, selected: v === 'other' }, l)));
  const save = h('input', { type: 'checkbox', checked: true });
  const draw = () => {
    const picked = items.filter(x => x.pick);
    fill(d, h('h2', {}, 'Import from the master folder'),
      h('div', { class: 'note', style: 'margin-bottom:8px' }, `${plan.path || 'Import folder'}: ${plan.files} audio files · ${items.length} session${items.length === 1 ? '' : 's'} found` + (items.some(x => x.imported) ? ` · ${items.filter(x => x.imported).length} already imported (unticked)` : '')),
      modeSeg(mode, k => serverPlan(pathRel, k)),
      h('div', { class: 'row', style: 'margin-bottom:4px' }, h('button', { class: 'sm', onclick: () => { items.forEach(x => x.pick = true); draw(); } }, 'All'), h('button', { class: 'sm', onclick: () => { items.forEach(x => x.pick = false); draw(); } }, 'None'), h('button', { class: 'sm', onclick: () => serverImport(pathRel) }, '‹ Other folder')),
      h('div', { style: 'max-height:44vh;overflow:auto;margin-bottom:8px' }, items.map(x => {
        const cb = h('input', { type: 'checkbox', checked: x.pick, onchange: () => { x.pick = cb.checked; draw(); } });
        const nm = h('input', { type: 'text', class: 'grow', value: x.name, oninput: () => { x.name = nm.value; } });
        const bd = h('input', { type: 'text', placeholder: 'Band / artist', value: x.band, style: 'width:28%', oninput: () => { x.band = bd.value; } });
        return h('div', { class: 'li' + (x.pick ? '' : ' dim') }, cb, nm, bd, h('span', { class: 'note', style: 'white-space:nowrap', title: x.folder + '\n' + x.sample.join('\n') + (x.files > x.sample.length ? '\n…' : '') }, `${x.files} tracks · ${fmtMB(x.size)}${x.recorded ? ' · ' + fmtDay(x.recorded) : ''}`), x.imported && h('span', { class: 'chip' }, 'imported'));
      })),
      h('div', { class: 'row', style: 'margin-bottom:8px' }, h('span', { class: 'note' }, 'Type'), type, h('label', { class: 'row note', style: 'flex-wrap:nowrap' }, save, 'Save version 1.0.0 when converted')),
      h('div', { class: 'row' }, h('button', { class: 'on', disabled: !picked.length, onclick: () => act(async () => {
        await api('POST', '/api/import/run', { path: plan.path, mode, type: type.value, save: save.checked, items: picked.map(x => ({ folder: x.folder, name: x.name, band: x.band })) });
        importProgress();
      }, false) }, `Import ${picked.length} session${picked.length === 1 ? '' : 's'} (${fmtMB(picked.reduce((n, x) => n + x.size, 0))})`), h('span', { class: 'grow' }), h('button', { onclick: () => d.close() }, 'Cancel')));
  };
  draw(); if (!d.open) d.showModal();
}
async function importProgress() {
  const d = $('#dlg'); if (!d.open) d.showModal();
  let open = true; d.onclose = () => { open = false; render(); };
  while (open) {
    let st; try { st = await api('GET', '/api/import/status'); } catch { break; }
    const j = st.job || {};
    fill(d, h('h2', {}, j.running ? 'Importing…' : 'Import finished'),
      h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((j.done || 0) / Math.max(1, j.total || 1) * 100)}%` })),
      h('div', { class: 'note', style: 'margin-bottom:6px' }, `${j.done || 0} of ${j.total || 0} sessions · ${j.files || 0} files queued${j.current ? ' · now: ' + j.current : ''}`),
      h('div', { class: 'note', style: 'margin-bottom:8px' }, st.busy ? `Converting: ${st.busy} track${st.busy === 1 ? '' : 's'} to go. This keeps going if you close this window; the library shows each session once its first version is saved.` : 'All tracks are converted.'),
      (j.errors || []).length ? h('div', { class: 'errbox', style: 'margin-bottom:8px;white-space:pre-wrap' }, j.errors.slice(0, 20).join('\n')) : null,
      h('div', { class: 'row' }, j.running && h('button', { onclick: () => api('POST', '/api/import/stop') }, 'Stop after this session'), h('span', { class: 'grow' }), h('button', { class: 'on', onclick: () => d.close() }, 'Close')));
    if (!j.running && !st.busy) break;
    await new Promise(r => setTimeout(r, 1500));
  }
}

// =====================================================================================
// Session page
// =====================================================================================
async function loadSession(sid) {
  S.s = await api('GET', '/api/sessions/' + sid);
  [S.mixes, S.recs] = await Promise.all([api('GET', `/api/sessions/${sid}/mixes`).then(j => j.mixes), api('GET', `/api/sessions/${sid}/recordings`).then(j => j.recordings)]);
  if (S.s.can.edit && !S.people.length) S.people = (await api('GET', '/api/people')).people;
}
let pollT = 0;
async function sessionPage(main, sid, view) {
  if (!S.s || S.s.id !== sid || main.dataset.sid !== sid) { player.stop(); recPlayer.stop(); S.edit = false; await loadSession(sid); }
  const s = S.s, latest = s.versions[s.versions.length - 1];
  // What the track list shows: an older version (read-only), or the working copy (unsaved changes, else the latest version)
  const old = view && latest && view !== latest.v && s.versions.find(v => v.v === view);
  const editable = !old && s.can.upload;
  const tracks = old ? old.tracks : s.draft ? s.draft.tracks : latest ? latest.tracks : [];
  S.view = old ? old.v : 'current'; main.dataset.sid = sid;
  const busy = s.draft && s.draft.tracks.filter(t => t.status === 'queued' || t.status === 'processing').length;
  status(busy || 0);
  clearTimeout(pollT);
  if (busy) pollT = setTimeout(async () => { if (route().a !== sid) return; try { S.s = await api('GET', '/api/sessions/' + sid); if (route().a === sid) sessionPage(main, sid, route().b && decodeURIComponent(route().b)); } catch {} }, 1500);
  player.setTracks(sid, tracks.filter(t => t.status === 'ready' || !t.status));
  const sub = [s.artist, TYPE[s.source] || s.source, s.recorded && fmtDay(s.recorded), s.key && 'Key ' + s.key, s.bpm && s.bpm + ' BPM'].filter(Boolean).join(' · ');
  fill(main, h('div', { class: 'page' },
    h('div', { class: 'col' }, detailsCard(s), licenseCard(s)),
    h('div', { class: 'col' },
      S.msg && h('div', { class: 'errbox' }, S.msg),
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:10px;align-items:flex-start' },
          h('div', { class: 'grow' }, h('p', { class: 'title' }, s.name), h('div', { class: 'sub' }, sub),
            (s.difficulty || s.tags.length) ? h('div', { class: 'chips', style: 'margin-top:6px' }, s.difficulty && h('span', { class: 'chip teal' }, DIFF[s.difficulty]), s.tags.map(t => h('span', { class: 'chip' }, t))) : null),
          latest && mixButton(sid, (old || latest).v, s.ready[(old || latest).v], true),
          menuButton([s.can.delete && ['Delete session…', () => confirm(`Delete "${s.name}" with all its versions, mixes and recordings?`) && act(async () => { await api('DELETE', '/api/sessions/' + sid); S.s = null; go('#/'); }, false)]])),
        tracksSection(s, tracks, editable, old, latest)),
      versionsCard(s, old ? old.v : latest && latest.v), mixesCard(s), recordingsCard(s))));
  player.draw();
}
// a small "⋯" menu: items are [label, onclick] (falsy items are skipped)
function menuButton(items, label = '⋯') {
  items = items.filter(Boolean); if (!items.length) return null;
  const b = h('button', { class: 'sm menu-btn', title: 'More', onclick: e => {
    e.stopPropagation(); closeMenus();
    const r = b.getBoundingClientRect(), m = h('div', { class: 'menu', style: `top:${r.bottom + 4}px;right:${Math.max(8, innerWidth - r.right)}px` },
      items.map(([l, fn, cls]) => l === '-' ? h('hr') : h('button', { class: cls || '', onclick: ev => { ev.stopPropagation(); closeMenus(); fn(); } }, l)));
    document.body.append(m);
    const mh = m.offsetHeight; if (r.bottom + 4 + mh > innerHeight) m.style.top = Math.max(8, r.top - 4 - mh) + 'px';   // open upwards near the bottom
  } }, label);
  return b;
}
const closeMenus = () => document.querySelectorAll('.menu').forEach(m => m.remove());
document.addEventListener('click', closeMenus); window.addEventListener('scroll', closeMenus, true);

// ---- details (view first; Edit opens the form) ----
const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
function detailsCard(s) {
  const row = (k, v) => v ? h('div', { class: 'stat' }, h('span', { class: 'note' }, k), h('span', {}, v)) : null;
  if (!S.edit || !s.can.edit) return h('div', { class: 'card' }, h('div', { class: 'row', style: 'margin-bottom:6px' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Details'), s.can.edit && h('button', { class: 'sm', onclick: () => { S.edit = true; render(); } }, 'Edit')),
    row('Band / artist', s.artist), row('Type', TYPE[s.source] || s.source), row('Recorded', s.recorded && fmtDay(s.recorded)), row('Key', s.key), row('Tempo', s.bpm && s.bpm + ' BPM'), row('Source', s.sourceNote), row('Difficulty', s.difficulty && DIFF[s.difficulty]),
    s.listenFor && [h('div', { class: 'note', style: 'margin-top:8px' }, 'Listen for'), h('div', { class: 'ro' }, s.listenFor)],
    s.notes && [h('div', { class: 'note', style: 'margin-top:8px' }, 'Notes'), h('div', { class: 'ro' }, s.notes)],
    h('div', { class: 'note', style: 'margin-top:8px' }, `Added ${fmtDate(s.created)} by ${s.names[s.createdBy] || ''}`));
  const f = {}, inp = (k, ph) => (f[k] = h('input', { type: 'text', value: s[k] || '', placeholder: ph || '' }));
  f.source = h('select', {}, Object.entries(TYPE).map(([v, l]) => h('option', { value: v, selected: s.source === v }, l)));
  f.recorded = h('input', { type: 'date', value: s.recorded || '' });
  f.difficulty = h('select', {}, Object.entries(DIFF).map(([v, l]) => h('option', { value: v, selected: s.difficulty === v }, l)));
  f.tags = h('input', { type: 'text', value: s.tags.join(', '), placeholder: 'vocal-heavy, acoustic, full band' });
  f.listenFor = h('textarea', { placeholder: 'What should a trainee listen for?' }, s.listenFor); f.notes = h('textarea', { placeholder: 'Assignments, background, anything else' }, s.notes);
  const save = () => act(async () => {
    const b = { name: f.name.value, artist: f.artist.value, source: f.source.value, recorded: f.recorded.value, key: f.key.value, bpm: f.bpm.value, sourceNote: f.sourceNote.value, difficulty: f.difficulty.value, tags: f.tags.value.split(','), listenFor: f.listenFor.value, notes: f.notes.value };
    if (b.recorded === (s.recorded || '')) delete b.recorded;   // keep following the files unless it was changed
    S.s = { ...(await api('PATCH', '/api/sessions/' + s.id, b)) }; S.edit = false;
  });
  return h('div', { class: 'card' }, h('h2', {}, 'Details'), field('Name', inp('name')), field('Band / artist', inp('artist')),
    h('div', { class: 'two' }, field('Type', f.source), field(s.recordedAuto !== false && s.recorded ? 'Recorded (from the files)' : 'Recorded', f.recorded)),
    h('div', { class: 'two' }, field('Key', inp('key')), field('Tempo (BPM)', inp('bpm'))), field('Source', inp('sourceNote', 'e.g. Sunday 9:30 service, MultiTracks.com')),
    h('div', { class: 'two' }, field('Difficulty', f.difficulty), field('Tags', f.tags)), field('Listen for', f.listenFor), field('Notes', f.notes),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: save }, 'Save'), h('button', { onclick: () => { S.edit = false; render(); } }, 'Cancel')));
}
function licenseCard(s) {
  const L = s.license;
  if (!s.can.edit) return L.kind === 'none' && !L.restricted ? null : h('div', { class: 'card' }, h('h2', {}, 'License'),
    h('div', { class: 'stat' }, h('span', { class: 'note' }, 'Type'), h('span', {}, L.kind === 'purchased' ? 'Purchased' : L.kind === 'other' ? 'Other' : 'None')),
    L.holder && h('div', { class: 'stat' }, h('span', { class: 'note' }, 'Licensed to'), h('span', {}, L.holder)), L.terms && h('div', { class: 'ro', style: 'margin-top:6px' }, L.terms),
    L.restricted && h('div', { class: 'note', style: 'margin-top:6px' }, 'Only people with access to licensed sessions can see this one.'));
  const save = license => act(async () => { S.s = { ...(await api('PATCH', '/api/sessions/' + s.id, { license })) }; }, true);
  if (!S.licOpen && L.kind === 'none' && !L.restricted) return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'License'), h('button', { class: 'sm', onclick: () => { S.licOpen = true; render(); } }, 'Add')), h('div', { class: 'note', style: 'margin-top:4px' }, 'Our own recording, no license.'));
  const kind = h('select', { onchange: () => save({ kind: kind.value }) }, [['none', 'None / our own recording'], ['purchased', 'Purchased'], ['other', 'Other license']].map(([v, l]) => h('option', { value: v, selected: L.kind === v }, l)));
  const holder = h('input', { type: 'text', value: L.holder, placeholder: 'e.g. Rolling Hills Community Church' }); holder.onchange = () => save({ holder: holder.value });
  const terms = h('textarea', { placeholder: 'What the license allows' }, L.terms); terms.onchange = () => save({ terms: terms.value });
  const restr = h('input', { type: 'checkbox', checked: L.restricted, onchange: () => save({ restricted: restr.checked }) });
  return h('div', { class: 'card' }, h('h2', {}, 'License'), field('Type', kind), field('Licensed to', holder), field('Terms', terms),
    h('label', { class: 'row', style: 'margin-bottom:6px' }, restr, h('span', {}, 'Restrict who can see this session')),
    L.restricted && h('div', {}, h('div', { class: 'note', style: 'margin-bottom:4px' }, 'People with "Licensed sessions" access can always see it. Also allow:'),
      h('div', { class: 'perms' }, S.people.map(p => h('label', {}, h('input', { type: 'checkbox', checked: L.allow.includes(p.id), onchange: e => save({ allow: e.target.checked ? [...L.allow, p.id] : L.allow.filter(x => x !== p.id) }) }), p.display)))));
}

// ---- tracks: one list; edits collect as unsaved changes until "Save as vX" ----
function tracksSection(s, tracks, editable, old, latest) {
  const sid = s.id, kids = [];
  const patchT = (t, body) => act(async () => { S.s = await api('PATCH', `/api/sessions/${sid}/draft/tracks/${t.id}`, body); });
  const setOrder = ids => act(async () => { S.s = await api('PATCH', `/api/sessions/${sid}/draft`, { order: ids }); });
  if (old) kids.push(h('div', { class: 'draft' }, h('div', { class: 'row' }, h('b', { class: 'grow' }, `You are looking at v${old.v}. The latest is v${latest.v}.`),
    h('button', { class: 'sm', onclick: () => go('#/s/' + sid) }, 'Back to latest'),
    s.can.upload && h('button', { class: 'sm', title: 'Puts these tracks back as unsaved changes, so you can save them as a new version', onclick: () => act(async () => { S.s = await api('POST', `/api/sessions/${sid}/restore`, { version: old.v }); go('#/s/' + sid); }, false) }, 'Restore this version'))));
  // unsaved changes bar
  if (!old && s.draft) {
    const d = s.draft, base = d.restoredFrom || d.base, baseTracks = base ? (s.versions.find(v => v.v === base) || latest || { tracks: [] }).tracks : [];
    const c = diffLocal(latest ? latest.tracks : [], d.tracks), notReady = d.tracks.some(t => t.status !== 'ready');
    const next = latest ? bump(latest.v, (c.added.length || c.removed.length || c.replaced.length) ? 'minor' : 'patch') : '1.0.0';
    const note = h('input', { type: 'text', class: 'grow', placeholder: latest ? 'What changed? (optional)' : 'Notes for the first version (optional)' });
    kids.push(h('div', { class: 'draft' },
      h('div', { class: 'row' }, h('b', {}, latest ? 'Unsaved changes' : 'Not saved yet'), h('span', { class: 'note grow' }, latest ? (changesText(c) || 'No changes yet.') : `${d.tracks.length} track${d.tracks.length === 1 ? '' : 's'}`)),
      h('div', { class: 'row', style: 'margin-top:8px' }, note,
        h('button', { class: 'on', disabled: notReady || !d.tracks.length || (latest && !changesText(c)), title: notReady ? 'Wait until every track has converted' : '', onclick: () => act(async () => { const j = await api('POST', `/api/sessions/${sid}/versions`, { bump: 'auto', message: note.value }); S.s = j.session; }) }, 'Save as v' + next),
        h('button', { onclick: () => confirm(latest ? 'Undo all unsaved changes?' : 'Remove all the tracks you added?') && act(async () => { S.s = await api('POST', `/api/sessions/${sid}/draft/discard`); }) }, latest ? 'Undo changes' : 'Clear'))));
  }
  // add tracks: button, or drop files/folders anywhere on the card
  const file = h('input', { type: 'file', multiple: true, accept: 'audio/*,.zip,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus,.caf', class: 'hide', onchange: () => file.files.length && upload(pickedFiles(file).map(x => x.file)) });
  const dir = h('input', { type: 'file', webkitdirectory: true, multiple: true, class: 'hide', onchange: () => { const l = pickedFiles(dir).sort(byPath); l.length && upload(l.map(x => x.file)); } });
  // warnings: tracks that are not the same length as the rest, silent tracks
  const ready = tracks.filter(t => t.hash && (!t.status || t.status === 'ready'));
  const used = ready.filter(t => t.kind !== 'off'), durs = used.map(t => t.duration).sort((a, b) => a - b), med = durs.length ? durs[Math.floor(durs.length / 2)] : 0;
  const odd = new Map(used.filter(t => Math.abs(t.duration - med) > 0.5).map(t => [t.id, t.duration - med]));
  const silent = ready.filter(t => t.silent);
  kids.push(h('div', { class: 'tbar' }, player.transport(tracks), h('span', { class: 'grow' }),
    editable && tracks.length > 1 && h('button', { class: 'sm', title: 'Put the tracks in instrument order: drums, percussion, bass, guitars, keys, vocals, click & tracks', onclick: () => setOrder([...tracks].sort((a, b) => Object.keys(GROUP).indexOf(a.group) - Object.keys(GROUP).indexOf(b.group) || (a.kind === 'reference') - (b.kind === 'reference')).map(t => t.id)) }, 'Sort by instrument'),
    editable && h('button', { class: 'sm on', onclick: () => file.click() }, '+ Add tracks'), editable && h('button', { class: 'sm', onclick: () => dir.click() }, '+ Folder'), file, dir));
  if (S.up) kids.push(h('div', { class: 'note', id: 'upTxt' }, S.up));
  if (odd.size) kids.push(h('div', { class: 'warn-line' }, `⚠ ${odd.size} track${odd.size === 1 ? ' is' : 's are'} a different length from the rest (${fmtTime(med)}), so ${odd.size === 1 ? 'it' : 'they'} may not line up: ` + [...odd].map(([id, dd]) => `${tracks.find(t => t.id === id).name} (${dd > 0 ? '+' : ''}${dd.toFixed(1)} s)`).join(', ')));
  if (silent.length) kids.push(h('div', { class: 'note', style: 'margin-bottom:6px' }, `${silent.length} silent track${silent.length === 1 ? '' : 's'} (nothing above -60 dB)${silent.some(t => t.kind === 'off') ? ', set to Not used' : ''}: ${silent.map(t => t.name).join(', ')}`));
  if (!tracks.length) kids.push(h('div', { class: 'drop', onclick: () => editable && file.click() }, h('b', {}, editable ? 'Drop tracks or a folder here' : 'No tracks yet'), editable && h('div', { class: 'note' }, 'WAV, AIFF, FLAC, MP3, M4A or a zip. Everything is stored as 96 kHz / 24-bit WAV.')));
  let no = 0, dragId = null;
  const list = h('div', { class: 'tlist' });
  tracks.forEach(t => {
    const isRef = t.kind === 'reference', off = t.kind === 'off', n = t.kind === 'channel' ? String(++no) : isRef ? 'REF' : '–';
    const isReady = !t.status || t.status === 'ready', col = GCOLOR[t.group] || GCOLOR.other;
    const info = isReady ? `${t.channels > 1 ? 'Stereo' : 'Mono'} · ${fmtTime(t.duration)}${t.srcFormat ? ' · ' + t.srcFormat : ''}` : t.status === 'error' ? '' : t.status === 'processing' ? 'Converting…' : 'Waiting…';
    const wave = isReady && t.hash ? player.canvas(t, col) : h('div', { class: t.status === 'error' ? 'bad note' : 'note' }, t.status === 'error' ? 'Failed: ' + t.error : info);
    const nameEl = h('div', { class: 'nm', title: (t.srcName ? 'File: ' + t.srcName + '\n' : '') + (editable ? 'Click to rename' : '') }, t.name, h('small', {}, [GROUP[t.group], isRef && 'Reference mix', off && 'Not used', info].filter(Boolean).join(' · ')));
    if (editable) nameEl.onclick = () => {
      const inp = h('input', { type: 'text', value: t.name });
      const done = ok => { if (ok && inp.value.trim() && inp.value.trim() !== t.name) patchT(t, { name: inp.value.trim() }); else render(); };
      inp.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); }; inp.onblur = () => done(true);
      nameEl.replaceChildren(inp); inp.focus(); inp.select();
    };
    const groupItems = Object.entries(GROUP).map(([g, l]) => [(t.group === g ? '✓ ' : ' ') + l, () => patchT(t, { group: g })]);
    const rep = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.caf', class: 'hide', onchange: () => rep.files.length && upload(rep.files, t.id) });
    const menu = menuButton([
      editable && [(t.kind === 'channel' ? '✓ ' : ' ') + 'Mixer channel', () => patchT(t, { kind: 'channel' })],
      editable && [(isRef ? '✓ ' : ' ') + 'Reference mix', () => patchT(t, { kind: 'reference' })],
      editable && [(off ? '✓ ' : ' ') + 'Not used', () => patchT(t, { kind: 'off' })],
      editable && ['-'], ...(editable ? groupItems : []), editable && ['-'],
      editable && ['Replace audio…', () => rep.click()],
      s.can.download && t.hash && ['Download WAV (96 kHz)', () => { location.href = `/api/sessions/${sid}/files/${t.hash}`; }],
      s.can.download && t.origHash && ['Download original file', () => { location.href = `/api/sessions/${sid}/files/${t.origHash}?orig=1`; }],
      editable && ['-'], editable && ['Remove track', () => act(async () => { S.s = await api('DELETE', `/api/sessions/${sid}/draft/tracks/${t.id}`); }), 'danger']]);
    const row = h('div', { class: 'trk' + (off ? ' off' : '') + (isRef ? ' ref' : '') + (odd.has(t.id) ? ' odd' : ''), style: `--g:${col}` },
      editable ? h('span', { class: 'grip', title: 'Drag to reorder' }, '⋮⋮') : h('span'), h('span', { class: 'no' }, n), nameEl, player.buttons(t), wave, h('div', { class: 'acts' }, menu, rep));
    if (editable) {
      row.draggable = true;
      row.ondragstart = e => { dragId = t.id; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); };
      row.ondragend = () => row.classList.remove('dragging');
      row.ondragover = e => { if (!dragId) return; e.preventDefault(); const r = row.getBoundingClientRect(); row.classList.toggle('drop-before', e.clientY < r.top + r.height / 2); row.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2); };
      row.ondragleave = () => row.classList.remove('drop-before', 'drop-after');
      row.ondrop = e => {
        if (!dragId) return; e.preventDefault(); e.stopPropagation();
        const after = row.classList.contains('drop-after'); row.classList.remove('drop-before', 'drop-after');
        const ids = tracks.map(x => x.id).filter(x => x !== dragId), i = ids.indexOf(t.id); ids.splice(after ? i + 1 : i, 0, dragId); dragId = null;
        if (ids.join() !== tracks.map(x => x.id).join()) setOrder(ids);
      };
    }
    list.append(row);
  });
  kids.push(list);
  const card = h('div', {}, kids);
  if (editable) {   // files or folders dropped on the track list are added to this session
    card.ondragover = e => { if (!dragId && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); card.classList.add('dropping'); } };
    card.ondragleave = e => { if (e.target === card) card.classList.remove('dropping'); };
    card.ondrop = e => { if (dragId) return; e.preventDefault(); card.classList.remove('dropping'); droppedFiles(e.dataTransfer).then(l => l.length ? upload(l.sort(byPath).map(x => x.file)) : (S.msg = 'No audio files in what you dropped', render())); };
  }
  return card;
}

// ---- files and folders from a drop or a picker ----
const AUDIO_RE = /\.(wav|wave|bwf|aiff?|flac|mp3|m4a|aac|ogg|opus|wma|caf|zip)$/i;
const keepFile = name => AUDIO_RE.test(name) && !name.startsWith('.') && !name.startsWith('._');
const fileDate = f => { const d = new Date(f.lastModified || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Everything dropped, folders included, as [{ path: 'Folder/Sub/file.wav', file }]. Must start inside the drop event.
function droppedFiles(dt) {
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry ? i.webkitGetAsEntry() : null).filter(Boolean);
  if (!entries.length) return Promise.resolve([...dt.files].filter(f => keepFile(f.name)).map(f => ({ path: f.name, file: f })));
  const out = [];
  const readAll = dir => new Promise((resolve, reject) => { const r = dir.createReader(), all = []; const next = () => r.readEntries(b => { if (!b.length) resolve(all); else { all.push(...b); next(); } }, reject); next(); });
  const walk = async (e, prefix) => {
    if (e.name.startsWith('.') || e.name === '__MACOSX') return;
    if (e.isFile) { if (keepFile(e.name)) out.push({ path: prefix + e.name, file: await new Promise((res, rej) => e.file(res, rej)) }); }
    else if (e.isDirectory) for (const c of await readAll(e)) await walk(c, prefix + e.name + '/');
  };
  return Promise.all(entries.map(e => walk(e, ''))).then(() => out);
}
const pickedFiles = input => [...input.files].filter(f => keepFile(f.name)).map(f => ({ path: f.webkitRelativePath || f.name, file: f }));
const byPath = (a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });
// Upload one file into a session's unsaved changes; resolves with the session.
function putFile(sid, file, extra, onprog) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/sessions/${sid}/upload?name=${encodeURIComponent(file.name)}&date=${fileDate(file)}${extra || ''}`);
    x.setRequestHeader('x-livevault', '1');
    x.upload.onprogress = e => onprog && onprog(e.loaded / Math.max(1, e.total));
    x.onload = () => { if (x.status === 200) resolve(JSON.parse(x.responseText)); else { let m = 'Upload failed'; try { m = JSON.parse(x.responseText).error || m; } catch {} reject(new Error(m)); } };
    x.onerror = () => reject(new Error('Upload failed: connection lost'));
    x.send(file);
  });
}
function upload(files, replace) {
  const list = [...files], sid = S.s.id;
  act(async () => {
    for (let i = 0; i < list.length; i++) {
      S.s = await putFile(sid, list[i], replace ? '&replace=' + replace : '', f => { S.up = `Uploading ${i + 1} of ${list.length}: ${list[i].name} (${Math.round(f * 100)}%)`; const el = $('#upTxt'); if (el) el.textContent = S.up; else render(); }).finally(() => { S.up = ''; });
      render();
    }
  });
}
function bump(v, k) { if (!v) return '1.0.0'; let [a, b, c] = v.split('.').map(Number); if (k === 'major') { a++; b = 0; c = 0; } else if (k === 'minor') { b++; c = 0; } else c++; return `${a}.${b}.${c}`; }
function diffLocal(a, b) {
  const A = new Map(a.map(t => [t.id, t])), B = new Map(b.map(t => [t.id, t])), o = { added: [], removed: [], renamed: [], replaced: [], kind: [], grouped: [], reordered: false };
  for (const t of b) { const x = A.get(t.id); if (!x) o.added.push(t.name); else { if (x.name !== t.name) o.renamed.push([x.name, t.name]); if (x.hash !== t.hash) o.replaced.push(t.name); if (x.kind !== t.kind) o.kind.push([t.name, x.kind, t.kind]); if (x.group && x.group !== t.group) o.grouped.push([t.name, x.group, t.group]); } }
  for (const t of a) if (!B.has(t.id)) o.removed.push(t.name);
  o.reordered = a.filter(t => B.has(t.id)).map(t => t.id).join() !== b.filter(t => A.has(t.id)).map(t => t.id).join();
  return o;
}
function changesText(c) {
  if (!c) return '';
  const p = [], few = l => l.length > 3 ? `${l.slice(0, 3).join(', ')} and ${l.length - 3} more` : l.join(', ');
  if (c.added.length) p.push('Added ' + few(c.added));
  if (c.removed.length) p.push('Removed ' + few(c.removed));
  if (c.replaced.length) p.push('New audio for ' + few(c.replaced));
  if (c.renamed.length) p.push('Renamed ' + few(c.renamed.map(([a, b]) => `${a} → ${b}`)));
  if (c.kind.length) p.push(few(c.kind.map(([n, , k]) => `${n} is now ${KIND[k].toLowerCase()}`)));
  if (c.grouped && c.grouped.length) p.push('Regrouped ' + few(c.grouped.map(([n]) => n)));
  if (c.reordered) p.push('New track order');
  return p.join('. ');
}

// ---- versions ----
function versionsCard(s, shown) {
  if (!s.versions.length) return null;
  const latest = s.versions[s.versions.length - 1];
  return h('div', { class: 'card' }, h('h2', {}, 'History'), [...s.versions].reverse().map(v => h('div', { class: 'ver' },
    h('span', { class: 'v' + (v.v === shown ? ' cur' : '') }, 'v' + v.v),
    h('div', { class: 'grow' }, h('div', {}, v.message || (v.v === '1.0.0' ? 'First version' : h('span', { class: 'note' }, 'No notes'))),
      h('div', { class: 'what' }, `${fmtWhen(v.created)} · ${s.names[v.by] || ''} · ${v.tracks.length} tracks`, v.changes && v.v !== '1.0.0' && changesText(v.changes) ? ' · ' + changesText(v.changes) : '')),
    v.v !== shown && h('button', { class: 'sm', onclick: () => go(v === latest ? `#/s/${s.id}` : `#/s/${s.id}/${v.v}`) }, v === latest ? 'Latest' : 'View'))));
}

// ---- mixes ----
function mixesCard(s) {
  const sid = s.id;
  return h('div', { class: 'card' }, h('h2', {}, 'Mixes'),
    !S.mixes.length ? h('div', { class: 'note' }, s.can.mix ? 'No mixes yet. Mixes made in LiveWebMixer are saved here, one per person for each version.' : 'No mixes you can see yet.') :
    S.mixes.map(m => h('div', { class: 'item' }, h('div', { class: 'row' },
      h('b', { class: 'grow' }, m.name, m.reference && h('span', { class: 'chip teal', style: 'margin-left:6px' }, 'Reference')),
      m.lwm && m.by === S.user.id && mixButton(sid, m.version, s.ready[m.version]),
      menuButton([
        s.can.edit && [m.reference ? 'Unmark as reference' : 'Mark as reference (everyone can see it)', () => act(async () => { await api('PATCH', `/api/sessions/${sid}/mixes/${m.id}`, { reference: !m.reference }); await loadSession(sid); })],
        (m.by === S.user.id || S.user.admin) && ['Rename…', () => { const n = prompt('Mix name', m.name); n && act(async () => { await api('PATCH', `/api/sessions/${sid}/mixes/${m.id}`, { name: n }); await loadSession(sid); }); }],
        ['Download settings (JSON)', () => { location.href = `/api/sessions/${sid}/mixes/${m.id}/download`; }],
        (m.by === S.user.id || s.can.delete) && ['Delete', () => confirm(`Delete the mix "${m.name}"?`) && act(async () => { await api('DELETE', `/api/sessions/${sid}/mixes/${m.id}`); await loadSession(sid); }), 'danger']])),
      h('div', { class: 'note' }, `${m.byName} · made on v${m.version} · saved ${fmtWhen(m.updated)}`))));
}

// ---- recordings (Main LR from LiveWebMixer, for review) ----
function recordingsCard(s) {
  const sid = s.id;
  return h('div', { class: 'card' }, h('h2', {}, 'Recordings'),
    !S.recs.length ? h('div', { class: 'note' }, 'No recordings yet. In LiveWebMixer press Record: the Main LR mix is recorded while it plays and saved here for review.') :
    S.recs.map(r => {
      const v = s.versions.find(x => x.v === r.version), ref = v && v.tracks.find(t => t.kind === 'reference');
      const notes = s.can.edit && h('textarea', { placeholder: 'Review notes for ' + r.byName, style: 'width:100%;min-height:60px;margin-top:6px' }, r.notes);
      if (notes) notes.onchange = () => act(async () => { const j = await api('PATCH', `/api/sessions/${sid}/recordings/${r.id}`, { notes: notes.value }); Object.assign(r, j); }, false);
      return h('div', { class: 'item' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, r.name),
          menuButton([
            (r.by === S.user.id || S.user.admin) && ['Rename…', () => { const n = prompt('Recording name', r.name); n && act(async () => { await api('PATCH', `/api/sessions/${sid}/recordings/${r.id}`, { name: n }); await loadSession(sid); }); }],
            (s.can.download || r.by === S.user.id) && ['Download WAV', () => { location.href = `/api/sessions/${sid}/recordings/${r.id}/download`; }],
            (r.by === S.user.id || s.can.delete) && ['Delete', () => confirm(`Delete the recording "${r.name}"?`) && act(async () => { recPlayer.stop(); await api('DELETE', `/api/sessions/${sid}/recordings/${r.id}`); await loadSession(sid); }), 'danger']])),
        h('div', { class: 'note' }, `${r.byName} · v${r.version}${r.mixName ? ' · mix "' + r.mixName + '"' : ''} · ${fmtWhen(r.created)} · ${fmtTime(r.duration)}${r.start ? ' · starts at ' + fmtTime(r.start) + ' in the song' : ''}`),
        recPlayer.ui(sid, r, ref),
        notes || (r.notes ? h('div', { class: 'review' }, r.notes) : null),
        r.notesAt && h('div', { class: 'note', style: 'margin-top:4px' }, `Review by ${r.notesByName} · ${fmtWhen(r.notesAt)}`));
    }));
}

// =====================================================================================
// Preview player: plays the session's tracks together in the browser (Opus previews)
// =====================================================================================
const peaksCache = new Map();
async function peaks(url) { if (!peaksCache.has(url)) peaksCache.set(url, fetch(url).then(r => r.ok ? r.json() : null).catch(() => null)); return peaksCache.get(url); }
function drawWave(cv, pk, frac, color) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth || 300, hh = cv.clientHeight || 34;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr); }
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, css = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, W, H);
  if (pk) {
    g.fillStyle = color && color[0] === '#' ? color : css.getPropertyValue(color || '--acc');
    const n = pk.p.length;
    for (let x = 0; x < W; x++) { const v = Math.sqrt(pk.p[Math.floor(x / W * n)] / 100), y = Math.max(1, v * H * 0.92); g.fillRect(x, (H - y) / 2, 1, y); }
  }
  if (frac != null) { g.fillStyle = css.getPropertyValue('--fg'); g.fillRect(Math.round(frac * W), 0, Math.max(1, dpr), H); }
}
const player = {
  ctx: null, sid: null, tracks: [], bufs: new Map(), srcs: [], gains: new Map(), mute: new Set(), solo: new Set(), ref: false, playing: false, t0: 0, off: 0, dur: 0, canvases: [], ui: null,
  setTracks(sid, tracks) {
    const key = tracks.map(t => t.id + t.hash).join();
    if (sid !== this.sid || key !== this.key) { this.stop(); this.bufs.clear(); this.mute.clear(); this.solo.clear(); this.off = 0; this.ref = false; }
    this.sid = sid; this.key = key; this.tracks = tracks; this.canvases = [];
    this.dur = Math.max(0, ...tracks.map(t => t.duration || 0));
  },
  loaded() { return this.tracks.length && this.tracks.filter(t => t.kind !== 'off').every(t => this.bufs.has(t.id)); },
  async load() {
    this.ctx = this.ctx || new AudioContext();
    const list = this.tracks.filter(t => t.kind !== 'off' && !this.bufs.has(t.id));
    $('#load').classList.remove('hide'); let done = 0, bytes = 0;
    const setLoad = txt => { $('#loadBar').style.width = (done / Math.max(1, list.length) * 100) + '%'; $('#loadTxt').textContent = txt; };
    setLoad('Starting…');
    try {
      let next = 0;
      const work = async () => { while (next < list.length) { const t = list[next++]; const r = await fetch(`/media/preview/${t.hash}?s=${this.sid}`); if (!r.ok) throw new Error('Could not load ' + t.name); const ab = await r.arrayBuffer(); bytes += ab.byteLength; this.bufs.set(t.id, await this.ctx.decodeAudioData(ab)); done++; setLoad(`${done} of ${list.length} tracks · ${fmtMB(bytes)}`); } };
      await Promise.all([work(), work(), work()]);
    } catch (e) { S.msg = e.message; }
    $('#load').classList.add('hide'); render();
  },
  get time() { return this.playing ? Math.min(this.dur, this.off + this.ctx.currentTime - this.t0) : this.off; },
  level(t) { if (this.ref) return t.kind === 'reference' ? 1 : 0; if (t.kind !== 'channel') return 0; if (this.solo.size) return this.solo.has(t.id) ? 1 : 0; return this.mute.has(t.id) ? 0 : 1; },
  apply() { for (const t of this.tracks) { const g = this.gains.get(t.id); if (g) g.gain.setTargetAtTime(this.level(t), this.ctx.currentTime, 0.01); } },
  play() {
    if (!this.loaded()) return this.load();
    this.ctx.resume(); this.stopSources();
    if (this.off >= this.dur - 0.05) this.off = 0;
    const at = this.ctx.currentTime + 0.05;
    for (const t of this.tracks) {
      const b = this.bufs.get(t.id); if (!b) continue;
      const src = this.ctx.createBufferSource(), g = this.ctx.createGain(); src.buffer = b; g.gain.value = this.level(t);
      src.connect(g); g.connect(this.ctx.destination); src.start(at, Math.min(this.off, b.duration)); this.srcs.push(src); this.gains.set(t.id, g);
    }
    this.t0 = at; this.playing = true; this.tick(); this.paint();
  },
  stopSources() { for (const s of this.srcs) { try { s.stop(); } catch {} s.disconnect(); } this.srcs = []; this.gains.clear(); },
  pause() { if (!this.playing) return; this.off = this.time; this.playing = false; this.stopSources(); this.paint(); },
  stop() { if (this.ctx && this.playing) { this.off = this.time; } this.playing = false; this.stopSources(); },
  seek(sec) { const was = this.playing; this.pause(); this.off = Math.max(0, Math.min(this.dur, sec)); if (was) this.play(); else this.draw(); },
  transport(tracks) {
    const listen = tracks.filter(t => t.kind !== 'off'); if (!listen.length || listen.some(t => !t.hash || (t.status && t.status !== 'ready'))) return null;
    const hasRef = tracks.some(t => t.kind === 'reference');
    const play = h('button', { class: 'on', style: 'min-width:120px', onclick: () => this.playing ? this.pause() : this.play() });
    const time = h('span', { class: 'time' }), seek = h('input', { type: 'range', class: 'seek', min: 0, max: Math.max(1, this.dur), step: 0.05, value: this.off });
    seek.oninput = () => this.seek(+seek.value);
    const ref = hasRef && h('button', { class: 'sm' + (this.ref ? ' on' : ''), title: 'Switch between the tracks and the reference mix', onclick: () => { this.ref = !this.ref; ref.classList.toggle('on', this.ref); this.apply(); } }, 'Reference A/B');
    const clear = h('button', { class: 'sm', title: 'Clear mutes and solos', onclick: () => { this.mute.clear(); this.solo.clear(); this.apply(); render(); } }, 'Clear M/S');
    this.ui = { play, time, seek };
    this.paint();
    return h('div', { class: 'tbar' }, play, time, seek, ref, clear,
      !this.loaded() && h('span', { class: 'note' }, 'Preview loads compressed copies (about ' + fmtMB(listen.reduce((n, t) => n + t.duration * (t.channels > 1 ? 12000 : 8000), 0)) + ').'));
  },
  paint() {
    const u = this.ui; if (!u || !u.play.isConnected) return;
    u.play.textContent = this.playing ? 'Pause' : this.loaded() ? 'Play preview' : 'Load preview';
    u.time.textContent = fmtTime(this.time) + ' / ' + fmtTime(this.dur); if (document.activeElement !== u.seek) u.seek.value = this.time;
  },
  buttons(t) {
    if (t.kind !== 'channel') return h('span');
    const m = h('button', { class: 'mute' + (this.mute.has(t.id) ? ' on' : ''), onclick: () => { this.mute.has(t.id) ? this.mute.delete(t.id) : this.mute.add(t.id); m.classList.toggle('on'); this.apply(); } }, 'M');
    const s = h('button', { class: 'solo' + (this.solo.has(t.id) ? ' on' : ''), onclick: () => { this.solo.has(t.id) ? this.solo.delete(t.id) : this.solo.add(t.id); s.classList.toggle('on'); this.apply(); } }, 'S');
    return h('div', { class: 'ms' }, m, s);
  },
  canvas(t, color) {
    const cv = h('canvas', { class: 'wave' }), dur = t.duration || this.dur;
    cv.onclick = e => { const r = cv.getBoundingClientRect(); this.seek((e.clientX - r.left) / r.width * dur); };
    const c = { cv, t, pk: null, color }; this.canvases.push(c);
    peaks(`/media/peaks/${t.hash}?s=${this.sid}`).then(p => { c.pk = p; this.drawOne(c); });
    return cv;
  },
  drawOne(c) { if (!c.cv.isConnected) return; drawWave(c.cv, c.pk, this.time > 0 || this.playing ? Math.min(1, this.time / (c.t.duration || this.dur || 1)) : null, c.t.kind === 'off' ? '--faint' : c.color || (c.t.kind === 'reference' ? '--teal' : '--acc')); },
  draw() { for (const c of this.canvases) this.drawOne(c); this.paint(); },
  tick() {
    if (!this.playing) return;
    if (this.time >= this.dur) { this.pause(); this.off = 0; this.draw(); return; }
    this.draw(); requestAnimationFrame(() => this.tick());
  },
};
window.addEventListener('resize', () => player.draw());

// One recording at a time, with an A/B switch to the version's reference mix at the same point in the song.
const recPlayer = {
  cur: null,
  stop() { if (this.cur) { this.cur.a.pause(); this.cur.b && this.cur.b.pause(); this.cur.sync(); this.cur = null; } },
  ui(sid, r, ref) {
    const a = new Audio(); a.preload = 'none'; a.src = `/media/rec/${sid}/${r.id}`;
    const b = ref ? new Audio() : null; if (b) { b.preload = 'none'; b.src = `/media/preview/${ref.hash}?s=${sid}`; b.muted = true; }
    const cv = h('canvas', { class: 'wave', style: 'margin-top:6px' }); let pk = null, abRef = false;
    const play = h('button', { class: 'sm on', style: 'min-width:64px' }, 'Play'), time = h('span', { class: 'note', style: 'font-variant-numeric:tabular-nums' }, fmtTime(0) + ' / ' + fmtTime(r.duration));
    const ab = b && h('button', { class: 'sm', title: 'Switch between this recording and the reference mix at the same point' }, 'Reference A/B');
    const me = { a, b, sync: () => { play.textContent = a.paused ? 'Play' : 'Pause'; } };
    const align = () => { if (b && Math.abs(b.currentTime - (a.currentTime + r.start)) > 0.06) b.currentTime = a.currentTime + r.start; };
    const draw = () => { time.textContent = fmtTime(a.currentTime) + ' / ' + fmtTime(r.duration); drawWave(cv, pk, a.currentTime / (r.duration || 1), abRef ? '--faint' : '--teal'); };
    play.onclick = () => { if (a.paused) { if (this.cur && this.cur !== me) this.stop(); player.pause(); this.cur = me; align(); a.play(); b && b.play().catch(() => {}); } else { a.pause(); b && b.pause(); } me.sync(); };
    if (ab) ab.onclick = () => { abRef = !abRef; ab.classList.toggle('on', abRef); a.muted = abRef; b.muted = !abRef; align(); draw(); };
    a.onpause = () => { b && b.pause(); me.sync(); }; a.onended = () => { b && b.pause(); me.sync(); };
    a.ontimeupdate = () => { draw(); if (b && !a.paused) { align(); } };
    a.onseeked = () => { align(); draw(); };
    cv.onclick = e => { const rc = cv.getBoundingClientRect(); a.currentTime = (e.clientX - rc.left) / rc.width * r.duration; };
    peaks(`/media/rec/${sid}/${r.id}/peaks`).then(p => { pk = p; draw(); });
    return h('div', {}, cv, h('div', { class: 'row', style: 'margin-top:4px' }, play, time, ab, !ref && h('span', { class: 'note' }, 'This version has no reference mix to compare with.')));
  },
};

// =====================================================================================
// Users (admin)
// =====================================================================================
async function usersPage(main) {
  if (!S.user.admin) return go('#/');
  const j = await api('GET', '/api/users'), keys = j.perms;
  const permBoxes = (perms, onchange) => h('div', { class: 'perms' }, keys.map(k => h('label', { title: PERM[k][1] }, h('input', { type: 'checkbox', checked: !!perms[k], onchange: e => onchange(k, e.target.checked) }), PERM[k][0])));
  const nu = { perms: { mix: true } };
  const un = h('input', { type: 'text', placeholder: 'User name' }), dn = h('input', { type: 'text', placeholder: 'Display name' }), pw = h('input', { type: 'password', placeholder: 'Password (8+ characters)' });
  const nadm = h('input', { type: 'checkbox' });
  const patch = (x, body) => act(async () => { await api('PATCH', '/api/users/' + x.id, body); if (x.id === S.user.id) S.user = (await api('GET', '/api/state')).user; });
  fill(main, h('div', { class: 'page one' }, S.msg && h('div', { class: 'errbox' }, S.msg),
    h('div', { class: 'card' }, h('h2', {}, 'People'),
      h('div', { class: 'note', style: 'margin-bottom:6px' }, 'Every person gets their own permissions. Admins can do everything. Hover a permission for what it allows.'),
      j.users.map(x => h('div', { class: 'urow' },
        h('div', { class: 'row', style: 'margin-bottom:6px' }, h('b', {}, x.display), h('span', { class: 'note' }, x.username), x.admin && h('span', { class: 'chip acc' }, 'Admin'), x.disabled && h('span', { class: 'chip bad' }, 'Turned off'), h('span', { class: 'grow' }),
          h('label', { class: 'row note' }, h('input', { type: 'checkbox', checked: x.admin, onchange: e => patch(x, { admin: e.target.checked }) }), 'Admin'),
          h('button', { class: 'sm', onclick: () => { const p = prompt(`New password for ${x.display} (8+ characters)`); p && patch(x, { password: p }); } }, 'Set password'),
          x.id !== S.user.id && h('button', { class: 'sm', onclick: () => patch(x, { disabled: !x.disabled }) }, x.disabled ? 'Turn on' : 'Turn off'),
          x.id !== S.user.id && h('button', { class: 'sm danger', onclick: () => confirm(`Remove ${x.display}? Their mixes and recordings stay.`) && act(async () => { await api('DELETE', '/api/users/' + x.id); }) }, 'Remove')),
        x.admin ? h('div', { class: 'note' }, 'Admins have every permission.') : permBoxes(x.perms, (k, v) => patch(x, { perms: { ...x.perms, [k]: v } }))))),
    h('div', { class: 'card' }, h('h2', {}, 'Add a person'), h('div', { class: 'row', style: 'margin-bottom:8px' }, un, dn, pw, h('label', { class: 'row note' }, nadm, 'Admin')),
      permBoxes(nu.perms, (k, v) => { nu.perms[k] = v; }),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'on', onclick: () => act(async () => { await api('POST', '/api/users', { username: un.value, display: dn.value, password: pw.value, admin: nadm.checked, perms: nu.perms }); }) }, 'Add')))));
}

// =====================================================================================
// Settings (admin)
// =====================================================================================
async function settingsPage(main) {
  if (!S.user.admin) return go('#/');
  const j = await api('GET', '/api/settings'), st = await api('GET', '/api/storage'), c = j.settings;
  const lwm = h('input', { type: 'text', value: c.lwmUrl, placeholder: 'https://truenas.local:9443' });
  const vu = h('input', { type: 'text', value: c.vaultUrl || '', placeholder: `${location.protocol}//${location.host} (the address you are using now)` });
  const keep = h('input', { type: 'checkbox', checked: c.keepOriginals });
  const ws = h('select', {}, Object.entries(TYPE).map(([v, l]) => h('option', { value: v, selected: c.watchSource === v }, l)));
  let saved = '';
  const save = () => act(async () => { await api('PUT', '/api/settings', { lwmUrl: lwm.value, vaultUrl: vu.value, keepOriginals: keep.checked, watchSource: ws.value }); S.msg = ''; saved = 'Saved'; });
  fill(main, h('div', { class: 'page one' }, S.msg && h('div', { class: 'errbox' }, S.msg),
    h('div', { class: 'card' }, h('h2', {}, 'LiveWebMixer'),
      field('LiveWebMixer address (as your browser opens it)', lwm),
      field('LiveVault address for LiveWebMixer (optional)', vu),
      h('div', { class: 'note' }, 'Open in LiveWebMixer (on every session and in the library) opens LiveWebMixer in a new tab and connects it as the person who clicked: no tokens to copy. LiveWebMixer reaches LiveVault at the address the browser is using, unless you fill in the one above (use it if the browser opens LiveVault by a name the LiveWebMixer container cannot look up, such as truenas.local).')),
    h('div', { class: 'card' }, h('h2', {}, 'Imports'),
      h('label', { class: 'row', style: 'margin-bottom:8px' }, keep, h('span', {}, 'Keep the original file when it was not already a 96 kHz WAV')),
      field('Type for sessions from the watch folder', ws),
      h('div', { class: 'note', style: 'margin-bottom:6px' }, j.import ? 'Master folder: mounted at /import. Library > Import > From the master folder imports straight from it.' : 'Master folder: not mounted. Add your master multitrack folder to the YAML as /import (read-only) to import from it without uploading.'),
      h('div', { class: 'note' }, j.watch ? `Watch folder is on (${j.watchDir}). Drop a folder of tracks, or a zip, into it: once the files stop changing it becomes a session with version 1.0.0 and the folder moves to _imported.` :
        'Watch folder is off. Mount a folder (for example an SMB share) at /watch in the container to turn it on.')),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: save }, 'Save settings'), h('span', { class: 'ok' }, saved)),
    h('div', { class: 'card' }, h('h2', {}, 'Storage'),
      [['Sessions', String(st.sessions)], ['Tracks (96 kHz WAV)', fmtMB(st.audio)], ['Originals', fmtMB(st.originals)], ['Previews and waveforms', fmtMB(st.previews)], ['Recordings', fmtMB(st.recordings)], ['Mixes', fmtMB(st.mixes)], st.free != null && ['Free space', fmtMB(st.free)]]
        .filter(Boolean).map(([k, v]) => h('div', { class: 'stat' }, h('span', {}, k), h('b', {}, v))),
      st.libraryError && h('div', { class: 'errbox', style: 'margin-top:8px' }, st.libraryError),
      h('div', { class: 'note', style: 'margin-top:8px' }, st.library ? `Audio is on the library drive (${st.library.path}${st.library.free != null ? ', ' + fmtMB(st.library.free) + ' free' : ''}). Each session has a readable folder there, with one folder per version, Recordings and Mixes; share the dataset over SMB read-only to browse it.` :
        'Audio is in the app\'s Docker volume. Mount a dataset at /library to keep it on a drive you can browse over SMB, with a readable folder per session.'),
      st.library && h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { onclick: () => act(async () => { const r = await api('POST', '/api/storage/library'); alert(`Library folders rebuilt (${r.folders} sessions).`); }) }, 'Rebuild library folders'),
        h('span', { class: 'note' }, 'Only needed if files in the session folders were moved or deleted by hand.')),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { onclick: () => act(async () => { const r = await api('POST', '/api/storage/cleanup'); S.msg = ''; alert(`Removed ${r.files} unused files (${fmtMB(r.bytes)}).`); }) }, 'Clean up unused audio'),
        h('span', { class: 'note' }, 'Deletes audio that no version or unsaved change uses any more (left behind by deleted sessions and discarded uploads).')))));
}

// =====================================================================================
// My account
// =====================================================================================
async function mePage(main) {
  const toks = (await api('GET', '/api/me/tokens')).tokens;
  const tokName = h('input', { type: 'text', class: 'grow', placeholder: 'Token name, e.g. LiveWebMixer on TrueNAS' });
  const dn = h('input', { type: 'text', value: S.user.display }), op = h('input', { type: 'password', placeholder: 'Current password' }), np = h('input', { type: 'password', placeholder: 'New password (8+ characters)' });
  let ok = '';
  const draw = () => fill(main, h('div', { class: 'page one', style: 'max-width:520px' }, S.msg && h('div', { class: 'errbox' }, S.msg),
    h('div', { class: 'card' }, h('h2', {}, 'My account'), h('div', { class: 'note', style: 'margin-bottom:8px' }, 'Signed in as ' + S.user.username),
      field('Display name', dn), field('Change password', h('div', { class: 'col', style: 'gap:6px' }, op, np)),
      h('div', { class: 'row' }, h('button', { class: 'on', onclick: async () => { try { S.msg = ''; const body = { display: dn.value }; if (np.value) Object.assign(body, { password: np.value, oldPassword: op.value }); S.user = (await api('PATCH', '/api/me', body)).user; ok = 'Saved'; op.value = np.value = ''; renderNav(); } catch (e) { S.msg = e.message; } draw(); } }, 'Save'), h('span', { class: 'ok' }, ok), h('span', { class: 'grow' }),
        h('button', { class: 'danger', onclick: async () => { await api('POST', '/api/logout').catch(() => {}); S.user = null; location.hash = ''; render(); } }, 'Sign out'))),
    h('div', { class: 'card' }, h('h2', {}, 'Access tokens'),
      h('div', { class: 'note', style: 'margin-bottom:8px' }, 'A token lets LiveWebMixer reach LiveVault as you, with your permissions: it sees the sessions you can see and saves mixes and recordings under your name. Paste it into LiveWebMixer > Setup > LiveVault library > Connection. Remove a token to cut that mixer off.'),
      newTok && h('div', { class: 'draft' }, h('div', { class: 'note' }, 'Copy this token now. It is not shown again.'), h('div', { class: 'row', style: 'margin-top:6px' }, h('input', { type: 'text', readOnly: true, value: newTok, class: 'grow', onfocus: e => e.target.select() }), h('button', { class: 'sm', onclick: () => navigator.clipboard && navigator.clipboard.writeText(newTok) }, 'Copy'))),
      toks.map(t => h('div', { class: 'li row', style: 'padding:6px 0;border-top:1px solid var(--line)' }, h('b', { class: 'grow' }, t.name), h('span', { class: 'note' }, `made ${fmtDate(t.created)} · ${t.used ? 'last used ' + fmtWhen(t.used) : 'not used yet'}`),
        h('button', { class: 'sm danger', onclick: () => confirm(`Remove the token "${t.name}"? Anything using it stops working.`) && act(async () => { await api('DELETE', '/api/me/tokens/' + t.id); }) }, 'Remove'))),
      h('div', { class: 'row', style: 'margin-top:8px' }, tokName, h('button', { class: 'on', onclick: () => act(async () => { const r = await api('POST', '/api/me/tokens', { name: tokName.value }); newTok = r.token; }, false).then(() => mePage(main)) }, 'Make a token')))));
  draw();
}

$('#themeBtn').onclick = () => { const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', t); ls('theme', t); player.draw(); };
(async () => {
  try { S.st = await api('GET', '/api/state'); S.user = S.st.user; $('#hVer').textContent = 'v' + S.st.version; }
  catch (e) { fill($('#main'), h('div', { class: 'errbox' }, 'Cannot reach the LiveVault server: ' + e.message)); return; }
  render();
})();
window.LV = { S, player };
