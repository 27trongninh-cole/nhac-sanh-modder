'use strict';

const { ilog } = require('./bitio');

// Inverse of codebook_library::rebuild() in hcs64/ww2ogg's codebook.cpp.
// See wav2wem's codebook_pack.py for a fully-commented reference version
// of this same logic -- kept terse here to match project style.

function packCodebook(br, bw) {
  const sync = br.read(24);
  if (sync !== 0x564342) throw new Error(`expected codebook sync 0x564342, got ${sync.toString(16)}`);
  const dimensions = br.read(16);
  const entries = br.read(24);

  if (dimensions > 0xF) throw new Error(`codebook dimensions ${dimensions} won't fit in 4 bits`);
  if (entries > 0x3FFF) throw new Error(`codebook entries ${entries} won't fit in 14 bits`);

  bw.write(dimensions, 4);
  bw.write(entries, 14);

  const ordered = br.read(1);
  bw.write(ordered, 1);

  if (ordered) {
    const initialLength = br.read(5);
    bw.write(initialLength, 5);
    let currentEntry = 0;
    while (currentEntry < entries) {
      const nbits = ilog(entries - currentEntry);
      const number = br.read(nbits);
      bw.write(number, nbits);
      currentEntry += number;
    }
    if (currentEntry > entries) throw new Error('codebook ordered run-length overflow');
  } else {
    const sparse = br.read(1);

    const lengths = [];
    for (let i = 0; i < entries; i++) {
      let present = 1;
      if (sparse) present = br.read(1);
      if (present) {
        lengths.push(br.read(5));
      } else {
        lengths.push(null);
      }
    }

    let maxLen = 0;
    for (const l of lengths) if (l !== null && l > maxLen) maxLen = l;
    const codewordLengthLength = Math.max(1, Math.min(5, ilog(maxLen)));

    bw.write(codewordLengthLength, 3);
    bw.write(sparse, 1);

    for (const lengthMinus1 of lengths) {
      if (sparse) {
        bw.write(lengthMinus1 !== null ? 1 : 0, 1);
      }
      if (lengthMinus1 !== null) {
        bw.write(lengthMinus1, codewordLengthLength);
      }
    }
  }

  const lookupType = br.read(4);
  if (lookupType > 1) throw new Error(`unsupported codebook lookup_type ${lookupType} (Wwise only supports 0/1)`);
  bw.write(lookupType, 1);

  if (lookupType === 1) {
    const minVal = br.read(32);
    const maxVal = br.read(32);
    const valueLength = br.read(4);
    const sequenceFlag = br.read(1);
    bw.write(minVal, 32);
    bw.write(maxVal, 32);
    bw.write(valueLength, 4);
    bw.write(sequenceFlag, 1);

    const quantvals = bookMaptype1Quantvals(entries, dimensions);
    for (let i = 0; i < quantvals; i++) {
      const val = br.read(valueLength + 1);
      bw.write(val, valueLength + 1);
    }
  }
}

function bookMaptype1Quantvals(entries, dimensions) {
  const bits = ilog(entries);
  let vals = entries >>> Math.floor(((bits - 1) * (dimensions - 1)) / dimensions);
  for (;;) {
    let acc = 1;
    let acc1 = 1;
    for (let i = 0; i < dimensions; i++) {
      acc *= vals;
      acc1 *= vals + 1;
    }
    if (acc <= entries && acc1 > entries) return vals;
    if (acc > entries) vals -= 1;
    else vals += 1;
  }
}

module.exports = { packCodebook };
