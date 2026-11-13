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
const fmtWhen = t => t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const SRC = { sq5: 'SQ-5 recording', purchased: 'Purchased', training: 'Training pack', daw: 'Studio / DAW', other: 'Other' };
const DIFF = { '': 'Not set', beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const KIND = { channel: 'Mixer channel', reference: 'Reference mix', off: 'Not used' };
const PERM = { upload: ['Add and edit', 'Create sessions, upload tracks, save versions'], edit: ['Edit info', 'Session info, training notes, license, reference mixes, review notes'],
  delete: ['Delete', 'Delete sessions and other people\'s mixes and recordings'], download: ['Download', 'Download the audio files'], mix: ['Mix', 'Open sessions in LiveWebMixer, save mixes and recordings'],
  seeMixes: ['See all mixes', 'See everyone\'s mixes and recordings, not only their own'], licensed: ['Licensed sessions', 'See sessions marked as license-restricted'] };

let newTok = '';
const S = { st: null, user: null, sessions: [], s: null, view: null, mixes: [], recs: [], people: [], q: '', fSrc: '', fDiff: '', fTag: '', msg: '', up: '', bump: 'minor' };

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
    S.user.admin && h('button', { class: r.page === 'settings' ? 'on' : '', onclick: () => go('#/settings') }, 'Settings'));
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
  const un = h('input', { type: 'text', placeholder: 'User name', autocomplete: 'username' }), dn = h('input', { type: 'text', placeholder: 'Display name (shown to others)' });
  const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: setup ? 'new-password' : 'current-password' });
  const err = h('div', { class: 'errbox hide' });
  const submit = async () => {
    try {
      const j = await api('POST', setup ? '/api/setup' : '/api/login', { username: un.value, password: pw.value, display: dn.value });
      S.user = j.user; S.st = await api('GET', '/api/state'); render();
    } catch (e) { err.textContent = e.message; err.classList.remove('hide'); }
  };
  pw.onkeydown = e => e.key === 'Enter' && submit();
  return h('div', { class: 'login card' }, h('h2', {}, setup ? 'Set up LiveVault' : 'Sign in'),
    setup && h('div', { class: 'note', style: 'margin-bottom:10px' }, 'Create the first account. It is an admin and can add everyone else under Users.'),
    un, setup && dn, pw, h('div', { class: 'row' }, h('button', { class: 'on grow', onclick: submit }, setup ? 'Create admin account' : 'Sign in')), h('div', { style: 'margin-top:8px' }, err));
}

