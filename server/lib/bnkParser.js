'use strict';

// Ported from the browser bnk-analyzer tool. All offsets returned here are
// ABSOLUTE offsets into the original file buffer, which is what makes this
// reusable for both read-only analysis and in-place binary patching.

const HIRC_TYPES = {
  1: 'Settings', 2: 'Sound', 3: 'EventAction', 4: 'Event',
  5: 'RandomSequenceContainer', 6: 'SwitchContainer', 7: 'ActorMixer',
  8: 'Bus', 9: 'LayerContainer', 10: 'MusicSegment', 11: 'MusicTrack',
  12: 'MusicSwitchContainer', 13: 'MusicRanSeqContainer', 14: 'Attenuation',
  15: 'DialogueEvent', 16: 'FeedbackBus', 17: 'FeedbackNode', 18: 'Effect',
  19: 'Environment', 20: 'AudioDevice', 22: 'AuxiliaryBus', 23: 'LFO',
  24: 'Envelope', 25: 'AudioDeviceEffect', 26: 'Curve'
};

const CONTAINER_TYPES = new Set([5, 6, 7, 8, 9, 10, 12, 13]);

function u32(b, off) { return b.readUInt32LE(off); }
function u8(b, off) { return b.readUInt8(off); }
function fourCC(b, off) { return b.toString('ascii', off, off + 4); }

function parseChunks(buf) {
  const total = buf.length;
  const chunks = [];
  let off = 0;
  while (off + 8 <= total) {
    const id = fourCC(buf, off);
    const size = u32(buf, off + 4);
    const dataStart = off + 8;
    if (dataStart + size > total) {
      chunks.push({ id, offset: off, size, dataStart, truncated: true });
      break;
    }
    chunks.push({ id, offset: off, size, dataStart, truncated: false });
    off = dataStart + size;
  }
  return chunks;
}

function parseBKHD(buf, c) {
  return { version: u32(buf, c.dataStart), soundBankId: u32(buf, c.dataStart + 4) };
}

function parseDIDX(buf, c) {
  const entries = [];
  const n = Math.floor(c.size / 12);
  for (let i = 0; i < n; i++) {
    const o = c.dataStart + i * 12;
    entries.push({ mediaId: u32(buf, o), offset: u32(buf, o + 4), size: u32(buf, o + 8) });
  }
  return entries;
}

function parseHIRC(buf, c) {
  const objs = [];
  let o = c.dataStart;
  const end = c.dataStart + c.size;
  const count = u32(buf, o); o += 4;
  for (let i = 0; i < count; i++) {
    if (o + 5 > end) break;
    const type = u8(buf, o);
    const len = u32(buf, o + 1);
    const objStart = o + 5;
    if (objStart + len > end) break;
    const id = u32(buf, objStart);
    const payloadStart = objStart + 4; // absolute offset into buf
    const payloadLen = len - 4;
    const payload = buf.subarray(payloadStart, payloadStart + Math.max(0, payloadLen));
    objs.push({
      id, type, typeName: HIRC_TYPES[type] || ('Unknown(' + type + ')'),
      size: len, index: i, payload, payloadStart // keep absolute offset for patching
    });
    o = objStart + len;
  }
  return objs;
}

function parseEventRefs(payload, ids) {
  const out = new Set();
  if (payload.length < 1) return out;
  const cnt = payload.readUInt8(0);
  if (1 + cnt * 4 <= payload.length) {
    for (let k = 0; k < cnt; k++) {
      const v = payload.readUInt32LE(1 + 4 * k);
      if (ids.has(v)) out.add(v);
    }
  }
  return out;
}

function parseContainerRefs(payload, ids) {
  const out = new Set();
  const len = payload.length;
  for (let p = 0; p + 8 <= len; p++) {
    const cnt = payload.readUInt32LE(p);
    if (cnt < 1 || cnt > 64) continue;
    if (p + 4 + cnt * 4 > len) continue;
    const vals = [];
    let allValid = true;
    const dupCheck = new Set();
    for (let k = 0; k < cnt; k++) {
      const v = payload.readUInt32LE(p + 4 + 4 * k);
      if (!ids.has(v) || dupCheck.has(v)) { allValid = false; break; }
      dupCheck.add(v);
      vals.push(v);
    }
    if (allValid) for (const v of vals) out.add(v);
  }
  return out;
}

function parseActionRefs(payload, ids) {
  const out = new Set();
  for (let p = 0; p + 4 <= payload.length; p++) {
    const v = payload.readUInt32LE(p);
    if (ids.has(v)) out.add(v);
  }
  return out;
}

