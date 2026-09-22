/**
 * InfraStudio — local dev server.
 *
 * Serves the static site and provides POST /api/waitlist, which appends
 * "Request Early Access" / "Become a Design Partner" submissions to
 * data/waitlist.csv. This is a stopgap for collecting real submissions
 * before a proper backend (and database) exists — swap this file for a
 * real API once one is built; the front end already POSTs JSON to
 * /api/waitlist, so only this handler needs to change.
 *
 * No dependencies — uses only Node's built-in http/fs/path modules.
 *
 * Usage:
 *   node server.js            # serves on http://localhost:3000
 *   PORT=8080 node server.js  # custom port
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const CSV_PATH = path.join(DATA_DIR, "waitlist.csv");
const PORT = process.env.PORT || 3000;

const CSV_COLUMNS = ["submittedAt", "type", "name", "email", "profession", "company", "notes"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function ensureCsvFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(CSV_PATH, CSV_COLUMNS.join(",") + "\n", "utf-8");
  }
}

function appendWaitlistEntry(entry) {
  ensureCsvFile();
  const row = CSV_COLUMNS.map((col) => csvEscape(entry[col])).join(",") + "\n";
  fs.appendFileSync(CSV_PATH, row, "utf-8");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function handleWaitlistSubmission(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy(); // guard against absurdly large payloads
  });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Invalid JSON body." }));
    }

    const name = String(payload.name || "").trim();
    const email = String(payload.email || "").trim();
    const profession = String(payload.profession || "").trim();

    if (!name || !isValidEmail(email) || !profession) {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ ok: false, error: "name, a valid email, and profession are required." })
      );
    }

    const entry = {
      submittedAt: payload.submittedAt || new Date().toISOString(),
      type: payload.type === "design-partner" ? "design-partner" : "early-access",
      name,
      email,
      profession,
      company: String(payload.company || "").trim(),
      notes: String(payload.notes || "").trim(),
    };

    try {
      appendWaitlistEntry(entry);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "Could not write to waitlist file." }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
}

function serveStaticFile(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(ROOT, relPath));

  // Prevent path traversal outside the site root.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/waitlist") {
    return handleWaitlistSubmission(req, res);
  }
  if (req.method === "GET") {
    return serveStaticFile(req, res);
  }
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("Method not allowed");
});

server.listen(PORT, () => {
  ensureCsvFile();
  console.log(`InfraStudio site running at http://localhost:${PORT}`);
  console.log(`Waitlist submissions are appended to ${path.relative(ROOT, CSV_PATH)}`);
});
