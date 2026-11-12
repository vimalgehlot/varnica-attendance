// ============================================================
// VARNICA ATTENDANCE — Manual Review (unknown face) shared list
// File: /opt/varnica-attendance-api/review-router.js
//
// Every device sees the SAME list of unknown-face entries, and the
// server decides who gets to approve/reject each one (first one wins),
// so two devices can never punch the same entry twice.
//
//   GET  /api/review?bucket=T009            -> { ok, items:[...] }  (photo only while open)
//   POST /api/review/add      {bucket,item} -> adds one entry (safe to repeat)
//   POST /api/review/claim    {bucket,id,by}-> "I am handling this"  (pending -> processing)
//   POST /api/review/resolve  {bucket,id,status:'approved'|'rejected',staffId,by}
//   POST /api/review/release  {bucket,id,by}-> give a claim back (processing -> pending)
//
// A claim that is not finished within 2 minutes expires by itself.
//
// FACE AUTO-LEARNING (extra face samples per staff, shared by all devices)
//   GET  /api/review/learn?bucket=T009                 -> { ok, learn:{ staffId:[{d,at,src}] } }
//   POST /api/review/learn/add   {bucket,staffId,d,at,src}  (d = 128 numbers)
//   POST /api/review/learn/reset {bucket,staffId?}     (no staffId = everyone)
//
// SCAN SPEED LOG (last 500 scans, to measure how fast punching really is)
//   POST /api/review/stat {bucket,s:{ms,frames,result,dist,gap}}
//   GET  /api/review/stat?bucket=T009
// Plain Node (no extra packages). Data: ./review/<bucket>.json
// ============================================================
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'review');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}

const CLAIM_TTL_MS = Number(process.env.REVIEW_CLAIM_TTL_MS) || 2 * 60 * 1000;
const KEEP_DONE_MS = 30 * 24 * 3600 * 1000; // resolved entries are kept for 30 days
const MAX_DONE = 200;
const MAX_OPEN = 200;
const MAX_BODY = 400 * 1024;
const MAX_PHOTO = 150 * 1024; // characters of the base64 data-URL

const ID_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const BUCKET_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function fileFor(bucket) { return path.join(DIR, bucket + '.json'); }

function load(bucket) {
  let items = [];
  try { items = JSON.parse(fs.readFileSync(fileFor(bucket), 'utf8')); } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];
  const now = Date.now();
  // an expired claim goes back to "pending" so nobody is stuck behind a closed browser
  items.forEach(i => {
    if (i.status === 'processing' && now - Date.parse(i.claimedAt || 0) > CLAIM_TTL_MS) {
      i.status = 'pending'; delete i.claimedBy; delete i.claimedAt;
    }
  });
  return items;
}
function save(bucket, items) {
  const now = Date.now();
  const open = items.filter(i => i.status === 'pending' || i.status === 'processing');
  const done = items.filter(i => i.status !== 'pending' && i.status !== 'processing')
    .filter(i => now - Date.parse(i.resolvedAt || i.timestamp || 0) < KEEP_DONE_MS)
    .sort((a, b) => String(a.resolvedAt).localeCompare(String(b.resolvedAt)))
    .slice(-MAX_DONE);
  const keep = open.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-MAX_OPEN).concat(done);
  const fp = fileFor(bucket), tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(keep));
  fs.renameSync(tmp, fp); // atomic
}
// what a device is allowed to see (no internal claim fields; photo only while still open)
function view(i) {
  const open = i.status === 'pending' || i.status === 'processing';
  const v = { id: i.id, timestamp: i.timestamp, date: i.date, time: i.time, status: i.status };
  if (open && i.photo) v.photo = i.photo;
  if (i.staffId) v.staffId = i.staffId;
  if (i.resolvedAt) v.resolvedAt = i.resolvedAt;
  return v;
}
const LEARN_MAX = 8;
function learnFile(bucket) { return path.join(DIR, bucket + '-learn.json'); }
function loadLearn(bucket) {
  try { const o = JSON.parse(fs.readFileSync(learnFile(bucket), 'utf8')); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
}
function saveLearn(bucket, o) {
  const fp = learnFile(bucket), tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, fp);
}
function validDesc(d) {
  return Array.isArray(d) && d.length === 128 && d.every(v => typeof v === 'number' && isFinite(v) && Math.abs(v) < 2);
}
function who(by) { return (typeof by === 'string' && ID_RE.test(by)) ? by : 'unknown'; }