// Scans a window of the payload for a plausible ms-duration double, matching the
// latest bnk-analyzer heuristic exactly:
//   - candidate range: 100ms .. 7,200,000ms (0.1s .. 2h)
//   - MusicSegment payloads carry an unrelated FIXED constant of exactly 1000.0
//     at a stable position — excluded outright
//   - when a track has fade/trim, two duration-like fields can appear (full
//     duration vs. a slightly shorter trimmed/exit-cue point); the real
//     Duration is always the LARGER of the two, not just "the one that repeats"
// Returns the winning value plus every absolute byte offset where that exact
// value occurs (so a patcher can overwrite every copy of the field).
function findDurationOccurrences(payload, payloadStart, startOffset, windowBytes) {
  const end = Math.min(payload.length - 8, startOffset + windowBytes);
  let best = null;
  for (let p = startOffset; p <= end; p++) {
    let v;
    try { v = payload.readDoubleLE(p); } catch (e) { continue; }
    if (!isFinite(v)) continue;
    if (v >= 100 && v <= 7200000) {
      if (Math.abs(v - 1000.0) < 0.01) continue; // known unrelated fixed constant
      if (best == null || v > best) best = v;
    }
  }
  if (best == null) return null;
  const value = Math.round(best * 1000) / 1000;

  // second pass: collect every absolute offset whose double equals the winning value
  const offsets = [];
  for (let p = startOffset; p <= end; p++) {
    let v;
    try { v = payload.readDoubleLE(p); } catch (e) { continue; }
    if (!isFinite(v)) continue;
    if (Math.round(v * 1000) / 1000 === value) offsets.push(payloadStart + p);
  }
  return { value, offsets };
}

function scanForSourceStructs(payload, didxIds) {
  const results = [];
  const len = payload.length;
  const maxScan = Math.min(len - 9, 64);
  for (let p = 0; p <= maxScan; p++) {
    let streamType, sourceId;
    try {
      streamType = payload.readUInt8(p + 4);
      sourceId = payload.readUInt32LE(p + 5);
    } catch (e) { continue; }
    if (streamType > 2) continue;
    if (sourceId === 0) continue;
    const embedded = didxIds.has(sourceId);
    let confidence = 'low';
    if (embedded && streamType === 0) confidence = 'high';
    else if (!embedded && (streamType === 1 || streamType === 2)) confidence = 'medium';
    else continue;
    results.push({ sourceId, streamType, confidence, structOffset: p });
    if (results.length >= 3) break;
  }
  return results;
}

// Given the payload of a Sound/MusicTrack HIRC object and a source-struct match
// from scanForSourceStructs, locate the track's own nearby duration field
// (offsets relative to the object, matching the analyzer's p+9..p+9+80 window).
function findTrackOwnDuration(payload, payloadStart, structOffset) {
  return findDurationOccurrences(payload, payloadStart, structOffset + 9, 80);
}

// Full parse producing the same shape as the browser tool's `report`, but with
// absolute payload offsets retained (report.hirc[i].payloadStart) for patching.
function parseBnk(buf) {
  const chunks = parseChunks(buf);
  const result = { fileSize: buf.length, chunks, bkhd: null, didx: [], hirc: [] };

  for (const c of chunks) {
    if (c.truncated) continue;
    if (c.id === 'BKHD') result.bkhd = parseBKHD(buf, c);
    else if (c.id === 'DIDX') result.didx = parseDIDX(buf, c);
    else if (c.id === 'HIRC') result.hirc = parseHIRC(buf, c);
  }

  const didxIds = new Set(result.didx.map(d => d.mediaId));
  const hircIds = new Set(result.hirc.map(h => h.id));

  for (const h of result.hirc) {
    let refs;
    if (h.type === 4) refs = parseEventRefs(h.payload, hircIds);
    else if (CONTAINER_TYPES.has(h.type)) refs = parseContainerRefs(h.payload, hircIds);
    else if (h.type === 3) refs = parseActionRefs(h.payload, hircIds);
    else refs = new Set();
    h.refIds = Array.from(refs);
  }

  return { result, didxIds, hircIds };
}

module.exports = {
  HIRC_TYPES, CONTAINER_TYPES,
  parseBnk, parseChunks, parseHIRC, parseDIDX, parseBKHD,
  findDurationOccurrences, scanForSourceStructs, findTrackOwnDuration
};
