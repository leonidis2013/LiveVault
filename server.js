// LiveVault server: multitrack library for LiveWebMixer.
// Stores every track once (by content hash) as 96 kHz / 24-bit WAV, keeps sessions with
// major.minor.patch versions, per-user permissions, license restrictions, saved mixes,
// a watch folder, and the LiveVault API (version 1) that LiveWebMixer uses with personal access tokens.
// No npm dependencies: Node built-ins plus the ffmpeg/unzip/openssl programs in the image.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const VERSION = require('./package.json').version;
const DATA = path.resolve(process.env.DATA_DIR || '/data');
const PORT = +(process.env.PORT || 8080);
const HTTPS_PORT = +(process.env.HTTPS_PORT || 8443);
const WATCH = path.resolve(process.env.WATCH_DIR || '/watch');
const PUBLIC = path.join(__dirname, 'public');
const MAX_UPLOAD = +(process.env.MAX_UPLOAD_MB || 8192) * 1024 * 1024;
const RATE = 96000;
const D = { sessions: path.join(DATA, 'sessions'), mixes: path.join(DATA, 'mixes'), blobs: path.join(DATA, 'blobs'), orig: path.join(DATA, 'originals'),
  prev: path.join(DATA, 'previews'), raw: path.join(DATA, 'raw'), recs: path.join(DATA, 'recordings'), inc: path.join(DATA, 'incoming'), tmp: path.join(DATA, 'tmp') };
// Mixed storage: when a dataset is mounted at /library, the audio (tracks and Main LR recordings) lives there, with
// readable folders per session that you can browse over SMB. Everything else stays in the /data volume.
const LIB = path.resolve(process.env.LIBRARY_DIR || '/library');
let libErr = '';
const libOn = (() => {
  try { if (!fs.statSync(LIB).isDirectory()) return false; } catch { return false; }
  try { fs.accessSync(LIB, fs.constants.W_OK); fs.mkdirSync(path.join(LIB, '.livevault'), { recursive: true }); return true; }
  catch (e) { libErr = `LiveVault cannot write to the library dataset (${e.code}). Give user ID 1000 Modify permission on it, then restart the app. Audio stays in the volume until then.`; console.error(libErr); return false; }
})();
if (libOn) {
  const store = path.join(LIB, '.livevault');
  for (const [k, sub] of [['blobs', 'blobs'], ['recs', 'recordings']]) {
    const from = D[k], to = path.join(store, sub);
    D[k] = to; fs.mkdirSync(to, { recursive: true });
    moveTreeSync(from, to);   // one-time move from the volume to the drive
  }
}
function moveTreeSync(from, to) {
  let n = 0;
  const walk = (a, b) => {
    for (const e of (() => { try { return fs.readdirSync(a, { withFileTypes: true }); } catch { return []; } })()) {
      const pa = path.join(a, e.name), pb = path.join(b, e.name);
      if (e.isDirectory()) { fs.mkdirSync(pb, { recursive: true }); walk(pa, pb); try { fs.rmdirSync(pa); } catch {} continue; }
      if (fs.existsSync(pb)) { fs.unlinkSync(pa); continue; }
      try { fs.renameSync(pa, pb); } catch { fs.copyFileSync(pa, pb); fs.unlinkSync(pa); }
      if (++n % 200 === 0) console.log(`moving audio to ${to}: ${n} files so far`);
    }
  };
  walk(from, to);
  if (n) console.log(`moved ${n} files to ${to}`);
}
for (const d of Object.values(D)) fs.mkdirSync(d, { recursive: true });
const AUDIO_EXT = new Set(['.wav', '.wave', '.bwf', '.aif', '.aiff', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.caf']);
const PERMS = ['upload', 'edit', 'delete', 'download', 'mix', 'seeMixes', 'licensed'];
const SOURCES = ['sq5', 'purchased', 'training', 'daw', 'other'];
const KINDS = ['channel', 'reference', 'off'];
const LOGIN_DAYS = 30;

// ---------- small helpers ----------
const id = (n = 4) => crypto.randomBytes(n).toString('hex');
const okId = s => typeof s === 'string' && /^[a-f0-9]{6,16}$/.test(s);
const okHash = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const clone = v => JSON.parse(JSON.stringify(v));
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const httpErr = (code, msg) => Object.assign(new Error(msg), { code });
const readJson = async (f, dflt) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return dflt; } };
const writeJson = async (f, v) => { const t = f + '.' + id() + '.tmp'; await fsp.writeFile(t, JSON.stringify(v)); await fsp.rename(t, f); };
const exists = f => fsp.access(f).then(() => true, () => false);
const shard = (dir, h, ext) => path.join(dir, h.slice(0, 2), h + ext);
const send = (res, code, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
};
const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', c => { n += c.length; if (n > limit) { reject(httpErr(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpErr(400, 'Bad JSON')); } });
  req.on('error', reject);
});
function run(cmd, args, asBuffer) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { if (err.length < 8000) err += d; });
    p.on('error', reject);
    p.on('close', code => {
      const o = Buffer.concat(out);
      code === 0 ? resolve(asBuffer ? o : o.toString()) : reject(new Error((err || o.toString() || cmd + ' failed').trim().split('\n').slice(-3).join(' ')));
    });
  });
}
const hashFile = f => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
const moveFile = async (a, b) => { await fsp.mkdir(path.dirname(b), { recursive: true }); await fsp.rename(a, b).catch(async () => { await fsp.copyFile(a, b); await fsp.unlink(a); }); };
const cleanName = file => path.basename(file, path.extname(file)).replace(/^\d+[\s_.\-]*/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || path.basename(file);
const isRefName = n => /\b(reference|ref ?mix|full ?mix|mixdown|master)\b/i.test(n);
const okDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
const localDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: process.env.TZ || undefined });   // YYYY-MM-DD in the server's time zone
// The session's original date follows the oldest imported file until someone sets it by hand.
function noteFileDate(s, d) { if (!okDate(d) || s.recordedAuto === false) return; if (!s.recorded || d < s.recorded) { s.recorded = d; s.recordedAuto = true; } }
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

// Serialized read-modify-write on one JSON file (fn may mutate; return false to skip the write).
const fileLocks = new Map();
function withJson(file, dflt, fn) {
  const prev = fileLocks.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => { const v = await readJson(file, clone(dflt)); const r = await fn(v); if (r !== false) await writeJson(file, v); return v; });
  fileLocks.set(file, next);
  next.finally(() => { if (fileLocks.get(file) === next) fileLocks.delete(file); }).catch(() => {});
  return next;
}

// ---------- settings ----------
const SETTINGS_F = path.join(DATA, 'settings.json');
const SETTINGS_DEFAULT = { lwmUrl: '', keepOriginals: true, watchSource: 'sq5' };
let settings = { ...SETTINGS_DEFAULT, ...(JSON.parse(fs.existsSync(SETTINGS_F) ? fs.readFileSync(SETTINGS_F, 'utf8') : '{}')) };

