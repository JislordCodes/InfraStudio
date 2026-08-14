const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...cors, "Content-Type": "application/json" } });
  const expected = Deno.env.get("QWEN_PROXY_TOKEN");
  if (!expected || req.headers.get("x-internal-token") !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
  }
  const key = Deno.env.get("QWEN_API_KEY");
  const base = (Deno.env.get("QWEN_BASE_URL") || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  if (!key) return new Response(JSON.stringify({ error: "QWEN_API_KEY is not configured" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const body = await req.json();
    const upstream = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
