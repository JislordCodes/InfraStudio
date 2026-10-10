/**
 * Hashed-IP identity helper. The one-trial-per-IP gate that used to live here
 * was removed: every visitor now has full access. The hash is still used by
 * the `identity` action so chat history follows a visitor across browsers.
 * Same dual-runtime plain-fetch approach as jev_client.ts - bundled by both
 * the Deno Supabase runtime and esbuild for the Lambda.
 */

function getEnv(name: string): string | undefined {
  const v = typeof Deno !== "undefined" ? Deno.env.get(name) : process.env[name];
  return v?.trim() || undefined;
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