function readJson(req, res, cb) {
  let size = 0, tooBig = false;
  const chunks = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { tooBig = true; return; } chunks.push(c); });
  req.on('end', () => {
    if (tooBig) return send(res, 413, { ok: false, error: 'request too large' });
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { send(res, 400, { ok: false, error: 'bad json' }); }
  });
  req.on('error', () => {});
}

module.exports = function reviewRouter(req, res, next) {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { return next(); }
  const p = u.pathname.replace(/\/+$/, '') || '/';

  try {
    if (p === '/stat') {
      const statFile = b => path.join(DIR, b + '-stats.json');
      const loadStat = b => { try { const a = JSON.parse(fs.readFileSync(statFile(b), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
      if (req.method === 'GET') {
        const bucket = u.searchParams.get('bucket') || '';
        if (!BUCKET_RE.test(bucket)) return send(res, 400, { ok: false, error: 'bucket required' });
        const a = loadStat(bucket), punch = a.filter(x => x.result === 'punch');
        const avg = punch.length ? Math.round(punch.reduce((t, x) => t + x.ms, 0) / punch.length) : null;
        return send(res, 200, { ok: true, total: a.length, punches: punch.length, reviews: a.length - punch.length, avgPunchMs: avg, last: a.slice(-40) });
      }
      if (req.method !== 'POST') return next();
      return readJson(req, res, b => {
        try {
          b = b || {};
          const bucket = String(b.bucket || '');
          if (!BUCKET_RE.test(bucket)) return send(res, 400, { ok: false, error: 'bucket required' });
          const x = b.s || {};
          const num = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : null;
          const rec = { at: new Date().toISOString(), ms: Math.max(0, Math.min(600000, Number(x.ms) || 0)), frames: Math.max(0, Math.min(999, Number(x.frames) || 0)),
            result: x.result === 'punch' ? 'punch' : 'review', dist: num(x.dist), gap: num(x.gap), dev: who(b.by) };
          const a = loadStat(bucket); a.push(rec);
          const fp = statFile(bucket), tmp = fp + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(a.slice(-500))); fs.renameSync(tmp, fp);
          return send(res, 200, { ok: true });
        } catch (e) { send(res, 500, { ok: false, error: 'server error' }); }
      });
    }
    if (req.method === 'GET' && p === '/learn') {
      const bucket = u.searchParams.get('bucket') || '';
      if (!BUCKET_RE.test(bucket)) return send(res, 400, { ok: false, error: 'bucket required' });
      return send(res, 200, { ok: true, learn: loadLearn(bucket) });
    }
    if (req.method === 'POST' && (p === '/learn/add' || p === '/learn/reset')) {
      return readJson(req, res, b => {
        try {
          b = b || {};
          const bucket = String(b.bucket || '');
          if (!BUCKET_RE.test(bucket)) return send(res, 400, { ok: false, error: 'bucket required' });
          const o = loadLearn(bucket);
          if (p === '/learn/reset') {
            if (b.staffId) { if (!ID_RE.test(String(b.staffId))) return send(res, 400, { ok: false, error: 'bad staffId' }); delete o[String(b.staffId)]; }
            else Object.keys(o).forEach(k => delete o[k]);
            saveLearn(bucket, o);
            return send(res, 200, { ok: true });
          }
          const sid = String(b.staffId || '');
          if (!ID_RE.test(sid)) return send(res, 400, { ok: false, error: 'bad staffId' });
          if (!validDesc(b.d)) return send(res, 400, { ok: false, error: 'bad descriptor' });
          const at = new Date(b.at); if (isNaN(at.getTime())) return send(res, 400, { ok: false, error: 'bad at' });
          const list = Array.isArray(o[sid]) ? o[sid] : [];
          const atIso = at.toISOString();
          if (!list.some(x => x.at === atIso)) {
            list.push({ d: b.d.map(v => Math.round(v * 10000) / 10000), at: atIso, src: b.src === 'approved' ? 'approved' : 'auto' });
            list.sort((x, y) => String(x.at).localeCompare(String(y.at)));
          }
          o[sid] = list.slice(-LEARN_MAX);
          saveLearn(bucket, o);
          return send(res, 200, { ok: true, count: o[sid].length });
        } catch (e) { console.error('[review/learn]', e); send(res, 500, { ok: false, error: 'server error' }); }
      });
    }
    if (req.method === 'GET' && p === '/') {
      const bucket = u.searchParams.get('bucket') || '';
      if (!BUCKET_RE.test(bucket)) return send(res, 400, { ok: false, error: 'bucket required' });
      return send(res, 200, { ok: true, items: load(bucket).map(view) });
    }
    if (req.method !== 'POST' || ['/add', '/claim', '/resolve', '/release'].indexOf(p) < 0) return next();

    readJson(req, res, b => {
      try {
        b = b || {};
        if (!BUCKET_RE.test(String(b.bucket || ''))) return send(res, 400, { ok: false, error: 'bucket required' });
        const bucket = b.bucket;
        const items = load(bucket);
        const by = who(b.by);

        if (p === '/add') {
          const it = b.item || {};
          if (!ID_RE.test(String(it.id || ''))) return send(res, 400, { ok: false, error: 'bad id' });
          const existing = items.find(x => x.id === it.id);
          if (existing) return send(res, 200, { ok: true, existed: true, item: view(existing) });
          if (it.photo && (typeof it.photo !== 'string' || it.photo.indexOf('data:image/') !== 0)) return send(res, 400, { ok: false, error: 'bad photo' });
          if (it.photo && it.photo.length > MAX_PHOTO) return send(res, 413, { ok: false, error: 'photo too large' });
          const ts = new Date(it.timestamp);
          if (isNaN(ts.getTime())) return send(res, 400, { ok: false, error: 'bad timestamp' });
          const rec = {
            id: it.id, photo: it.photo || '', timestamp: ts.toISOString(),
            date: DATE_RE.test(String(it.date || '')) ? it.date : '', time: String(it.time || '').slice(0, 12),
            status: 'pending', addedAt: new Date().toISOString()
          };
          items.push(rec); save(bucket, items);
          return send(res, 200, { ok: true, item: view(rec) });
        }

        const item = items.find(x => x.id === String(b.id || ''));
        if (!item) return send(res, 200, { ok: true, missing: true, claimed: false, applied: true }); // the device handles it locally

        if (p === '/claim') {
          const done = item.status === 'approved' || item.status === 'rejected';
          if (done) return send(res, 200, { ok: true, claimed: false, item: view(item) });
          if (item.status === 'processing' && item.claimedBy !== by) return send(res, 200, { ok: true, claimed: false, item: view(item) });
          item.status = 'processing'; item.claimedBy = by; item.claimedAt = new Date().toISOString();
          save(bucket, items);
          return send(res, 200, { ok: true, claimed: true, item: view(item) });
        }

        if (p === '/release') {
          if (item.status === 'processing' && item.claimedBy === by) {
            item.status = 'pending'; delete item.claimedBy; delete item.claimedAt; save(bucket, items);
          }
          return send(res, 200, { ok: true, item: view(item) });
        }

        // /resolve
        if (b.status !== 'approved' && b.status !== 'rejected') return send(res, 400, { ok: false, error: 'bad status' });
        if (item.status === 'approved' || item.status === 'rejected') return send(res, 200, { ok: true, applied: false, item: view(item) });
        if (item.status === 'processing' && item.claimedBy !== by) return send(res, 200, { ok: true, applied: false, item: view(item) });
        item.status = b.status;
        if (b.staffId && ID_RE.test(String(b.staffId))) item.staffId = String(b.staffId);
        item.resolvedBy = by; item.resolvedAt = new Date().toISOString();
        delete item.photo; delete item.claimedBy; delete item.claimedAt;
        save(bucket, items);
        return send(res, 200, { ok: true, applied: true, item: view(item) });
      } catch (e) {
        console.error('[review]', e);
        send(res, 500, { ok: false, error: 'server error' });
      }
    });
  } catch (e) {
    console.error('[review]', e);
    send(res, 500, { ok: false, error: 'server error' });
  }
};
