'use strict';

// Debug/testing route: upload multiple .wav files, get back a zip of
// .wem files (Vorbis, external-codebook format from toWwiseVorbisBufferV2),
// each keeping the ORIGINAL filename (just swapping extension to .wem).
// No Music_Login.bnk patching, no ZIP_DIR path packaging -- purely for
// comparing raw encoder output against real .wem samples while debugging
// why the game won't play generated files.

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');

const { toWwiseVorbisBufferV2 } = require('./lib/audioConvert');

const router = express.Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 100 * 1024 * 1024, files: 50 } });

router.post('/api/batch-wem', upload.array('files', 50), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ ok: false, error: 'Chưa chọn file nào (field "files")' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="batch_wem.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('archiver error', err);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  const quality = req.body && req.body.quality ? Number(req.body.quality) : 5;

  for (const file of files) {
    const originalBase = path.parse(file.originalname).name; // strip extension, keep exact original name
    try {
      const wemBuffer = await toWwiseVorbisBufferV2(file.path, { quality });
      archive.append(wemBuffer, { name: `${originalBase}.wem` });
    } catch (err) {
      // Don't abort the whole batch for one bad file -- include an error
      // marker file instead so you still get the rest of the zip.
      archive.append(Buffer.from(String(err.stack || err.message)), { name: `${originalBase}.ERROR.txt` });
    } finally {
      fs.promises.unlink(file.path).catch(() => {});
    }
  }

  await archive.finalize();
});

module.exports = router;
