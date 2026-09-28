// GET /api/dashboard-data - the waitlist rows for /dashboard<token>.
// Auth: the same token that's in the dashboard URL, sent as the x-dashboard-token header.
// GET /api/dashboard-data?format=csv - same data as a CSV download.
const { listSignups, tokensMatch } = require("./_shared");

const CSV_COLUMNS = [
  ["created_at", "signedUpAt"],
  ["type", "type"],
  ["name", "name"],
  ["email", "email"],
  ["profession", "profession"],
  ["company", "company"],
  ["notes", "notes"],
];

// Neutralise spreadsheet formula injection (a cell starting with = + - @ would run
// as a formula when the export is opened in Excel/Sheets), then CSV-quote.
function csvCell(value) {
  let str = String(value == null ? "" : value);
  if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }

  const given = req.headers["x-dashboard-token"] || req.query?.token;
  if (!tokensMatch(given)) {
    await new Promise((r) => setTimeout(r, 400)); // blunt brute-force guessing
    return res.status(401).json({ ok: false, error: "Unauthorized." });
  }

  let rows;
  try {
    rows = await listSignups(5000);
  } catch (err) {
    console.error("[dashboard] could not load signups:", err && err.message);
    return res.status(500).json({ ok: false, error: "Could not load signups." });
  }

  if (req.query?.format === "csv") {
    const head = CSV_COLUMNS.map(([, label]) => label).join(",");
    const body = rows.map((r) => CSV_COLUMNS.map(([key]) => csvCell(r[key])).join(",")).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="infrastudio-waitlist.csv"');
    return res.status(200).send(head + "\n" + body + "\n");
  }

  return res.status(200).json({ ok: true, count: rows.length, rows });
};
