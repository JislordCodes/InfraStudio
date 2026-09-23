/**
 * Public-landing-page trial gate: the product is currently released for
 * anonymous visitors to try ONCE. Gated by IP (hashed, never stored raw),
 * not by device id / localStorage / session id, because those are trivially
 * cleared or reset by the visitor and would let the same person "test" an
 * unlimited number of times.
 *
 * Uses the Supabase service_role key (server-only, never shipped to the
 * frontend bundle) against a table with RLS enabled and no anon/authenticated
 * policies, so a visitor holding the public anon key cannot read or clear
 * their own gate the way they could with the app's other, intentionally-open
 * tables.
 *
 * Same dual-runtime plain-fetch approach as jev_client.ts - this file is
 * bundled by both the Deno Supabase runtime and esbuild for the Lambda.
 */

function getEnv(name: string): string | undefined {
  const v = typeof Deno !== "undefined" ? Deno.env.get(name) : process.env[name];
  return v?.trim() || undefined;
}

function supabaseConfigured(): boolean {
  return !!(getEnv("SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY"));
}

/** SHA-256 of the IP plus a server-only salt (IP_HASH_SALT) so the stored
 *  value can't be reversed back to a raw IP even if the table ever leaked -
 *  we only ever need to compare hashes, never to recover an address. */
async function hashIp(ip: string): Promise<string> {
  const salt = getEnv("IP_HASH_SALT") || "";
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The Lambda wrapper (aws-lambda/index.ts) sets this from
 *  event.requestContext.http.sourceIp AFTER parsing the client's own JSON
 *  body, overwriting anything the client tried to send under this key - a
 *  visitor cannot spoof their own IP through the request payload. */
export async function getIpHash(payload: any): Promise<string | null> {
  const ip = typeof payload?._clientIp === "string" ? payload._clientIp.trim() : "";
  if (!ip) return null; // e.g. local/dev invocation with no real client IP - gate no-ops
  return hashIp(ip);
}

/** True if this IP has already completed one successful build. Fails open
 *  (returns false = "not used yet") on any Supabase error or missing
 *  config, so a DB outage degrades to "gate skipped" rather than blocking
 *  every visitor. */
export async function hasUsedTrial(ipHash: string | null): Promise<boolean> {
  if (!ipHash || !supabaseConfigured()) return false;
  try {
    const url = `${getEnv("SUPABASE_URL")}/rest/v1/ip_trial_usage?ip_hash=eq.${ipHash}&select=ip_hash&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn("[trial_gate] hasUsedTrial check failed, allowing request:", e);
    return false;
  }
}

/** Records this IP as having used its trial. Called only once a build
 *  genuinely reaches status:"success" - never for a build that errored out,
 *  so a failed first attempt doesn't cost the visitor their one real try. */
export async function markTrialUsed(ipHash: string | null, jobId: string): Promise<void> {
  if (!ipHash || !supabaseConfigured()) return;
  try {
    const url = `${getEnv("SUPABASE_URL")}/rest/v1/ip_trial_usage`;
    await fetch(url, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ ip_hash: ipHash, job_id: jobId }),
    });
  } catch (e) {
    console.warn("[trial_gate] markTrialUsed failed (non-fatal):", e);
  }
}

export const WAITLIST_URL = "https://www.infrastudio.app/?waitlist=early-access";

/** Owner/trusted-tester bypass: true only if the code the visitor's browser
 *  sent (from https://www.infrastudio.app/studios?unlock=<code>, see
 *  App.tsx) matches the real secret, which lives only in this env var -
 *  never in the frontend bundle. No-ops (always false) if the env var isn't
 *  set. This is just "was the correct code supplied on THIS request" - see
 *  isIpUnlocked/markIpUnlocked below for the persistent, IP-scoped version
 *  that lets the unlock survive across browsers/devices once granted. */
export function isUnlockedRequest(payload: any): boolean {
  const expected = getEnv("UNLIMITED_ACCESS_PASSWORD");
  if (!expected) return false;
  const provided = typeof payload?.plan?.unlockCode === "string" ? payload.plan.unlockCode.trim() : "";
  return !!provided && provided === expected;
}

/** True if this IP has ever supplied the correct unlock code (see
 *  markIpUnlocked). Checked on EVERY request - not just ones carrying the
 *  code - so an already-unlocked IP gets unlimited access through the plain
 *  /studios URL too, not only through the ?unlock= link itself; the link's
 *  only job is to record the IP here once. Fails open (false = "not
 *  unlocked") on any Supabase error or missing config, same reasoning as
 *  hasUsedTrial - a DB outage degrades to "gate enforced", not "gate broken
 *  open". */
export async function isIpUnlocked(ipHash: string | null): Promise<boolean> {
  if (!ipHash || !supabaseConfigured()) return false;
  try {
    const url = `${getEnv("SUPABASE_URL")}/rest/v1/ip_unlocked_access?ip_hash=eq.${ipHash}&select=ip_hash&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
      },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn("[trial_gate] isIpUnlocked check failed, denying unlock:", e);
    return false;
  }
}

/** Records this IP as permanently unlocked - called the first (and every,
 *  harmlessly idempotent via merge-duplicates) time it supplies the correct
 *  access code. This is what makes the unlock IP-based rather than
 *  per-browser: once recorded, every future request from this IP is
 *  unlocked regardless of which browser/device it comes from or whether
 *  that request still carries the code. */
export async function markIpUnlocked(ipHash: string | null): Promise<void> {
  if (!ipHash || !supabaseConfigured()) return;
  try {
    const url = `${getEnv("SUPABASE_URL")}/rest/v1/ip_unlocked_access`;
    await fetch(url, {
      method: "POST",
      headers: {
        apikey: getEnv("SUPABASE_SERVICE_ROLE_KEY")!,
        Authorization: `Bearer ${getEnv("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ ip_hash: ipHash }),
    });
  } catch (e) {
    console.warn("[trial_gate] markIpUnlocked failed (non-fatal):", e);
  }
}