// ---------- users and logins ----------
const USERS_F = path.join(DATA, 'users.json'), LOGINS_F = path.join(DATA, 'logins.json');
let users = (JSON.parse(fs.existsSync(USERS_F) ? fs.readFileSync(USERS_F, 'utf8') : '{"users":[]}')).users;
let logins = JSON.parse(fs.existsSync(LOGINS_F) ? fs.readFileSync(LOGINS_F, 'utf8') : '{}');
let saveChain = Promise.resolve();
const persist = (f, v) => { saveChain = saveChain.then(() => writeJson(f, v)).catch(e => console.error('save', f, e.message)); return saveChain; };
const saveUsers = () => persist(USERS_F, { users });
const saveLogins = () => persist(LOGINS_F, logins);
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');
const checkPw = (u, pw) => { const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const setPw = (u, pw) => { u.salt = id(16); u.hash = hashPw(pw, u.salt); };
const pwProblem = pw => typeof pw !== 'string' || pw.length < 8 ? 'Passwords need at least 8 characters' : '';
const normPerms = p => Object.fromEntries(PERMS.map(k => [k, !!(p && p[k])]));
const can = (u, p) => !!u && (u.admin || !!(u.perms && u.perms[p]));
const pubUser = u => ({ id: u.id, username: u.username, display: u.display, admin: !!u.admin, perms: normPerms(u.perms), disabled: !!u.disabled, created: u.created, tokens: (u.tokens || []).length });
const userName = uid => uid === 'watch' ? 'Watch folder' : (users.find(u => u.id === uid) || {}).display || 'Removed user';
// prune expired logins once an hour
setInterval(() => {
  let a = false;
  for (const [k, l] of Object.entries(logins)) if (l.expires < now()) { delete logins[k]; a = true; }
  if (a) saveLogins();
}, 3600e3).unref();
// Personal access tokens (for LiveWebMixer): shown once, stored only as a hash. They act as their owner, with the owner's permissions.
function tokenUser(req) {
  const m = /^Bearer (lv_[a-f0-9]{48})$/.exec(req.headers.authorization || ''); if (!m) return null;
  const h = sha(m[1]);
  for (const u of users) { const t = (u.tokens || []).find(t => t.sha === h); if (t) { if (u.disabled) return null; if (now() - (t.used || 0) > 3600e3) { t.used = now(); saveUsers(); } return u; } }
  return null;
}
const pubToken = t => ({ id: t.id, name: t.name, created: t.created, used: t.used || null });

function cookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function currentUser(req) {
  const t = cookies(req).lv_session; if (!t) return null;
  const l = logins[sha(t)]; if (!l || l.expires < now()) return null;
  const u = users.find(u => u.id === l.uid); return u && !u.disabled ? u : null;
}
function startLogin(req, res, u) {
  const t = id(32); logins[sha(t)] = { uid: u.id, created: now(), expires: now() + LOGIN_DAYS * 864e5 }; saveLogins();
  return `lv_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${LOGIN_DAYS * 86400}` + (req.socket.encrypted ? '; Secure' : '');
}
const fails = new Map();
function tooManyFails(ip) { const f = fails.get(ip); return f && f.n >= 10 && now() - f.t < 600e3; }
function noteFail(ip) { const f = fails.get(ip); if (!f || now() - f.t > 600e3) fails.set(ip, { n: 1, t: now() }); else f.n++; }

// ---------- sessions (kept in memory, one JSON file each) ----------
const sessions = new Map();
for (const f of fs.readdirSync(D.sessions)) {
  if (!f.endsWith('.json')) continue;
  try { const s = JSON.parse(fs.readFileSync(path.join(D.sessions, f), 'utf8')); sessions.set(s.id, s); } catch (e) { console.error('Could not read session', f, e.message); }
}
const sesLocks = new Map();
function withSession(sid, fn) {
  const prev = sesLocks.get(sid) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const cur = sessions.get(sid); if (!cur) throw httpErr(404, 'Session not found');
    const s = clone(cur); const r = await fn(s);
    if (r !== false) { s.updated = now(); await writeJson(path.join(D.sessions, sid + '.json'), s); sessions.set(sid, s); scheduleMirror(sid); }
    return s;
  });
  sesLocks.set(sid, next);
  next.finally(() => { if (sesLocks.get(sid) === next) sesLocks.delete(sid); }).catch(() => {});
  return next;
}
const visible = (u, s) => !!u && !!s && (u.admin || !s.license.restricted || can(u, 'licensed') || (s.license.allow || []).includes(u.id));
function getVisible(u, sid) { const s = okId(sid) && sessions.get(sid); if (!s || !visible(u, s)) throw httpErr(404, 'Session not found'); return s; }
const latest = s => s.versions[s.versions.length - 1] || null;
const findVersion = (s, v) => v === 'draft' ? (s.draft ? { v: 'draft', tracks: s.draft.tracks } : null) : s.versions.find(x => x.v === v) || null;
const trackDur = ts => Math.max(0, ...ts.map(t => t.duration || 0));
function summary(s) {
  const l = latest(s), ts = l ? l.tracks : (s.draft ? s.draft.tracks : []);
  return { id: s.id, name: s.name, artist: s.artist, source: s.source, tags: s.tags, difficulty: s.difficulty, bpm: s.bpm, key: s.key, recorded: s.recorded || '', version: l ? l.v : null,
    tracks: ts.filter(t => t.kind !== 'off').length, duration: trackDur(ts), restricted: !!s.license.restricted, draft: !!s.draft, created: s.created, updated: s.updated };
}
function newSession(b, uid) {
  return { id: id(4), name: str(b.name, 100) || 'New session', artist: str(b.artist, 100), source: SOURCES.includes(b.source) ? b.source : 'other', sourceNote: '', bpm: '', key: '',
    recorded: okDate(b.recorded) ? b.recorded : '', recordedAuto: !okDate(b.recorded), tags: [], difficulty: '', notes: '', listenFor: '', license: { kind: 'none', holder: '', terms: '', restricted: false, allow: [] },
    created: now(), createdBy: uid, updated: now(), versions: [], draft: null };
}
function applyMeta(s, b) {
  if (typeof b.name === 'string' && b.name.trim()) s.name = str(b.name, 100);
  for (const k of ['artist', 'sourceNote', 'key']) if (typeof b[k] === 'string') s[k] = str(b[k], 100);
  if (b.bpm !== undefined) s.bpm = str(String(b.bpm), 12);
  if (SOURCES.includes(b.source)) s.source = b.source;
  if (b.recorded === '' || okDate(b.recorded)) { s.recorded = b.recorded; s.recordedAuto = b.recorded === ''; }
  if (['', 'beginner', 'intermediate', 'advanced'].includes(b.difficulty)) s.difficulty = b.difficulty;
  if (typeof b.notes === 'string') s.notes = b.notes.slice(0, 20000);
  if (typeof b.listenFor === 'string') s.listenFor = b.listenFor.slice(0, 5000);
  if (Array.isArray(b.tags)) s.tags = [...new Set(b.tags.map(t => str(String(t), 40).toLowerCase()).filter(Boolean))].slice(0, 30);
  if (b.license && typeof b.license === 'object') {
    const L = b.license, o = s.license;
    if (['none', 'purchased', 'other'].includes(L.kind)) o.kind = L.kind;
    if (typeof L.holder === 'string') o.holder = str(L.holder, 200);
    if (typeof L.terms === 'string') o.terms = L.terms.slice(0, 4000);
    if (typeof L.restricted === 'boolean') o.restricted = L.restricted;
    if (Array.isArray(L.allow)) o.allow = L.allow.filter(x => users.some(u => u.id === x));
  }
}
const cleanTrack = t => ({ id: t.id, name: t.name, kind: t.kind, hash: t.hash, origHash: t.origHash || null, origExt: t.origExt || null, channels: t.channels, duration: t.duration, srcRate: t.srcRate, srcFormat: t.srcFormat, srcName: t.srcName });
function ensureDraft(s, uid) {
  if (!s.draft) { const l = latest(s); s.draft = { base: l ? l.v : null, by: uid, started: now(), tracks: l ? l.tracks.map(t => ({ ...clone(t), status: 'ready', error: '' })) : [] }; }
  return s.draft;
}
function bumpVersion(v, kind) {
  if (!v) return '1.0.0';
  let [a, b, c] = v.split('.').map(Number);
  if (kind === 'major') { a++; b = 0; c = 0; } else if (kind === 'minor') { b++; c = 0; } else c++;
  return `${a}.${b}.${c}`;
}
function diff(a, b) {
  a = a || []; b = b || [];
  const A = new Map(a.map(t => [t.id, t])), B = new Map(b.map(t => [t.id, t]));
  const out = { added: [], removed: [], renamed: [], replaced: [], kind: [], reordered: false };
  for (const t of b) if (!A.has(t.id)) out.added.push(t.name);
  for (const t of a) if (!B.has(t.id)) out.removed.push(t.name);
  for (const t of b) { const o = A.get(t.id); if (!o) continue; if (o.name !== t.name) out.renamed.push([o.name, t.name]); if (o.hash !== t.hash) out.replaced.push(t.name); if (o.kind !== t.kind) out.kind.push([t.name, o.kind, t.kind]); }
  const ca = a.filter(t => B.has(t.id)).map(t => t.id).join(), cb = b.filter(t => A.has(t.id)).map(t => t.id).join();
  out.reordered = ca !== cb;
  out.changed = !!(out.added.length || out.removed.length || out.renamed.length || out.replaced.length || out.kind.length || out.reordered);
  return out;
}
function saveVersion(s, uid, bump, message) {
  const d = s.draft; if (!d) throw httpErr(400, 'There are no unsaved changes');
  if (d.tracks.some(t => t.status !== 'ready')) throw httpErr(400, 'Some tracks are still converting or failed. Wait for them, or remove the failed ones.');
  if (!d.tracks.length) throw httpErr(400, 'Add at least one track first');
  const l = latest(s), dd = diff(l && l.tracks, d.tracks);
  if (l && !dd.changed) throw httpErr(400, 'Nothing changed since ' + l.v);
  const v = bumpVersion(l && l.v, ['major', 'minor', 'patch'].includes(bump) ? bump : 'minor');
  s.versions.push({ v, created: now(), by: uid, message: str(message, 500) || (l ? '' : 'First version'), base: d.base, tracks: d.tracks.map(cleanTrack), changes: dd });
  s.draft = null;
  return v;
}

