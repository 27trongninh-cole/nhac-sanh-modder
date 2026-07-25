'use strict';

// Minimal Ogg container demuxer. Extracts raw logical-stream packets from a
// standard .ogg (Vorbis) buffer. No CRC validation / multi-stream handling
// needed since ffmpeg always emits one clean Vorbis stream for our use case.
//
// Returns: array of Buffers. packet[0] = identification, packet[1] = comment,
// packet[2] = setup, packet[3..] = audio packets.
function readOggPackets(buf) {
  const packets = [];
  let current = [];
  let offset = 0;
  const n = buf.length;

  while (offset < n) {
    if (buf.toString('ascii', offset, offset + 4) !== 'OggS') {
      throw new Error(`Expected 'OggS' capture pattern at offset ${offset}`);
    }

    // Ogg page header: 27 bytes fixed + N-byte segment table
    // capture(4) version(1) header_type(1) granule_pos(8) serial(4)
    // page_seq(4) checksum(4) page_segments(1)
    const pageSegments = buf.readUInt8(offset + 26);
    const segTable = buf.subarray(offset + 27, offset + 27 + pageSegments);
    let pos = offset + 27 + pageSegments;

    for (const segLen of segTable) {
      current.push(buf.subarray(pos, pos + segLen));
      pos += segLen;
      if (segLen < 255) {
        packets.push(Buffer.concat(current));
        current = [];
      }
    }

    offset = pos;
  }

  if (current.length) packets.push(Buffer.concat(current)); // trailing partial (shouldn't happen)

  return packets;
}

// Parses a standard Vorbis identification packet (packet 0).
function parseIdentificationPacket(pkt) {
  if (pkt[0] !== 1 || pkt.toString('ascii', 1, 7) !== 'vorbis') {
    throw new Error('not a Vorbis identification packet');
  }
  let off = 7;
  off += 4; // version (unused)
  const channels = pkt.readUInt8(off); off += 1;
  const sampleRate = pkt.readUInt32LE(off); off += 4;
  off += 4; // bitrate_max
  const bitrateNominal = pkt.readInt32LE(off); off += 4;
  off += 4; // bitrate_min
  const blocksizeByte = pkt.readUInt8(off); off += 1;
  const blocksize0Pow = blocksizeByte & 0x0F;
  const blocksize1Pow = (blocksizeByte >> 4) & 0x0F;
  return { channels, sampleRate, bitrateNominal, blocksize0Pow, blocksize1Pow };
}

module.exports = { readOggPackets, parseIdentificationPacket };