// =====================================================================================
// Library
// =====================================================================================
async function libraryPage(main) {
  const j = await api('GET', '/api/sessions'); S.sessions = j.sessions;
  const st = await api('GET', '/api/state'); status(st.busy);
  const tags = [...new Set(S.sessions.flatMap(s => s.tags))].sort();
  const q = S.q.toLowerCase();
  const list = S.sessions.filter(s => (!q || (s.name + ' ' + s.artist + ' ' + s.tags.join(' ')).toLowerCase().includes(q)) && (!S.fSrc || s.source === S.fSrc) && (!S.fDiff || s.difficulty === S.fDiff) && (!S.fTag || s.tags.includes(S.fTag)));
  const search = h('input', { type: 'search', placeholder: 'Search name, artist, tag', value: S.q, style: 'width:100%' });
  search.oninput = () => { S.q = search.value; const pos = search.selectionStart; libraryPage(main).then(() => { const n = $('#main input[type=search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
  const chipRow = (cur, opts, set) => h('div', { class: 'chips filters', style: 'margin-bottom:10px' }, opts.map(([v, l]) => h('span', { class: 'chip' + (cur === v ? ' on' : ''), onclick: () => { set(cur === v ? '' : v); render(); } }, l)));
  const nameIn = h('input', { type: 'text', placeholder: 'New session name', class: 'grow' });
  const add = () => nameIn.value.trim() && act(async () => { const s = await api('POST', '/api/sessions', { name: nameIn.value.trim() }); go('#/s/' + s.id + '/draft'); }, false);
  nameIn.onkeydown = e => e.key === 'Enter' && add();
  fill(main, h('div', { class: 'page' },
    h('div', { class: 'col' },
      h('div', { class: 'card' }, h('h2', {}, 'Find'), search,
        h('div', { class: 'note', style: 'margin:10px 0 4px' }, 'Source'), chipRow(S.fSrc, Object.entries(SRC), v => S.fSrc = v),
        h('div', { class: 'note', style: 'margin:0 0 4px' }, 'Difficulty'), chipRow(S.fDiff, Object.entries(DIFF).filter(([k]) => k), v => S.fDiff = v),
        tags.length ? [h('div', { class: 'note', style: 'margin:0 0 4px' }, 'Tags'), chipRow(S.fTag, tags.map(t => [t, t]), v => S.fTag = v)] : null),
      S.user.perms.upload || S.user.admin ? h('div', { class: 'card' }, h('h2', {}, 'New session'), h('div', { class: 'row' }, nameIn, h('button', { class: 'on', onclick: add }, 'Add')),
        h('div', { class: 'note', style: 'margin-top:8px' }, st.watch ? 'Or drop a folder of tracks into the watch folder; it becomes a session on its own.' : 'Tip: an admin can connect a watch folder so dropped folders import on their own.')) : null),
    h('div', { class: 'col' }, S.msg && h('div', { class: 'errbox' }, S.msg),
      h('div', { class: 'card' }, h('h2', {}, `Sessions · ${list.length}${list.length !== S.sessions.length ? ' of ' + S.sessions.length : ''}`),
        !S.sessions.length ? h('div', { class: 'note' }, 'No sessions yet.') : !list.length ? h('div', { class: 'note' }, 'Nothing matches those filters.') :
        h('div', { style: 'overflow-x:auto' }, h('table', { class: 'tr' }, h('thead', {}, h('tr', {}, ['Name', 'Source', 'Version', 'Tracks', 'Length', 'Tags', ''].map(x => h('th', {}, x)))),
          h('tbody', {}, list.map(s => h('tr', { class: 'click', onclick: () => go('#/s/' + s.id) },
            h('td', {}, h('b', {}, s.name), s.artist && h('div', { class: 'note' }, s.artist)),
            h('td', {}, h('span', { class: 'chip' }, SRC[s.source] || s.source)),
            h('td', { class: 'num' }, s.version ? 'v' + s.version : '–', s.draft && h('span', { class: 'chip warn', style: 'margin-left:6px', title: 'Has unsaved changes' }, 'Draft')),
            h('td', { class: 'num' }, String(s.tracks)), h('td', { class: 'num' }, fmtTime(s.duration)),
            h('td', {}, h('div', { class: 'chips' }, s.difficulty && h('span', { class: 'chip teal' }, DIFF[s.difficulty]), s.tags.slice(0, 4).map(t => h('span', { class: 'chip' }, t)))),
            h('td', {}, s.restricted && h('span', { class: 'chip warn', title: 'License-restricted' }, 'Licensed')))))))))));
}

// =====================================================================================
// Session page
// =====================================================================================
let pollT = 0;
async function loadSession(sid) {
  S.s = await api('GET', '/api/sessions/' + sid);
  [S.mixes, S.recs] = await Promise.all([api('GET', `/api/sessions/${sid}/mixes`).then(j => j.mixes), api('GET', `/api/sessions/${sid}/recordings`).then(j => j.recordings)]);
  if (S.s.can.edit && !S.people.length) S.people = (await api('GET', '/api/people')).people;
}
function viewTracks(s, view) {
  if (view === 'draft') return s.draft ? s.draft.tracks : (s.versions.length ? s.versions[s.versions.length - 1].tracks.map(t => ({ ...t, status: 'ready' })) : []);
  const v = s.versions.find(x => x.v === view) || s.versions[s.versions.length - 1];
  return v ? v.tracks : [];
}
async function sessionPage(main, sid, view) {
  if (!S.s || S.s.id !== sid || !main.firstChild || main.dataset.sid !== sid) { player.stop(); recPlayer.stop(); await loadSession(sid); }
  const s = S.s, latest = s.versions[s.versions.length - 1];
  if (view !== 'draft' && view && !s.versions.some(v => v.v === view)) view = null;
  if (!view) view = latest ? latest.v : 'draft';
  if (view === 'draft' && !s.can.upload && !s.draft) view = latest ? latest.v : 'draft';
  S.view = view; main.dataset.sid = sid;
  const editing = view === 'draft';
  const tracks = viewTracks(s, view);
  const busy = s.draft && s.draft.tracks.some(t => t.status === 'queued' || t.status === 'processing');
  status(busy ? s.draft.tracks.filter(t => t.status === 'queued' || t.status === 'processing').length : 0);
  clearTimeout(pollT);
  if (busy) pollT = setTimeout(async () => { if (route().a !== sid) return; try { S.s = await api('GET', '/api/sessions/' + sid); if (route().a === sid) sessionPage(main, sid, route().b && decodeURIComponent(route().b)); } catch {} }, 1500);
  player.setTracks(sid, tracks.filter(t => t.status === 'ready' || !t.status));

  const verSel = h('select', { id: 'verSel', onchange: () => go(`#/s/${sid}/${encodeURIComponent(verSel.value)}`) },
    (s.draft || s.can.upload) && h('option', { value: 'draft', selected: editing }, s.draft ? 'Unsaved changes' : 'Edit (new version)'),
    [...s.versions].reverse().map(v => h('option', { value: v.v, selected: view === v.v }, 'v' + v.v + (v === latest ? ' (latest)' : ''))));
  const openBtn = s.can.mix && latest && !editing && h('button', { class: 'on', title: s.can.lwm ? 'Open this version in LiveWebMixer' : 'An admin needs to enter the LiveWebMixer address in Settings', disabled: !s.can.lwm, onclick: () => openInMixer(view) }, 'Open in LiveWebMixer');
  let delArmed = false;
  const del = s.can.delete && h('button', { class: 'danger', onclick: () => { if (!delArmed) { delArmed = true; del.textContent = 'Really delete this session?'; return; } act(async () => { await api('DELETE', '/api/sessions/' + sid); S.s = null; go('#/'); }, false); } }, 'Delete session');

  fill(main, h('div', { class: 'page' },
    h('div', { class: 'col' }, infoCard(s), trainingCard(s), licenseCard(s)),
    h('div', { class: 'col' },
      S.msg && h('div', { class: 'errbox' }, S.msg),
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'margin-bottom:6px' }, h('div', { class: 'grow' }, h('p', { class: 'title' }, s.name), h('div', { class: 'sub' }, [s.artist, SRC[s.source], s.bpm && s.bpm + ' BPM', s.key && 'Key ' + s.key].filter(Boolean).join(' · '))),
          verSel, openBtn, del),
        tracksSection(s, view, tracks, editing)),
      versionsCard(s, view), mixesCard(s), recordingsCard(s))));
  player.draw();
}

// ---- left column ----
const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
function infoCard(s) {
  if (!s.can.edit) return h('div', { class: 'card' }, h('h2', {}, 'Session'),
    [['Artist', s.artist], ['Source', SRC[s.source] + (s.sourceNote ? ' · ' + s.sourceNote : '')], ['Tempo', s.bpm && s.bpm + ' BPM'], ['Key', s.key], ['Added', fmtDate(s.created) + ' by ' + (s.names[s.createdBy] || '')]]
      .map(([k, v]) => h('div', { class: 'stat' }, h('span', { class: 'note' }, k), h('span', {}, v || '–'))));
  const save = body => act(async () => { S.s = { ...(await api('PATCH', '/api/sessions/' + s.id, body)), names: S.s.names }; }, true);
  const inp = (k, ph) => { const el = h('input', { type: 'text', value: s[k] || '', placeholder: ph || '' }); el.onchange = () => save({ [k]: el.value }); return el; };
  const src = h('select', { onchange: () => save({ source: src.value }) }, Object.entries(SRC).map(([v, l]) => h('option', { value: v, selected: s.source === v }, l)));
  return h('div', { class: 'card' }, h('h2', {}, 'Session'), field('Name', inp('name')), field('Artist', inp('artist')),
    h('div', { class: 'two' }, field('Tempo (BPM)', inp('bpm')), field('Key', inp('key'))),
    field('Source', src), field('Source details', inp('sourceNote', 'e.g. Sunday 9:30 service, MultiTracks.com')),
    h('div', { class: 'note' }, `Added ${fmtDate(s.created)} by ${s.names[s.createdBy] || ''}`));
}
function trainingCard(s) {
  if (!s.can.edit) return h('div', { class: 'card' }, h('h2', {}, 'Training'),
    h('div', { class: 'chips', style: 'margin-bottom:8px' }, s.difficulty && h('span', { class: 'chip teal' }, DIFF[s.difficulty]), s.tags.map(t => h('span', { class: 'chip' }, t))),
    h('div', { class: 'note' }, 'Listen for'), h('div', { class: 'ro' + (s.listenFor ? '' : ' empty'), style: 'margin-bottom:8px' }, s.listenFor || 'Nothing yet'),
    h('div', { class: 'note' }, 'Notes'), h('div', { class: 'ro' + (s.notes ? '' : ' empty') }, s.notes || 'Nothing yet'));
  const save = body => act(async () => { S.s = { ...(await api('PATCH', '/api/sessions/' + s.id, body)), names: S.s.names }; }, true);
  const dif = h('select', { onchange: () => save({ difficulty: dif.value }) }, Object.entries(DIFF).map(([v, l]) => h('option', { value: v, selected: s.difficulty === v }, l)));
  const tags = h('input', { type: 'text', value: s.tags.join(', '), placeholder: 'vocal-heavy, acoustic, full band' }); tags.onchange = () => save({ tags: tags.value.split(',') });
  const lf = h('textarea', { placeholder: 'What should a trainee listen for? e.g. kick and bass fighting at 80 Hz, harsh lead vocal in the bridge' }, s.listenFor); lf.onchange = () => save({ listenFor: lf.value });
  const nt = h('textarea', { placeholder: 'Assignments, background, anything else' }, s.notes); nt.onchange = () => save({ notes: nt.value });
  return h('div', { class: 'card' }, h('h2', {}, 'Training'), field('Difficulty', dif), field('Tags (comma separated)', tags), field('Listen for', lf), field('Notes', nt));
}
function licenseCard(s) {
  const L = s.license;
  if (!s.can.edit) return L.kind === 'none' && !L.restricted ? null : h('div', { class: 'card' }, h('h2', {}, 'License'),
    h('div', { class: 'stat' }, h('span', { class: 'note' }, 'Type'), h('span', {}, L.kind === 'purchased' ? 'Purchased' : L.kind === 'other' ? 'Other' : 'None')),
    L.holder && h('div', { class: 'stat' }, h('span', { class: 'note' }, 'Licensed to'), h('span', {}, L.holder)), L.terms && h('div', { class: 'ro', style: 'margin-top:6px' }, L.terms),
    L.restricted && h('div', { class: 'note', style: 'margin-top:6px' }, 'Only people with access to licensed sessions can see this one.'));
  const save = license => act(async () => { S.s = { ...(await api('PATCH', '/api/sessions/' + s.id, { license })), names: S.s.names }; }, true);
  const kind = h('select', { onchange: () => save({ kind: kind.value }) }, [['none', 'None / our own recording'], ['purchased', 'Purchased'], ['other', 'Other license']].map(([v, l]) => h('option', { value: v, selected: L.kind === v }, l)));
  const holder = h('input', { type: 'text', value: L.holder, placeholder: 'e.g. Rolling Hills Community Church' }); holder.onchange = () => save({ holder: holder.value });
  const terms = h('textarea', { placeholder: 'What the license allows' }, L.terms); terms.onchange = () => save({ terms: terms.value });
  const restr = h('input', { type: 'checkbox', checked: L.restricted, onchange: () => save({ restricted: restr.checked }) });
  return h('div', { class: 'card' }, h('h2', {}, 'License'), field('Type', kind), field('Licensed to', holder), field('Terms', terms),
    h('label', { class: 'row', style: 'margin-bottom:6px' }, restr, h('span', {}, 'Restrict who can see this session')),
    L.restricted && h('div', {}, h('div', { class: 'note', style: 'margin-bottom:4px' }, 'People with "Licensed sessions" access can always see it. Also allow:'),
      h('div', { class: 'perms' }, S.people.map(p => h('label', {}, h('input', { type: 'checkbox', checked: L.allow.includes(p.id), onchange: e => save({ allow: e.target.checked ? [...L.allow, p.id] : L.allow.filter(x => x !== p.id) }) }), p.display)))));
}

// ---- tracks ----
function tracksSection(s, view, tracks, editing) {
  const sid = s.id, kids = [];
  if (editing) {
    const d = s.draft, latest = s.versions[s.versions.length - 1];
    const file = h('input', { type: 'file', multiple: true, accept: 'audio/*,.zip,.wav,.aif,.aiff,.flac,.mp3,.m4a,.ogg,.opus,.caf', class: 'hide', onchange: () => file.files.length && upload(file.files) });
    const drop = h('div', { class: 'drop', onclick: () => file.click() }, h('b', {}, 'Drop multitrack files here'),
      h('div', { class: 'note', id: 'upTxt' }, S.up || 'or click to choose. WAV, AIFF, FLAC, MP3, M4A, or a zip of the whole session. Everything is stored as 96 kHz / 24-bit WAV; files with more than two channels are split into one track per channel.'));
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files.length && upload(e.dataTransfer.files); };
    const msg = h('input', { type: 'text', class: 'grow', placeholder: latest ? 'What changed? (shown in the history)' : 'Notes for the first version (optional)' });
    const notReady = d && d.tracks.some(t => t.status !== 'ready');
    const next = bump(latest && latest.v, S.bump);
    kids.push(file, drop, h('div', { class: 'draft' },
      h('div', { class: 'row' }, h('b', {}, d ? (d.restoredFrom ? `Restored from v${d.restoredFrom}` : latest ? `Unsaved changes on v${d.base || latest.v}` : 'New session, not saved yet') : 'Editing: changes become a new version'),
        d && d.by && h('span', { class: 'note' }, 'by ' + (s.names[d.by] || ''))),
      h('div', { class: 'row', style: 'margin-top:8px' },
        latest && h('div', { class: 'seg' }, [['major', 'Major'], ['minor', 'Minor'], ['patch', 'Patch']].map(([k, l]) => h('button', { class: S.bump === k ? 'on' : '', onclick: () => { S.bump = k; render(); } }, l))),
        msg, h('button', { class: 'on', disabled: !d || notReady || !d.tracks.length, onclick: () => act(async () => { const j = await api('POST', `/api/sessions/${sid}/versions`, { bump: S.bump, message: msg.value }); S.s = j.session; go(`#/s/${sid}/${j.version}`); }, false) }, 'Save v' + next),
        d && h('button', { onclick: () => act(async () => { S.s = await api('POST', `/api/sessions/${sid}/draft/discard`); go(`#/s/${sid}`); }, false) }, 'Discard')),
      d && latest && h('div', { class: 'note', style: 'margin-top:6px' }, changesText(diffLocal(viewTracks(s, d.restoredFrom || d.base || latest.v), d.tracks)) || 'No changes yet.')));
  }
  kids.push(player.transport(tracks));
  if (!tracks.length) kids.push(h('div', { class: 'note' }, editing ? 'No tracks yet. Drop the files above.' : 'This version has no tracks.'));
  let no = 0;
  tracks.forEach((t, i) => {
    const off = t.kind === 'off', n = t.kind === 'channel' ? String(++no) : t.kind === 'reference' ? 'REF' : '–';
    const ready = !t.status || t.status === 'ready';
    const info = ready ? `${t.channels > 1 ? 'Stereo' : 'Mono'} · ${fmtTime(t.duration)}${t.srcFormat ? ' · from ' + t.srcFormat : ''}` : t.status === 'error' ? '' : t.status === 'processing' ? 'Converting…' : 'Waiting…';
    const wave = ready && t.hash ? player.canvas(t) : h('div', { class: t.status === 'error' ? 'bad note' : 'note' }, t.status === 'error' ? 'Failed: ' + t.error : '');
    if (editing) {
      const nm = h('input', { type: 'text', value: t.name, onchange: () => patchT(t, { name: nm.value }) });
      const kind = h('select', { class: 'sm', onchange: () => patchT(t, { kind: kind.value }) }, Object.entries(KIND).map(([v, l]) => h('option', { value: v, selected: t.kind === v }, l)));
      const rep = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac,.mp3,.m4a,.caf', class: 'hide', onchange: () => rep.files.length && upload(rep.files, t.id) });
      kids.push(h('div', { class: 'trk edit' + (off ? ' off' : '') + (t.kind === 'reference' ? ' ref' : '') },
        h('span', { class: 'no' }, n), h('div', {}, nm, h('div', { class: 'note', style: 'font-size:11px;margin-top:2px' }, info)), kind, wave,
        h('div', { class: 'acts' }, h('button', { class: 'sm', disabled: i === 0, onclick: () => move(i, -1) }, '▲'), h('button', { class: 'sm', disabled: i === tracks.length - 1, onclick: () => move(i, 1) }, '▼'),
          h('button', { class: 'sm', title: 'Replace the audio of this track', onclick: () => rep.click() }, 'Replace'), rep,
          h('button', { class: 'sm danger', title: 'Remove track', onclick: () => act(async () => { S.s = await api('DELETE', `/api/sessions/${sid}/draft/tracks/${t.id}`); }) }, '✕'))));
    } else {
      kids.push(h('div', { class: 'trk' + (off ? ' off' : '') + (t.kind === 'reference' ? ' ref' : '') },
        h('span', { class: 'no' }, n), h('div', { class: 'nm', title: t.srcName || '' }, t.name, h('small', {}, info)), player.buttons(t), wave,
        h('div', { class: 'acts' }, s.can.download && h('a', { href: `/api/sessions/${sid}/files/${t.hash}`, download: '' }, h('button', { class: 'sm', title: 'Download the 96 kHz WAV' }, 'WAV')),
          s.can.download && t.origHash && h('a', { href: `/api/sessions/${sid}/files/${t.origHash}?orig=1`, download: '' }, h('button', { class: 'sm', title: 'Download the file as it was uploaded' }, 'Original')))));
    }
  });
  return kids;
  function patchT(t, body) { act(async () => { S.s = await api('PATCH', `/api/sessions/${sid}/draft/tracks/${t.id}`, body); if (route().b !== 'draft') go(`#/s/${sid}/draft`); }); }
  function move(i, d) { const ids = tracks.map(t => t.id), j = i + d; [ids[i], ids[j]] = [ids[j], ids[i]]; act(async () => { S.s = await api('PATCH', `/api/sessions/${sid}/draft`, { order: ids }); }); }
}
function upload(files, replace) {
  const list = [...files], sid = S.s.id;
  act(async () => {
    for (let i = 0; i < list.length; i++) {
      await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `/api/sessions/${sid}/upload?name=${encodeURIComponent(list[i].name)}${replace ? '&replace=' + replace : ''}`);
        x.setRequestHeader('x-livevault', '1');
        x.upload.onprogress = e => { S.up = `Uploading ${i + 1} of ${list.length}: ${list[i].name} (${Math.round(e.loaded / e.total * 100)}%)`; const el = $('#upTxt'); if (el) el.textContent = S.up; };
        x.onload = () => { if (x.status === 200) { S.s = { ...JSON.parse(x.responseText) }; resolve(); } else reject(new Error((JSON.parse(x.responseText || '{}').error) || 'Upload failed')); };
        x.onerror = () => reject(new Error('Upload failed: connection lost'));
        x.send(list[i]);
      }).finally(() => { S.up = ''; });
      render();
    }
    if (route().b !== 'draft') go(`#/s/${sid}/draft`);
  });
}
function bump(v, k) { if (!v) return '1.0.0'; let [a, b, c] = v.split('.').map(Number); if (k === 'major') { a++; b = 0; c = 0; } else if (k === 'minor') { b++; c = 0; } else c++; return `${a}.${b}.${c}`; }
function diffLocal(a, b) {
  const A = new Map(a.map(t => [t.id, t])), B = new Map(b.map(t => [t.id, t])), o = { added: [], removed: [], renamed: [], replaced: [], kind: [], reordered: false };
  for (const t of b) { const x = A.get(t.id); if (!x) o.added.push(t.name); else { if (x.name !== t.name) o.renamed.push([x.name, t.name]); if (x.hash !== t.hash) o.replaced.push(t.name); if (x.kind !== t.kind) o.kind.push([t.name, x.kind, t.kind]); } }
  for (const t of a) if (!B.has(t.id)) o.removed.push(t.name);
  o.reordered = a.filter(t => B.has(t.id)).map(t => t.id).join() !== b.filter(t => A.has(t.id)).map(t => t.id).join();
  return o;
}
function changesText(c) {
  if (!c) return '';
  const p = [];
  if (c.added.length) p.push('Added ' + c.added.join(', '));
  if (c.removed.length) p.push('Removed ' + c.removed.join(', '));
  if (c.replaced.length) p.push('New audio for ' + c.replaced.join(', '));
  if (c.renamed.length) p.push('Renamed ' + c.renamed.map(([a, b]) => `${a} → ${b}`).join(', '));
  if (c.kind.length) p.push(c.kind.map(([n, , k]) => `${n} is now ${KIND[k].toLowerCase()}`).join(', '));
  if (c.reordered) p.push('Changed the track order');
  return p.join('. ');
}