// ---------- audio: convert to 96k/24-bit, store once by hash, previews and waveforms ----------
const blobPath = h => shard(D.blobs, h, '.wav');
const blobMeta = h => readJson(shard(D.blobs, h, '.json'), null);
const origPath = (h, ext) => shard(D.orig, h, ext);
async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels,sample_rate,bits_per_raw_sample,bits_per_sample,duration:format=duration,format_name', '-of', 'json', file]));
  const st = (j.streams || [])[0]; if (!st) throw new Error('No audio found in this file');
  return { codec: st.codec_name || '', channels: +st.channels || 1, rate: +st.sample_rate || 0, bits: +(st.bits_per_raw_sample || st.bits_per_sample || 0), duration: +(st.duration || (j.format || {}).duration || 0) };
}
const codecName = (c, name) => /^pcm_/.test(c) ? (/\.aiff?$/i.test(name) ? 'AIFF' : /\.caf$/i.test(name) ? 'CAF' : 'WAV') : ({ flac: 'FLAC', mp3: 'MP3', aac: 'AAC', alac: 'ALAC', opus: 'Opus', vorbis: 'Ogg' }[c] || c.toUpperCase());
let soxr = true;
async function toWav96(src, out, chan) {
  const filt = r => [chan == null ? null : `pan=mono|c0=c${chan}`, r ? `aresample=${RATE}:resampler=soxr:precision=28` : `aresample=${RATE}`].filter(Boolean).join(',');
  const args = r => ['-y', '-v', 'error', '-i', src, '-map', '0:a:0', '-vn', '-af', filt(r), '-c:a', 'pcm_s24le', '-ar', String(RATE), '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'wav', out];
  try { await run('ffmpeg', args(soxr)); } catch (e) { if (!soxr || !/soxr/i.test(e.message)) throw e; soxr = false; await run('ffmpeg', args(false)); }
}
async function makePreview(h) {
  const op = shard(D.prev, h, '.opus'), pk = shard(D.prev, h, '.peaks.json');
  if (await exists(op) && await exists(pk)) return;
  const meta = await blobMeta(h);
  await renderPreview(blobPath(h), op, pk, meta && meta.channels > 1 ? 2 : 1);
}
// Opus copy for the in-browser player plus a 1000-point waveform.
async function renderPreview(src, op, pk, ch) {
  await fsp.mkdir(path.dirname(op), { recursive: true });
  const t = op + '.' + id() + '.tmp';
  await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ac', String(ch), '-ar', '48000', '-c:a', 'libopus', '-b:a', ch > 1 ? '96k' : '64k', '-vbr', 'on', '-application', 'audio', '-f', 'ogg', t]);
  await fsp.rename(t, op);
  const raw = await run('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'], true);
  const n = raw.length >> 1, B = 1000, p = new Array(B).fill(0);
  for (let i = 0; i < n; i++) { const v = Math.abs(raw.readInt16LE(i * 2)); const b = Math.min(B - 1, Math.floor(i / n * B)); if (v > p[b]) p[b] = v; }
  await writeJson(pk, { n: B, p: p.map(v => Math.round(v / 327.68)) });
}
// One uploaded file -> one or more stored tracks. Results are remembered per raw file hash, so the same file uploads instantly next time.
async function ingestFile(file, origName, workDir) {
  const rawSha = await hashFile(file), rawF = path.join(D.raw, rawSha + '.json');
  const known = await readJson(rawF, null);
  if (known && (await Promise.all(known.outs.map(o => exists(blobPath(o.hash))))).every(Boolean)) {
    for (const o of known.outs) await makePreview(o.hash).catch(() => {});
    return known;
  }
  const pr = await probe(file);
  const outs = [], chans = pr.channels > 2 ? [...Array(pr.channels).keys()] : [null];
  for (const c of chans) {
    const out = path.join(workDir, 'out-' + (c == null ? 'm' : c) + '.wav');
    await toWav96(file, out, c);
    const h = await hashFile(out), ch = c == null ? Math.min(pr.channels, 2) : 1;
    const dst = blobPath(h);
    if (await exists(dst)) await fsp.unlink(out); else { await moveFile(out, dst); await fsp.chmod(dst, 0o444).catch(() => {}); }
    const size = (await fsp.stat(dst)).size, duration = pr.duration || size / (RATE * 3 * ch);
    await writeJson(shard(D.blobs, h, '.json'), { channels: ch, duration, size });
    await makePreview(h);
    outs.push({ hash: h, channels: ch, duration, chan: c });
  }
  let origHash = null, origExt = null;
  if (settings.keepOriginals && (pr.rate !== RATE || !/^pcm_/.test(pr.codec))) {
    origExt = (path.extname(origName).toLowerCase() || '.bin').replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin';
    const dst = origPath(rawSha, origExt);
    if (!await exists(dst)) { await fsp.mkdir(path.dirname(dst), { recursive: true }); await fsp.copyFile(file, dst); }
    origHash = rawSha;
  }
  const rec = { outs, origHash, origExt, srcRate: pr.rate, srcFormat: `${codecName(pr.codec, origName)}${pr.bits && /^(pcm|flac|alac)/.test(pr.codec) ? ' ' + pr.bits + '-bit' : ''} ${pr.rate ? pr.rate / 1000 + ' kHz' : ''}`.trim(), srcChannels: pr.channels };
  await writeJson(rawF, rec);
  return rec;
}

// ---------- conversion queue ----------
const queue = []; let running = 0;
const WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));
const enqueue = (sid, tid) => { queue.push({ sid, tid }); pump(); };
function pump() {
  while (running < WORKERS && queue.length) {
    const job = queue.shift(); running++;
    processTrack(job.sid, job.tid).catch(e => console.error('convert', e.message)).finally(() => { running--; pump(); });
  }
}
async function processTrack(sid, tid) {
  let tr;
  await withSession(sid, s => { tr = s.draft && s.draft.tracks.find(t => t.id === tid); if (!tr || tr.status === 'ready') { tr = null; return false; } tr.status = 'processing'; tr.error = ''; }).catch(() => {});
  if (!tr) return;
  const dir = path.join(D.inc, tid), file = path.join(dir, tr.job.file);
  try {
    if (!await exists(file)) throw new Error('The uploaded file is missing; upload it again');
    const rec = await ingestFile(file, tr.job.origName, dir);
    if (tr.job.replace && rec.outs.length > 1) throw new Error(`This file has ${rec.srcChannels} channels; a replacement needs a mono or stereo file`);
    await withSession(sid, s => {
      const ts = s.draft && s.draft.tracks, i = ts ? ts.findIndex(t => t.id === tid) : -1; if (i < 0) return false;
      const base = ts[i], many = rec.outs.length > 1;
      const made = rec.outs.map((o, k) => ({ ...base, id: k ? id(4) : base.id, name: many ? `${base.name} ${o.chan + 1}`.slice(0, 60) : base.name, hash: o.hash, channels: o.channels, duration: o.duration,
        origHash: rec.origHash, origExt: rec.origExt, srcRate: rec.srcRate, srcFormat: rec.srcFormat + (many ? ` (ch ${o.chan + 1} of ${rec.srcChannels})` : ''), status: 'ready', error: '', job: undefined }));
      for (const m of made) delete m.job;
      ts.splice(i, 1, ...made);
      maybeAutoSave(s);
    });
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  } catch (e) {
    await withSession(sid, s => { const t = s.draft && s.draft.tracks.find(t => t.id === tid); if (!t) return false; t.status = 'error'; t.error = e.message.slice(0, 300); }).catch(() => {});
  }
}
function maybeAutoSave(s) {
  const d = s.draft;
  if (d && d.autoSave && d.tracks.length && d.tracks.every(t => t.status === 'ready')) { const m = d.autoSave; delete d.autoSave; try { saveVersion(s, d.by, 'minor', m); } catch (e) { console.error('auto save', e.message); } }
}
// pick up anything that was waiting when the container stopped
for (const s of sessions.values()) if (s.draft) for (const t of s.draft.tracks) if (t.status === 'queued' || t.status === 'processing') enqueue(s.id, t.id);

