'use strict';

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readOggPackets, parseIdentificationPacket } = require('./oggParse');
const { packSetupPacket } = require('./setupPack');
const { packAudioPacket } = require('./packAudioPacket');
const { buildWemV2 } = require('./wemWriteV2');
const { CodebookLibrary } = require('./codebookLibrary');

let _codebookLib = null;
function getCodebookLib() {
  if (!_codebookLib) {
    _codebookLib = new CodebookLibrary(path.join(__dirname, 'packed_codebooks.bin'));
  }
  return _codebookLib;
}

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
async function toRawPcm16(filePath, channels) {
  const tmpOut = path.join(os.tmpdir(), `raw_${Date.now()}_${Math.random().toString(36).slice(2)}.pcm`);
  try {
    const args = ['-y', '-i', filePath, '-f', 's16le', '-acodec', 'pcm_s16le'];
    if (channels) args.push('-ac', String(channels));
    args.push(tmpOut);
    await run(ffmpegPath, args);
    return fs.readFileSync(tmpOut);
  } finally {
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}

// Builds a Wwise PCM .wem container BYTE-EXACT to real working samples
// produced by "SBank Editor" (an Android APK confirmed to make files the
// actual game accepts — samples inspected directly, not reverse-engineered
// from docs). Structure, confirmed by hex-dumping a real 48kHz/stereo sample:
//
//   RIFF/WAVE
//   "fmt " chunk, size=24:
//     format_tag=0xFFFE, channels, sampleRate, byteRate, blockAlign, bitsPerSample(16)
//     cbSize=6
//     2 zero bytes + 4-byte "pseudo channel config" (Wwise's own compact
//       encoding, NOT the standard 16-byte SubFormat GUID):
//         bits 0-7  = channel count
//         bits 8-11 = config type (1 = standard)
//         bits 12+  = AK speaker channel mask (mono=0x4 front-center,
//                     stereo=0x3 front-left|front-right)
//   "JUNK" chunk, size=4, all zero (padding)
//   "data" chunk: raw interleaved PCM samples, runs to end of file
//
// Kept as a fallback / for reference. NOT used by default anymore — see
// toWwiseVorbisBufferV2 below, which produces real Vorbis-compressed .wem
// files (smaller, and matches the codec most mobile music tracks actually
// use, unlike this PCM path).
function buildWwisePcmWem({ pcmData, sampleRate, channels, bitsPerSample = 16 }) {
  if (channels !== 1 && channels !== 2) {
    throw new Error(`Chỉ hỗ trợ mono hoặc stereo (nhận ${channels} kênh)`);
  }
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const channelMask = channels === 1 ? 0x4 : 0x3; // AK speaker config: mono=front-center, stereo=L|R
  const configType = 1; // "standard"
  const pseudoConfig = (channels & 0xFF) | ((configType & 0xF) << 8) | (channelMask << 12);

  const fmt = Buffer.alloc(24);
  fmt.writeUInt16LE(0xFFFE, 0);          // format_tag = WAVE_FORMAT_EXTENSIBLE ("PCM for Wwise Authoring")
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(byteRate, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  fmt.writeUInt16LE(6, 16);              // cbSize = 6
  fmt.writeUInt16LE(0, 18);              // 2 zero bytes
  fmt.writeUInt32LE(pseudoConfig, 20);   // 4-byte pseudo channel config

  const junk = Buffer.alloc(4); // all zero, matches real sample exactly

  function chunk(id, data) {
    const header = Buffer.alloc(8);
    header.write(id, 0, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data]);
  }

  const fmtChunk = chunk('fmt ', fmt);
  const junkChunk = chunk('JUNK', junk);
  const dataChunk = chunk('data', pcmData);

  const riffBody = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmtChunk, junkChunk, dataChunk]);
  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 'ascii');
  riffHeader.writeUInt32LE(riffBody.length, 4);

  return Buffer.concat([riffHeader, riffBody]);
}

// High-level helper: any ffmpeg-readable input -> byte-exact Wwise PCM wem.
// Forces stereo (2ch) output since that's what real samples confirmed —
// simplest safe default; mono is also supported by buildWwisePcmWem if ever
// needed directly.
async function toWwisePcmBuffer(filePath) {
  const { sampleRate, channels } = await probeAudioInfo(filePath);
  const targetChannels = channels >= 2 ? 2 : 1;
  const pcmData = await toRawPcm16(filePath, targetChannels);
  return buildWwisePcmWem({ pcmData, sampleRate, channels: targetChannels, bitsPerSample: 16 });
}

// ---------------------------------------------------------------------
// Vorbis .wem v2 -- matches the REAL format confirmed by hex-inspecting
// actual AOV .wem assets (142682346.wem / 251044735.wem): inline packed
// codebooks + reduced setup packet + mod_packets audio framing.
// ---------------------------------------------------------------------

async function encodeToOgg(filePath, oggPath, quality) {
  await run(ffmpegPath, [
    '-y', '-i', filePath,
    '-c:a', 'libvorbis', '-q:a', String(quality),
    oggPath,
  ]);
}

async function toWwiseVorbisBufferV2(filePath, { quality = 5 } = {}) {
  const tmpOgg = path.join(os.tmpdir(), `wv2_${Date.now()}_${Math.random().toString(36).slice(2)}.ogg`);
  try {
    await encodeToOgg(filePath, tmpOgg, quality);

    const oggBuf = fs.readFileSync(tmpOgg);
    const { packets, lastGranule } = readOggPackets(oggBuf);
    if (packets.length < 4) {
      throw new Error('Ogg stream bất thường: ít hơn 4 packet (cần id/comment/setup + audio)');
    }
    if (lastGranule === null) {
      throw new Error('Không đọc được granule position từ Ogg stream (cần để tính sample_count chính xác)');
    }

    const [idPacket, , setupPacketFull, ...audioPackets] = packets;
    const info = parseIdentificationPacket(idPacket);

    // strip the 7-byte Vorbis packet header (type=5 + 'vorbis') -- Wwise's
    // wire format never stores it.
    const standardSetupBody = setupPacketFull.subarray(7);
    const { bytes: wwiseSetupPacket, modeBits, modeBlockflag } =
      packSetupPacket(standardSetupBody, info.channels, getCodebookLib());

    const wwiseAudioPackets = audioPackets.map(pkt => packAudioPacket(pkt, modeBits, modeBlockflag));

    // IMPORTANT: use the EXACT sample count the re-encoded Ogg stream
    // decodes to (its final page's granule position), not an estimate
    // from source-file duration. This format's packets have no
    // per-packet granule (2-byte "no granule" headers), so the game's
    // decoder trusts sample_count alone to size its output PCM buffer --
    // any mismatch, even by a handful of samples, can overflow that
    // buffer and crash.
    const sampleCount = lastGranule;

    return buildWemV2({
      channels: info.channels,
      sampleRate: info.sampleRate,
      bitrateNominal: info.bitrateNominal,
      blocksize0Pow: info.blocksize0Pow,
      blocksize1Pow: info.blocksize1Pow,
      wwiseSetupPacket,
      wwiseAudioPackets,
      sampleCount,
    });
  } finally {
    fs.promises.unlink(tmpOgg).catch(() => {});
  }
}

module.exports = {
  getDurationMs,
  probeAudioInfo,
  toRawPcm16,
  buildWwisePcmWem,
  toWwisePcmBuffer,
  toWwiseVorbisBufferV2,
};
