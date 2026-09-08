
/// <reference types="jsr:@supabase/functions-js/edge-runtime.d.ts" />

export const LOCATION = "global";

/** Resolve per request so ECS migration errors cannot crash CORS preflight. */
export function getMcpUrl(): string {
  const configured = typeof Deno !== "undefined"
    ? Deno.env.get("MCP_URL")
    : process.env.MCP_URL;
  const url = configured?.trim();
  if (!url) {
    throw new Error("MCP_URL is not configured. Set it to the stable ECS MCP endpoint, including /mcp.");
  }
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
    return parsed.toString();
  } catch {
    throw new Error("MCP_URL must be a valid HTTP(S) URL ending in /mcp.");
  }
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const STATELESS_MCP_SESSION_ID = "stateless-mcp";

export function extractText(content: unknown): string | undefined {
  if (!content) return undefined;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (Array.isArray(item)) { const r = extractText(item); if (r) return r; }
      else if (typeof item === "object" && item !== null) {
        const o = item as Record<string, unknown>;
        if (typeof o.text === "string") return o.text;
      }
    }
  }
  return undefined;
}

export async function mcpPost(body: unknown, clientSessionId: string): Promise<{ data: unknown; session: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (clientSessionId) headers["mcp-session-id"] = clientSessionId;
  const res = await fetch(getMcpUrl(), {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const returnedSession = res.headers.get("mcp-session-id") || clientSessionId || STATELESS_MCP_SESSION_ID;
  const text = await res.text();
  if (text.trim().startsWith("data:")) {
    const l = text.split("\n").find(l => l.startsWith("data:"));
    const data = l ? JSON.parse(l.slice(5).trim()) : {};
    return { data, session: returnedSession };
  }
  try { return { data: JSON.parse(text), session: returnedSession }; } 
  catch { return { data: { raw: text }, session: returnedSession }; }
}

export async function mcpInit(clientSessionId: string): Promise<string> {
  const res1 = await mcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "infrastudio", version: "9.0" } }
  }, clientSessionId);
  const newSession = res1.session || STATELESS_MCP_SESSION_ID;
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, newSession).catch(() => {});
  return newSession;
}

