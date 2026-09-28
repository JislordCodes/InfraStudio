// Shared helpers for the Vercel functions in this folder. The leading underscore
// keeps Vercel from exposing this file as a route of its own.
//
// Required environment variables (Vercel project -> Settings -> Environment Variables):
//   SUPABASE_URL                e.g. https://<ref>.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   server-only key; the table has RLS on with no policies,
//                               so nothing else can read or write it
//   (alerts - set at least one channel, see notifyOwner below)
//   SMTP_USER + SMTP_PASS       Gmail address + Google App password  -> free email alert
//   NOTIFY_EMAIL                inbox that receives it (defaults to SMTP_USER)
//   NTFY_TOPIC                  free phone push via the ntfy app
//   RESEND_API_KEY              optional alternative to Gmail
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

// Best-effort: a failed alert must never fail (or lose) the signup itself. Every
// channel that's configured is tried; none configured just logs a warning.
//   Gmail (free):  SMTP_USER + SMTP_PASS (a Google "App password") [+ NOTIFY_EMAIL, default SMTP_USER]
//   Resend:        RESEND_API_KEY + NOTIFY_EMAIL
//   Phone push:    NTFY_TOPIC (free, no account - install the ntfy app and subscribe to that topic)
async function notifyOwner(entry) {
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
  const text = lines.join("\n");
  const subject = `New waitlist signup: ${entry.name}`;
  const jobs = [];

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    jobs.push(
      (async () => {
        const nodemailer = require("nodemailer");
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: Number(process.env.SMTP_PORT || 465),
          secure: Number(process.env.SMTP_PORT || 465) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transport.sendMail({
          from: `InfraStudio Alerts <${process.env.SMTP_USER}>`,
          to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
          subject,
          text,
        });
      })().then(() => "smtp")
    );
  }

  if (process.env.RESEND_API_KEY && process.env.NOTIFY_EMAIL) {
    jobs.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.NOTIFY_FROM || "InfraStudio <onboarding@resend.dev>",
          to: [process.env.NOTIFY_EMAIL],
          subject,
          text,
        }),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`resend ${res.status} ${(await res.text()).slice(0, 200)}`);
        return "resend";
      })
    );
  }

  if (process.env.NTFY_TOPIC) {
    jobs.push(
      fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
        method: "POST",
        headers: { Title: "New waitlist signup", Click: link, Tags: "tada" },
        body: text,
      }).then((res) => {
        if (!res.ok) throw new Error(`ntfy ${res.status}`);
        return "ntfy";
      })
    );
  }

  if (!jobs.length) {
    console.warn("[waitlist] no alert channel configured (SMTP_USER/SMTP_PASS, RESEND_API_KEY, or NTFY_TOPIC) - skipping alert");
    return false;
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === "rejected") console.error("[waitlist] alert failed:", r.reason && r.reason.message);
  });
  return results.some((r) => r.status === "fulfilled");
}

module.exports = { insertSignup, listSignups, notifyOwner, tokensMatch, dashboardToken, config };
