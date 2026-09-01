// ============================================================
// VARNICA JEWELS — Attendance Archive Router
// File: /opt/varnica-attendance-api/attendance-archive-router.js
// Purpose: Permanent, append-only attendance history on the VPS —
// independent of what any single device keeps in its local browser
// storage. This is Phase 1 of moving the attendance tool toward a
// "thin client" model (like Gold Issue System): the browser will
// eventually only hold what it needs for today's offline-safe
// operation, and the VPS becomes the source of truth for all history.
//
// Key design: this endpoint only UPSERTS (add/update by staffId+date).
// It never deletes and is never overwritten wholesale — so even if a
// device trims its own local copy, nothing is ever lost here.
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

const ARCHIVE_DIR = path.join(__dirname, 'attendance-archive');
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function archivePath(bucket) {
  return path.join(ARCHIVE_DIR, bucket + '.json');
}

function loadArchive(bucket) {
  const p = archivePath(bucket);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveArchive(bucket, obj) {
  // Write to a temp file then rename — avoids a corrupted file if the
  // process is killed mid-write (safer for a file that only ever grows).
  const p = archivePath(bucket);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

// POST /api/attendance-archive  { bucket, records: [{staffId,date,...fields}] }
// Upserts each record by staffId+date key. Additive only — never deletes.
router.post('/', express.json({ limit: '2mb' }), (req, res) => {
  try {
    const { bucket, records } = req.body || {};
    if (!bucket || !Array.isArray(records)) {
      return res.status(400).json({ error: 'Missing bucket/records' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(bucket)) {
      return res.status(400).json({ error: 'Invalid bucket' });
    }
    const archive = loadArchive(bucket);
    let n = 0;
    records.forEach(r => {
      if (!r || !r.staffId || !r.date) return;
      const key = r.staffId + '__' + r.date;
      archive[key] = r; // upsert — latest write wins for that staff+date
      n++;
    });
    saveArchive(bucket, archive);
    res.json({ ok: true, upserted: n, totalArchived: Object.keys(archive).length });
  } catch (e) {
    console.error('[attendance-archive POST]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/attendance-archive?bucket=T009&from=YYYY-MM-DD&to=YYYY-MM-DD&staffId=optional
// Not used by the frontend yet (that's Phase 2) — but live and testable now.
router.get('/', (req, res) => {
  try {
    const { bucket, from, to, staffId } = req.query || {};
    if (!bucket || !/^[A-Za-z0-9_-]+$/.test(bucket)) {
      return res.status(400).json({ error: 'Invalid bucket' });
    }
    const archive = loadArchive(bucket);
    let records = Object.values(archive);
    if (from) records = records.filter(r => r.date >= from);
    if (to) records = records.filter(r => r.date <= to);
    if (staffId) records = records.filter(r => r.staffId === staffId);
    records.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    res.json({ ok: true, records, total: records.length });
  } catch (e) {
    console.error('[attendance-archive GET]', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;
