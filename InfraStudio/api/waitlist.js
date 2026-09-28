// POST /api/waitlist - stores a signup in Supabase and emails the owner.
// Replaces the local-only server.js CSV writer, which can't run on Vercel.
const { insertSignup, notifyOwner } = require("./_shared");

const LIMITS = { name: 200, email: 254, profession: 200, company: 200, notes: 2000 };

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clean(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ ok: false, error: "Invalid request body." });
  }

  const name = clean(payload.name, LIMITS.name);
  const email = clean(payload.email, LIMITS.email);
  const profession = clean(payload.profession, LIMITS.profession);
  if (!name || !isValidEmail(email) || !profession) {
    return res.status(422).json({ ok: false, error: "Name, a valid email, and profession are required." });
  }

  const submitted = new Date(payload.submittedAt);
  const row = {
    submitted_at: isNaN(submitted.getTime()) ? new Date().toISOString() : submitted.toISOString(),
    type: payload.type === "design-partner" ? "design-partner" : "early-access",
    name,
    email,
    profession,
    company: clean(payload.company, LIMITS.company),
    notes: clean(payload.notes, LIMITS.notes),
    user_agent: clean(req.headers["user-agent"], 300),
  };

  let result;
  try {
    result = await insertSignup(row);
  } catch (err) {
    console.error("[waitlist] could not store signup:", err && err.message);
    // Honest failure: the form must NOT tell the visitor they joined when they didn't.
    return res.status(500).json({ ok: false, error: "We couldn't save your signup. Please try again in a moment." });
  }

  if (!result.duplicate) await notifyOwner(row);
  return res.status(200).json({ ok: true });
};
