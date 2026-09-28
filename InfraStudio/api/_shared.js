// Shared helpers for the Vercel functions in this folder. The leading underscore
// keeps Vercel from exposing this file as a route of its own.
//
// Required environment variables (Vercel project -> Settings -> Environment Variables):
//   SUPABASE_URL                e.g. https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   server-only key; the table has RLS on with no policies,
//                               so nothing else can read or write it
//   RESEND_API_KEY              for the "someone joined" email (optional - signups still
//                               save without it, you just won't be emailed)
//   NOTIFY_EMAIL                where that email goes (optional, same as above)
// Optional:
//   DASHBOARD_TOKEN             defaults to "omoSAL6" - must match the /dashboard<token> URL
//   NOTIFY_FROM                 defaults to Resend's shared sender "InfraStudio <onboarding@resend.dev>"
//   DASHBOARD_URL               link put in the email, defaults to https://www.infrastudio.app/dashboard<token>

const crypto = require("crypto");

const TABLE = "waitlist_signups";

function config() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key, ok: Boolean(url && key) };
}

function dashboardToken() {
  return process.env.DASHBOARD_TOKEN || "omoSAL6";
}

function tokensMatch(given) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(dashboardToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function restHeaders(key, extra) {
  return Object.assign(
    { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    extra || {}
  );
}

// Returns { ok: true, duplicate: false } for a new row, { ok: true, duplicate: true }
// if that email is already on the list, or throws if storage genuinely failed.
async function insertSignup(row) {
  const cfg = config();
  if (!cfg.ok) throw new Error("storage-not-configured");
  const res = await fetch(`${cfg.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: restHeaders(cfg.key, { Prefer: "return=minimal" }),
    body: JSON.stringify(row),
  });
  if (res.ok) return { ok: true, duplicate: false };
  const text = await res.text().catch(() => "");
  // 23505 = unique_violation: same email already signed up. That's a success from
  // the visitor's point of view; it just must not fire a second notification.
  if (res.status === 409 || text.includes("23505")) return { ok: true, duplicate: true };
  throw new Error(`insert-failed:${res.status}:${text.slice(0, 200)}`);
}

async function listSignups(limit) {
  const cfg = config();
  if (!cfg.ok) throw new Error("storage-not-configured");
  const res = await fetch(
    `${cfg.url}/rest/v1/${TABLE}?select=*&order=created_at.desc&limit=${limit || 5000}`,
    { headers: restHeaders(cfg.key) }
  );
  if (!res.ok) throw new Error(`list-failed:${res.status}`);
  return res.json();
}

// Best-effort: a failed email must never fail (or lose) the signup itself.
async function notifyOwner(entry) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) {
    console.warn("[waitlist] RESEND_API_KEY / NOTIFY_EMAIL not set - skipping notification email");
    return false;
  }
  const link = process.env.DASHBOARD_URL || `https://www.infrastudio.app/dashboard${dashboardToken()}`;
  const label = entry.type === "design-partner" ? "design partner" : "early-access";
  const lines = [
    `Someone just joined the InfraStudio waitlist (${label}).`,
    "",
    `Name: ${entry.name}`,
    `Profession: ${entry.profession}`,
    entry.company ? `Company: ${entry.company}` : null,
    "",
    `See everyone on the dashboard: ${link}`,
  ].filter((l) => l !== null);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM || "InfraStudio <onboarding@resend.dev>",
        to: [to],
        subject: `New waitlist signup: ${entry.name}`,
        text: lines.join("\n"),
      }),
    });
    if (!res.ok) console.error("[waitlist] notification email failed", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (err) {
    console.error("[waitlist] notification email error", err && err.message);
    return false;
  }
}

module.exports = { insertSignup, listSignups, notifyOwner, tokensMatch, dashboardToken, config };
