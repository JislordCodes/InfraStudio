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

/** Groups an IPv6 address down to its /64 network prefix (the block an ISP
 *  hands a whole household/router, not a single device) - IPv4 passes
 *  through unchanged. Confirmed live: our own Lambda Function URL is
 *  dual-stack (both A and AAAA DNS records), and modern OSes/browsers
 *  generate a new temporary IPv6 address per connection under RFC 4941
 *  privacy addressing - so two browser tabs on the exact same device and
 *  network can legitimately present two different FULL IPv6 addresses to
 *  the server, defeating IP-based gating entirely on an IPv6-capable
 *  network. The /64 prefix is stable across that rotation (it's the routed
 *  block, not the interface identifier), so hashing that instead correctly
 *  treats them as the same visitor - the same normalization Cloudflare and
 *  GitHub use for exactly this reason. */
function normalizeIp(ip: string): string {
  if (!ip.includes(":")) return ip; // IPv4 - unchanged
  const clean = ip.split("%")[0]; // strip a zone id (e.g. "%eth0") if present
  const doubleColonIdx = clean.indexOf("::");
  let groups: string[];
  if (doubleColonIdx === -1) {
    groups = clean.split(":");
  } else {
    const head = clean.slice(0, doubleColonIdx).split(":").filter((g) => g !== "");
    const tail = clean.slice(doubleColonIdx + 2).split(":").filter((g) => g !== "");
    const missing = 8 - head.length - tail.length;
    groups = [...head, ...Array(Math.max(missing, 0)).fill("0"), ...tail];
  }
  return groups.slice(0, 4).join(":");
}

/** SHA-256 of the (prefix-normalized, see normalizeIp) IP plus a
 *  server-only salt (IP_HASH_SALT) so the stored value can't be reversed
 *  back to a raw IP even if the table ever leaked - we only ever need to
 *  compare hashes, never to recover an address. */
async function hashIp(ip: string): Promise<string> {
  const salt = getEnv("IP_HASH_SALT") || "";
  const data = new TextEncoder().encode(`${salt}:${normalizeIp(ip)}`);
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

/** Owner/trusted-tester bypass: true only if the code THIS REQUEST supplies
 *  (from https://www.infrastudio.app/studios?unlock=<code>, re-sent by the
 *  frontend on every build_code call for that one browser tab - see
 *  useMultiAgentLoop.ts) matches the real secret, which lives only in this
 *  env var, never in the frontend bundle. No-ops (always false) if the env
 *  var isn't set.
 *
 *  Deliberately NOT persisted anywhere server-side (no per-IP "has ever
 *  unlocked" flag): a visitor who used their one trial on plain /studios
 *  must stay gated there even if that same IP unlocked at some earlier
 *  point - only actually visiting the ?unlock= link again grants access.
 *  An earlier version of this recorded the unlock per-IP in a DB table so
 *  it would silently keep applying to plain /studios forever, which is
 *  exactly the behavior this was corrected away from. */
export function isUnlockedRequest(payload: any): boolean {
  const expected = getEnv("UNLIMITED_ACCESS_PASSWORD");
  if (!expected) return false;
  const provided = typeof payload?.plan?.unlockCode === "string" ? payload.plan.unlockCode.trim() : "";
  return !!provided && provided === expected;
}
