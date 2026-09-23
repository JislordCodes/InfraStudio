const EDGE_PROXY_BASE = import.meta.env.VITE_EDGE_PROXY_BASE || "https://xdii2dngnrumglsuv74fv5awz40rgwrg.lambda-url.us-east-1.on.aws";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

export interface Identity {
  ipHash: string | null;
  unlocked: boolean;
}

let cached: Promise<Identity> | null = null;

/**
 * Resolves this visitor's identity from the server: a hash of their real
 * public IP (the server never returns the raw address, and the hash can't
 * be reversed without the server-only salt) plus whether that IP has
 * unlocked unlimited access. Replaces the old per-browser localStorage
 * device id for chat-session scoping (see useSessions.ts), so switching
 * browsers/devices on the same network keeps the same chat history - IP is
 * exactly what the trial gate itself is keyed on, so "which sessions do I
 * see" now matches "am I gated".
 *
 * Cached after the first resolved call so repeated lookups (e.g. from
 * useSessions on every mount) don't add extra round trips. Passing
 * `unlockCode` always bypasses the cache and fires a fresh request, since
 * that's the one case where a NEW server-side effect (recording the IP as
 * unlocked) needs to actually happen, not just be read back.
 */
export function getIdentity(unlockCode?: string): Promise<Identity> {
  if (cached && !unlockCode) return cached;
  const promise = fetch(`${EDGE_PROXY_BASE}/agent-bim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: 'identity', plan: { unlockCode } }),
  })
    .then((res) => (res.ok ? res.json() : { ip_hash: null, unlocked: false }))
    .then((data) => ({ ipHash: data.ip_hash || null, unlocked: !!data.unlocked }))
    .catch(() => ({ ipHash: null, unlocked: false }));
  cached = promise;
  return promise;
}
