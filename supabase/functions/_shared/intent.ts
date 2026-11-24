// Tells a question from a request to change or build the model. A question
// must be answered in chat and never start a build.

const ACTION_VERBS =
  "add|build|create|make|change|move|remove|delete|resize|replace|rotate|extend|raise|lower|widen|narrow|paint|colou?r|set|put|insert|modify|edit|increase|decrease|extrude|design|generate|draw|place|turn|convert|update|fix|redo|rebuild|expand|shrink|enlarge|shift|swap|join|split|duplicate|copy|clear|reset|start|finish|complete|continue|apply|rename|cut|trim|stretch|lengthen|shorten|thicken|heighten|elevate|fill|cover|connect|attach|align|mirror|scale|tilt|flip|merge";

const POLITE_PREFIX =
  "(?:(?:please|kindly|pls|ok|okay|hey|now|then|also|and)[ ,]+)*(?:(?:can|could|would|will) (?:you|u)(?: please)?|i (?:want|need|would like|'d like|wanna) (?:you )?to|i want|i need|let'?s|let us|go ahead and|try to|you should|you must|just)?[ ,]*";

const ACTION_START = new RegExp(`^${POLITE_PREFIX}(?:${ACTION_VERBS})\\b`, "i");

const QUESTION_START =
  /^(?:(?:please|pls|ok|okay|hey|so|and|but)[ ,]+)*(?:what|whats|what's|why|how|which|who|whom|whose|when|where|is|are|was|were|does|do|did|has|have|had|should|shall|can|could|would|will|may|might|explain|describe|tell me|let me know|i wonder|any idea|do you know)\b/i;

export type Intent = "question" | "action";

export function classifyIntent(text: string): Intent {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "action";
  // "Can you add a door?" and "please make it taller" are requests, even with
  // a question mark or a polite question form.
  if (ACTION_START.test(t)) return "action";
  if (QUESTION_START.test(t)) return "question";
  if (/\?\s*$/.test(t)) return "question";
  // Questions that do not start with a question word, such as
  // "in real life how much do you think it would cost".
  if (/\b(how (?:much|many|long|big|tall|wide|far|old|heavy|expensive)|do you think|would it cost|will it cost|what do you think|is it possible|is there|are there)\b/i.test(t)) return "question";
  return "action";
}

export const QUESTION_SYSTEM_PROMPT = `You are the InfraStudio assistant, chatting with someone who is building an IFC model of a building or structure.
The user asked a question. Answer it. Do not build or change anything, and do not offer to build unless they ask.

Rules:
 * Use the conversation history for what was built or discussed.
 * When a MODEL DATA block follows, it was measured from the user's open IFC model. Answer from it: use its exact counts, sizes, IFC entity names (IfcWall, IfcSlab and so on), materials, property sets and storeys. Never say you cannot see the model. Say plainly when something is not in the data, for example that no materials are assigned.
 * For cost questions with MODEL DATA, give the model's estimated cost and cost per m2 from the data, say it uses indicative unit rates, and note that real cost depends on country, year, finishes and market. Add a typical real-world range per m2 for this building type as context.
 * When there is no MODEL DATA block, you cannot see the model's measurements. For counts, areas, lengths, costs and code checks, tell the user to open Quantities and cost or Ask the model in the Studio dock under the viewer. Never invent numbers about their model.
 * For general design, engineering or BIM questions, answer from your own knowledge.
 * Keep it short and plain: a few sentences. No headings, no emoji, no marketing language.
 * If the user also seems to want a change, say which change you understood and tell them to ask for it as an instruction, for example "make the roof flat".`;
