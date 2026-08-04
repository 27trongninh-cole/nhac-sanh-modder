'use strict';

const { BitReader, BitWriter } = require('./bitio');

let __debugPacketCount = 0;

// Strips the packet-type bit and (for long/window blocks) the redundant
// previous/next window-type bits from a standard Vorbis audio packet,
// producing Wwise's compact "mod_packets" form. These window-type bits
// are redundant -- the Wwise decoder recomputes them from neighboring
// packets' mode numbers -- so we can just discard them here.
function packAudioPacket(standardPacket, modeBits, modeBlockflag) {
  const br = new BitReader(standardPacket);
  const bw = new BitWriter();

  const totalBits = standardPacket.length * 8;

  const packetType = br.read(1);
  if (packetType !== 0) throw new Error(`expected audio packet type 0, got ${packetType}`);

  const modeNumber = br.read(modeBits);
  bw.write(modeNumber, modeBits);

  let hadWindowFlags = false;
  if (modeBlockflag[modeNumber]) {
    br.read(1); // previous window type -- discarded
    br.read(1); // next window type -- discarded
    hadWindowFlags = true;
  }

  const remaining = totalBits - br.bitsRead();
  for (let i = 0; i < remaining; i++) {
    bw.write(br.read(1), 1);
  }

  const out = bw.getBytes();
  if (__debugPacketCount < 5) {
    console.log(`[DEBUG] audioPacket[${__debugPacketCount}] inLen=${standardPacket.length} modeNumber=${modeNumber} hadWindowFlags=${hadWindowFlags} outLen=${out.length} inHex=${standardPacket.subarray(0,8).toString('hex')} outHex=${out.subarray(0,8).toString('hex')}`);
  }
  __debugPacketCount++;

  return out;
}

module.exports = { packAudioPacket };
