'use strict';

// Packs raw Vorbis packets (as extracted by oggParse.js) into a Wwise .wem
// RIFF/WAVE container, using the "header triad present / old packet headers"
// layout (vorb chunk size 0x28). This is the *simplest* Wwise-Vorbis variant:
// the identification/comment/setup packets are stored completely unmodified
// (byte-for-byte, including their leading type byte + "vorbis" signature),
// and audio packets are stored unmodified too ("standard", non-mod packets).
// Each packet in the data chunk gets an 8-byte header: size(u32 LE) + granule(u32 LE).
//
// This was reverse-engineered from hcs64/ww2ogg's reference decoder
// (generate_ogg_header_with_triad in wwriff.cpp) and confirmed working by
// round-tripping a generated file through ww2ogg (decodes back to valid,
// playable Vorbis audio matching the source).
//
// Because no bit-level codebook stripping/rebuilding is needed for this
// variant, encoding is just: encode WAV -> standard Ogg Vorbis (ffmpeg),
// pull out the raw packets, and re-frame them into this container. No Wwise
// installation, no proprietary codec, no external codebook file required.

function buildWemVorbis({
  channels,
  sampleRate,
  bitrateNominal,
  idPacket,
  commentPacket,
  setupPacket,
  audioPackets,
  sampleCount,
}) {
  if (setupPacket[0] !== 5 || setupPacket.toString('ascii', 1, 7) !== 'vorbis') {
    throw new Error("setup packet missing expected 'vorbis' header");
  }
  if (idPacket[0] !== 1 || idPacket.toString('ascii', 1, 7) !== 'vorbis') {
    throw new Error("identification packet missing expected 'vorbis' header");
  }
  if (commentPacket[0] !== 3 || commentPacket.toString('ascii', 1, 7) !== 'vorbis') {
    throw new Error("comment packet missing expected 'vorbis' header");
  }

  const avgBytesPerSecond = bitrateNominal > 0 ? Math.floor(bitrateNominal / 8) : 0;

  // ---- data chunk: id, comment, setup packets (triad), then audio packets.
  // Every packet: 8-byte LE header (size u32, granule u32) + raw payload.
  const dataParts = [];
  let dataLen = 0;
  const offsets = {};

  function writePacket(key, payload, granule) {
    offsets[key] = dataLen;
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt32LE(granule >>> 0, 4);
    dataParts.push(header, payload);
    dataLen += 8 + payload.length;
  }

  writePacket('id', idPacket, 0);
  writePacket('comment', commentPacket, 0);
  writePacket('setup', setupPacket, 0);

  const n = audioPackets.length;
  audioPackets.forEach((pkt, i) => {
    const isLast = i === n - 1;
    const granule = isLast ? sampleCount : 0xFFFFFFFF;
    writePacket(`audio_${i}`, pkt, granule);
  });

  const data = Buffer.concat(dataParts, dataLen);

  const setupPacketOffset = offsets.id; // marks start of the whole triad
  const firstAudioPacketOffset = offsets.audio_0;

  // ---- vorb chunk (0x28 bytes): "header triad present" old style ----
  const vorb = Buffer.alloc(0x28);
  vorb.writeUInt32LE(sampleCount >>> 0, 0x00);
  // bytes 0x04..0x17 reserved/unused for this variant -> left zero
  vorb.writeUInt32LE(setupPacketOffset >>> 0, 0x18);
  vorb.writeUInt32LE(firstAudioPacketOffset >>> 0, 0x1C);
  // bytes 0x20..0x27 reserved -> left zero (not read for this vorb size)

  // ---- fmt chunk (0x18 bytes) ----
  const fmt = Buffer.alloc(0x18);
  fmt.writeUInt16LE(0xFFFF, 0x00);  // codec id: Wwise Vorbis marker
  fmt.writeUInt16LE(channels, 0x02);
  fmt.writeUInt32LE(sampleRate, 0x04);
  fmt.writeUInt32LE(avgBytesPerSecond, 0x08);
  fmt.writeUInt16LE(0, 0x0C);        // block align
  fmt.writeUInt16LE(0, 0x0E);        // bits per sample
  fmt.writeUInt16LE(6, 0x10);        // extra fmt length
  fmt.writeUInt16LE(0, 0x12);        // ext_unk
  fmt.writeUInt32LE(0, 0x14);        // subtype

  // ---- assemble RIFF/WAVE ----
  // NOTE: deliberately NOT adding RIFF word-alignment padding bytes -- the
  // reference Wwise RIFF parser advances to the next chunk using only the
  // declared chunk size (no padding accounted for); adding a pad byte here
  // would desync chunk parsing for odd-sized chunks.
  function chunk(tag, payload) {
    const header = Buffer.alloc(8);
    header.write(tag, 0, 4, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  const fmtChunk = chunk('fmt ', fmt);
  const vorbChunk = chunk('vorb', vorb);
  const dataChunk = chunk('data', data);

  const riffBody = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    fmtChunk,
    vorbChunk,
    dataChunk,
  ]);

  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(riffBody.length, 4);

  return Buffer.concat([riffHeader, riffBody]);
}

module.exports = { buildWemVorbis };