export function sanitizePythonCode(code: string): string {
  if (!code || typeof code !== 'string') return code;
  const safeHeader = `
import math
import numpy as np
import trimesh

NaN = float('nan')
nan = float('nan')
null = None
true = True
false = False
Infinity = float('inf')
inf = float('inf')

try:
    _orig_apply_transform = trimesh.primitives.Primitive.apply_transform
    def _safe_apply_transform(self, matrix):
        try:
            return _orig_apply_transform(self, matrix)
        except Exception:
            mesh = self.to_mesh()
            mesh.apply_transform(matrix)
            return mesh
    trimesh.primitives.Primitive.apply_transform = _safe_apply_transform
except Exception:
    pass

try:
    _orig_creation_cylinder = trimesh.creation.cylinder
    def _safe_creation_cylinder(radius, height=None, sections=32, segment=None, transform=None):
        try:
            return _orig_creation_cylinder(radius=radius, height=height, sections=sections, segment=segment, transform=transform)
        except Exception:
            h = height if height is not None else 1.0
            mesh = trimesh.primitives.Cylinder(radius=radius, height=h, sections=sections).to_mesh()
            if transform is not None:
                mesh.apply_transform(transform)
            return mesh
    trimesh.creation.cylinder = _safe_creation_cylinder
except Exception:
    pass

try:
    import mathutils
except Exception:
    mathutils = None

def extrude_polygon_safe(poly, height=1.0):
    pts = None
    if hasattr(poly, 'exterior'):
        pts = list(poly.exterior.coords)[:-1]
    elif isinstance(poly, (list, tuple, np.ndarray)):
        pts = list(poly)
    else:
        try:
            pts = list(poly.vertices)
        except Exception:
            pts = list(poly)

    pts_2d = [[float(p[0]), float(p[1])] for p in pts]
    N = len(pts_2d)
    bottom_v = [[p[0], p[1], 0.0] for p in pts_2d]
    top_v = [[p[0], p[1], float(height)] for p in pts_2d]
    all_v = np.array(bottom_v + top_v, dtype=float)

    cap_tris = []
    if mathutils is not None and hasattr(mathutils, 'geometry'):
        try:
            cap_tris = mathutils.geometry.tessellate_polygon([pts_2d])
        except Exception:
            cap_tris = []
    if not cap_tris:
        for i in range(1, N - 1):
            cap_tris.append((0, i, i + 1))

    faces = []
    for (i, j, k) in cap_tris:
        faces.append([i, k, j])
    for (i, j, k) in cap_tris:
        faces.append([N + i, N + j, N + k])
    for i in range(N):
        nxt = (i + 1) % N
        faces.append([i, nxt, N + nxt])
        faces.append([i, N + nxt, N + i])

    m = trimesh.Trimesh(vertices=all_v, faces=np.array(faces, dtype=int), process=True)
    return m

try:
    trimesh.creation.extrude_polygon = extrude_polygon_safe
except Exception:
    pass

def InfraStudioHarness(ifc_file, storey=None):
    if storey is None:
        st = ifc_file.by_type("IfcBuildingStorey")
        storey = st[0] if st else None

    body_ctx = None
    try:
        contexts = ifc_file.by_type("IfcGeometricRepresentationSubContext")
        for ctx in contexts:
            if getattr(ctx, "ContextIdentifier", "") == "Body":
                body_ctx = ctx
                break
        if body_ctx is None:
            m_ctx = ifc_file.by_type("IfcGeometricRepresentationContext")
            mc = m_ctx[0] if m_ctx else ifc_file.create_entity("IfcGeometricRepresentationContext", ContextType="Model", CoordinateSpaceDimension=3, Precision=1e-5)
            body_ctx = ifc_file.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Body", ContextType="Model", TargetView="MODEL_VIEW", ParentContext=mc)
    except Exception:
        body_ctx = None

    elements = []
    styles = {}

    def create_box(extents=[1, 1, 1], pos=[0, 0, 0], rot_z_deg=0.0):
        m = trimesh.primitives.Box(extents=extents)
        if rot_z_deg != 0.0:
            rad = math.radians(rot_z_deg)
            R = trimesh.transformations.rotation_matrix(rad, [0, 0, 1])
            m.apply_transform(R)
        m.apply_translation(pos)
        return m

    def create_cylinder(radius=0.5, height=2.0, pos=[0, 0, 0], axis=[0, 0, 1], sections=32):
        m = trimesh.primitives.Cylinder(radius=radius, height=height, sections=sections)
        ax = np.array(axis, dtype=float)
        norm = np.linalg.norm(ax)
        if norm > 1e-6:
            ax = ax / norm
            z_ax = np.array([0, 0, 1], dtype=float)
            if not np.allclose(ax, z_ax):
                v = np.cross(z_ax, ax)
                c = np.dot(z_ax, ax)
                if np.allclose(c, -1.0):
                    R = trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0])
                else:
                    s = np.linalg.norm(v)
                    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
                    R_3x3 = np.eye(3) + vx + (vx @ vx) * ((1 - c) / (s * s))
                    R = np.eye(4)
                    R[:3, :3] = R_3x3
                m.apply_transform(R)
        m.apply_translation(pos)
        return m

    def create_pipe(outer_r=0.4, inner_r=0.35, height=2.0, pos=[0, 0, 0], axis=[0, 0, 1], sections=32):
        outer = trimesh.primitives.Cylinder(radius=outer_r, height=height, sections=sections)
        inner = trimesh.primitives.Cylinder(radius=inner_r, height=height + 0.02, sections=sections)
        try:
            m = outer.difference(inner)
        except Exception:
            m = outer
        ax = np.array(axis, dtype=float)
        norm = np.linalg.norm(ax)
        if norm > 1e-6:
            ax = ax / norm
            z_ax = np.array([0, 0, 1], dtype=float)
            if not np.allclose(ax, z_ax):
                v = np.cross(z_ax, ax)
                c = np.dot(z_ax, ax)
                if np.allclose(c, -1.0):
                    R = trimesh.transformations.rotation_matrix(math.pi, [1, 0, 0])
                else:
                    s = np.linalg.norm(v)
                    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
                    R_3x3 = np.eye(3) + vx + (vx @ vx) * ((1 - c) / (s * s))
                    R = np.eye(4)
                    R[:3, :3] = R_3x3
                m.apply_transform(R)
        m.apply_translation(pos)
        return m

    def create_corrugated_panel(width=2.4, height=12.0, depth=0.45, pitch=0.6, thickness=0.04, pos=[0, 0, 0], rot_z_deg=0.0):
        pts = []
        n_waves = max(2, int(width / pitch))
        for i in range(n_waves):
            x0 = i * pitch
            x1 = x0 + pitch * 0.25
            x2 = x0 + pitch * 0.50
            x3 = x0 + pitch * 0.75
            pts.extend([[x0, 0], [x1, depth], [x2, depth], [x3, 0]])
        pts.append([width, 0])
        polyline = np.array(pts)
        outward = []
        inward = []
        for p in polyline:
            outward.append([p[0], p[1] + thickness / 2])
            inward.append([p[0], p[1] - thickness / 2])
        poly2d = outward + inward[::-1]
        m = extrude_polygon_safe(poly2d, height=height)
        R_align = trimesh.transformations.rotation_matrix(math.pi / 2, [1, 0, 0])
        m.apply_transform(R_align)
        if rot_z_deg != 0.0:
            rad = math.radians(rot_z_deg)
            R_rot = trimesh.transformations.rotation_matrix(rad, [0, 0, 1])
            m.apply_transform(R_rot)
        m.apply_translation(pos)
        return m

    def create_cutwater_pier(length=12.0, width=4.0, height=8.0, nose_r=2.0, pos=[0, 0, 0], rot_z_deg=0.0):
        rect_len = max(0.1, length - 2.0 * nose_r)
        pts = []
        for deg in range(-90, 91, 10):
            rad = math.radians(deg)
            pts.append([rect_len / 2.0 + nose_r * math.cos(rad), nose_r * math.sin(rad)])
        for deg in range(90, 271, 10):
            rad = math.radians(deg)
            pts.append([-rect_len / 2.0 + nose_r * math.cos(rad), nose_r * math.sin(rad)])
        m = extrude_polygon_safe(pts, height=height)
        if rot_z_deg != 0.0:
            rad = math.radians(rot_z_deg)
            R = trimesh.transformations.rotation_matrix(rad, [0, 0, 1])
            m.apply_transform(R)
        m.apply_translation(pos)
        return m

    def create_i_beam(depth=0.6, flange_w=0.3, web_t=0.02, flange_t=0.03, length=10.0, pos=[0, 0, 0], rot_z_deg=0.0):
        d, b, tw, tf = depth, flange_w, web_t, flange_t
        pts = [
            [-b/2, -d/2], [b/2, -d/2], [b/2, -d/2 + tf], [tw/2, -d/2 + tf],
            [tw/2, d/2 - tf], [b/2, d/2 - tf], [b/2, d/2], [-b/2, d/2],
            [-b/2, d/2 - tf], [-tw/2, d/2 - tf], [-tw/2, -d/2 + tf], [-b/2, -d/2 + tf]
        ]
        m = extrude_polygon_safe(pts, height=length)
        R = trimesh.transformations.rotation_matrix(math.pi / 2, [0, 1, 0])
        m.apply_transform(R)
        if rot_z_deg != 0.0:
            rad = math.radians(rot_z_deg)
            R_rot = trimesh.transformations.rotation_matrix(rad, [0, 0, 1])
            m.apply_transform(R_rot)
        m.apply_translation(pos)
        return m

    def add_mesh_element(mesh, name, ifc_class="IfcBuildingElementProxy", mat_name="Structural Steel", rgb=(0.5, 0.5, 0.5), transparency=0.0):
        if not isinstance(mesh, trimesh.Trimesh) or len(mesh.faces) == 0:
            return None
        import ifcopenshell.api as api
        point_list = ifc_file.create_entity("IfcCartesianPointList3D", CoordList=mesh.vertices.tolist())
        faces_1based = (mesh.faces + 1).tolist()
        face_set = ifc_file.create_entity("IfcTriangulatedFaceSet", Coordinates=point_list, CoordIndex=faces_1based, Closed=True)
        rep = ifc_file.create_entity("IfcShapeRepresentation", ContextOfItems=body_ctx, RepresentationIdentifier="Body", RepresentationType="Tessellation", Items=[face_set])
        prod_shape = ifc_file.create_entity("IfcProductDefinitionShape", Representations=[rep])
        
        pt = ifc_file.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
        d_z = ifc_file.create_entity("IfcDirection", DirectionRatios=(0.0, 0.0, 1.0))
        d_x = ifc_file.create_entity("IfcDirection", DirectionRatios=(1.0, 0.0, 0.0))
        axis_place = ifc_file.create_entity("IfcAxis2Placement3D", Location=pt, Axis=d_z, RefDirection=d_x)
        local_place = ifc_file.create_entity("IfcLocalPlacement", RelativePlacement=axis_place)
        
        prod = api.run("root.create_entity", ifc_file, ifc_class=ifc_class, name=name)
        prod.Representation = prod_shape
        prod.ObjectPlacement = local_place
        
        key = f"{mat_name}_{rgb}_{transparency}"
        if key not in styles:
            mat = api.run("material.add_material", ifc_file, name=mat_name)
            style = api.run("style.add_style", ifc_file, name=f"Style_{mat_name}", ifc_class="IfcSurfaceStyle")
            c_rgb = ifc_file.create_entity("IfcColourRgb", Red=float(rgb[0]), Green=float(rgb[1]), Blue=float(rgb[2]))
            shading = ifc_file.create_entity("IfcSurfaceStyleShading", SurfaceColour=c_rgb, Transparency=float(transparency))
            style.Styles = [shading]
            try:
                api.run("style.assign_material_style", ifc_file, material=mat, style=style, context=body_ctx)
            except Exception:
                pass
            styles[key] = (mat, style)
        
        mat, style = styles[key]
        try:
            api.run("style.assign_representation_styles", ifc_file, shape_representation=rep, styles=[style])
        except Exception:
            pass
        
        elements.append((prod, mat))
        return prod

    def commit():
        if not elements:
            return 0
        import ifcopenshell.api as api
        prods = [p for p, _ in elements]
        if storey:
            try:
                api.run("aggregate.assign_object", ifc_file, relating_object=storey, products=prods)
            except Exception:
                pass
        by_mat = {}
        for p, m in elements:
            by_mat.setdefault(m, []).append(p)
        for m, ps in by_mat.items():
            try:
                api.run("material.assign_material", ifc_file, products=ps, material=m)
            except Exception:
                pass
        return len(prods)

    return type("InfraStudioHarnessInstance", (), {
        "create_box": staticmethod(create_box),
        "create_cylinder": staticmethod(create_cylinder),
        "create_pipe": staticmethod(create_pipe),
        "create_corrugated_panel": staticmethod(create_corrugated_panel),
        "create_cutwater_pier": staticmethod(create_cutwater_pier),
        "create_i_beam": staticmethod(create_i_beam),
        "add_mesh_element": staticmethod(add_mesh_element),
        "commit": staticmethod(commit)
    })()
`;
  const sanitized = code.replace(/\.is_empty/g, '.size == 0');
  return safeHeader + '\n' + sanitized;
}

