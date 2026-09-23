const EDGE_PROXY_BASE = import.meta.env.VITE_EDGE_PROXY_BASE || "https://xdii2dngnrumglsuv74fv5awz40rgwrg.lambda-url.us-east-1.on.aws";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6ZW9pbHZxZXl1aGVzbGtmaGpxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgzNDM2MjEsImV4cCI6MjA5MzkxOTYyMX0.f9ewqw57exbpvMcG_SUgXPytztDC08oeSFe3DTC9atc";

export interface Identity {
  ipHash: string | null;
}

let cached: Promise<Identity> | null = null;

/**
 * Resolves a hash of this visitor's real public IP from the server (never
 * the raw address, and not reversible without the server-only salt).
 * Replaces the old per-browser localStorage device id for chat-session
 * scoping (see useSessions.ts), so switching browsers/devices on the same
 * network keeps the same chat history.
 *
 * Cached after the first call so repeated lookups (e.g. from useSessions on
 * every mount) don't add extra round trips - an IP hash doesn't change
 * within a page session, so there's nothing to re-fetch.
 */
export function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  const promise = fetch(`${EDGE_PROXY_BASE}/agent-bim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ action: 'identity', plan: {} }),
  })
    .then((res) => (res.ok ? res.json() : { ip_hash: null }))
    .then((data) => ({ ipHash: data.ip_hash || null }))
    .catch(() => ({ ipHash: null }));
  cached = promise;
  return promise;
}
