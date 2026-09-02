// ============================================================
// VARNICA JEWELS — Staff Self-Service Portal Router
// File: /opt/varnica-attendance-api/staff-portal-router.js
//
// Staff log in on their OWN phone with a private link + PIN and
// can ONLY view their own attendance + salary. Read-only:
// there is no punch, no edit, no photo in this API.
//
// Security notes:
//  - Every response is filtered server-side by the staffId inside
//    the signed token. A staff member cannot request someone else's
//    data by changing anything in the browser.
//  - Login is rate-limited (5 wrong PINs -> 15 min lock).
//  - Session token is HMAC-signed and expires in 12 hours, so it
//    survives a pm2 restart but cannot be forged.
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const DATA_DIR = path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(__dirname, 'attendance-archive');
const SECRET_FILE = path.join(__dirname, '.staff-portal-secret');

// ── Server secret (auto-created once, then reused) ──
function getSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s) return s;
    }
  } catch (e) {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); } catch (e) {}
  return s;
}
const SECRET = getSecret();

function loadBucket(bucket) {
  const p = path.join(DATA_DIR, bucket + '.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return raw && raw.data ? raw.data : raw;
  } catch (e) { return {}; }
}

function loadArchive(bucket) {
  const p = path.join(ARCHIVE_DIR, bucket + '.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

// ── Signed session token ──
function makeToken(staffId, bucket) {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12 hours
  const payload = Buffer.from(JSON.stringify({ staffId, bucket, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (parts[1].length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expect))) return null;
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

// ── Login rate limiting ──
const attempts = new Map();
function isLocked(key) {
  const a = attempts.get(key);
  return !!(a && a.count >= 5 && Date.now() - a.last < 15 * 60 * 1000);
}
function noteFail(key) {
  const a = attempts.get(key) || { count: 0, last: 0 };
  if (Date.now() - a.last > 15 * 60 * 1000) a.count = 0;
  a.count++; a.last = Date.now();
  attempts.set(key, a);
}

// POST /api/staff-portal/login  { bucket, staffId, pin }
router.post('/login', express.json(), (req, res) => {
  try {
    const { bucket, staffId, pin } = req.body || {};
    if (!bucket || !staffId || !pin) return res.status(400).json({ error: 'Missing details' });
    if (!/^[A-Za-z0-9_-]+$/.test(bucket)) return res.status(400).json({ error: 'Invalid link' });

    const key = bucket + ':' + staffId;
    if (isLocked(key)) {
      return res.status(429).json({ error: 'Too many wrong PIN attempts. Please try again after 15 minutes.' });
    }

    const data = loadBucket(bucket);
    const staff = (data.staff || []).find(s => String(s.id) === String(staffId));

    // Same message for "no such staff" and "no PIN set" so the link can't be used to probe IDs
    if (!staff || !staff.portalPin) {
      noteFail(key);
      return res.status(401).json({ error: 'Login not available. Please ask the admin to enable your access.' });
    }
    if (String(staff.portalPin) !== String(pin)) {
      noteFail(key);
      return res.status(401).json({ error: 'Wrong PIN. Please try again.' });
    }

    attempts.delete(key);
    res.json({ ok: true, token: makeToken(staffId, bucket), name: staff.name });
  } catch (e) {
    console.error('[staff-portal login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/staff-portal/me?from=YYYY-MM-DD&to=YYYY-MM-DD
// Requires header: Authorization: Bearer <token>
router.get('/me', (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const claim = verifyToken(token);
    if (!claim) return res.status(401).json({ error: 'Session expired. Please log in again.' });

    const data = loadBucket(claim.bucket);
    const staff = (data.staff || []).find(s => String(s.id) === String(claim.staffId));
    if (!staff) return res.status(404).json({ error: 'Staff record not found' });

    // Merge live data + permanent archive, keeping ONLY this staff's rows.
    // IMPORTANT: don't just "fill gaps" — pick whichever version is more complete
    // (e.g. has outTime), since either source could be the fresher one depending
    // on sync timing. This is what fixes an OUT-punch sometimes not showing up.
    function completeness(r) {
      return (r.inTime ? 1 : 0) + (r.outTime ? 1 : 0) + (r.reason ? 1 : 0) + (r.absentReason ? 1 : 0) + (r.earlyOutReason ? 1 : 0);
    }
    function betterOf(a, b) {
      if (!a) return b;
      if (!b) return a;
      return completeness(b) > completeness(a) ? b : a;
    }
    const map = {};
    (data.att || []).forEach(a => {
      if (a && String(a.staffId) === String(claim.staffId) && a.date) map[a.date] = betterOf(map[a.date], a);
    });
    const arch = loadArchive(claim.bucket);
    Object.keys(arch).forEach(k => {
      const a = arch[k];
      if (a && String(a.staffId) === String(claim.staffId) && a.date) map[a.date] = betterOf(map[a.date], a);
    });

    const from = req.query.from, to = req.query.to;
    let records = Object.keys(map).map(d => map[d]);
    if (from) records = records.filter(r => r.date >= from);
    if (to) records = records.filter(r => r.date <= to);
    records.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // Strip photos — staff portal never serves images
    records = records.map(r => ({
      date: r.date,
      status: r.status,
      inTime: r.inTime || '',
      outTime: r.outTime || '',
      hours: r.hours || 0,
      reason: r.reason || r.earlyOutReason || r.absentReason || '',
      manual: r.manual === true
    }));

    const st = data.settings || {};
    // Admin controls this from Settings. Enforced HERE (not just in the UI) so that
    // when it is off, the salary never leaves the server at all.
    const showSalary = st.staffPortalSalary !== false;

    res.json({
      ok: true,
      showSalary,
      staff: {
        id: staff.id,
        name: staff.name,
        role: staff.role || '',
        salary: showSalary ? (staff.salary || 0) : 0,
        salaryBasis: staff.salaryBasis || 'monthly',
        shiftIn: staff.shiftIn || '09:00',
        shiftOut: staff.shiftOut || '18:00',
        pf: showSalary ? staff.pf : 0,
        esi: showSalary ? staff.esi : 0
      },
      settings: {
        grace: st.grace, halfDay: st.halfDay, earlyOut: st.earlyOut,
        weekOff: st.weekOff, holidays: st.holidays || [],
        pfRate: showSalary ? st.pfRate : 0,
        esiRate: showSalary ? st.esiRate : 0,
        esiCeiling: st.esiCeiling
      },
      records
    });
  } catch (e) {
    console.error('[staff-portal me]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
