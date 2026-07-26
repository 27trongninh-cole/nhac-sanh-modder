'use strict';

const { BitReader, BitWriter, ilog } = require('./bitio');
const { packCodebook, bookMaptype1Quantvals } = require('./codebookPack');

// Reads one standard-format codebook (consuming those bits from `br`) and
// returns its structural signature {dims, entries, ordered, lengths} --
// the same shape used by CodebookLibrary's index -- WITHOUT writing
// anything. Caller uses this to look up the codebook's external ID.
function readStandardCodebookSignature(br) {
  const sync = br.read(24);
  if (sync !== 0x564342) throw new Error(`expected codebook sync 0x564342, got ${sync.toString(16)}`);
  const dims = br.read(16);
  const entries = br.read(24);

  const ordered = br.read(1);
  const lengths = [];
  if (ordered) {
    const initialLength = br.read(5);
    let currentEntry = 0;
    let cur = initialLength;
    while (currentEntry < entries) {
      const nbits = ilog(entries - currentEntry);
      const number = br.read(nbits);
      for (let i = 0; i < number; i++) lengths.push(cur);
      currentEntry += number;
      cur += 1;
    }
    if (currentEntry > entries) throw new Error('codebook ordered run-length overflow');
  } else {
    const sparse = br.read(1);
    for (let i = 0; i < entries; i++) {
      let present = 1;
      if (sparse) present = br.read(1);
      lengths.push(present ? br.read(5) : null);
    }
  }

  const lookupType = br.read(4);
  if (lookupType > 1) throw new Error(`unsupported codebook lookup_type ${lookupType}`);
  if (lookupType === 1) {
    br.read(32); // min
    br.read(32); // max
    const valueLength = br.read(4);
    br.read(1); // sequence_flag
    const quantvals = bookMaptype1Quantvals(entries, dims);
    for (let i = 0; i < quantvals; i++) br.read(valueLength + 1);
  }

  return { dims, entries, ordered, lengths };
}