export async function mcpCallTool(name: string, args: Record<string, unknown>, clientSessionId: string): Promise<{ resultText: string, session: string }> {
  if (args) {
    if (typeof args.trimesh_code === 'string') {
      args.trimesh_code = sanitizePythonCode(args.trimesh_code);
    }
    if (typeof args.code_str === 'string') {
      args.code_str = sanitizePythonCode(args.code_str);
    }
    if (typeof args.code === 'string' && (name.includes('code') || name.includes('ifc'))) {
      args.code = sanitizePythonCode(args.code);
    }
  }

  const res = await mcpPost({
    jsonrpc: "2.0", id: Date.now(), method: "tools/call",
    params: { name, arguments: args }
  }, clientSessionId);
  const payload = res.data as Record<string, unknown>;
  
  if (payload.error) {
    throw new Error(`Tool ${name} failed: ${JSON.stringify(payload.error)}`);
  }
  
  if (!payload.result && payload.raw) {
    throw new Error(`Tool ${name} returned invalid response from server: ${payload.raw}`);
  }
  
  const resultText = extractText((payload?.result as Record<string, unknown>)?.content) || JSON.stringify(payload?.result ?? "done");
  
  try {
    const parsed = JSON.parse(resultText);
    if (parsed && typeof parsed === "object") {
      if (parsed.success === false || parsed.error) {
        throw new Error(`Tool ${name} reported failure: ${parsed.error || JSON.stringify(parsed)}`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Tool ")) throw e;
  }
  
  return { resultText, session: res.session };
}

export async function fetchMcpTools(clientSessionId: string): Promise<{ tools: any[], session: string }> {
  const res = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, clientSessionId);
  const data = res.data as Record<string, unknown>;
  const tools = ((data?.result as any)?.tools || []) as any[];
  return {
    tools: tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: (t.description || "").slice(0, 256),
        parameters: t.inputSchema || { type: "object", properties: {} }
      }
    })),
    session: res.session
  };
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}
let cachedToken: { token: string; expiresAt: number } | null = null;
async function mintAccessToken(saJson: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) return cachedToken.token;
  const tokenUri = saJson.token_uri || "https://oauth2.googleapis.com/token";
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: saJson.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, exp: now + 3600, iat: now };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const rawKey = saJson.private_key || "";
  const privateKey = rawKey.split("\\n").join("\n");
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(sig))}`;
  const resp = await fetch(tokenUri, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!resp.ok) throw new Error(`Failed to mint GCP access token: ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

