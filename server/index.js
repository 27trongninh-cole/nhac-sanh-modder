'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { getDurationMs, toWwiseVorbisBufferV2 } = require('./lib/audioConvert');
const { patchIdAndDuration, locateDurationFields } = require('./lib/bnkPatcher');
const supabaseStore = require('./lib/supabaseStore');
const bnkCache = require('./lib/bnkCache');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

const ZIP_DIR = 'com.garena.game.kgvn/files/Extra/2022.V3/Sound_DLC/Android/';

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---- admin auth ----
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD chưa được cấu hình trên server (Environment Variable). Trang admin bị khoá cho tới khi set biến này.' });
  }
  const supplied = req.header('X-Admin-Password');
  if (supplied !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Sai mật khẩu admin' });
  }
  next();
}

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  try {
    const active = await bnkCache.getActive({ forceRefresh: true });
    res.json({
      ok: true,
      supabaseConfigured: supabaseStore.isConfigured(),
      sourceId: active.sourceId,
      replacementId: active.replacementId,
      bnkUrl: active.config ? active.config.bnkUrl : null,
      isDefault: active.isDefault,
      updatedAt: active.config ? active.config.updatedAt : null,
      updatedBy: active.config ? active.config.updatedBy : null,
      bnkSize: active.bnkBuffer.length
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Body: { sourceId?: number, replacementId?: number, bnkUrl?: string (Catbox link), updatedBy?: string }
// At least one of sourceId / bnkUrl must be provided. Validates by actually
// downloading the (new or currently active) bnk and confirming the target
// sourceId's duration fields can be located, BEFORE saving to Supabase — so a
// bad link or wrong ID never silently breaks /api/build for real users.
app.post('/api/admin/update', requireAdmin, async (req, res) => {
  try {
    if (!supabaseStore.isConfigured()) {
      return res.status(503).json({ ok: false, error: 'Supabase chưa được cấu hình (thiếu SUPABASE_URL / SUPABASE_SERVICE_KEY trên server)' });
    }

    const { sourceId: sourceIdRaw, replacementId: replacementIdRaw, bnkUrl: bnkUrlRaw, updatedBy } = req.body || {};
    if (!sourceIdRaw && !bnkUrlRaw && !replacementIdRaw) {
      return res.status(400).json({ ok: false, error: 'Cần ít nhất 1 trong 3: Source ID, Replacement ID, hoặc link Catbox mới' });
    }

    const sourceId = sourceIdRaw ? parseInt(sourceIdRaw, 10) : null;
    if (sourceIdRaw && !Number.isFinite(sourceId)) {
      return res.status(400).json({ ok: false, error: 'Source ID không hợp lệ' });
    }
    const replacementId = replacementIdRaw ? parseInt(replacementIdRaw, 10) : null;
    if (replacementIdRaw && !Number.isFinite(replacementId)) {
      return res.status(400).json({ ok: false, error: 'Replacement ID không hợp lệ' });
    }
    const bnkUrl = bnkUrlRaw ? String(bnkUrlRaw).trim() : null;
    if (bnkUrl && !/^https?:\/\//i.test(bnkUrl)) {
      return res.status(400).json({ ok: false, error: 'Link Catbox không hợp lệ (phải bắt đầu bằng http:// hoặc https://)' });
    }

    const current = await supabaseStore.getConfig();
    const effectiveBnkUrl = bnkUrl || (current && current.bnkUrl);
    const effectiveSourceId = sourceId != null ? sourceId : (current ? current.sourceId : bnkCache.DEFAULT_SOURCE_ID);
    const effectiveReplacementId = replacementId != null ? replacementId : (current && current.replacementId != null ? current.replacementId : effectiveSourceId);

    if (!effectiveBnkUrl) {
      return res.status(400).json({ ok: false, error: 'Chưa có link Catbox nào được lưu trước đó — cần nhập link Catbox ở lần cập nhật đầu tiên' });
    }

    const bnkBuffer = await bnkCache.fetchBuffer(effectiveBnkUrl);
    const located = locateDurationFields(bnkBuffer, effectiveSourceId);
    if (!located.ok) {
      return res.status(400).json({
        ok: false,
        error: `Không xác nhận được Source ID ${effectiveSourceId} trong file .bnk tải từ link này: ${located.reason}`
      });
    }

    const saved = await supabaseStore.setConfig({ sourceId: effectiveSourceId, replacementId: effectiveReplacementId, bnkUrl: effectiveBnkUrl, updatedBy });
    bnkCache.invalidate();
    await bnkCache.getActive({ forceRefresh: true }); // warm the cache immediately

    res.json({ ok: true, config: saved, validated: { trackIds: located.trackIds, fieldCount: located.fields.length } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/admin/reset', requireAdmin, async (req, res) => {
  try {
    if (supabaseStore.isConfigured()) {
      // "reset" = point back at nothing so getActive() falls back to the bundled default
      await supabaseStore.setConfig({ sourceId: bnkCache.DEFAULT_SOURCE_ID, bnkUrl: null, updatedBy: 'reset' }).catch(() => {});
    }
    bnkCache.invalidate();
    const active = await bnkCache.getActive({ forceRefresh: true });
    res.json({ ok: true, sourceId: active.sourceId, isDefault: active.isDefault });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- main build endpoint ----
// Body fields:
//   audio          (required) either a REAL .wem (converted via actual Wwise
//                  software — passed through byte-for-byte, HIGHEST confidence)
//                  or a .wav/.mp3 (auto-converted to a Wwise-PCM-shaped .wem —
//                  see caveat below).
//   referenceAudio (optional, only used when `audio` is .wem) a .wav/.mp3 of
//                  the SAME track, used ONLY to auto-measure duration via
//                  ffprobe — never packaged as the .wem.
//   durationMs     (optional) manual duration in ms.
//
// The .wav/.mp3 path now produces a REAL Vorbis-encoded .wem (not a PCM
// substitute): ffmpeg encodes to standard Ogg Vorbis, then the raw Vorbis
// packets are re-framed into a Wwise RIFF container (see wemVorbis.js for
// the format details and how it was verified via ww2ogg round-trip decode).
// This matches the codec most mobile music tracks actually use in-game.
app.post('/api/build', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'referenceAudio', maxCount: 1 }]), async (req, res) => {
  const file = req.files && req.files.audio && req.files.audio[0];
  const refFile = req.files && req.files.referenceAudio && req.files.referenceAudio[0];
  if (!file) return res.status(400).json({ ok: false, error: 'Thiếu file audio (field "audio")' });

  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const cleanup = () => {
    fs.promises.unlink(file.path).catch(() => {});
    if (refFile) fs.promises.unlink(refFile.path).catch(() => {});
  };

  try {
    const active = await bnkCache.getActive();
    const targetSourceId = active.sourceId;
    const replacementId = active.replacementId;

    let wemBytes;
    let durationMs = null;
    let durationSource = null;
    let conversionWarning = null;

    if (ext === 'wem') {
      wemBytes = fs.readFileSync(file.path); // pass-through, never re-encoded
      const refExt = refFile ? path.extname(refFile.originalname).toLowerCase().replace('.', '') : null;
      if (refFile && (refExt === 'wav' || refExt === 'mp3')) {
        durationMs = await getDurationMs(refFile.path);
        durationSource = `ffprobe (từ file tham chiếu .${refExt})`;
      } else if (req.body.durationMs) {
        durationMs = parseFloat(req.body.durationMs);
        durationSource = 'user-provided';
      }
    } else if (ext === 'wav' || ext === 'mp3') {
      durationMs = await getDurationMs(file.path);
      durationSource = 'ffprobe';
      wemBytes = await toWwiseVorbisBufferV2(file.path, { quality: 5 });
      conversionWarning = null; // real Vorbis encode (inline codebooks + mod_packets, matches confirmed real .wem format) — xem wemWriteV2.js.
    } else {
      cleanup();
      return res.status(400).json({ ok: false, error: `Định dạng .${ext} không được hỗ trợ (chỉ .wem, .wav, .mp3)` });
    }

    // Patch the currently active Music_Login.bnk: repoint targetSourceId ->
    // replacementId (so the original .wem on the game's disk is never
    // overwritten — it stays as a natural backup) and update duration.
    let bnkBytes = null;
    let patchReport = null;
    if (durationMs != null) {
      const result = patchIdAndDuration(active.bnkBuffer, targetSourceId, replacementId, durationMs);
      if (result.ok) {
        bnkBytes = result.buffer;
        patchReport = {
          durationMs, durationSource, targetSourceId, replacementId, conversionWarning,
          idFields: result.idFields,
          durationFields: result.durationFields.map(f => ({ kind: f.kind, ownerId: f.ownerId, oldValueMs: f.oldValueMs, newValueMs: f.newValueMs, offsetCount: f.offsetCount }))
        };
      } else {
        patchReport = { warning: result.reason, targetSourceId, replacementId, conversionWarning };
      }
    } else {
      patchReport = { warning: 'Không xác định được duration (file .wem không kèm durationMs) — Music_Login.bnk giữ nguyên, không patch.', targetSourceId, replacementId, conversionWarning };
    }

    const zipWemName = `${replacementId}.wem`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Nhac_sanh.zip"');
    res.setHeader('X-Patch-Report', encodeURIComponent(JSON.stringify(patchReport)));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.append(wemBytes, { name: ZIP_DIR + zipWemName });
    if (bnkBytes) archive.append(bnkBytes, { name: ZIP_DIR + 'Music_Login.bnk' });
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  } finally {
    cleanup();
  }
});

app.listen(PORT, () => {
  console.log(`Nhạc sảnh modder server đang chạy tại http://localhost:${PORT}`);
  if (!ADMIN_PASSWORD) console.log('⚠ ADMIN_PASSWORD chưa được set — trang /admin sẽ bị khoá.');
  if (!supabaseStore.isConfigured()) console.log('⚠ SUPABASE_URL/SUPABASE_SERVICE_KEY chưa được set — dùng bnk mặc định bundle sẵn, admin update sẽ bị khoá.');
});
