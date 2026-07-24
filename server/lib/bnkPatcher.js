'use strict';

const { parseBnk, findDurationOccurrences, scanForSourceStructs, findTrackOwnDuration } = require('./bnkParser');

/**
 * Given a .bnk buffer and the external Media (source) ID used for the track
 * you're modding (e.g. 520249413), find every relevant field:
 *   1. the MusicTrack HIRC object that references that sourceId — and the
 *      exact absolute offset of the sourceId itself (4 bytes, uint32 LE),
 *      so it can be rewritten to point at a DIFFERENT media id instead
 *      (e.g. to avoid overwriting the original .wem on disk).
 *   2. the MusicSegment(s) that reference that MusicTrack (via refIds) — the
 *      PRIMARY duration source (what the analyzer sorts/displays by).
 *   3. the track's OWN nearby duration field (secondary — "nearby field guess").
 * Both duration fields are patched so nothing is left stale, since it isn't
 * fully known which field the game engine actually reads at runtime.
 */
function locateFields(buf, targetSourceId) {
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

  const durationFields = []; // { kind, ownerId, currentValueMs, offsets }

  for (const seg of segments) {
    const occ = findDurationOccurrences(seg.payload, seg.payloadStart, 0, seg.payload.length - 8);
    if (occ) durationFields.push({ kind: 'segment', ownerId: seg.id, currentValueMs: occ.value, offsets: occ.offsets });
  }

  for (const m of trackMatches) {
    const occ = findTrackOwnDuration(m.hirc.payload, m.hirc.payloadStart, m.structOffset);
    if (occ) durationFields.push({ kind: 'track', ownerId: m.hirc.id, currentValueMs: occ.value, offsets: occ.offsets });
  }

  if (durationFields.length === 0) {
    return {
      ok: false,
      reason: `Tìm thấy track (${[...trackIds].join(', ')}) nhưng không dò được field duration hợp lệ nào (segment hay track)`
    };
  }

  // sourceId field itself: struct layout is [.., streamType(u8) @+4, sourceId(u32LE) @+5, ..]
  // (see scanForSourceStructs in bnkParser.js) — offset relative to hirc.payload
  const idFields = trackMatches.map(m => ({
    hircId: m.hirc.id,
    offset: m.hirc.payloadStart + m.structOffset + 5
  }));

  return { ok: true, trackIds: [...trackIds], durationFields, idFields };
}

// Kept for backward compatibility (used by /api/admin/update to validate a
// bnk without needing to patch anything).
function locateDurationFields(buf, targetSourceId) {
  const located = locateFields(buf, targetSourceId);
  if (!located.ok) return located;
  return { ok: true, trackIds: located.trackIds, fields: located.durationFields };
}

/**
 * Returns a NEW Buffer (copy) with:
 *   - every sourceId occurrence for `targetSourceId` rewritten to `replacementSourceId`
 *     (so the .bnk points at a NEW/unused media id instead of the original)
 *   - every located duration occurrence (segment-level AND track-own)
 *     overwritten with `newDurationMs` (float64 LE)
 * File size is preserved exactly — only fixed-width fields are rewritten in place.
 * If replacementSourceId === targetSourceId, this behaves exactly like the
 * old in-place "just patch duration" mode.
 */
function patchIdAndDuration(buf, targetSourceId, replacementSourceId, newDurationMs) {
  const located = locateFields(buf, targetSourceId);
  if (!located.ok) return { ok: false, reason: located.reason };

  const patched = Buffer.from(buf); // copy, never mutate the original

  let idPatchCount = 0;
  for (const idf of located.idFields) {
    patched.writeUInt32LE(replacementSourceId, idf.offset);
    idPatchCount++;
  }

  let durationPatchCount = 0;
  for (const field of located.durationFields) {
    for (const off of field.offsets) {
      patched.writeDoubleLE(newDurationMs, off);
      durationPatchCount++;
    }
  }

  return {
    ok: true,
    buffer: patched,
    trackIds: located.trackIds,
    idFields: located.idFields.map(f => ({ hircId: f.hircId, oldSourceId: targetSourceId, newSourceId: replacementSourceId })),
    idPatchCount,
    durationFields: located.durationFields.map(f => ({
      kind: f.kind, ownerId: f.ownerId,
      oldValueMs: f.currentValueMs, newValueMs: newDurationMs,
      offsetCount: f.offsets.length
    })),
    durationPatchCount
  };
}

module.exports = { locateFields, locateDurationFields, patchIdAndDuration };