export function getExplabsApiKey(): string | undefined {
  return typeof Deno !== "undefined"
    ? Deno.env.get("EXPLABS_API_KEY")
    : process.env.EXPLABS_API_KEY;
}

export async function callAstra(
  systemPrompt: string,
  userMessage: string | any[],
  jsonMode: boolean = false,
  model: string = "gpt-6-astra"
): Promise<string> {
  const key = getExplabsApiKey();
  if (!key) throw new Error("EXPLABS_API_KEY is not configured.");

  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage) && userMessage.length > 0) {
    msgs = msgs.concat(userMessage.map((m: any) => ({ role: m.role || "user", content: m.content || "" })));
  } else if (!Array.isArray(userMessage) && userMessage && String(userMessage).trim().length > 0) {
    msgs.push({ role: "user", content: String(userMessage) });
  } else {
    msgs.push({ role: "user", content: "Process according to system instructions." });
  }

  const payload: any = {
    model: model || "gpt-6-astra",
    messages: msgs
  };
  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const res = await fetch("https://api.experientiallabs.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`[Experiential Labs Astra ${res.status}]: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callGemini(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "gemini-3.6-flash"): Promise<string> {
  const explabsKey = getExplabsApiKey();
  if (explabsKey) {
    try {
      return await callAstra(systemPrompt, userMessage, jsonMode, "gpt-6-astra");
    } catch (err) {
      console.warn("[callGemini] Fallback from Astra error:", err);
    }
  }

  const saRaw = typeof Deno !== "undefined" ? Deno.env.get("GCP_SERVICE_ACCOUNT_JSON") : process.env.GCP_SERVICE_ACCOUNT_JSON;
  const geminiKey = typeof Deno !== "undefined" ? Deno.env.get("GEMINI_API_KEY") : process.env.GEMINI_API_KEY;

  const targetModel = model.includes("gemini") ? model : "gemini-3.6-flash";
  const promptText = typeof userMessage === "string" 
    ? userMessage 
    : (Array.isArray(userMessage) ? userMessage.map(m => `${m.role}: ${m.content}`).join("\n") : String(userMessage));

  // 1. If GCP Service Account JSON is provided, authenticate via Vertex AI
  if (saRaw) {
    try {
      let saJson: any = {};
      try {
        saJson = JSON.parse(saRaw);
      } catch {
        const decoded = typeof atob !== "undefined" ? atob(saRaw) : Buffer.from(saRaw, "base64").toString("utf-8");
        saJson = JSON.parse(decoded);
      }

      const accessToken = await mintAccessToken(saJson);
      const projectId = saJson.project_id || "gemini-app-sa-495716";
      // gemini-3.6-flash is only available on the global endpoint
      const location = "global";
      const host = "aiplatform.googleapis.com";

      const url = `https://${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${targetModel}:generateContent`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUSER REQUEST:\n${promptText}` }] }],
          generationConfig: {
            maxOutputTokens: 16384,
            responseMimeType: jsonMode ? "application/json" : "text/plain"
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`[Vertex AI ${targetModel} Error ${res.status}]: ${errText}`);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (!text) throw new Error(`Empty response from Vertex AI ${targetModel}`);
      return text;
    } catch (e) {
      // Re-throw so the caller sees the real error instead of silently falling back
      throw new Error(`[callGemini Vertex] ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. If GEMINI_API_KEY is provided, use Google AI Studio endpoint
  if (geminiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${geminiKey}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60000),
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nUSER REQUEST:\n${promptText}` }] }],
          generationConfig: {
            maxOutputTokens: 8192,
            responseMimeType: jsonMode ? "application/json" : "text/plain"
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (text) return text;
      } else {
        console.warn(`[callGemini] AI Studio API key ${targetModel} failed (${res.status}): ${await res.text()}`);
      }
    } catch (e) {
      console.warn("[callGemini] AI Studio API key call failed:", e);
    }
  }

  // 3. Fallback to callQwen qwen3.7-plus if no GCP/Gemini key is configured or working
  return callQwen(systemPrompt, userMessage, jsonMode, "qwen3.7-plus");
}

function getTargetModel(model: string): string {
  if (model === "qwen3.8-max" || model === "qwen3.8-max-preview") {
    // The current Model Studio quota is attached to qwen3.8-max. The preview
    // alias can be entitlement/plan-specific and is not interchangeable.
    return "qwen3.8-max";
  }
  if (model === "qwen-max" || !model || model === "glm-5.1") {
    return "qwen-max";
  }
  if (model === "kimi-k2.7-code") {
    return "qwen-max";
  }
  if (model === "qwen3.7-plus" || model === "qwen-plus") {
    return "qwen-plus";
  }
  return model;
}

function getQwenEndpoints(): string[] {
  const proxy = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (proxy?.trim()) return [proxy.trim().replace(/\/+$/, "")];
  const configured = typeof Deno !== "undefined"
    ? Deno.env.get("QWEN_BASE_URL")
    : process.env.QWEN_BASE_URL;
  const base = configured?.trim().replace(/\/+$/, "");
  if (base) return [`${base}/chat/completions`];
  return [
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"
  ];
}

export async function callQwen(systemPrompt: string, userMessage: string | any[], jsonMode: boolean = false, model: string = "glm-5.1"): Promise<string> {
  const explabsKey = getExplabsApiKey();
  if (explabsKey) {
    try {
      return await callAstra(systemPrompt, userMessage, jsonMode, "gpt-6-astra");
    } catch (err) {
      console.warn("[callQwen] Fallback from Astra error:", err);
    }
  }

  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  let msgs: any[] = [{ role: "system", content: systemPrompt }];
  if (Array.isArray(userMessage)) {
    msgs = msgs.concat(userMessage.map(m => ({ role: m.role, content: m.content || "" })));
  } else {
    msgs.push({ role: "user", content: userMessage });
  }

  const targetModel = getTargetModel(model);
  let lastError: any = null;

  const endpoints = getQwenEndpoints();
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;

  for (const endpoint of endpoints) {
    try {
      console.log(`[callQwen] Invoking ${targetModel} via ${endpoint}...`);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: endpoints[0].includes("functions/v1/qwen-proxy")
          ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
          : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(140000), // stay below the Supabase proxy wall-clock limit
        body: JSON.stringify({
          model: targetModel,
          messages: msgs,
          temperature: targetModel === "qwen3.8-max" ? 0.6 : 0.1,
          reasoning_effort: targetModel === "qwen3.8-max" ? "medium" : undefined,
          max_tokens: 4096,
          response_format: jsonMode ? { type: "json_object" } : undefined
        })
      });
      
      if (!res.ok) {
        const errText = await res.text();
        console.warn(`[callQwen] Endpoint ${endpoint} returned ${res.status}: ${errText.slice(0, 150)}`);
        lastError = new Error(`Qwen Error (${res.status}): ${errText}`);
        continue;
      }
      
      const data = await res.json();
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") {
        console.warn(`[callQwen] WARNING: ${targetModel} output was truncated (finish_reason=length).`);
      }
      return choice?.message?.content || "";
    } catch (err: any) {
      lastError = err;
      console.warn(`[callQwen] Endpoint ${endpoint} for ${targetModel} failed:`, err.message || err);
    }
  }

  throw new Error(`callQwen failed for ${targetModel}: ${lastError?.message || String(lastError)}`);
}

export async function callGLM(systemPrompt: string, userMessage: string, tools?: any[], model: string = "qwen3.8-max"): Promise<any> {
  const explabsKey = getExplabsApiKey();
  if (explabsKey) {
    try {
      const msgs = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ];
      const payload: any = {
        model: "gpt-6-astra",
        messages: msgs
      };
      if (tools && tools.length > 0) {
        payload.tools = tools;
      }
      const res = await fetch("https://api.experientiallabs.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${explabsKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        return data.choices?.[0]?.message;
      }
      console.warn(`[callGLM Astra] ${res.status}: ${await res.text()}`);
    } catch (err) {
      console.warn("[callGLM Astra] Fallback on error:", err);
    }
  }

  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  const targetModel = getTargetModel(model);
  const endpoints = getQwenEndpoints();
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;

  let lastErrText = "";
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: endpoints[0].includes("functions/v1/qwen-proxy")
          ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
          : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: targetModel,
          messages: msgs,
          tools: (tools && tools.length > 0) ? tools : undefined,
          temperature: targetModel === "qwen3.8-max" ? 0.6 : 0.1,
          reasoning_effort: targetModel === "qwen3.8-max" ? "medium" : undefined,
          max_tokens: 4096
        })
      });

      if (res.ok) {
        const data = await res.json();
        return data.choices[0].message;
      }

      lastErrText = await res.text();
      console.warn(`[callGLM] ${endpoint} returned (${res.status}): ${lastErrText}`);
    } catch (e: any) {
      lastErrText = e.message || String(e);
    }
  }

  throw new Error(`BIM Model Error (${targetModel}): ${lastErrText}`);
}

export async function callGLMStream(systemPrompt: string, userMessage: string, model: string = "glm-5.1"): Promise<ReadableStream<Uint8Array>> {
  const qwenKey = typeof Deno !== "undefined" ? Deno.env.get("QWEN_API_KEY") : process.env.QWEN_API_KEY;
  const proxyUrl = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_URL") : process.env.SUPABASE_QWEN_PROXY_URL;
  if (!qwenKey && !proxyUrl) throw new Error("QWEN_API_KEY or SUPABASE_QWEN_PROXY_URL missing");
  const msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];
  const targetModel = getTargetModel(model);
  const streamEndpoint = getQwenEndpoints()[0];
  const proxyToken = typeof Deno !== "undefined" ? Deno.env.get("SUPABASE_QWEN_PROXY_TOKEN") : process.env.SUPABASE_QWEN_PROXY_TOKEN;
  const res = await fetch(streamEndpoint, {
    method: "POST",
    headers: streamEndpoint.includes("functions/v1/qwen-proxy")
      ? { "x-internal-token": proxyToken || "", "Content-Type": "application/json" }
      : { "Authorization": `Bearer ${qwenKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: targetModel,
      messages: msgs,
      temperature: 0.1,
      max_tokens: 16384,
      stream: true
    })
  });
  if (!res.ok) {
    if (targetModel === "qwen-max") {
      return await callGLMStream(systemPrompt, userMessage, "qwen-flash");
    }
    throw new Error(`GLM Stream Error: ${await res.text()}`);
  }
  if (!res.body) throw new Error("No response body from GLM Stream");
  return res.body;
}