// Add one audio file (already on disk) to a session's draft as a new track, or as new audio for an existing track.
async function addTrack(sid, uid, tmpFile, origName, replaceTid) {
  const tid = replaceTid || id(4), dir = path.join(D.inc, tid);
  if (replaceTid) await fsp.rm(dir, { recursive: true, force: true });
  const file = 'src' + (path.extname(origName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin');
  await moveFile(tmpFile, path.join(dir, file));
  await withSession(sid, s => {
    const d = ensureDraft(s, uid);
    if (replaceTid) {
      const t = d.tracks.find(t => t.id === replaceTid); if (!t) throw httpErr(404, 'Track not found');
      Object.assign(t, { status: 'queued', error: '', job: { file, origName, replace: true } });
    } else {
      const nm = cleanName(origName).slice(0, 60);
      d.tracks.push({ id: tid, name: nm, kind: isRefName(nm) ? 'reference' : 'channel', status: 'queued', error: '', hash: null, channels: 0, duration: 0, srcName: origName.slice(0, 200), job: { file, origName } });
    }
  });
  enqueue(sid, tid);
}
async function unzipTo(zip, dir) {
  await fsp.mkdir(dir, { recursive: true });
  await run('unzip', ['-o', '-qq', zip, '-d', dir]).catch(e => { if (!fs.readdirSync(dir).length) throw e; });
  return audioFiles(dir, 4);
}
async function audioFiles(dir, depth) {
  const out = [];
  const walk = async (d, n) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith('.') || e.name.startsWith('._') || e.name === '__MACOSX') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (n > 0) await walk(p, n - 1); } else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  await walk(dir, depth);
  return out.sort((a, b) => natural(path.basename(a), path.basename(b)));
}
async function streamTo(req, file) {
  await new Promise((resolve, reject) => {
    let n = 0; const ws = fs.createWriteStream(file);
    req.on('data', c => { n += c.length; if (n > MAX_UPLOAD) { req.destroy(); ws.destroy(); reject(httpErr(413, 'File is larger than the upload limit')); } });
    req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject); req.on('aborted', () => reject(new Error('Upload interrupted')));
  });
}
async function handleUpload(req, res, u, s, name, replace, date) {
  name = path.basename(String(name || 'track'));
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.zip' && !AUDIO_EXT.has(ext)) return send(res, 400, { error: 'Not an audio file or zip: ' + name });
  if (replace && (ext === '.zip' || !(s.draft || latest(s)) || !(ensureDraftView(s).find(t => t.id === replace)))) return send(res, 400, { error: 'Pick one audio file to replace that track' });
  const tmpDir = await fsp.mkdtemp(path.join(D.tmp, 'up-'));
  try {
    const tmp = path.join(tmpDir, 'upload' + ext);
    await streamTo(req, tmp);
    if (ext === '.zip') {
      const files = await unzipTo(tmp, path.join(tmpDir, 'x'));
      if (!files.length) throw httpErr(400, 'No audio files in that zip');
      for (const f of files) await addTrack(s.id, u.id, f, path.basename(f));
    } else await addTrack(s.id, u.id, tmp, name, replace || null);
    if (okDate(date)) await withSession(s.id, x => { const before = x.recorded; noteFileDate(x, date); if (x.recorded === before) return false; });
    send(res, 200, sessionOut(u, sessions.get(s.id)));
  } catch (e) { send(res, e.code || 400, { error: e.message }); }
  finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
}
const ensureDraftView = s => s.draft ? s.draft.tracks : (latest(s) ? latest(s).tracks : []);
function sessionOut(u, s) {
  const o = clone(s);
  if (o.draft) for (const t of o.draft.tracks) delete t.job;
  const ids = new Set([s.createdBy, ...s.versions.map(v => v.by), s.draft && s.draft.by].filter(Boolean));
  o.names = Object.fromEntries([...ids].map(x => [x, userName(x)]));
  o.mixCount = 0;
  o.can = { upload: can(u, 'upload'), edit: can(u, 'edit'), delete: can(u, 'delete'), download: can(u, 'download'), mix: can(u, 'mix'), lwm: !!settings.lwmUrl };
  if (!can(u, 'edit') && !u.admin) o.license = { kind: s.license.kind, holder: s.license.holder, terms: s.license.terms, restricted: s.license.restricted, allow: [] };
  return o;
}
const sessionHas = (s, h) => s.versions.some(v => v.tracks.some(t => t.hash === h || t.origHash === h)) || (s.draft && s.draft.tracks.some(t => t.hash === h || t.origHash === h));

// ---------- watch folder: drop a folder (or a zip) of tracks and it becomes a session ----------
const WATCH_F = path.join(DATA, 'watch.json');
let watchSeen = new Map(), watchBusy = false;
const watchOn = () => fs.existsSync(WATCH) && fs.statSync(WATCH).isDirectory();
async function scanWatch() {
  if (watchBusy || !watchOn()) return; watchBusy = true;
  try {
    const done = await readJson(WATCH_F, {});
    for (const e of await fsp.readdir(WATCH, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('_') || e.name.startsWith('#')) continue;
      const p = path.join(WATCH, e.name), isZip = e.isFile() && e.name.toLowerCase().endsWith('.zip');
      if (!e.isDirectory() && !isZip) continue;
      const files = isZip ? [p] : await audioFiles(p, 3);
      if (!files.length) continue;
      let size = 0, mt = 0; for (const f of files) { const st = await fsp.stat(f).catch(() => null); if (st) { size += st.size; mt = Math.max(mt, st.mtimeMs); } }
      const sig = `${e.name}|${files.length}|${size}|${Math.round(mt)}`;
      if (done[sig]) continue;
      const prev = watchSeen.get(e.name); watchSeen.set(e.name, sig);
      if (prev !== sig || now() - mt < 30e3) continue;   // still being copied: wait until it is unchanged for a scan and 30 s old
      try { await importWatched(e.name, p, isZip, files); } catch (err) { console.error('watch import', e.name, err.message); }
      done[sig] = now(); await writeJson(WATCH_F, done);
      const dst = path.join(WATCH, '_imported', e.name.replace(/\.zip$/i, '') + ' ' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + (isZip ? '.zip' : ''));
      await fsp.mkdir(path.dirname(dst), { recursive: true }).then(() => fsp.rename(p, dst)).catch(() => {});
      watchSeen.delete(e.name);
    }
  } catch (e) { console.error('watch', e.message); }
  finally { watchBusy = false; }
}
async function importWatched(name, p, isZip, files) {
  const s = newSession({ name: name.replace(/\.zip$/i, '').replace(/[_]+/g, ' ').trim(), source: settings.watchSource }, 'watch');
  s.draft = { base: null, by: 'watch', started: now(), tracks: [] };
  await writeJson(path.join(D.sessions, s.id + '.json'), s); sessions.set(s.id, s);
  const tmpDir = await fsp.mkdtemp(path.join(D.tmp, 'watch-'));
  let oldest = Infinity;
  for (const f of files) { const st = await fsp.stat(f).catch(() => null); if (st) oldest = Math.min(oldest, st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs, st.mtimeMs); }
  if (oldest < Infinity) await withSession(s.id, x => noteFileDate(x, localDate(oldest)));
  try {
    if (isZip) files = await unzipTo(p, path.join(tmpDir, 'x'));
    for (const f of files) { const t = path.join(tmpDir, id(6) + path.extname(f)); await fsp.copyFile(f, t); await addTrack(s.id, 'watch', t, path.basename(f)); }
  } finally { fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}); }
  // save version 1.0.0 once every track has converted (set only now, so it never saves with half the files)
  await withSession(s.id, x => { if (!x.draft) return false; x.draft.autoSave = 'Imported from the watch folder'; maybeAutoSave(x); });
  console.log(`watch folder: imported "${s.name}" (${files.length} files)`);
}
setInterval(scanWatch, +(process.env.WATCH_SCAN_MS || 15e3)).unref();

// ---------- mixes ----------
const mixDir = sid => path.join(D.mixes, sid);
async function listMixes(sid) {
  const out = [];
  for (const f of await fsp.readdir(mixDir(sid)).catch(() => [])) { if (!f.endsWith('.json')) continue; const m = await readJson(path.join(mixDir(sid), f), null); if (m) { delete m.data; out.push(m); } }
  return out.sort((a, b) => b.updated - a.updated);
}
const mixVisible = (u, m) => u.admin || can(u, 'seeMixes') || m.by === u.id || m.reference;
async function saveMix(s, u, b, version) {
  scheduleMirror(s.id);
  if (!b.data || typeof b.data !== 'object') throw httpErr(400, 'No mix data');
  const raw = JSON.stringify(b.data); if (raw.length > 4e6) throw httpErr(413, 'Mix is too large');
  await fsp.mkdir(mixDir(s.id), { recursive: true });
  if (okId(b.mixId)) {
    const f = path.join(mixDir(s.id), b.mixId + '.json'), m = await readJson(f, null);
    if (m && m.by === u.id) { m.data = b.data; m.updated = now(); if (str(b.name, 80)) m.name = str(b.name, 80); m.version = version || m.version; await writeJson(f, m); delete m.data; return m; }
  }
  const m = { id: id(4), sid: s.id, version: version || null, name: str(b.name, 80) || `${u.display}'s mix`, by: u.id, byName: u.display, created: now(), updated: now(), reference: false, lwm: !!b.lwm, data: b.data };
  await writeJson(path.join(mixDir(s.id), m.id + '.json'), m); delete m.data; return m;
}

// ---------- recordings: the Main LR mix as recorded in LiveWebMixer, kept for review ----------
const recDir = sid => path.join(D.recs, sid);
async function listRecordings(sid) {
  const out = [];
  for (const f of await fsp.readdir(recDir(sid)).catch(() => [])) { if (!/^[a-f0-9]+\.json$/.test(f)) continue; const r = await readJson(path.join(recDir(sid), f), null); if (r) out.push(r); }
  return out.sort((a, b) => b.created - a.created);
}
async function addRecording(req, s, u, version, q) {
  scheduleMirror(s.id);
  const rid = id(4), dir = recDir(s.id), wav = path.join(dir, rid + '.wav');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await streamTo(req, wav + '.part'); await fsp.rename(wav + '.part', wav); await fsp.chmod(wav, 0o444).catch(() => {});
    const pr = await probe(wav);
    await renderPreview(wav, path.join(dir, rid + '.opus'), path.join(dir, rid + '.peaks.json'), pr.channels > 1 ? 2 : 1);
    let mixName = '';
    const mixId = okId(q.get('mixId')) ? q.get('mixId') : null;
    if (mixId) { const mm = await readJson(path.join(mixDir(s.id), mixId + '.json'), null); mixName = mm ? mm.name : ''; }
    const r = { id: rid, sid: s.id, version, mixId, mixName, name: str(q.get('name') || '', 80) || `${u.display}, ${new Date().toLocaleDateString('en-US')}`, by: u.id, byName: u.display,
      created: now(), duration: pr.duration, start: Math.max(0, +q.get('start') || 0), size: (await fsp.stat(wav)).size, notes: '', notesBy: null, notesAt: null };
    await writeJson(path.join(dir, rid + '.json'), r);
    return r;
  } catch (e) { for (const x of ['.wav', '.wav.part', '.opus', '.peaks.json']) fsp.rm(path.join(dir, rid + x), { force: true }).catch(() => {}); throw e; }
}

