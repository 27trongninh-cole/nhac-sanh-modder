'use strict';

const fs = require('fs');
const path = require('path');
const supabaseStore = require('./supabaseStore');

const DEFAULT_BNK_PATH = path.join(__dirname, '..', 'data', 'Music_Login.bnk');
const DEFAULT_SOURCE_ID = 985479411;
const CONFIG_TTL_MS = 30 * 1000; // re-check Supabase at most every 30s
const MAX_BNK_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30 * 1000;

let cachedConfig = null;     // { sourceId, bnkUrl, updatedAt, updatedBy, fetchedAt }
let cachedBnkBuffer = null;
let cachedBnkUrl = null;

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } catch (e) {
    throw new Error(`Không tải được file từ URL (${e.message})`);
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(`Không tải được file từ URL (HTTP ${resp.status})`);

  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BNK_BYTES) {
    throw new Error('File vượt quá giới hạn 100MB');
  }
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > MAX_BNK_BYTES) throw new Error('File vượt quá giới hạn 100MB');
  if (buf.length === 0) throw new Error('File tải về rỗng (0 byte) — kiểm tra lại link Catbox');
  return buf;
}

// Returns { bnkBuffer, sourceId, isDefault, config }
// `opts.forceRefresh` bypasses both the config TTL and the bnk-buffer cache —
// used right after an admin update so /api/build reflects it immediately.
async function getActive(opts = {}) {
  const now = Date.now();
  const stale = !cachedConfig || (now - cachedConfig.fetchedAt) > CONFIG_TTL_MS;

  if (opts.forceRefresh || stale) {
    const remote = await supabaseStore.getConfig(); // null if unconfigured or no row yet
    cachedConfig = (remote && remote.bnkUrl) ? { ...remote, fetchedAt: now } : null;
  }

  if (!cachedConfig) {
    return {
      bnkBuffer: fs.readFileSync(DEFAULT_BNK_PATH),
      sourceId: DEFAULT_SOURCE_ID,
      replacementId: DEFAULT_SOURCE_ID, // no admin config yet -> old in-place behavior
      isDefault: true,
      config: null
    };
  }

  if (opts.forceRefresh || cachedBnkUrl !== cachedConfig.bnkUrl || !cachedBnkBuffer) {
    cachedBnkBuffer = await fetchBuffer(cachedConfig.bnkUrl);
    cachedBnkUrl = cachedConfig.bnkUrl;
  }

  return {
    bnkBuffer: cachedBnkBuffer,
    sourceId: cachedConfig.sourceId,
    replacementId: cachedConfig.replacementId != null ? cachedConfig.replacementId : cachedConfig.sourceId,
    isDefault: false,
    config: cachedConfig
  };
}

function invalidate() {
  cachedConfig = null;
  cachedBnkBuffer = null;
  cachedBnkUrl = null;
}

module.exports = { getActive, invalidate, fetchBuffer, DEFAULT_SOURCE_ID, DEFAULT_BNK_PATH };
