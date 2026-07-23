'use strict';

const { parseBnk, findDurationOccurrences, scanForSourceStructs, findTrackOwnDuration } = require('./bnkParser');

/**
 * Given a .bnk buffer and the external Media (source) ID used for the track
 * you're modding (e.g. 985479411 for nhạc sảnh), find every place the current
 * duration is stored, matching the latest bnk-analyzer heuristic:
 *   1. the MusicTrack HIRC object that references that sourceId
 *   2. the MusicSegment(s) that reference that MusicTrack (via refIds) — this
 *      is the PRIMARY duration source (what the analyzer sorts/displays by)
 *   3. the track's OWN nearby duration field (secondary — "nearby field guess")
 * Both are patched so nothing is left stale, since it isn't fully known which
 * field the game engine actually reads at runtime.
 */
function locateDurationFields(buf, targetSourceId) {
  const { result, didxIds } = parseBnk(buf);

  const trackMatches = []; // { hirc, structOffset }
  for (const h of result.hirc) {
    if (h.type !== 2 && h.type !== 11) continue; // Sound / MusicTrack
    const found = scanForSourceStructs(h.payload, didxIds);
    for (const f of found) {
      if (f.sourceId === targetSourceId) trackMatches.push({ hirc: h, structOffset: f.structOffset });
    }
  }

  if (trackMatches.length === 0) {
    return { ok: false, reason: `Không tìm thấy HIRC object nào tham chiếu sourceId ${targetSourceId}` };
  }

  const trackIds = new Set(trackMatches.map(m => m.hirc.id));
  const segments = result.hirc.filter(h => h.type === 10 && h.refIds.some(r => trackIds.has(r)));

  const fields = []; // { kind, ownerId, currentValueMs, offsets }

  for (const seg of segments) {
    const occ = findDurationOccurrences(seg.payload, seg.payloadStart, 0, seg.payload.length - 8);
    if (occ) fields.push({ kind: 'segment', ownerId: seg.id, currentValueMs: occ.value, offsets: occ.offsets });
  }

  for (const m of trackMatches) {
    const occ = findTrackOwnDuration(m.hirc.payload, m.hirc.payloadStart, m.structOffset);
    if (occ) fields.push({ kind: 'track', ownerId: m.hirc.id, currentValueMs: occ.value, offsets: occ.offsets });
  }

  if (fields.length === 0) {
    return {
      ok: false,
      reason: `Tìm thấy track (${[...trackIds].join(', ')}) nhưng không dò được field duration hợp lệ nào (segment hay track)`
    };
  }

  return { ok: true, trackIds: [...trackIds], fields };
}

/**
 * Returns a NEW Buffer (copy) with every located duration occurrence
 * (segment-level AND track-own) overwritten with newDurationMs (float64 LE),
 * preserving file size exactly (only 8-byte double values are rewritten).
 */
function patchDuration(buf, targetSourceId, newDurationMs) {
  const located = locateDurationFields(buf, targetSourceId);
  if (!located.ok) return { ok: false, reason: located.reason };

  const patched = Buffer.from(buf); // copy, never mutate the original
  let patchedOffsetCount = 0;
  for (const field of located.fields) {
    for (const off of field.offsets) {
      patched.writeDoubleLE(newDurationMs, off);
      patchedOffsetCount++;
    }
  }

  return {
    ok: true,
    buffer: patched,
    trackIds: located.trackIds,
    fields: located.fields.map(f => ({
      kind: f.kind, ownerId: f.ownerId,
      oldValueMs: f.currentValueMs, newValueMs: newDurationMs,
      offsetCount: f.offsets.length
    })),
    patchedOffsetCount
  };
}

module.exports = { locateDurationFields, patchDuration };
