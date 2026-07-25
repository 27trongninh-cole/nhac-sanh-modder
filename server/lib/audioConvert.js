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

// Extracts sample_rate and channel count via ffprobe (needed to build the
// minimal fmt chunk ourselves, rather than trusting ffmpeg's WAV muxer).
async function probeAudioInfo(filePath) {
  const out = await run(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels',
    '-of', 'json',
    filePath
  ]);
  const info = JSON.parse(out);
  const stream = info.streams && info.streams[0];
  if (!stream) throw new Error('ffprobe không đọc được thông tin audio stream');
  return { sampleRate: parseInt(stream.sample_rate, 10), channels: stream.channels };
}

// Transcodes to headerless raw 16-bit PCM (no container at all) — used so we
// can build the RIFF/WAVE header ourselves byte-for-byte, matching exactly
// what Wwise's real parser accepts (see buildMinimalPcmWem below), instead of
// trusting ffmpeg's own WAV muxer which may add extra chunks (e.g. a "LIST"
// info chunk) that a strict Wwise-format validator could reject.
async function toRawPcm16(filePath) {
  const tmpOut = path.join(os.tmpdir(), `raw_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);
  try {
    await run(ffmpegPath, [
      '-y', '-i', filePath,
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      tmpOut
    ]);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}

// Builds a MINIMAL RIFF/WAVE PCM container matching exactly what Wwise's
// actual parser accepts for the PCM codec, per vgmstream's real (reverse
// engineered from the real SDK) source:
//   https://github.com/vgmstream/vgmstream/blob/master/src/meta/wwise.c
// Relevant excerpt (case PCM):
//   fmt_size must be 0x10, 0x12, 0x18, or 0x28
//   bits_per_sample must be exactly 16
//   format tag 0x0001 ("PCM") or 0xFFFE ("PCM for Wwise Authoring") both map
//   to the PCM codec path
// This uses the simplest accepted shape: format=0x0001, fmt_size=0x10 (16
// bytes) — a bare-minimum PCM WAVE — and writes ONLY RIFF/WAVE/fmt/data with
// no extra chunks (no LIST/INFO metadata that ffmpeg's own muxer tends to
// add), since vgmstream's chunk parser tolerates unknown chunks but a
// stricter validator might not.
//
// IMPORTANT CAVEAT: this fixes the CONTAINER format so generic Wwise-format
// checkers (like vgmstream-based tools) recognize it as valid PCM. It does
// NOT guarantee the actual game accepts it — Wwise SoundBanks bake in a
// specific codec per sound at build time (Vorbis is very common for mobile
// music tracks to save space), and the game's own Wwise SDK may reject a PCM
// substitute for a slot that was originally Vorbis-encoded, regardless of
// how well-formed the PCM container is. There is no software-only fix for
// that case — it requires actual Wwise conversion.
function buildMinimalPcmWem({ pcmData, sampleRate, channels, bitsPerSample = 16 }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);              // format tag = 1 (PCM)
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);

  function chunk(id, data) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  }

  const fmtChunk = chunk('fmt ', fmt);
  const dataChunk = chunk('data', pcmData);

  const riffBody = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, dataChunk]);
  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffBody.length, 4);

  return Buffer.concat([riffHeader, riffBody]);
}

// High-level helper: any ffmpeg-readable input -> minimal Wwise-PCM-shaped buffer.
async function toWwisePcmBuffer(filePath) {
  const { sampleRate, channels } = await probeAudioInfo(filePath);
  const pcmData = await toRawPcm16(filePath);
  return buildMinimalPcmWem({ pcmData, sampleRate, channels, bitsPerSample: 16 });
}

module.exports = { getDurationMs, probeAudioInfo, toRawPcm16, buildMinimalPcmWem, toWwisePcmBuffer };
