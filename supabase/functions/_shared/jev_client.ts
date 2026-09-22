/**
 * Client for TypeSafe's Jev (System One) API — a typed-decision model, not a
 * chat model. You send it `state` plus one or more typed `questions` and get
 * back structured answers (a choice, a score, or a 0-1 yes/no) in a couple
 * hundred milliseconds, instead of a paragraph of prose to parse.
 *
 * This is NOT a replacement for Antigravity anywhere in this pipeline — Jev
 * cannot generate IFC code or design a building, and it's text-only (no
 * images). It's used as a fast, cheap gate around the expensive steps:
 * rejecting junk prompts before a 30-minute build starts, and turning a raw
 * geometric clash list into a short, actionable one before Antigravity (or
 * the user) has to look at it. See docs.typesafe.ai for the underlying model.
 *
 * Plain fetch, no SDK dependency — this file gets bundled by BOTH the Deno
 * Supabase runtime and esbuild for the Lambda (see infrastudio-deploy-path:
 * the Lambda bundle is what actually ships), and adding an npm package here
 * risks repeating the exact dual-runtime bundling breakage @aws-sdk/client-ssm
 * caused, for very little benefit over a single fetch call.
 */

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

function getJevApiKey(): string | undefined {
  const key = typeof Deno !== "undefined" ? Deno.env.get("JEV_API_KEY") : process.env.JEV_API_KEY;
  return key?.trim() || undefined;
}

/** True once JEV_API_KEY is configured. Every call site checks this first and
 *  no-ops (falls back to its non-Jev behaviour) when it's false, so Jev is
 *  strictly additive - the pipeline works identically without a key set. */
export function jevEnabled(): boolean {
  return !!getJevApiKey();
}

export type JevState = string | number | boolean | null | JevState[] | { [key: string]: JevState };

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** option name -> what that option means, e.g. { billing: "...", technical: "..." } */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** ordered rubric levels, low to high, e.g. ["Calm", "Frustrated", "Very angry"] */
  criteria: string[];
}

export type JevQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer { type: "noul"; noul: number; }
export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number; }
export interface ScoreAnswer { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number; }
export type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

interface JevHttpResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export class JevError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

/**
 * Ask any mix of Noul/Choice/Score questions against one shared `state` in a
 * single round trip - questions are evaluated in parallel server-side, so
 * asking five instead of one barely changes latency. Throws JevError on
 * anything but a 200; callers decide whether that's fatal (see jevSafe below
 * for the common "never let a Jev outage break the real pipeline" case).
 */
export async function jevAsk<Q extends Record<string, JevQuestion>>(
  state: JevState,
  questions: Q,
  timeoutMs = 5000,
): Promise<{ [K in keyof Q]: JevAnswer }> {
  const apiKey = getJevApiKey();
  if (!apiKey) throw new JevError("JEV_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new JevError(`Jev API returned ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    const parsed = JSON.parse(text) as JevHttpResponse;
    return parsed.answers as { [K in keyof Q]: JevAnswer };
  } catch (e) {
    if (e instanceof JevError) throw e;
    if (e instanceof Error && e.name === "AbortError") {
      throw new JevError(`Jev request timed out after ${timeoutMs}ms`);
    }
    throw new JevError(`Jev request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same as jevAsk, but never throws - logs and returns null instead. Every
 * production call site in this pipeline should go through this, not jevAsk
 * directly: Jev is a quality gate, not a dependency the build should ever
 * fail on. A TypeSafe outage must degrade to "Jev step skipped", never to a
 * broken build.
 */
export async function jevSafe<Q extends Record<string, JevQuestion>>(
  state: JevState,
  questions: Q,
  timeoutMs = 5000,
): Promise<{ [K in keyof Q]: JevAnswer } | null> {
  if (!jevEnabled()) return null;
  try {
    return await jevAsk(state, questions, timeoutMs);
  } catch (e) {
    console.warn(`[jev] call failed, continuing without it: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
