/**
 * Clarifying-questions step. Before an expensive build starts, decide whether
 * the brief is missing key design parameters and, if so, return a few short
 * follow-up questions (with sensible defaults) instead of guessing silently.
 * Turns a one-shot generator into a short design conversation.
 *
 * Fails OPEN everywhere: any model/parse error returns "no questions, build
 * with what we have" so this step can never block a build.
 */
import { cleanJsonResponse } from "./shared.ts";
import { runAgyOneShot } from "./antigravity_agent.ts";

export interface ClarifyQuestion {
  id: string;
  question: string;
  /** Short answers the user can tap/copy, e.g. ["1", "2-3", "4+"]. */
  options: string[];
  /** The assumption used if the user skips this question. */
  default: string;
}

export interface ClarifyResult {
  status: "success";
  needs_clarification: boolean;
  questions: ClarifyQuestion[];
  /** Assumptions that will be applied for anything left unanswered. */
  assumptions: string[];
  /** The brief to actually build from: original + answers + explicit defaults. */
  refined_brief: string;
  round: number;
}

/** Most rounds of questions before we stop asking and build. */
export const MAX_CLARIFY_ROUNDS = 2;

const CLARIFY_SYSTEM_PROMPT = `You are the intake architect for InfraStudio, an AI tool that generates detailed BIM/IFC models of buildings and infrastructure from a written brief. Your job is the conversation BEFORE the build: decide whether the brief is clear enough, and if not, ask a few short, relevant questions - like a senior architect taking a client brief.

Key parameters that matter for a building (ask ONLY about the ones that are missing AND would change the design, and only those relevant to this brief):
- number of storeys
- maximum height
- GFA (gross floor area) or footprint size
- FSR (floor space ratio) - only if a site/plot area or zoning context is mentioned or clearly relevant
- site context (urban/suburban/rural/waterfront/sloping, neighbours, orientation, plot size)
- construction typology / structural system (e.g. reinforced concrete frame, steel frame, timber, masonry)
- form: podium + tower, slab/bar, courtyard, or single-storey pavilion
- underground car park / basement (yes/no, rough capacity)
For infrastructure (bridge, cofferdam, retaining wall, tunnel, dam, ...) ask the equivalents instead: span/length/width, number of spans or piers, loads/traffic, ground and water conditions, material/structural form.

Rules:
1. NEVER ask about something the brief (or earlier answers) already states. Anything the user stated is binding and must appear unchanged in refined_brief.
2. If the brief is already specific enough to build well, or is a single element (a column, a wall, a door), set needs_clarification=false and ask nothing.
3. At most 4 questions, each short (under 15 words), each with 2-4 short "options" and a sensible "default" (what you would assume if skipped). Prefer the 3-4 questions that change the design the most.
4. Reference images: if images are attached they may already answer layout/form questions - ask fewer questions.
5. Only the questions are shown to the user; keep the tone plain and friendly, no jargon beyond the parameter names above.
6. When MODE is "finalize" you must NOT ask anything: set needs_clarification=false and questions=[]. Fold the user's answers into the brief and state explicit, sensible assumptions for every key parameter still missing.

Always produce refined_brief: a clean, complete build specification written from the user's own words + their answers, then a clearly separated "Assumed (not specified by the user)" list of defaults for the parameters still unspecified. Never contradict or silently change anything the user specified. Keep it under 250 words.

Respond with ONE JSON object only, no markdown:
{"needs_clarification": boolean,
 "questions": [{"id": "storeys", "question": "How many storeys?", "options": ["1","2-3","4+"], "default": "3 storeys"}],
 "assumptions": ["3 storeys", "reinforced concrete frame"],
 "refined_brief": "..."}`;

function failOpen(brief: string, answers: string, round: number): ClarifyResult {
  return {
    status: "success",
    needs_clarification: false,
    questions: [],
    assumptions: [],
    refined_brief: composeBrief(brief, answers),
    round,
  };
}

/** Original brief plus whatever the user answered, used when the model can't be reached. */
function composeBrief(brief: string, answers: string): string {
  const a = (answers || "").trim();
  return a ? `${brief.trim()}\n\nClarifications from the user:\n${a}` : brief.trim();
}

function cleanQuestions(raw: any): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarifyQuestion[] = [];
  for (const q of raw) {
    const question = typeof q?.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    out.push({
      id: typeof q?.id === "string" && q.id.trim() ? q.id.trim().slice(0, 40) : `q${out.length + 1}`,
      question: question.slice(0, 160),
      options: Array.isArray(q?.options) ? q.options.filter((o: any) => typeof o === "string" && o.trim()).map((o: string) => o.trim().slice(0, 40)).slice(0, 4) : [],
      default: typeof q?.default === "string" ? q.default.trim().slice(0, 120) : "",
    });
    if (out.length >= 4) break;
  }
  return out;
}

export async function runClarify(payload: any): Promise<ClarifyResult> {
  const plan = payload?.plan || {};
  const brief: string = typeof plan.client_requirements === "string" ? plan.client_requirements.trim() : "";
  const answers: string = typeof plan.answers === "string" ? plan.answers.trim() : "";
  const round: number = Number.isFinite(plan.round) ? Math.max(0, Math.floor(plan.round)) : 0;
  const skip = plan.skip === true;
  const hasImages = plan.has_images === true;
  const questionsAsked: ClarifyQuestion[] = Array.isArray(plan.questions_asked) ? plan.questions_asked : [];

  if (!brief) return failOpen("", answers, round);

  const finalize = skip || round >= MAX_CLARIFY_ROUNDS;
  const user = [
    `MODE: ${finalize ? "finalize" : "ask"}`,
    `ROUND: ${round} of ${MAX_CLARIFY_ROUNDS}`,
    `REFERENCE IMAGES ATTACHED: ${hasImages ? "yes" : "no"}`,
    `ORIGINAL BRIEF:\n${brief}`,
    questionsAsked.length ? `QUESTIONS ALREADY ASKED:\n${questionsAsked.map((q, i) => `${i + 1}. ${q?.question}`).join("\n")}` : "",
    answers ? `USER ANSWERS (free text, may answer some or all of the questions):\n${answers}` : "",
    skip ? "The user chose to SKIP the remaining questions: apply sensible defaults." : "",
  ].filter(Boolean).join("\n\n");

  try {
    // Tool-free one-shot to the on-box agy (Gemini). Do not use any tools or write files.
    const raw = await runAgyOneShot(`${CLARIFY_SYSTEM_PROMPT}

Do NOT use any tools and do NOT create or edit any files - answer directly with the JSON object only.

---
${user}`, 90000);
    const data = cleanJsonResponse(raw);
    const refined = typeof data?.refined_brief === "string" && data.refined_brief.trim() ? data.refined_brief.trim() : composeBrief(brief, answers);
    const questions = finalize ? [] : cleanQuestions(data?.questions);
    const needs = !finalize && data?.needs_clarification === true && questions.length > 0;
    return {
      status: "success",
      needs_clarification: needs,
      questions: needs ? questions : [],
      assumptions: Array.isArray(data?.assumptions) ? data.assumptions.filter((a: any) => typeof a === "string").slice(0, 10) : [],
      refined_brief: refined,
      round: needs ? round + 1 : round,
    };
  } catch (e: any) {
    console.warn(`[clarify] failing open (build proceeds without questions): ${e?.message || e}`);
    return failOpen(brief, answers, round);
  }
}
