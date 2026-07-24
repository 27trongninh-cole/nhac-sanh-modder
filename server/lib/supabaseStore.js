'use strict';

// Stores exactly one row: the currently active { sourceId, bnkUrl }. Using
// Supabase (external, persists independent of the Render instance disk) means
// admin updates survive redeploys — unlike the earlier local-disk version.
//
// SECURITY: only the SERVICE ROLE key is used, and only from this server
// process. It is never sent to the browser. The admin panel talks to OUR
// /api/admin/* routes (protected by ADMIN_PASSWORD), which then talk to
// Supabase — the browser never holds a Supabase credential.

const TABLE = 'nhac_sanh_active_config';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || null;

let client = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function isConfigured() {
  return !!client;
}

// Returns { sourceId, bnkUrl, updatedAt, updatedBy } or null if no row saved yet
// (fresh Supabase project) or Supabase isn't configured at all.
async function getConfig() {
  if (!client) return null;
  const { data, error } = await client
    .from(TABLE)
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error('Supabase lỗi khi đọc config: ' + error.message);
  if (!data) return null;
  return {
    sourceId: data.source_id,
    bnkUrl: data.bnk_url,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by
  };
}

async function setConfig({ sourceId, bnkUrl, updatedBy }) {
  if (!client) throw new Error('Supabase chưa được cấu hình (thiếu SUPABASE_URL / SUPABASE_SERVICE_KEY trên server)');
  const { data, error } = await client
    .from(TABLE)
    .upsert({
      id: 1,
      source_id: sourceId,
      bnk_url: bnkUrl,
      updated_by: updatedBy || null,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) throw new Error('Supabase lỗi khi lưu config: ' + error.message);
  return {
    sourceId: data.source_id,
    bnkUrl: data.bnk_url,
    updatedAt: data.updated_at,
    updatedBy: data.updated_by
  };
}

module.exports = { isConfigured, getConfig, setConfig };