// ---------- mixer copies: what LiveWebMixer plays (48 kHz FLAC, and Opus for remote use) ----------
const MIXQ = { flac: { ext: '.flac', mime: 'audio/flac' }, hi: { ext: '.hi.opus', mime: 'audio/ogg', kbps: [96, 160] }, lo: { ext: '.lo.opus', mime: 'audio/ogg', kbps: [48, 80] } };
const mixerPath = (h, q) => shard(path.join(DATA, 'mixer'), h, MIXQ[q].ext);
const mixerJobs = new Map();
function mixerCopies(h) {
  if (mixerJobs.has(h)) return mixerJobs.get(h);
  const job = (async () => {
    if ((await Promise.all(Object.keys(MIXQ).map(q => exists(mixerPath(h, q))))).every(Boolean)) return;
    const meta = await blobMeta(h), ch = meta && meta.channels > 1 ? 2 : 1, tmp = [], args = ['-y', '-v', 'error', '-i', blobPath(h)];
    await fsp.mkdir(path.dirname(mixerPath(h, 'flac')), { recursive: true });
    for (const [q, Q] of Object.entries(MIXQ)) {
      const t = mixerPath(h, q) + '.' + id() + '.tmp'; tmp.push([t, mixerPath(h, q)]);
      args.push('-map', '0:a:0', '-vn', '-ac', String(ch), '-ar', '48000');
      if (Q.kbps) args.push('-c:a', 'libopus', '-b:a', Q.kbps[ch - 1] + 'k', '-vbr', 'on', '-application', 'audio', '-f', 'ogg'); else args.push('-c:a', 'flac', '-compression_level', '5', '-f', 'flac');
      args.push(t);
    }
    try { await run('ffmpeg', args); for (const [a, b] of tmp) await fsp.rename(a, b); }
    finally { for (const [a] of tmp) fsp.rm(a, { force: true }).catch(() => {}); }
  })();
  mixerJobs.set(h, job); job.finally(() => mixerJobs.delete(h)).catch(() => {});
  return job;
}
async function mixerSizes(h, ch, dur) {
  const o = {};
  for (const [q, Q] of Object.entries(MIXQ)) { const st = await fsp.stat(mixerPath(h, q)).catch(() => null); o[q] = st ? st.size : Math.round(Q.kbps ? Q.kbps[ch > 1 ? 1 : 0] * 125 * dur : dur * 48000 * 2 * ch * 0.55); }
  return o;
}
// Make the mixer copies in the background for every saved version (one at a time, so imports stay quick).
const mixerQueue = []; let mixerBusy = false;
function queueMixer(hashes) { for (const h of hashes) if (h && !mixerQueue.includes(h)) mixerQueue.push(h); if (!mixerBusy) mixerNext(); }
async function mixerNext() { mixerBusy = true; while (mixerQueue.length) { const h = mixerQueue.shift(); await mixerCopies(h).catch(e => console.error('mixer copy', e.message)); } mixerBusy = false; }
setTimeout(() => queueMixer([...sessions.values()].flatMap(s => s.versions.flatMap(v => v.tracks.map(t => t.hash)))), 5000).unref();

// Sessions as LiveWebMixer sees them (docs/LIVEVAULT-API.md in LiveWebMixer).
const v1List = s => { const vs = [...s.versions].reverse(); return { id: s.id, name: s.name, latest: vs[0].v, versions: vs.map(v => v.v), tags: s.tags, recorded: s.recorded || '', tracks: vs[0].tracks.filter(t => t.kind !== 'off').length, duration: trackDur(vs[0].tracks) }; };
const lwmMixFile = async (s, u, ver) => (await listMixesFull(s.id)).find(m => m.lwm && m.by === u.id && m.version === ver) || null;
async function listMixesFull(sid) {
  const out = [];
  for (const f of await fsp.readdir(mixDir(sid)).catch(() => [])) if (f.endsWith('.json')) { const m = await readJson(path.join(mixDir(sid), f), null); if (m) out.push(m); }
  return out;
}