// ---- versions ----
function versionsCard(s, view) {
  if (!s.versions.length) return null;
  const latest = s.versions[s.versions.length - 1];
  return h('div', { class: 'card' }, h('h2', {}, 'History'), [...s.versions].reverse().map(v => h('div', { class: 'ver' },
    h('span', { class: 'v' + (v.v === view ? ' cur' : '') }, 'v' + v.v),
    h('div', { class: 'grow' }, h('div', {}, v.message || (v.v === '1.0.0' ? 'First version' : h('span', { class: 'note' }, 'No notes'))),
      h('div', { class: 'what' }, `${fmtWhen(v.created)} · ${s.names[v.by] || ''} · ${v.tracks.length} tracks`, v.changes && v.v !== '1.0.0' && changesText(v.changes) ? ' · ' + changesText(v.changes) : '')),
    v.v !== view && h('button', { class: 'sm', onclick: () => go(`#/s/${s.id}/${v.v}`) }, 'View'),
    s.can.upload && v !== latest && h('button', { class: 'sm', title: 'Start a new version from this one', onclick: () => act(async () => { S.s = await api('POST', `/api/sessions/${s.id}/restore`, { version: v.v }); go(`#/s/${s.id}/draft`); }, false) }, 'Restore'))));
}

// ---- mixes ----
async function openInMixer(version) {
  const w = window.open('', '_blank');
  try { const j = await api('POST', `/api/sessions/${S.s.id}/open`, { version }); if (w) w.location = j.url; else location.href = j.url; }
  catch (e) { if (w) w.close(); S.msg = e.message; render(); }
}
function mixesCard(s) {
  const sid = s.id;
  return h('div', { class: 'card' }, h('h2', {}, 'Mixes'),
    !S.mixes.length ? h('div', { class: 'note' }, s.can.mix ? 'No mixes yet. Mixes made in LiveWebMixer are saved here, one per person for each version.' : 'No mixes you can see yet.') :
    S.mixes.map(m => h('div', { class: 'item' }, h('div', { class: 'row' },
      h('b', { class: 'grow' }, m.name, m.reference && h('span', { class: 'chip teal', style: 'margin-left:6px' }, 'Reference')),
      m.lwm && m.by === S.user.id && s.can.lwm && h('button', { class: 'sm on', title: 'Open this version in LiveWebMixer, where this mix loads', onclick: () => openInMixer(m.version) }, 'Open'),
      s.can.edit && h('button', { class: 'sm', title: 'Reference mixes are visible to everyone who can see the session', onclick: () => act(async () => { await api('PATCH', `/api/sessions/${sid}/mixes/${m.id}`, { reference: !m.reference }); await loadSession(sid); }) }, m.reference ? 'Unmark reference' : 'Mark as reference'),
      (m.by === S.user.id || S.user.admin) && h('button', { class: 'sm', onclick: () => { const n = prompt('Mix name', m.name); n && act(async () => { await api('PATCH', `/api/sessions/${sid}/mixes/${m.id}`, { name: n }); await loadSession(sid); }); } }, 'Rename'),
      h('a', { href: `/api/sessions/${sid}/mixes/${m.id}/download`, download: '' }, h('button', { class: 'sm' }, 'JSON')),
      (m.by === S.user.id || s.can.delete) && h('button', { class: 'sm danger', onclick: () => confirm(`Delete the mix "${m.name}"?`) && act(async () => { await api('DELETE', `/api/sessions/${sid}/mixes/${m.id}`); await loadSession(sid); }) }, '✕')),
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
          (r.by === S.user.id || S.user.admin) && h('button', { class: 'sm', onclick: () => { const n = prompt('Recording name', r.name); n && act(async () => { await api('PATCH', `/api/sessions/${sid}/recordings/${r.id}`, { name: n }); await loadSession(sid); }); } }, 'Rename'),
          (s.can.download || r.by === S.user.id) && h('a', { href: `/api/sessions/${sid}/recordings/${r.id}/download`, download: '' }, h('button', { class: 'sm' }, 'WAV')),
          (r.by === S.user.id || s.can.delete) && h('button', { class: 'sm danger', onclick: () => confirm(`Delete the recording "${r.name}"?`) && act(async () => { recPlayer.stop(); await api('DELETE', `/api/sessions/${sid}/recordings/${r.id}`); await loadSession(sid); }) }, '✕')),
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
    g.fillStyle = css.getPropertyValue(color || '--acc');
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
  canvas(t) {
    const cv = h('canvas', { class: 'wave' }), dur = t.duration || this.dur;
    cv.onclick = e => { const r = cv.getBoundingClientRect(); this.seek((e.clientX - r.left) / r.width * dur); };
    const c = { cv, t, pk: null }; this.canvases.push(c);
    peaks(`/media/peaks/${t.hash}?s=${this.sid}`).then(p => { c.pk = p; this.drawOne(c); });
    return cv;
  },
  drawOne(c) { if (!c.cv.isConnected) return; drawWave(c.cv, c.pk, this.time > 0 || this.playing ? Math.min(1, this.time / (c.t.duration || this.dur || 1)) : null, c.t.kind === 'reference' ? '--teal' : c.t.kind === 'off' ? '--faint' : '--acc'); },
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
  const keep = h('input', { type: 'checkbox', checked: c.keepOriginals });
  const ws = h('select', {}, Object.entries(SRC).map(([v, l]) => h('option', { value: v, selected: c.watchSource === v }, l)));
  let saved = '';
  const save = () => act(async () => { await api('PUT', '/api/settings', { lwmUrl: lwm.value, keepOriginals: keep.checked, watchSource: ws.value }); S.msg = ''; saved = 'Saved'; });
  fill(main, h('div', { class: 'page one' }, S.msg && h('div', { class: 'errbox' }, S.msg),
    h('div', { class: 'card' }, h('h2', {}, 'LiveWebMixer'),
      field('LiveWebMixer address (as your browser opens it)', lwm),
      h('div', { class: 'note' }, `Connect LiveWebMixer once from its Setup page: LiveVault address http://${location.hostname}:9580 (the http port) and an access token made under My account. LiveWebMixer then plays sessions straight from here and saves mixes and recordings as the token's owner. "Open in LiveWebMixer" on a session opens that version there.`)),
    h('div', { class: 'card' }, h('h2', {}, 'Imports'),
      h('label', { class: 'row', style: 'margin-bottom:8px' }, keep, h('span', {}, 'Keep the original file when it was not already a 96 kHz WAV')),
      field('Source for sessions from the watch folder', ws),
      h('div', { class: 'note' }, j.watch ? `Watch folder is on (${j.watchDir}). Drop a folder of tracks, or a zip, into it: once the files stop changing it becomes a session with version 1.0.0 and the folder moves to _imported.` :
        'Watch folder is off. Mount a folder (for example an SMB share) at /watch in the container to turn it on.')),
    h('div', { class: 'row' }, h('button', { class: 'on', onclick: save }, 'Save settings'), h('span', { class: 'ok' }, saved)),
    h('div', { class: 'card' }, h('h2', {}, 'Storage'),
      [['Sessions', String(st.sessions)], ['Tracks (96 kHz WAV)', fmtMB(st.audio)], ['Originals', fmtMB(st.originals)], ['Previews and waveforms', fmtMB(st.previews)], ['Recordings', fmtMB(st.recordings)], ['Mixes', fmtMB(st.mixes)], st.free != null && ['Free space', fmtMB(st.free)]]
        .filter(Boolean).map(([k, v]) => h('div', { class: 'stat' }, h('span', {}, k), h('b', {}, v))),
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
