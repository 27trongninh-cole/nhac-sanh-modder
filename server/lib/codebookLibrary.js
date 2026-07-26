'use strict';

const fs = require('fs');
const { BitReader, ilog } = require('./bitio');

// Loads a Wwise/aoTuV external codebook library file (e.g. packed_codebooks.bin)
// and builds a lookup index from a codebook's structural signature to its ID.
// See wav2wem's codebook_library.py for the fully-commented reference version.

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
  return { dims, entries, ordered, lengths };
}

function sigKey(dims, entries, ordered, lengths) {
  return `${dims}|${entries}|${ordered}|${lengths.join(',')}`;
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
      const { dims, entries, ordered, lengths } = parseWwiseCodebookSignature(buf);
      const key = sigKey(dims, entries, ordered, lengths);
      if (!this.index.has(key)) this.index.set(key, i);
    }
  }

  lookupId(dims, entries, ordered, lengths) {
    const key = sigKey(dims, entries, ordered, lengths);
    return this.index.has(key) ? this.index.get(key) : null;
  }
}

module.exports = { CodebookLibrary };