// ---------- readable library folders on the drive ----------
// <Session> (<date>)/v1.0.0/01 Kick.wav … hard links to the one stored copy, so versions cost no extra space.
// Recordings/ and Mixes/ hold the Main LR takes and the mix settings. LiveVault owns these folders and rewrites them.
const MARK = '.livevault-session', mirrorDirs = new Map(), mirrorTimers = new Map();
const safeName = n => String(n || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^[.\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled';
if (libOn) for (const e of fs.readdirSync(LIB, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue;
  try { const sid = fs.readFileSync(path.join(LIB, e.name, MARK), 'utf8').trim(); if (okId(sid)) mirrorDirs.set(sid, e.name); } catch {}
}
function scheduleMirror(sid) {
  if (!libOn) return;
  clearTimeout(mirrorTimers.get(sid));
  mirrorTimers.set(sid, setTimeout(() => { mirrorTimers.delete(sid); syncMirror(sid).catch(e => console.error('library folder', sid, e.message)); }, 800));
}
async function linkInto(target, dest) {
  try { await fsp.link(target, dest); }
  catch (e) { if (e.code === 'EEXIST') return; await fsp.symlink(path.relative(path.dirname(dest), target), dest); }   // different file system: a relative link instead
}
async function syncMirror(sid) {
  const s = sessions.get(sid), old = mirrorDirs.get(sid);
  if (!s) { if (old) { await fsp.rm(path.join(LIB, old), { recursive: true, force: true }); mirrorDirs.delete(sid); } return; }
  // what the folder should hold
  const want = new Map(), uniq = (dir, base, ext) => { let p = `${dir}/${base}${ext}`, n = 2; while (want.has(p)) p = `${dir}/${base} (${n++})${ext}`; return p; };
  for (const v of s.versions) {
    let no = 0;
    for (const t of v.tracks) {
      const label = t.kind === 'reference' ? 'REF' : t.kind === 'off' ? 'Unused' : String(++no).padStart(2, '0');
      want.set(uniq('v' + v.v, `${label} ${safeName(t.name)}`, '.wav'), { link: blobPath(t.hash) });
    }
  }
  for (const r of await listRecordings(sid)) want.set(uniq('Recordings', `${localDate(r.created)} ${safeName(r.name)} (v${r.version})`, '.wav'), { link: path.join(recDir(sid), r.id + '.wav') });
  for (const m of await listMixesFull(sid)) want.set(uniq('Mixes', `${safeName(m.name)} (v${m.version})`, '.json'),
    { text: JSON.stringify({ name: m.name, by: m.byName, version: m.version, reference: m.reference, updated: new Date(m.updated).toISOString(), mix: m.data }, null, 2) });
  if (!want.size) { if (old) { await fsp.rm(path.join(LIB, old), { recursive: true, force: true }); mirrorDirs.delete(sid); } return; }   // nothing saved yet
  // its folder name follows the session name and date
  let name = safeName(s.name) + (okDate(s.recorded) ? ` (${s.recorded})` : '');
  if ([...mirrorDirs].some(([x, n]) => x !== sid && n.toLowerCase() === name.toLowerCase())) name += ` [${sid}]`;
  if (old && old !== name) { await fsp.rename(path.join(LIB, old), path.join(LIB, name)).catch(async () => { await fsp.rm(path.join(LIB, old), { recursive: true, force: true }); }); }
  const root = path.join(LIB, name); mirrorDirs.set(sid, name);
  await fsp.mkdir(root, { recursive: true }); await fsp.writeFile(path.join(root, MARK), sid);
  // remove what should not be there, add or fix what should
  const have = new Set();
  for (const d of await fsp.readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !(/^v\d+\.\d+\.\d+$/.test(d.name) || d.name === 'Recordings' || d.name === 'Mixes')) continue;
    for (const f of await fsp.readdir(path.join(root, d.name))) { const rel = `${d.name}/${f}`; if (want.has(rel)) have.add(rel); else await fsp.rm(path.join(root, rel), { recursive: true, force: true }); }
    if (!(await fsp.readdir(path.join(root, d.name))).length) await fsp.rmdir(path.join(root, d.name)).catch(() => {});
  }
  for (const [rel, w] of want) {
    const dest = path.join(root, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (w.link) {
      const [a, b] = await Promise.all([fsp.stat(w.link).catch(() => null), have.has(rel) ? fsp.stat(dest).catch(() => null) : null]);
      if (!a) continue;
      if (b && b.ino === a.ino && b.dev === a.dev) continue;
      if (have.has(rel)) await fsp.rm(dest, { force: true });
      await linkInto(w.link, dest);
    } else if (!have.has(rel) || (await fsp.readFile(dest, 'utf8').catch(() => '')) !== w.text) await fsp.writeFile(dest, w.text);
  }
}
async function syncAllMirrors() {
  for (const sid of sessions.keys()) await syncMirror(sid).catch(e => console.error('library folder', sid, e.message));
  for (const sid of [...mirrorDirs.keys()]) if (!sessions.has(sid)) await syncMirror(sid).catch(() => {});
}

// ---------- files with Range support ----------
async function serveFile(req, res, f, type, extra = {}) {
  const st = await fsp.stat(f).catch(() => null);
  if (!st) return send(res, 404, 'Not found');
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', ...extra };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? +m[1] : st.size - +m[2], b = m[1] && m[2] ? +m[2] : st.size - 1;
    a = Math.max(0, a); b = Math.min(st.size - 1, b);
    if (a > b) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  res.writeHead(200, { ...h, 'Content-Length': st.size });
  req.method === 'HEAD' ? res.end() : fs.createReadStream(f).pipe(res);
}
const dispo = name => `attachment; filename="${name.replace(/[^\w .()\-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
async function serveStatic(req, res, p) {
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  const buf = await fsp.readFile(f).catch(() => null);
  if (!buf) return send(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}

// ---------- storage ----------
async function dirSize(d) { let n = 0; for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); n += e.isDirectory() ? await dirSize(p) : (await fsp.stat(p).catch(() => ({ size: 0 }))).size; } return n; }
function referenced() {
  const h = new Set(), o = new Set();
  for (const s of sessions.values()) for (const ts of [...s.versions.map(v => v.tracks), s.draft ? s.draft.tracks : []]) for (const t of ts) { if (t.hash) h.add(t.hash); if (t.origHash) o.add(t.origHash); }
  return { h, o };
}
async function cleanup() {
  const { h, o } = referenced(); let files = 0, bytes = 0;
  await fsp.mkdir(path.join(DATA, 'mixer'), { recursive: true });
  const sweep = async (dir, keep, re) => {
    for (const sub of await fsp.readdir(dir).catch(() => [])) for (const f of await fsp.readdir(path.join(dir, sub)).catch(() => [])) {
      const m = re.exec(f); if (!m || keep.has(m[1])) continue;
      const p = path.join(dir, sub, f), st = await fsp.stat(p).catch(() => null); if (!st) continue;
      await fsp.unlink(p).catch(() => {}); files++; bytes += st.size;
    }
  };
  await sweep(D.blobs, h, /^([a-f0-9]{64})\./); await sweep(D.prev, h, /^([a-f0-9]{64})\./); await sweep(path.join(DATA, 'mixer'), h, /^([a-f0-9]{64})\./); await sweep(D.orig, o, /^([a-f0-9]{64})\./);
  for (const f of await fsp.readdir(D.raw).catch(() => [])) { const r = await readJson(path.join(D.raw, f), null); if (r && !r.outs.some(x => h.has(x.hash))) await fsp.unlink(path.join(D.raw, f)).catch(() => {}); }
  for (const f of await fsp.readdir(D.tmp).catch(() => [])) await fsp.rm(path.join(D.tmp, f), { recursive: true, force: true }).catch(() => {});
  return { files, bytes };
}

// ---------- router ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname), m = req.method, q = url.searchParams;
  const seg = p.split('/').filter(Boolean);
  const isApi = seg[0] === 'api', isMedia = seg[0] === 'media';
  if (!isApi && !isMedia) return m === 'GET' || m === 'HEAD' ? serveStatic(req, res, p) : send(res, 405, 'Method not allowed');

  // ---- LiveVault API version 1, for LiveWebMixer (personal access token in the Authorization header) ----
  if (isApi && seg[1] === 'v1') {
    const u = tokenUser(req); if (!u) return send(res, 401, { error: 'Missing or wrong access token' });
    if (seg[2] === 'info' && m === 'GET') return send(res, 200, { name: 'LiveVault', version: VERSION, api: 1, user: u.display });
    if (seg[2] === 'sessions' && seg.length === 3 && m === 'GET') {
      const qq = (q.get('q') || '').toLowerCase();
      return send(res, 200, { sessions: [...sessions.values()].filter(s => visible(u, s) && s.versions.length && (!qq || (s.name + ' ' + s.artist + ' ' + s.tags.join(' ')).toLowerCase().includes(qq))).sort((a, b) => natural(a.name, b.name)).map(v1List) });
    }
    if (seg[2] === 'sessions' && seg[4] === 'versions') {
      const s = getVisible(u, seg[3]), v = s.versions.find(x => x.v === seg[5]);
      if (!v) return send(res, 404, { error: 'No such version' });
      if (seg.length === 6 && m === 'GET') {
        queueMixer(v.tracks.map(t => t.hash));
        const tracks = [];
        for (const t of v.tracks) if (t.kind !== 'off') tracks.push({ id: t.id, name: t.name, file: t.hash, role: t.kind, channels: t.channels > 1 ? 2 : 1, duration: t.duration, sizes: await mixerSizes(t.hash, t.channels, t.duration) });
        return send(res, 200, { id: s.id, name: s.name, version: v.v, versions: [...s.versions].reverse().map(x => x.v), tags: s.tags, notes: [s.listenFor && 'Listen for: ' + s.listenFor, s.notes].filter(Boolean).join('\n\n'), tracks });
      }
      if (seg[6] === 'mixes' && seg[7] === 'livewebmixer' && seg.length === 8) {
        const mm = await lwmMixFile(s, u, v.v);
        if (m === 'GET') return mm ? send(res, 200, mm.data) : send(res, 404, { error: 'No mix saved yet' });
        if (m === 'PUT') { if (!can(u, 'mix')) return send(res, 403, { error: 'This access token may not save mixes' }); await saveMix(s, u, { mixId: mm && mm.id, data: await readBody(req), lwm: true }, v.v); return send(res, 200, { ok: true }); }
      }
      if (seg[6] === 'recordings' && seg.length === 7 && m === 'PUT') {
        if (!can(u, 'mix')) return send(res, 403, { error: 'This access token may not save recordings' });
        const mm = await lwmMixFile(s, u, v.v); if (mm) q.set('mixId', mm.id); else q.delete('mixId');
        return send(res, 200, await addRecording(req, s, u, v.v, q));
      }
    }
    if (seg[2] === 'files' && okHash(seg[3]) && MIXQ[seg[4]] && (m === 'GET' || m === 'HEAD')) {
      if (![...sessions.values()].some(s => visible(u, s) && s.versions.some(v => v.tracks.some(t => t.hash === seg[3])))) return send(res, 404, { error: 'No such file' });
      await mixerCopies(seg[3]);
      return serveFile(req, res, mixerPath(seg[3], seg[4]), MIXQ[seg[4]].mime, { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }
    return send(res, 404, { error: 'Not found' });
  }

  // CSRF guard: every state-changing call from the page carries this header (other sites cannot add it without a CORS pre-flight)
  if (m !== 'GET' && m !== 'HEAD' && req.headers['x-livevault'] !== '1') return send(res, 403, { error: 'Missing request header' });
  const u = currentUser(req);

  if (isApi && seg[1] === 'state' && m === 'GET') return send(res, 200, { version: VERSION, needsSetup: !users.length, user: u ? pubUser(u) : null, watch: watchOn(), busy: running + queue.length });
  if (isApi && seg[1] === 'setup' && m === 'POST') {
    if (users.length) return send(res, 400, { error: 'LiveVault is already set up' });
    const b = await readBody(req), un = str(b.username, 40).toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(un)) return send(res, 400, { error: 'User names use letters, numbers, dots, dashes or underscores' });
    const pp = pwProblem(b.password); if (pp) return send(res, 400, { error: pp });
    const nu = { id: id(4), username: un, display: str(b.display, 60) || un, admin: true, perms: normPerms(Object.fromEntries(PERMS.map(k => [k, true]))), disabled: false, created: now() };
    setPw(nu, b.password); users.push(nu); await saveUsers();
    return send(res, 200, { user: pubUser(nu) }, { 'Set-Cookie': startLogin(req, res, nu) });
  }
  if (isApi && seg[1] === 'login' && m === 'POST') {
    const ip = req.socket.remoteAddress || '';
    if (tooManyFails(ip)) return send(res, 429, { error: 'Too many failed sign-ins. Wait 10 minutes and try again.' });
    const b = await readBody(req), lu = users.find(x => x.username === str(b.username, 40).toLowerCase());
    if (!lu || lu.disabled || !checkPw(lu, b.password || '')) { noteFail(ip); return send(res, 401, { error: 'Wrong user name or password' }); }
    fails.delete(ip);
    return send(res, 200, { user: pubUser(lu) }, { 'Set-Cookie': startLogin(req, res, lu) });
  }
  if (isApi && seg[1] === 'logout' && m === 'POST') {
    const t = cookies(req).lv_session; if (t) { delete logins[sha(t)]; saveLogins(); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'lv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (!u) return send(res, 401, { error: 'Sign in first' });

  // ---- previews and waveforms (?s=<session id> proves the track belongs to a session you can see) ----
  if (isMedia && seg[1] === 'rec') {
    const s = getVisible(u, seg[2]), r = okId(seg[3]) && await readJson(path.join(recDir(s.id), seg[3] + '.json'), null);
    if (!r || !mixVisible(u, r)) return send(res, 404, 'Not found');
    if (seg[4] === 'peaks') return serveFile(req, res, path.join(recDir(s.id), r.id + '.peaks.json'), 'application/json');
    return serveFile(req, res, path.join(recDir(s.id), r.id + '.opus'), 'audio/ogg');
  }
  if (isMedia) {
    const s = getVisible(u, q.get('s')), h = seg[2];
    if (!okHash(h) || !sessionHas(s, h)) return send(res, 404, 'Not found');
    if (seg[1] === 'preview') return serveFile(req, res, shard(D.prev, h, '.opus'), 'audio/ogg');
    if (seg[1] === 'peaks') return serveFile(req, res, shard(D.prev, h, '.peaks.json'), 'application/json');
    return send(res, 404, 'Not found');
  }

  // ---- me ----
  if (seg[1] === 'me' && m === 'PATCH') {
    const b = await readBody(req);
    if (typeof b.display === 'string' && b.display.trim()) u.display = str(b.display, 60);
    if (b.password !== undefined) { if (!checkPw(u, b.oldPassword || '')) return send(res, 400, { error: 'Your current password is not right' }); const pp = pwProblem(b.password); if (pp) return send(res, 400, { error: pp }); setPw(u, b.password); }
    await saveUsers(); return send(res, 200, { user: pubUser(u) });
  }
  if (seg[1] === 'me' && seg[2] === 'tokens') {
    u.tokens = u.tokens || [];
    if (seg.length === 3 && m === 'GET') return send(res, 200, { tokens: u.tokens.map(pubToken) });
    if (seg.length === 3 && m === 'POST') {
      const b = await readBody(req), value = 'lv_' + id(24), t = { id: id(4), name: str(b.name, 60) || 'LiveWebMixer', sha: sha(value), created: now(), used: null };
      if (u.tokens.length >= 20) return send(res, 400, { error: 'You already have 20 access tokens; remove one first' });
      u.tokens.push(t); await saveUsers(); return send(res, 200, { token: value, ...pubToken(t) });
    }
    if (okId(seg[3]) && m === 'DELETE') { u.tokens = u.tokens.filter(t => t.id !== seg[3]); await saveUsers(); return send(res, 200, { tokens: u.tokens.map(pubToken) }); }
  }
  if (seg[1] === 'people' && m === 'GET') return send(res, 200, { people: users.filter(x => !x.disabled).map(x => ({ id: x.id, display: x.display })) });

  // ---- users (admin) ----
  if (seg[1] === 'users') {
    if (!u.admin) return send(res, 403, { error: 'Only admins can manage users' });
    if (seg.length === 2 && m === 'GET') return send(res, 200, { users: users.map(pubUser), perms: PERMS });
    if (seg.length === 2 && m === 'POST') {
      const b = await readBody(req), un = str(b.username, 40).toLowerCase();
      if (!/^[a-z0-9._-]{2,40}$/.test(un)) return send(res, 400, { error: 'User names use letters, numbers, dots, dashes or underscores' });
      if (users.some(x => x.username === un)) return send(res, 400, { error: 'That user name is taken' });
      const pp = pwProblem(b.password); if (pp) return send(res, 400, { error: pp });
      const nu = { id: id(4), username: un, display: str(b.display, 60) || un, admin: !!b.admin, perms: normPerms(b.perms), disabled: false, created: now() };
      setPw(nu, b.password); users.push(nu); await saveUsers(); return send(res, 200, { user: pubUser(nu) });
    }
    const x = users.find(x => x.id === seg[2]); if (!x) return send(res, 404, { error: 'User not found' });
    const admins = users.filter(y => y.admin && !y.disabled);
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.display === 'string' && b.display.trim()) x.display = str(b.display, 60);
      if (b.perms) x.perms = normPerms(b.perms);
      if (typeof b.admin === 'boolean') { if (!b.admin && x.admin && admins.length === 1) return send(res, 400, { error: 'LiveVault needs at least one admin' }); x.admin = b.admin; }
      if (typeof b.disabled === 'boolean') { if (b.disabled && x.admin && admins.length === 1) return send(res, 400, { error: 'You cannot turn off the last admin' }); x.disabled = b.disabled; }
      if (b.password) { const pp = pwProblem(b.password); if (pp) return send(res, 400, { error: pp }); setPw(x, b.password); for (const [k, l] of Object.entries(logins)) if (l.uid === x.id && x.id !== u.id) delete logins[k]; saveLogins(); }
      if (x.disabled) { for (const [k, l] of Object.entries(logins)) if (l.uid === x.id) delete logins[k]; saveLogins(); }
      await saveUsers(); return send(res, 200, { user: pubUser(x) });
    }
    if (m === 'DELETE') {
      if (x.admin && admins.length === 1) return send(res, 400, { error: 'You cannot remove the last admin' });
      users = users.filter(y => y !== x); for (const [k, l] of Object.entries(logins)) if (l.uid === x.id) delete logins[k];
      saveLogins(); await saveUsers(); return send(res, 200, { ok: true });
    }
  }

  // ---- settings and storage (admin) ----
  if (seg[1] === 'settings') {
    if (!u.admin) return send(res, 403, { error: 'Only admins can change settings' });
    if (m === 'GET') return send(res, 200, { settings, watch: watchOn(), watchDir: WATCH, sources: SOURCES });
    if (m === 'PUT') {
      const b = await readBody(req), url = v => { v = str(v, 300).replace(/\/+$/, ''); if (v && !/^https?:\/\/[^\s]+$/i.test(v)) throw httpErr(400, 'Addresses start with http:// or https://'); return v; };
      settings = { lwmUrl: url(b.lwmUrl), keepOriginals: b.keepOriginals !== false, watchSource: SOURCES.includes(b.watchSource) ? b.watchSource : 'sq5' };
      await writeJson(SETTINGS_F, settings); return send(res, 200, { settings });
    }
  }
  if (seg[1] === 'storage') {
    if (!u.admin) return send(res, 403, { error: 'Only admins can see storage' });
    if (m === 'GET') {
      const fsInfo = await fsp.statfs(DATA).catch(() => null);
      return send(res, 200, { audio: await dirSize(D.blobs), originals: await dirSize(D.orig), previews: await dirSize(D.prev) + await dirSize(path.join(DATA, 'mixer')), mixes: await dirSize(D.mixes), recordings: await dirSize(D.recs),
        free: fsInfo ? fsInfo.bavail * fsInfo.bsize : null, sessions: sessions.size, busy: running + queue.length,
        library: libOn ? { path: LIB, free: await fsp.statfs(LIB).then(x => x.bavail * x.bsize).catch(() => null) } : null, libraryError: libErr });
    }
    if (seg[2] === 'library' && m === 'POST') { if (!libOn) return send(res, 400, { error: 'No library dataset is mounted at /library' }); await syncAllMirrors(); return send(res, 200, { ok: true, folders: mirrorDirs.size }); }
    if (seg[2] === 'cleanup' && m === 'POST') { if (running + queue.length) return send(res, 400, { error: 'Wait until all tracks have finished converting' }); return send(res, 200, await cleanup()); }
  }

  // ---- sessions ----
  if (seg[1] === 'sessions') {
    if (seg.length === 2 && m === 'GET') return send(res, 200, { sessions: [...sessions.values()].filter(s => visible(u, s)).map(summary).sort((a, b) => natural(a.name, b.name)) });
    if (seg.length === 2 && m === 'POST') {
      if (!can(u, 'upload')) return send(res, 403, { error: 'You do not have permission to add sessions' });
      const s = newSession(await readBody(req), u.id); s.draft = { base: null, by: u.id, started: now(), tracks: [] };
      await writeJson(path.join(D.sessions, s.id + '.json'), s); sessions.set(s.id, s);
      return send(res, 200, sessionOut(u, s));
    }
    const s = getVisible(u, seg[2]), sid = s.id, need = pm => { if (!can(u, pm)) throw httpErr(403, 'You do not have permission to do that'); };
    if (seg.length === 3) {
      if (m === 'GET') { const o = sessionOut(u, s); o.mixCount = (await listMixes(sid)).filter(x => mixVisible(u, x)).length; o.recCount = (await listRecordings(sid)).filter(x => mixVisible(u, x)).length; return send(res, 200, o); }
      if (m === 'PATCH') { need('edit'); const b = await readBody(req); return send(res, 200, sessionOut(u, await withSession(sid, x => applyMeta(x, b)))); }
      if (m === 'DELETE') {
        need('delete');
        await withSession(sid, () => false); sessions.delete(sid); scheduleMirror(sid);
        await fsp.rm(path.join(D.sessions, sid + '.json'), { force: true }); await fsp.rm(mixDir(sid), { recursive: true, force: true }); await fsp.rm(recDir(sid), { recursive: true, force: true });
        return send(res, 200, { ok: true });
      }
    }
    if (seg[3] === 'upload' && m === 'PUT') { need('upload'); return handleUpload(req, res, u, s, q.get('name'), okId(q.get('replace')) ? q.get('replace') : null, q.get('date')); }
    if (seg[3] === 'draft') {
      need('upload');
      if (seg.length === 4 && m === 'PATCH') {
        const b = await readBody(req);
        return send(res, 200, sessionOut(u, await withSession(sid, x => { const d = ensureDraft(x, u.id); if (Array.isArray(b.order)) { const pos = new Map(d.tracks.map((t, k) => { const i = b.order.indexOf(t.id); return [t.id, i < 0 ? 1e6 + k : i]; })); d.tracks.sort((a, c) => pos.get(a.id) - pos.get(c.id)); } })));
      }
      if (seg[4] === 'finish' && m === 'POST') {
        // all files of a dropped folder are uploaded: save the first version as soon as they have converted
        const b = await readBody(req);
        return send(res, 200, sessionOut(u, await withSession(sid, x => { if (!x.draft) return false; x.draft.autoSave = str(b.message, 200) || 'Imported from a dropped folder'; maybeAutoSave(x); })));
      }
      if (seg[4] === 'discard' && m === 'POST') {
        let gone = [];
        const out = await withSession(sid, x => { if (!x.draft) return false; gone = x.draft.tracks.filter(t => t.status !== 'ready').map(t => t.id); x.draft = null; });
        for (const t of gone) fsp.rm(path.join(D.inc, t), { recursive: true, force: true }).catch(() => {});
        return send(res, 200, sessionOut(u, out));
      }
      if (seg[4] === 'tracks' && okId(seg[5])) {
        const tid = seg[5];
        if (m === 'PATCH') {
          const b = await readBody(req);
          return send(res, 200, sessionOut(u, await withSession(sid, x => {
            const t = ensureDraft(x, u.id).tracks.find(t => t.id === tid); if (!t) throw httpErr(404, 'Track not found');
            if (typeof b.name === 'string' && b.name.trim()) t.name = str(b.name, 60);
            if (KINDS.includes(b.kind)) t.kind = b.kind;
          })));
        }
        if (m === 'DELETE') {
          const out = await withSession(sid, x => { const d = ensureDraft(x, u.id), i = d.tracks.findIndex(t => t.id === tid); if (i < 0) return false; d.tracks.splice(i, 1); });
          fsp.rm(path.join(D.inc, tid), { recursive: true, force: true }).catch(() => {});
          return send(res, 200, sessionOut(u, out));
        }
      }
    }
    if (seg[3] === 'versions' && seg.length === 4 && m === 'POST') {
      need('upload'); const b = await readBody(req); let v;
      const out = await withSession(sid, x => { v = saveVersion(x, u.id, b.bump, b.message); });
      queueMixer(out.versions[out.versions.length - 1].tracks.map(t => t.hash));
      return send(res, 200, { version: v, session: sessionOut(u, out) });
    }
    if (seg[3] === 'restore' && m === 'POST') {
      need('upload'); const b = await readBody(req);
      return send(res, 200, sessionOut(u, await withSession(sid, x => {
        const v = x.versions.find(y => y.v === b.version); if (!v) throw httpErr(404, 'Version not found');
        if (x.draft && x.draft.tracks.some(t => t.status !== 'ready')) throw httpErr(400, 'Wait for the tracks that are converting, or discard the unsaved changes first');
        x.draft = { base: v.v, by: u.id, started: now(), tracks: v.tracks.map(t => ({ ...clone(t), status: 'ready', error: '' })), restoredFrom: v.v };
      })));
    }
    if (seg[3] === 'diff' && m === 'GET') {
      const a = findVersion(s, q.get('a')), b = findVersion(s, q.get('b') || 'draft');
      if (!b) return send(res, 404, { error: 'Version not found' });
      return send(res, 200, diff(a && a.tracks, b.tracks));
    }
    if (seg[3] === 'files' && okHash(seg[4]) && (m === 'GET' || m === 'HEAD')) {
      need('download');
      const h = seg[4], all = [...s.versions.flatMap(v => v.tracks), ...(s.draft ? s.draft.tracks : [])];
      if (q.get('orig') === '1') { const t = all.find(t => t.origHash === h); if (!t) return send(res, 404, 'Not found'); return serveFile(req, res, origPath(h, t.origExt), 'application/octet-stream', { 'Content-Disposition': dispo(t.srcName || (t.name + t.origExt)) }); }
      const t = all.find(t => t.hash === h); if (!t) return send(res, 404, 'Not found');
      return serveFile(req, res, blobPath(h), 'audio/wav', { 'Content-Disposition': dispo(`${s.name} - ${t.name}.wav`) });
    }
    if (seg[3] === 'open' && m === 'POST') {
      need('mix');
      if (!settings.lwmUrl) return send(res, 400, { error: 'An admin needs to enter the LiveWebMixer address in LiveVault Settings first' });
      const b = await readBody(req), v = s.versions.find(x => x.v === b.version) || latest(s);
      if (!v) return send(res, 400, { error: 'Save a version of this session first' });
      queueMixer(v.tracks.map(t => t.hash));
      return send(res, 200, { url: `${settings.lwmUrl}/#vault=${encodeURIComponent(sid)}&version=${encodeURIComponent(v.v)}`, version: v.v });
    }
    if (seg[3] === 'recordings') {
      if (seg.length === 4 && m === 'GET') return send(res, 200, { recordings: (await listRecordings(sid)).filter(x => mixVisible(u, x)) });
      if (!okId(seg[4])) return send(res, 404, { error: 'Recording not found' });
      const f = path.join(recDir(sid), seg[4] + '.json'), r = await readJson(f, null);
      if (!r || !mixVisible(u, r)) return send(res, 404, { error: 'Recording not found' });
      if (seg[5] === 'download' && (m === 'GET' || m === 'HEAD')) { if (r.by !== u.id) need('download'); return serveFile(req, res, path.join(recDir(sid), r.id + '.wav'), 'audio/wav', { 'Content-Disposition': dispo(`${s.name} - ${r.name}.wav`) }); }
      if (m === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) { if (r.by !== u.id && !u.admin) return send(res, 403, { error: 'Only the owner can rename a recording' }); r.name = str(b.name, 80); }
        if (typeof b.notes === 'string') { need('edit'); r.notes = b.notes.slice(0, 20000); r.notesBy = u.id; r.notesByName = u.display; r.notesAt = now(); }
        await writeJson(f, r); scheduleMirror(sid); return send(res, 200, r);
      }
      if (m === 'DELETE') {
        if (r.by !== u.id && !can(u, 'delete')) return send(res, 403, { error: 'You can only delete your own recordings' });
        for (const x of ['.json', '.wav', '.opus', '.peaks.json']) await fsp.rm(path.join(recDir(sid), r.id + x), { force: true });
        scheduleMirror(sid);
        return send(res, 200, { ok: true });
      }
    }
    if (seg[3] === 'mixes') {
      if (seg.length === 4 && m === 'GET') return send(res, 200, { mixes: (await listMixes(sid)).filter(x => mixVisible(u, x)) });
      if (!okId(seg[4])) return send(res, 404, { error: 'Mix not found' });
      const f = path.join(mixDir(sid), seg[4] + '.json'), mm = await readJson(f, null);
      if (!mm || !mixVisible(u, mm)) return send(res, 404, { error: 'Mix not found' });
      if (seg[5] === 'download' && m === 'GET') return send(res, 200, mm, { 'Content-Disposition': dispo(`${s.name} - ${mm.name}.json`) });
      if (m === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim()) { if (mm.by !== u.id && !u.admin) return send(res, 403, { error: 'Only the owner can rename a mix' }); mm.name = str(b.name, 80); }
        if (typeof b.reference === 'boolean') { need('edit'); mm.reference = b.reference; }
        await writeJson(f, mm); delete mm.data; scheduleMirror(sid); return send(res, 200, mm);
      }
      if (m === 'DELETE') { if (mm.by !== u.id && !can(u, 'delete')) return send(res, 403, { error: 'You can only delete your own mixes' }); await fsp.rm(f, { force: true }); scheduleMirror(sid); return send(res, 200, { ok: true }); }
    }
  }
  send(res, 404, { error: 'Not found' });
}
const listener = (req, res) => handle(req, res).catch(e => { if (!res.headersSent) send(res, e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message }); else res.destroy(); });

// ---------- start ----------
if (libOn) setTimeout(() => syncAllMirrors().then(() => console.log(`library folders up to date in ${LIB}`)), 2000).unref();
http.createServer(listener).listen(PORT, () => console.log(`LiveVault ${VERSION}: http on ${PORT}` + (watchOn() ? `, watching ${WATCH}` : '') + (libOn ? `, audio in ${LIB}` : '')));
if (HTTPS_PORT) {
  try {
    const dir = path.join(DATA, 'tls'), key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
    const useOwn = process.env.TLS_CERT && process.env.TLS_KEY;
    if (!useOwn && !(fs.existsSync(key) && fs.existsSync(cert))) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=livevault',
        '-addext', 'subjectAltName=DNS:livevault,DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    }
    https.createServer({ key: fs.readFileSync(useOwn ? process.env.TLS_KEY : key), cert: fs.readFileSync(useOwn ? process.env.TLS_CERT : cert) }, listener)
      .listen(HTTPS_PORT, () => console.log(`LiveVault ${VERSION}: https on ${HTTPS_PORT}`));
  } catch (e) { console.error('https is off:', e.message); }
}
