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
  loopStart = -1,
  loopEnd = -1,
}) {
  const avgBytesPerSecond = bitrateNominal > 0 ? Math.floor(bitrateNominal / 8) : 0;

  // ---- data chunk: 2-byte (size-only) headers, no granule ----
  const dataParts = [];
  let dataLen = 0;
  let maxPacketSize = 0;

  const setupHeader = Buffer.alloc(2);
  setupHeader.writeUInt16LE(wwiseSetupPacket.length, 0);
  dataParts.push(setupHeader, wwiseSetupPacket);
  dataLen += 2 + wwiseSetupPacket.length;
  const setupPacketLength = wwiseSetupPacket.length; // NOT an offset -- see a6.a.o() below
  if (wwiseSetupPacket.length > maxPacketSize) maxPacketSize = wwiseSetupPacket.length;

  for (const pkt of wwiseAudioPackets) {
    const h = Buffer.alloc(2);
    h.writeUInt16LE(pkt.length, 0);
    dataParts.push(h, pkt);
    dataLen += 2 + pkt.length;
    if (pkt.length > maxPacketSize) maxPacketSize = pkt.length;
  }

  const data = Buffer.concat(dataParts, dataLen);

  // ---- fmt chunk (0x42 = 66 bytes), byte layout ported field-for-field
  // from the real app's a6.a.o() (decompiled from io_github_lnii11_bsed's
  // classes.dex, class a6.a). This supersedes the earlier hand-guessed
  // "vorb" layout, which had two field meanings wrong (a 16-bit field
  // that's actually 32-bit at 0x10, and a field that's actually the
  // setup packet's own byte length -- not the first-audio-packet offset
  // -- at 0x1C).
  const channelMask = channels === 1 ? 4 : 3; // AK speaker config (mono=4, stereo=3)
  const configType = 1; // "standard" config
  // Packed as its own little bitstream: channels(8 bits) + configType(4
  // bits) + channelMask(19 bits), LSB-first per byte, 4 bytes total.
  const channelConfigBlob = Buffer.alloc(4);
  {
    let bitpos = 0;
    const bits = [];
    const pushBits = (val, n) => { for (let i = 0; i < n; i++) bits.push((val >>> i) & 1); };
    pushBits(channels, 8);
    pushBits(configType, 4);
    pushBits(channelMask, 19);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) channelConfigBlob[i >> 3] |= 1 << (i & 7);
    }
  }

  const fmt = Buffer.alloc(0x42);
  fmt.writeUInt16LE(0xFFFF, 0x00);          // wFormatTag
  fmt.writeUInt16LE(channels, 0x02);
  fmt.writeUInt32LE(sampleRate, 0x04);
  fmt.writeUInt32LE(avgBytesPerSecond, 0x08);
  fmt.writeUInt16LE(0, 0x0C);                // blockAlign
  fmt.writeUInt16LE(0, 0x0E);                // bitsPerSample
  fmt.writeUInt32LE(48, 0x10);               // 4-byte field, value 48 (NOT a 16-bit cbSize)
  channelConfigBlob.copy(fmt, 0x14);         // 4-byte packed channel config
  fmt.writeUInt32LE(sampleCount >>> 0, 0x18);
  fmt.writeUInt32LE(setupPacketLength >>> 0, 0x1C); // setup packet's own byte length
  fmt.writeUInt32LE(dataLen >>> 0, 0x20);    // total data-chunk byte length
  fmt.writeUInt16LE(0, 0x24);
  // 0x26 (abs 0x3A): real a6.a.o() writes `dVar.f161j` here, NOT a
  // constant 0 -- confirmed by comparing against a real in-game .wem
  // (which had a nonzero value, 832, at this exact byte offset). Almost
  // certainly a packet-count used by the engine to size an internal
  // seek/index table; leaving it 0 while writing far more real packets
  // is a very plausible cause of a native heap overflow / crash deep in
  // libAkSoundEngine.so (matches the crash signature seen in-game while
  // vgmstream/SBank Editor, which don't rely on this field, played the
  // exact same file fine).
  fmt.writeUInt16LE(wwiseAudioPackets.length & 0xFFFF, 0x26);
  fmt.writeUInt32LE(0, 0x28);
  fmt.writeUInt32LE(setupPacketLength >>> 0, 0x2C); // redundant copy, matches real layout
  fmt.writeUInt16LE(maxPacketSize, 0x30);
  fmt.writeUInt16LE(0, 0x32);
  fmt.writeInt32LE(loopStart, 0x34);
  fmt.writeInt32LE(loopEnd, 0x38);
  // abs 0x50 (rel 0x3C trong buffer fmt): xác nhận qua so sánh 2 file WEM
  // thật hoàn toàn khác nội dung/kích thước (1.8MB và 39KB) -- byte giống
  // hệt nhau tuyệt đối (78 22 92 c9) ở cả 2 -- đây là 1 hằng số cố định
  // của build/project Wwise, KHÔNG phải checksum tính theo nội dung.
  fmt.writeUInt8(0x78, 0x3C);
  fmt.writeUInt8(0x22, 0x3D);
  fmt.writeUInt8(0x92, 0x3E);
  fmt.writeUInt8(0xC9, 0x3F);
  fmt.writeUInt8(blocksize0Pow, 0x40);
  fmt.writeUInt8(blocksize1Pow, 0x41);

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
