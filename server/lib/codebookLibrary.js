'use strict';

const fs = require('fs');
const { BitReader, ilog } = require('./bitio');
const { bookMaptype1Quantvals } = require('./codebookPack');

// Loads a Wwise/aoTuV external codebook library file (e.g. packed_codebooks.bin)
// and builds a lookup index from a codebook's structural signature to its ID.
// See wav2wem's codebook_library.py for the fully-commented reference version.
//
// IMPORTANT: the signature MUST include lookup_type and (if type==1) the
// full VQ lookup table (min/max/value_length/quantvals), not just the
// entropy-coding structure (dims/entries/lengths). A codebook used as a
// residue classbook/cascade book needs lookup_type==1 with the EXACT SAME
// VQ table to dequantize correctly; matching on entropy structure alone
// can pick an external codebook that "looks compatible" but has a
// different lookup_type or VQ values, corrupting memory when used in
// that role. This was confirmed via in-game bisection testing.

function parseWwiseCodebookSignature(buf) {
  const br = new BitReader(buf);
  const dims = br.read(4);
  const entries = br.read(14);
  const ordered = br.read(1);
  const lengths = [];
  if (ordered) {
    const initialLength = br.read(5);
    let currentEntry = 0;
    let cur = initialLength;
    while (currentEntry < entries) {
      const nbits = ilog(entries - currentEntry);
      const num = br.read(nbits);
      for (let i = 0; i < num; i++) lengths.push(cur);
      currentEntry += num;
      cur += 1;
    }
  } else {
    const codewordLengthLength = br.read(3);
    const sparse = br.read(1);
    for (let i = 0; i < entries; i++) {
      let present = 1;
      if (sparse) present = br.read(1);
      lengths.push(present ? br.read(codewordLengthLength) : null);
    }
  }

  const lookupType = br.read(1);
  let vq = null;
  if (lookupType === 1) {
    const minVal = br.read(32);
    const maxVal = br.read(32);
    const valueLength = br.read(4);
    const sequenceFlag = br.read(1);
    const quantvals = bookMaptype1Quantvals(entries, dims);
    const qvals = [];
    for (let i = 0; i < quantvals; i++) qvals.push(br.read(valueLength + 1));
    vq = [minVal, maxVal, valueLength, sequenceFlag, qvals];
  }

  return { dims, entries, ordered, lengths, lookupType, vq };
}

function sigKey(dims, entries, ordered, lengths, lookupType, vq) {
  const vqKey = vq ? vq[0] + '|' + vq[1] + '|' + vq[2] + '|' + vq[3] + '|' + vq[4].join(',') : 'none';
  return `${dims}|${entries}|${ordered}|${lengths.join(',')}|${lookupType}|${vqKey}`;
}

class CodebookLibrary {
  constructor(path) {
    const data = fs.readFileSync(path);
    const fileSize = data.length;
    const offsetOffset = data.readUInt32LE(fileSize - 4);
    const codebookCount = (fileSize - offsetOffset) / 4;
    const offsets = [];
    for (let i = 0; i < codebookCount; i++) {
      offsets.push(data.readUInt32LE(offsetOffset + i * 4));
    }
    this.count = offsets.length - 1;

    this.index = new Map();
    for (let i = 0; i < this.count; i++) {
      const buf = data.subarray(offsets[i], offsets[i + 1]);
      const { dims, entries, ordered, lengths, lookupType, vq } = parseWwiseCodebookSignature(buf);
      const key = sigKey(dims, entries, ordered, lengths, lookupType, vq);
      if (!this.index.has(key)) this.index.set(key, i);
    }
  }

  lookupId(dims, entries, ordered, lengths, lookupType, vq) {
    const key = sigKey(dims, entries, ordered, lengths, lookupType, vq);
    return this.index.has(key) ? this.index.get(key) : null;
  }
}

module.exports = { CodebookLibrary };