// Inverse of the manual reparse branch in wwriff.cpp's setup-packet
// generation. See wav2wem's setup_pack.py for the fully-commented
// reference version of this same logic.
//
// standardSetupPacket: raw 3rd Ogg packet content WITHOUT its leading
//   7-byte Vorbis header (type=5 + 'vorbis') -- caller strips that.
// codebookLib: a CodebookLibrary instance (see codebookLibrary.js), used
//   to resolve each codebook to its 10-bit external ID. This matches the
//   REAL format confirmed against actual game .wem files -- inline-
//   embedded codebooks caused a native crash in-game.
// Returns: { bytes, modeBits, modeBlockflag }
function packSetupPacket(standardSetupPacket, channels, codebookLib) {
  const br = new BitReader(standardSetupPacket);
  const bw = new BitWriter();

  const codebookCountLess1 = br.read(8);
  const codebookCount = codebookCountLess1 + 1;
  bw.write(codebookCountLess1, 8);

  for (let i = 0; i < codebookCount; i++) {
    const { dims, entries, ordered, lengths } = readStandardCodebookSignature(br);
    const codebookId = codebookLib.lookupId(dims, entries, ordered, lengths);
    if (codebookId === null) {
      throw new Error(
        `codebook (dims=${dims}, entries=${entries}, ordered=${ordered}) has no ` +
        'match in the external codebook library -- cannot encode this file'
      );
    }
    bw.write(codebookId, 10);
  }

  // time-domain placeholder: consume, write nothing (Wwise drops it)
  const timeCountLess1 = br.read(6);
  for (let i = 0; i < timeCountLess1 + 1; i++) br.read(16);

  const floorCountLess1 = br.read(6);
  const floorCount = floorCountLess1 + 1;
  bw.write(floorCountLess1, 6);

  for (let i = 0; i < floorCount; i++) {
    const floorType = br.read(16);
    if (floorType !== 1) throw new Error(`unsupported floor type ${floorType}`);

    const floor1Partitions = br.read(5);
    bw.write(floor1Partitions, 5);

    const partitionClassList = [];
    let maximumClass = 0;
    for (let j = 0; j < floor1Partitions; j++) {
      const cls = br.read(4);
      bw.write(cls, 4);
      partitionClassList.push(cls);
      if (cls > maximumClass) maximumClass = cls;
    }

    const classDimensionsList = new Array(maximumClass + 1).fill(0);
    for (let j = 0; j <= maximumClass; j++) {
      const classDimensionsLess1 = br.read(3);
      bw.write(classDimensionsLess1, 3);
      classDimensionsList[j] = classDimensionsLess1 + 1;

      const classSubclasses = br.read(2);
      bw.write(classSubclasses, 2);

      if (classSubclasses !== 0) {
        const masterbook = br.read(8);
        bw.write(masterbook, 8);
      }

      for (let k = 0; k < (1 << classSubclasses); k++) {
        const subclassBookPlus1 = br.read(8);
        bw.write(subclassBookPlus1, 8);
      }
    }

    const floor1MultiplierLess1 = br.read(2);
    bw.write(floor1MultiplierLess1, 2);

    const rangebits = br.read(4);
    bw.write(rangebits, 4);

    for (let j = 0; j < floor1Partitions; j++) {
      const curClass = partitionClassList[j];
      for (let k = 0; k < classDimensionsList[curClass]; k++) {
        const x = br.read(rangebits);
        bw.write(x, rangebits);
      }
    }
  }

  const residueCountLess1 = br.read(6);
  const residueCount = residueCountLess1 + 1;
  bw.write(residueCountLess1, 6);

  for (let i = 0; i < residueCount; i++) {
    const residueType = br.read(16);
    if (residueType > 2) throw new Error(`unsupported residue type ${residueType}`);
    bw.write(residueType, 2);

    const residueBegin = br.read(24);
    const residueEnd = br.read(24);
    const residuePartitionSizeLess1 = br.read(24);
    const residueClassificationsLess1 = br.read(6);
    const residueClassifications = residueClassificationsLess1 + 1;
    const residueClassbook = br.read(8);

    bw.write(residueBegin, 24);
    bw.write(residueEnd, 24);
    bw.write(residuePartitionSizeLess1, 24);
    bw.write(residueClassificationsLess1, 6);
    bw.write(residueClassbook, 8);

    const residueCascade = [];
    for (let j = 0; j < residueClassifications; j++) {
      const lowBits = br.read(3);
      bw.write(lowBits, 3);
      const bitflag = br.read(1);
      bw.write(bitflag, 1);
      let highBits = 0;
      if (bitflag) {
        highBits = br.read(5);
        bw.write(highBits, 5);
      }
      residueCascade.push(highBits * 8 + lowBits);
    }

    for (let j = 0; j < residueClassifications; j++) {
      for (let k = 0; k < 8; k++) {
        if (residueCascade[j] & (1 << k)) {
          const residueBook = br.read(8);
          bw.write(residueBook, 8);
        }
      }
    }
  }

  const mappingCountLess1 = br.read(6);
  const mappingCount = mappingCountLess1 + 1;
  bw.write(mappingCountLess1, 6);

  for (let i = 0; i < mappingCount; i++) {
    const mappingType = br.read(16);
    if (mappingType !== 0) throw new Error(`unsupported mapping type ${mappingType}`);

    const submapsFlag = br.read(1);
    bw.write(submapsFlag, 1);
    let submaps = 1;
    if (submapsFlag) {
      const submapsLess1 = br.read(4);
      bw.write(submapsLess1, 4);
      submaps = submapsLess1 + 1;
    }

    const squarePolarFlag = br.read(1);
    bw.write(squarePolarFlag, 1);
    if (squarePolarFlag) {
      const couplingStepsLess1 = br.read(8);
      bw.write(couplingStepsLess1, 8);
      const couplingSteps = couplingStepsLess1 + 1;
      const nbits = ilog(channels - 1);
      for (let j = 0; j < couplingSteps; j++) {
        const magnitude = br.read(nbits);
        const angle = br.read(nbits);
        bw.write(magnitude, nbits);
        bw.write(angle, nbits);
      }
    }

    const mappingReserved = br.read(2);
    if (mappingReserved !== 0) throw new Error('mapping reserved field nonzero');
    bw.write(mappingReserved, 2);

    if (submaps > 1) {
      for (let j = 0; j < channels; j++) {
        const mappingMux = br.read(4);
        bw.write(mappingMux, 4);
      }
    }

    for (let j = 0; j < submaps; j++) {
      const timeConfig = br.read(8);
      bw.write(timeConfig, 8);
      const floorNumber = br.read(8);
      bw.write(floorNumber, 8);
      const residueNumber = br.read(8);
      bw.write(residueNumber, 8);
    }
  }

  const modeCountLess1 = br.read(6);
  const modeCount = modeCountLess1 + 1;
  bw.write(modeCountLess1, 6);

  const modeBits = ilog(modeCount - 1);
  const modeBlockflag = [];

  for (let i = 0; i < modeCount; i++) {
    const blockFlag = br.read(1);
    bw.write(blockFlag, 1);
    modeBlockflag.push(!!blockFlag);

    const windowtype = br.read(16);
    const transformtype = br.read(16);
    if (windowtype !== 0 || transformtype !== 0) throw new Error('unsupported window/transform type');
    const mapping = br.read(8);
    bw.write(mapping, 8);
  }

  const framing = br.read(1);
  if (framing !== 1) throw new Error('expected framing bit == 1');

  return { bytes: bw.getBytes(), modeBits, modeBlockflag };
}

module.exports = { packSetupPacket };
