// Smoke test: start the server on a temp folder and exercise the API end to end
// (sign-in, permissions, uploads and 96 kHz conversion, versions, licenses, the LiveWebMixer link, mixes, recordings, watch folder).
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const root = path.join(__dirname, '..'), data = fs.mkdtempSync(path.join(os.tmpdir(), 'lv-')), watch = path.join(data, 'watch'), port = 19000 + Math.floor(Math.random() * 900);
const base = 'http://127.0.0.1:' + port;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  let cookie = '';
  const req = async (m, u, b, extra = {}) => {
    const raw = Buffer.isBuffer(b);
    const r = await fetch(base + u, { method: m, headers: { 'x-livevault': '1', ...(cookie ? { Cookie: cookie } : {}), ...(b && !raw ? { 'Content-Type': 'application/json' } : {}), ...extra }, body: b ? (raw ? b : JSON.stringify(b)) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  return req;
}
const tone = (f, rate, ch, d = 1) => { const out = path.join(data, `t${f}-${rate}-${ch}.wav`); assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${f}:d=${d}:sample_rate=${rate}`, '-ac', String(ch), out]).status, 0); return fs.readFileSync(out); };
async function untilReady(A, sid) { for (let i = 0; i < 200; i++) { const s = (await A('GET', '/api/sessions/' + sid)).body; const ts = s.draft ? s.draft.tracks : []; if (!ts.some(t => t.status === 'queued' || t.status === 'processing')) return s; await sleep(100); } throw new Error('conversion timed out'); }

(async () => {
  for (const f of ['server.js']) assert.strictEqual(spawnSync(process.execPath, ['--check', path.join(root, f)]).status, 0, f + ' has a syntax error');
  for (const f of fs.readdirSync(path.join(root, 'public/js'))) { const t = path.join(data, f.replace('.js', '.mjs')); fs.writeFileSync(t, fs.readFileSync(path.join(root, 'public/js', f))); assert.strictEqual(spawnSync(process.execPath, ['--check', t]).status, 0, f + ' has a syntax error'); }
  fs.mkdirSync(watch);
  const srv = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, DATA_DIR: path.join(data, 'd'), WATCH_DIR: watch, WATCH_SCAN_MS: '300', PORT: port, HTTPS_PORT: '0' }, stdio: 'inherit' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/state'); break; } catch { await sleep(100); } }
    const A = client(), T = client(), anon = client();
    let r = await A('GET', '/api/state'); assert.strictEqual(r.body.needsSetup, true); assert.strictEqual(r.body.watch, true);
    assert.strictEqual((await fetch(base + '/')).status, 200);
    assert.strictEqual((await fetch(base + '/../server.js')).status, 404);
    assert.strictEqual((await anon('GET', '/api/sessions')).status, 401);
    assert.strictEqual((await fetch(base + '/api/setup', { method: 'POST', body: '{}' })).status, 403, 'CSRF header required');
    r = await A('POST', '/api/setup', { username: 'jerod', password: 'short' }); assert.strictEqual(r.status, 400);
    r = await A('POST', '/api/setup', { username: 'jerod', password: 'longenough1', display: 'Jerod' }); assert.strictEqual(r.status, 200); assert.ok(r.body.user.admin);
    assert.strictEqual((await anon('POST', '/api/setup', { username: 'x', password: 'longenough1' })).status, 400);
    r = await A('POST', '/api/users', { username: 'trainee', password: 'trainee123', display: 'Trainee', perms: { mix: true } }); assert.strictEqual(r.status, 200);
    const tid = r.body.user.id;
    assert.strictEqual((await T('POST', '/api/login', { username: 'trainee', password: 'nope' })).status, 401);
    assert.strictEqual((await T('POST', '/api/login', { username: 'trainee', password: 'trainee123' })).status, 200);
    assert.strictEqual((await T('POST', '/api/sessions', { name: 'x' })).status, 403, 'trainee cannot add sessions');
    assert.strictEqual((await T('GET', '/api/users')).status, 403);

    r = await A('POST', '/api/sessions', { name: 'Goodness of God', source: 'purchased' }); const sid = r.body.id; assert.ok(sid);
    r = await A('PATCH', '/api/sessions/' + sid, { bpm: 63, key: 'Ab', tags: ['Worship', 'worship', 'vocal-heavy'], difficulty: 'beginner', license: { kind: 'purchased', holder: 'RHCC', restricted: true } });
    assert.deepStrictEqual(r.body.tags, ['worship', 'vocal-heavy']); assert.strictEqual(r.body.license.restricted, true);
    assert.strictEqual((await T('GET', '/api/sessions')).body.sessions.length, 0, 'restricted session is hidden');
    assert.strictEqual((await T('GET', '/api/sessions/' + sid)).status, 404);
    await A('PATCH', '/api/sessions/' + sid, { license: { allow: [tid] } });
    assert.strictEqual((await T('GET', '/api/sessions')).body.sessions.length, 1, 'allowed user sees it');
    assert.strictEqual((await A('PUT', `/api/sessions/${sid}/upload?name=notes.txt`, Buffer.from('x'))).status, 400);

    if (hasFfmpeg) {
      r = await A('PUT', `/api/sessions/${sid}/upload?name=01_Kick.wav`, tone(60, 48000, 1)); assert.strictEqual(r.status, 200);
      r = await A('PUT', `/api/sessions/${sid}/upload?name=02_Keys.wav&date=2026-03-08`, tone(440, 96000, 2)); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.recorded, '2026-03-08');
      r = await A('PUT', `/api/sessions/${sid}/upload?name=Drums.wav&date=2026-03-01`, tone(200, 48000, 4)); assert.strictEqual(r.body.recorded, '2026-03-01', 'oldest file wins');

      r = await A('PUT', `/api/sessions/${sid}/upload?name=Full Mix.wav`, tone(300, 48000, 2)); assert.strictEqual(r.status, 200);
      let s = await untilReady(A, sid), ts = s.draft.tracks;
      assert.deepStrictEqual(ts.map(t => t.status), Array(7).fill('ready'), JSON.stringify(ts.map(t => t.error)));
      assert.deepStrictEqual(ts.map(t => t.name), ['Kick', 'Keys', 'Drums 1', 'Drums 2', 'Drums 3', 'Drums 4', 'Full Mix']);
      assert.strictEqual(ts[6].kind, 'reference');
      assert.strictEqual(ts[0].channels, 1); assert.strictEqual(ts[1].channels, 2); assert.ok(ts[0].origHash, '48 kHz original kept'); assert.strictEqual(ts[1].origHash, null, '96 kHz WAV needs no original');
      const st = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,bits_per_sample', '-of', 'json', path.join(data, 'd', 'blobs', ts[0].hash.slice(0, 2), ts[0].hash + '.wav')]).stdout).streams[0];
      assert.strictEqual(+st.sample_rate, 96000); assert.strictEqual(+st.bits_per_sample, 24);
      // same file again: stored once, same hash
      r = await A('PUT', `/api/sessions/${sid}/upload?name=Kick copy.wav&date=2020-01-01`, tone(60, 48000, 1)); s = await untilReady(A, sid);
      assert.strictEqual(s.draft.tracks[7].hash, ts[0].hash);
      r = await A('DELETE', `/api/sessions/${sid}/draft/tracks/${s.draft.tracks[7].id}`); assert.strictEqual(r.body.draft.tracks.length, 7);
      r = await A('POST', `/api/sessions/${sid}/versions`, { message: 'First import' }); assert.strictEqual(r.body.version, '1.0.0');
      r = await A('PATCH', '/api/sessions/' + sid, { recorded: '2025-12-24' }); assert.strictEqual(r.body.recordedAuto, false);
      // a dropped folder: upload everything, then "finish" saves 1.0.0 once converted; a hand-set date is kept
      r = await A('POST', '/api/sessions', { name: 'Dropped', source: 'daw' }); const did = r.body.id;
      await A('PUT', `/api/sessions/${did}/upload?name=a.wav&date=2024-05-05`, tone(100, 48000, 1));
      await A('PUT', `/api/sessions/${did}/upload?name=b.wav&date=2024-05-04`, tone(120, 48000, 1));
      await A('POST', `/api/sessions/${did}/draft/finish`, {});
      let ds; for (let i = 0; i < 100; i++) { ds = (await A('GET', '/api/sessions/' + did)).body; if (ds.versions.length) break; await sleep(100); }
      assert.strictEqual(ds.versions[0].v, '1.0.0'); assert.strictEqual(ds.versions[0].tracks.length, 2); assert.strictEqual(ds.recorded, '2024-05-04'); assert.strictEqual(ds.draft, null);
      await A('DELETE', '/api/sessions/' + did);
      r = await A('POST', `/api/sessions/${sid}/versions`, {}); assert.strictEqual(r.status, 400, 'nothing to save');
      r = await A('PATCH', `/api/sessions/${sid}/draft/tracks/${ts[1].id}`, { name: 'Piano' }); assert.strictEqual(r.body.draft.tracks[1].name, 'Piano');
      r = await A('PATCH', `/api/sessions/${sid}/draft`, { order: [ts[1].id, ts[0].id] });
      r = await A('GET', `/api/sessions/${sid}/diff?a=1.0.0&b=draft`); assert.deepStrictEqual(r.body.renamed, [['Keys', 'Piano']]); assert.strictEqual(r.body.reordered, true);
      r = await A('PUT', `/api/sessions/${sid}/upload?name=Kick2.wav&replace=${ts[0].id}`, tone(70, 48000, 1)); s = await untilReady(A, sid);
      r = await A('POST', `/api/sessions/${sid}/versions`, { bump: 'patch', message: 'Renamed keys, new kick' }); assert.strictEqual(r.body.version, '1.0.1');
      assert.deepStrictEqual(r.body.session.versions[1].changes.replaced, ['Kick']);
      r = await A('POST', `/api/sessions/${sid}/restore`, { version: '1.0.0' }); assert.strictEqual(r.body.draft.restoredFrom, '1.0.0');
      r = await A('POST', `/api/sessions/${sid}/versions`, { bump: 'major' }); assert.strictEqual(r.body.version, '2.0.0');
      // previews, waveforms, downloads
      const h = ts[0].hash;
      r = await fetch(`${base}/media/peaks/${h}?s=${sid}`, { headers: { Cookie: '' } }); assert.strictEqual(r.status, 401);
      r = await T('GET', `/media/peaks/${h}?s=${sid}`); assert.strictEqual(r.body.p.length, 1000);
      assert.strictEqual((await T('GET', `/media/preview/${h}?s=${sid}`)).status, 200);
      assert.strictEqual((await T('GET', `/api/sessions/${sid}/files/${h}`)).status, 403, 'trainee cannot download');
      assert.strictEqual((await A('GET', `/api/sessions/${sid}/files/${h}`)).status, 200);
      assert.strictEqual((await A('GET', `/api/sessions/${sid}/files/${ts[0].origHash}?orig=1`)).status, 200);

      // LiveVault API v1 for LiveWebMixer, with the trainee's personal access token
      assert.strictEqual((await T('POST', `/api/sessions/${sid}/open`, {})).status, 400, 'needs the LiveWebMixer address');
      await A('PUT', '/api/settings', { lwmUrl: 'https://mixer.local:9443' });
      r = await T('POST', `/api/sessions/${sid}/open`, { version: '1.0.1' }); assert.strictEqual(r.body.url, `https://mixer.local:9443/#vault=${sid}&version=1.0.1`);
      r = await T('POST', '/api/me/tokens', { name: 'Mixer' }); const tok = r.body.token; assert.ok(/^lv_[a-f0-9]{48}$/.test(tok));
      assert.strictEqual((await T('GET', '/api/me/tokens')).body.tokens.length, 1);
      const L = (m, u, b, ct) => fetch(base + u, { method: m, headers: { Authorization: 'Bearer ' + tok, ...(ct ? { 'Content-Type': ct } : {}) }, body: b });
      assert.strictEqual((await fetch(base + '/api/v1/info', { headers: { Authorization: 'Bearer lv_' + 'f'.repeat(48) } })).status, 401);
      const info = await (await L('GET', '/api/v1/info')).json(); assert.strictEqual(info.name, 'LiveVault'); assert.strictEqual(info.api, 1);
      const list = await (await L('GET', '/api/v1/sessions?q=goodness')).json();
      assert.strictEqual(list.sessions.length, 1); assert.strictEqual(list.sessions[0].latest, '2.0.0'); assert.deepStrictEqual(list.sessions[0].versions, ['2.0.0', '1.0.1', '1.0.0']);
      const ver = await (await L('GET', `/api/v1/sessions/${sid}/versions/1.0.1`)).json();
      assert.strictEqual(ver.tracks[0].name, 'Piano'); assert.strictEqual(ver.tracks[6].role, 'reference'); assert.ok(ver.tracks[0].sizes.flac > 0); assert.ok(ver.notes === '');
      for (const qq of ['flac', 'hi', 'lo']) { r = await L('GET', `/api/v1/files/${ver.tracks[0].file}/${qq}`, undefined); assert.strictEqual(r.status, 200, qq); assert.ok((await r.arrayBuffer()).byteLength > 100); }
      r = await fetch(`${base}/api/v1/files/${ver.tracks[0].file}/flac`, { headers: { Authorization: 'Bearer ' + tok, Range: 'bytes=0-9' } }); assert.strictEqual(r.status, 206); assert.strictEqual((await r.arrayBuffer()).byteLength, 10);
      const fst = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'json', path.join(data, 'd', 'mixer', ver.tracks[0].file.slice(0, 2), ver.tracks[0].file + '.flac')]).stdout).streams[0];
      assert.strictEqual(+fst.sample_rate, 48000, 'mixer copies are 48 kHz');
      assert.strictEqual((await L('GET', `/api/v1/files/${'a'.repeat(64)}/flac`)).status, 404);
      const mixPath = `/api/v1/sessions/${sid}/versions/1.0.1/mixes/livewebmixer`;
      assert.strictEqual((await L('GET', mixPath)).status, 404);
      assert.strictEqual((await L('PUT', mixPath, JSON.stringify({ scenes: [{ name: 'Rough', mixer: {} }], current: { x: 1 } }), 'application/json')).status, 200);
      assert.strictEqual((await L('PUT', mixPath, JSON.stringify({ scenes: [{ name: 'Rough', mixer: {} }], current: { x: 2 } }), 'application/json')).status, 200);
      assert.deepStrictEqual((await (await L('GET', mixPath)).json()).current, { x: 2 });
      r = await T('GET', `/api/sessions/${sid}/mixes`); assert.strictEqual(r.body.mixes.length, 1, 'one mix per person and version'); const mix = r.body.mixes[0];
      assert.strictEqual(mix.name, "Trainee's mix"); assert.strictEqual(mix.version, '1.0.1'); assert.strictEqual(mix.lwm, true);
      r = await L('PUT', `/api/v1/sessions/${sid}/versions/1.0.1/recordings?name=Run%201&start=12.5`, tone(500, 48000, 2, 2), 'audio/wav'); assert.strictEqual(r.status, 200);
      const rec = await r.json(); assert.strictEqual(rec.mixName, "Trainee's mix"); assert.strictEqual(rec.start, 12.5); assert.ok(rec.duration > 1.9);
      r = await T('GET', `/api/sessions/${sid}/recordings`); assert.strictEqual(r.body.recordings.length, 1);
      assert.strictEqual((await T('GET', `/media/rec/${sid}/${rec.id}`)).status, 200);
      assert.strictEqual((await T('PATCH', `/api/sessions/${sid}/recordings/${rec.id}`, { notes: 'x' })).status, 403, 'trainee cannot write review notes');
      r = await A('PATCH', `/api/sessions/${sid}/recordings/${rec.id}`, { notes: 'Vocals sit too low in the chorus' }); assert.strictEqual(r.body.notesByName, 'Jerod');
      assert.strictEqual((await T('GET', `/api/sessions/${sid}/recordings/${rec.id}/download`)).status, 200, 'owner can download own recording');
      // mix visibility: a second trainee cannot see the first trainee's mix unless it is a reference
      await A('POST', '/api/users', { username: 'other', password: 'other1234', perms: { mix: true, licensed: true } });
      const O = client(); await O('POST', '/api/login', { username: 'other', password: 'other1234' });
      assert.strictEqual((await O('GET', `/api/sessions/${sid}/mixes`)).body.mixes.length, 0);
      await A('PATCH', `/api/sessions/${sid}/mixes/${mix.id}`, { reference: true });
      assert.strictEqual((await O('GET', `/api/sessions/${sid}/mixes`)).body.mixes.length, 1);
      // a token without the mix permission can read but not save; a disabled user's tokens stop working
      await A('PATCH', '/api/users/' + tid, { perms: { mix: false } });
      assert.strictEqual((await L('PUT', mixPath, '{}', 'application/json')).status, 403);
      await A('PATCH', '/api/users/' + tid, { disabled: true });
      assert.strictEqual((await L('GET', '/api/v1/info')).status, 401);

      // watch folder: a folder of files becomes a session with version 1.0.0
      const wd = path.join(watch, 'Sunday 11-09'); fs.mkdirSync(wd);
      fs.writeFileSync(path.join(wd, 'Ch01 Kick.wav'), tone(80, 96000, 1)); fs.writeFileSync(path.join(wd, 'Ch02 Snare.wav'), tone(180, 96000, 1));
      const old = new Date(Date.now() - 120e3); for (const f of fs.readdirSync(wd)) fs.utimesSync(path.join(wd, f), old, old);
      let ws;
      for (let i = 0; i < 100; i++) { ws = (await A('GET', '/api/sessions')).body.sessions.find(x => x.name === 'Sunday 11-09'); if (ws && ws.version) break; await sleep(150); }
      assert.ok(ws && ws.version === '1.0.0', 'watch import saved a version');
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ws.recorded), 'watch import has a date'); assert.strictEqual(ws.source, 'sq5'); assert.strictEqual(ws.tracks, 2);
      for (let i = 0; i < 20 && fs.existsSync(wd); i++) await sleep(100);
      assert.ok(!fs.existsSync(wd) && fs.readdirSync(path.join(watch, '_imported')).length === 1, 'imported folder moved aside');

      r = await A('GET', '/api/storage'); assert.ok(r.body.audio > 0);
      r = await A('POST', '/api/storage/cleanup'); assert.strictEqual(r.status, 200);
      assert.strictEqual((await A('GET', `/api/sessions/${sid}/files/${h}`)).status, 200, 'cleanup keeps audio that versions use');
    } else console.log('ffmpeg not installed here: skipped the audio tests');

    assert.strictEqual((await T('DELETE', '/api/sessions/' + sid)).status, hasFfmpeg ? 401 : 403, hasFfmpeg ? 'disabled user is signed out' : 'trainee cannot delete');
    r = await A('DELETE', '/api/sessions/' + sid); assert.strictEqual(r.status, 200);
    assert.strictEqual((await A('GET', '/api/sessions/' + sid)).status, 404);
    console.log('ok');
  } finally { srv.kill(); fs.rmSync(data, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