function autoRepairTruncatedJson(jsonStr: string): string {
  let str = jsonStr.trim();

  // Strip incomplete trailing key/value fragments
  str = str.replace(/,\s*"[^"]*"?\s*:\s*[^,\}\]]*$/, '');
  str = str.replace(/,\s*"[^"]*$/, '');
  str = str.replace(/,\s*$/, '');

  let inString = false;
  let escape = false;
  const stack: string[] = [];

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === char) {
          stack.pop();
        }
      }
    }
  }

  if (inString) {
    str += '"';
  }

  str = str.replace(/,\s*$/, '');

  while (stack.length > 0) {
    str += stack.pop();
  }

  return str;
}

export function cleanJsonResponse(rawStr: string): any {
  let clean = rawStr.trim();
  
  if (clean.includes("```")) {
    const startIdx = clean.indexOf("```");
    if (startIdx !== -1) {
      const newlineIdx = clean.indexOf("\n", startIdx);
      const contentStart = newlineIdx !== -1 ? newlineIdx + 1 : startIdx + 3;
      const endIdx = clean.indexOf("```", contentStart);
      if (endIdx !== -1) {
        clean = clean.substring(contentStart, endIdx);
      } else {
        clean = clean.substring(contentStart);
      }
    }
  }
  
  clean = clean.trim();
  const firstBrace = clean.indexOf('{');
  if (firstBrace !== -1) {
    clean = clean.substring(firstBrace);
  }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace > 0) {
    const candidate = clean.substring(0, lastBrace + 1);
    try {
      return JSON.parse(candidate.replace(/,\s*([\}])\}/g, '$1}'));
    } catch { /* fall through to repair */ }
  }

  // Strip trailing commas before closing brackets or braces
  clean = clean.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(clean);
  } catch (_err) {
    const repaired = autoRepairTruncatedJson(clean);
    try {
      return JSON.parse(repaired);
    } catch (_err2) {
      const sanitized = repaired.replace(/[\u0000-\u001F]+/g, " ");
      return JSON.parse(sanitized);
    }
  }
}
