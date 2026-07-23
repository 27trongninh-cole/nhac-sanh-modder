'use strict';

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Precise duration in ms via ffprobe (works for wav, mp3, and most common
// formats — NOT for .wem, since that uses Wwise's proprietary codec).
async function getDurationMs(filePath) {
  const out = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  const seconds = parseFloat(out.trim());
  if (!isFinite(seconds)) throw new Error('ffprobe không đọc được duration');
  return Math.round(seconds * 1000 * 1000) / 1000; // ms, ms-precision
}

// Transcode any ffmpeg-readable input to a 16-bit PCM RIFF/WAVE buffer,
// preserving the source sample rate and channel count.
async function toPcmWavBuffer(filePath) {
  const tmpOut = path.join(os.tmpdir(), `pcm_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  try {
    await run(ffmpegPath, [
      '-y', '-i', filePath,
      '-c:a', 'pcm_s16le',
      tmpOut
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}

module.exports = { getDurationMs, toPcmWavBuffer };
