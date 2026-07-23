'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { getDurationMs, toPcmWavBuffer } = require('./lib/audioConvert');
const { patchDuration } = require('./lib/bnkPatcher');

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_SOURCE_ID = 985479411; // nhạc sảnh Media ID, referenced by Music_Login.bnk
const ZIP_WEM_PATH = 'com.garena.game.kgvn/files/Extra/2022.V3/Sound_DLC/Android/985479411.wem';
const ZIP_BNK_PATH = 'com.garena.game.kgvn/files/Extra/2022.V3/Sound_DLC/Android/Music_Login.bnk';
const REFERENCE_BNK_PATH = path.join(__dirname, 'data', 'Music_Login.bnk');

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/build', upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ ok: false, error: 'Thiếu file audio (field "audio")' });

  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const cleanup = () => fs.promises.unlink(file.path).catch(() => {});

  try {
    let wemBytes;
    let durationMs = null;
    let durationSource = null;

    if (ext === 'wem') {
      // Pass-through: no re-encoding, and we can't measure duration of a
      // proprietary Wwise-Vorbis stream without their SDK. Duration patch is
      // skipped unless the caller supplies one explicitly.
      wemBytes = fs.readFileSync(file.path);
      if (req.body.durationMs) {
        durationMs = parseFloat(req.body.durationMs);
        durationSource = 'user-provided';
      }
    } else if (ext === 'wav' || ext === 'mp3') {
      durationMs = await getDurationMs(file.path);
      durationSource = 'ffprobe';
      wemBytes = await toPcmWavBuffer(file.path);
    } else {
      cleanup();
      return res.status(400).json({ ok: false, error: `Định dạng .${ext} không được hỗ trợ (chỉ .wem, .wav, .mp3)` });
    }

    // Patch the bundled reference Music_Login.bnk with the new duration.
    let bnkBytes = null;
    let patchReport = null;
    if (durationMs != null) {
      const original = fs.readFileSync(REFERENCE_BNK_PATH);
      const result = patchDuration(original, TARGET_SOURCE_ID, durationMs);
      if (result.ok) {
        bnkBytes = result.buffer;
        patchReport = {
          durationMs, durationSource,
          fields: result.fields.map(f => ({ kind: f.kind, ownerId: f.ownerId, oldValueMs: f.oldValueMs, newValueMs: f.newValueMs, offsetCount: f.offsetCount }))
        };
      } else {
        patchReport = { warning: result.reason };
      }
    } else {
      patchReport = { warning: 'Không xác định được duration (file .wem không kèm durationMs) — Music_Login.bnk giữ nguyên, không patch.' };
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="Nhac_sanh.zip"');
    res.setHeader('X-Patch-Report', encodeURIComponent(JSON.stringify(patchReport)));

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', err => { throw err; });
    archive.pipe(res);
    archive.append(wemBytes, { name: ZIP_WEM_PATH });
    if (bnkBytes) archive.append(bnkBytes, { name: ZIP_BNK_PATH });
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
});
