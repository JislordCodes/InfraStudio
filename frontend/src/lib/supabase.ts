import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getDeviceId } from './deviceId';
import { getIdentity } from './identity';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://pzeoilvqeyuheslkfhjq.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc';

// x-device-id scopes every request to this browser's own sessions/messages
// via Postgres RLS (see the ip_hash_rls_visibility migration) - there is no
// login system, so this per-device id is what stands in for a user identity.
// Used everywhere that doesn't need the IP-scoped variant below (e.g.
// storage uploads in AIChat.tsx).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-device-id': getDeviceId() } },
});

let scoped: Promise<SupabaseClient> | null = null;

/**
 * A second client, identical to `supabase` above but ALSO carrying an
 * x-ip-hash header - needed because RLS on ifc_sessions/ifc_messages only
 * recognizes x-device-id OR x-ip-hash, never a plain query filter alone
 * (confirmed live: a .or(ip_hash...,device_id...) query still came back
 * empty without this header, because RLS is enforced independently of the
 * query's own WHERE/OR clause). Can't just mutate the plain `supabase`
 * client's headers post-construction - supabase-js has no public API for
 * that - so this builds a second client once the async identity lookup
 * resolves, and caches it. Use this (not the plain `supabase` export) for
 * any ifc_sessions/ifc_messages query that should find another browser's
 * session on the same IP (see useSessions.ts).
 */
export function getScopedSupabase(): Promise<SupabaseClient> {
  if (scoped) return scoped;
  scoped = getIdentity().then(({ ipHash }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-device-id': getDeviceId(), 'x-ip-hash': ipHash || '' } },
    })
  );
  return scoped;
}
