/**
 * "Ask the model": turns a question about a building model into a structured query.
 * The browser runs the query on the model's own measured data. This step only translates
 * the question. It never sees the model file and never runs anything. The browser checks
 * the reply against a fixed schema before using it.
 */
import { cleanJsonResponse } from "./shared.ts";
import { runAgyOneShot } from "./antigravity_agent.ts";

const SYSTEM = `You translate a question about a building model into a JSON query. Reply with ONE JSON object and nothing else.

Query shape:
{
  "filters": [ { "field": FIELD, "op": OP, "value": VALUE, "arg": ARG } ],
  "show": "count" | "list" | "sum" | "group",
  "measure": "area" | "volume" | "length" | "cost",     (only with show "sum", or "group" when totals are wanted)
  "groupBy": "class" | "storey" | "material",           (only with show "group")
  "having": { "op": "=" | ">" | "<" | ">=" | "<=", "value": NUMBER }   (only with show "group", filters groups by how many elements they hold)
}

FIELD and what it means:
- "class": IFC class. op "is". value like "IfcDoor", "IfcWall", "IfcWindow", "IfcColumn", "IfcBeam", "IfcSlab", "IfcStair", "IfcRoof", "IfcRailing", "IfcFurniture", "IfcCovering", "IfcCurtainWall", "IfcFooting", "IfcMember", "IfcPlate".
- "name": text inside the element name. op "contains".
- "storey": text inside the level name. op "contains".
- "material": text inside a material name. op "contains", or op "missing" for elements with no material.
- "prop": a property, arg is the property name (for example "FireRating"), op "contains" with a value, or "missing".
- "length", "thickness", "height" (metres), "area" (square metres), "volume" (cubic metres): numeric, ops ">", "<", ">=", "<=", "=".
- "near": elements that have a number of elements of another class within 0.6 m. arg is the other class, for example "IfcWindow". op is a number comparison and value is the count. "No window near it" is op "=" value 0.

Rules:
- Use only the fields above. Never invent a field.
- Use only level names, class names and material names that appear in the model summary when you can.
- A question about which levels have or lack something is show "group" with groupBy "storey", and having value 0 with op "=" for "lack".
- A question about how many is show "count". A request to list or show is show "list". A total is show "sum".
- If the question cannot be answered from element class, name, level, material, properties or size, reply {"unanswerable": "short reason in plain words"}.`;

export interface AskModelPayload {
  question: string;
  context?: {
    classes?: string[];
    storeys?: string[];
    materials?: string[];
    props?: string[];
  };
}

export async function runAskModel(payload: AskModelPayload): Promise<Record<string, unknown>> {
  const question = String(payload?.question ?? "").trim().slice(0, 400);
  if (!question) return { status: "error", error: "Ask a question first." };
  const ctx = payload.context ?? {};
  const list = (a?: string[], n = 60) => (Array.isArray(a) ? a.slice(0, n).map((x) => String(x).slice(0, 80)).join("; ") : "");
  const summary = `Model summary:
Classes present: ${list(ctx.classes)}
Levels: ${list(ctx.storeys)}
Materials: ${list(ctx.materials)}
Property names: ${list(ctx.props)}`;
  try {
    const raw = await runAgyOneShot(`${SYSTEM}\n\nDo NOT use any tools and do NOT create or edit any files. Answer with the JSON object only.\n\n${summary}\n\nQuestion: ${question}\n\nJSON:`, 75000);
    const parsed = cleanJsonResponse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.unanswerable === "string") return { status: "success", unanswerable: parsed.unanswerable.slice(0, 200) };
      return { status: "success", query: parsed };
    }
    return { status: "error", error: "I could not understand that question." };
  } catch (e: any) {
    return { status: "error", error: "I could not reach the question service. Try a simpler question, or try again." };
  }
}
