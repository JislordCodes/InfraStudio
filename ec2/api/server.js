// Runs the InfraStudio backend bundle (aws-lambda/dist/index.js) as a plain HTTP service on the
// build box. It turns each HTTP request into the same Function-URL-style event the Lambda
// handler expects, so the exact same code runs here and on Lambda.
//
// CORS: the Lambda Function URL used to add the CORS headers (the handler deliberately does not),
// so this wrapper adds one set itself.
const http = require("http");
const { handler } = require("./index.js");

const PORT = Number(process.env.API_PORT || 8080);
const HOST = process.env.API_HOST || "127.0.0.1";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const url = new URL(req.url, "http://localhost");
    const body = Buffer.concat(chunks).toString("utf8");
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const event = {
      rawPath: url.pathname,
      rawQueryString: url.search.replace(/^\?/, ""),
      headers: req.headers,
      body: body || undefined,
      isBase64Encoded: false,
      requestContext: { http: { method: req.method, sourceIp: forwarded || req.socket.remoteAddress || "" } },
    };
    try {
      const out = await handler(event, {});
      const headers = { ...(out.headers || {}), ...CORS };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type") && out.body) {
        headers["content-type"] = "application/json";
      }
      res.writeHead(out.statusCode || 200, headers);
      res.end(out.isBase64Encoded ? Buffer.from(out.body || "", "base64") : out.body || "");
    } catch (err) {
      console.error("handler error:", err);
      res.writeHead(500, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ error: String((err && err.message) || err) }));
    }
  });
});

// A build request can legitimately run for a long time (the Lambda ceiling was 900 s).
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(PORT, HOST, () => console.log(`InfraStudio API listening on ${HOST}:${PORT}`));
