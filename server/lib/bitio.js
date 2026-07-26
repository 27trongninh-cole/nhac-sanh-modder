'use strict';

class BitReader {
  constructor(buf) {
    this.data = buf;
    this.bitpos = 0;
  }

  read(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = this.bitpos >> 3;
      const bitIdx = this.bitpos & 7;
      if (byteIdx >= this.data.length) throw new Error('BitReader: ran out of data');
      const bit = (this.data[byteIdx] >> bitIdx) & 1;
      val |= bit << i;
      this.bitpos += 1;
    }
    return val >>> 0;
  }

  bitsRead() {
    return this.bitpos;
  }
}

class BitWriter {
  constructor() {
    this.out = [];
    this.curByte = 0;
    this.curNbits = 0;
  }

  write(val, n) {
    for (let i = 0; i < n; i++) {
      const bit = (val >>> i) & 1;
      this.curByte |= bit << this.curNbits;
      this.curNbits += 1;
      if (this.curNbits === 8) {
        this.out.push(this.curByte);
        this.curByte = 0;
        this.curNbits = 0;
      }
    }
  }

  getBytes() {
    if (this.curNbits > 0) {
      this.out.push(this.curByte);
      this.curByte = 0;
      this.curNbits = 0;
    }
    return Buffer.from(this.out);
  }
}

function ilog(v) {
  let ret = 0;
  while (v) {
    ret += 1;
    v >>>= 1;
  }
  return ret;
}

module.exports = { BitReader, BitWriter, ilog };
