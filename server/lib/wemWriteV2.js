'use strict';

// Builds a Wwise .wem matching the REAL variant confirmed from actual
// game assets (142682346.wem / 251044735.wem, plus sbank_tạo.wem,
// hex-inspected directly): fmt chunk size 0x42 with the vorb-equivalent
// fields embedded inside it (no separate vorb chunk), 2-byte "no granule"
// packet headers, mod_packets audio framing, inline packed codebooks +
// reduced setup packet. This supersedes the earlier "header triad"
// wemVorbis.js writer, which turned out to be a rare/legacy variant NOT
// used by AOV.

function buildWemV2({
  channels,
  sampleRate,
  bitrateNominal,
  blocksize0Pow,
  blocksize1Pow,
  wwiseSetupPacket,
  wwiseAudioPackets,
  sampleCount,
}) {
  const avgBytesPerSecond = bitrateNominal > 0 ? Math.floor(bitrateNominal / 8) : 0;

  // ---- data chunk: 2-byte (size-only) headers, no granule ----
  const dataParts = [];
  let dataLen = 0;

  const setupHeader = Buffer.alloc(2);
  setupHeader.writeUInt16LE(wwiseSetupPacket.length, 0);
  dataParts.push(setupHeader, wwiseSetupPacket);
  const setupPacketOffset = 0;
  dataLen += 2 + wwiseSetupPacket.length;

  const firstAudioPacketOffset = dataLen;
  for (const pkt of wwiseAudioPackets) {
    const h = Buffer.alloc(2);
    h.writeUInt16LE(pkt.length, 0);
    dataParts.push(h, pkt);
    dataLen += 2 + pkt.length;
  }

  const data = Buffer.concat(dataParts, dataLen);

  // ---- vorb-equivalent (42 bytes), to be embedded inside fmt ----
  const vorb = Buffer.alloc(0x2A);
  vorb.writeUInt32LE(sampleCount >>> 0, 0x00);
  // mod_signal: empirically, every real .wem sample inspected has this
  // field exactly equal to firstAudioPacketOffset (NOT a fixed "magic"
  // constant -- ww2ogg's decoder only checks it against 4 known legacy
  // values as a heuristic for whether to enable mod_packets, but the real
  // encoder appears to just duplicate the offset here, and the actual
  // game engine may validate it against that offset).
  vorb.writeUInt32LE(firstAudioPacketOffset >>> 0, 0x04);
  // 0x08: confirmed by inspecting 3 real .wem samples -- always exactly
  // equal to the data chunk's total size (a redundant copy of it).
  vorb.writeUInt32LE(dataLen >>> 0, 0x08);
  vorb.writeUInt32LE(setupPacketOffset >>> 0, 0x10);
  vorb.writeUInt32LE(firstAudioPacketOffset >>> 0, 0x14);
  // 0x18: unresolved -- varies per file in real samples (392/673/666)
  // without a formula we could confirm; left at 0 for now.
  // 0x1c / 0x20: confirmed CONSTANT across all 3 real samples regardless
  // of content/duration (16080 / 16560, always exactly 480 apart) --
  // very likely a fixed Wwise-project-level prefetch/streaming setting,
  // not computed per-file.
  vorb.writeUInt32LE(16080, 0x1c);
  vorb.writeUInt32LE(16560, 0x20);
  vorb.writeUInt32LE(0, 0x24); // uid -- not validated for playback
  vorb.writeUInt8(blocksize0Pow, 0x28);
  vorb.writeUInt8(blocksize1Pow, 0x29);

  // ---- fmt chunk (0x42 = 66 bytes) ----
  const channelMask = channels === 1 ? 0x4 : 0x3; // AK speaker config
  const configType = 1; // "standard"
  const pseudoConfig = (channels & 0xFF) | ((configType & 0xF) << 8) | (channelMask << 12);

  const fmt = Buffer.alloc(0x42);
  fmt.writeUInt16LE(0xFFFF, 0x00);
  fmt.writeUInt16LE(channels, 0x02);
  fmt.writeUInt32LE(sampleRate, 0x04);
  fmt.writeUInt32LE(avgBytesPerSecond, 0x08);
  fmt.writeUInt16LE(0, 0x0C);
  fmt.writeUInt16LE(0, 0x0E);
  fmt.writeUInt16LE(0x30, 0x10); // extra fmt length = 48
  fmt.writeUInt16LE(0, 0x12);
  fmt.writeUInt32LE(pseudoConfig, 0x14);
  vorb.copy(fmt, 0x18);

  // ---- assemble RIFF/WAVE ----
  function chunk(tag, payload) {
    const header = Buffer.alloc(8);
    header.write(tag, 0, 4, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  const riffBody = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt), chunk('data', data)]);
  const riffHeader = Buffer.alloc(8);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(riffBody.length, 4);

  return Buffer.concat([riffHeader, riffBody]);
}

module.exports = { buildWemV2 };
