/**
 * Parallel ("fast") builds: one design is split into 2-3 sections that are built
 * AT THE SAME TIME, each by its own agent on its own build slot (own empty IFC
 * scene), from one shared spec so the parts line up; the finished parts are then
 * merged into a single IFC (see antigravity_agent.ts startMergeJob).
 *
 * Only used when at least two slots are free, and every failure before the
 * sections start falls back to the normal single-slot build, so enabling this
 * can never make a build impossible - only (usually) faster.
 *
 * Continuation (carried by the frontend between polls):
 *   { kind: "parallel", phase: "sections", jobId, sections: [{ name, jobId, ssmCommandId, done?, url?, count?, error? }] }
 *   { kind: "parallel", phase: "merge", jobId, ssmCommandId, parts: n }
 */
import { runAgyOneShot, startAntigravityBuild, startMergeJob, pollAntigravityBuild, countFreeSlots, type ReferenceImage } from "./antigravity_agent.ts";
import { cleanJsonResponse } from "./shared.ts";
import { SPEC_PRIORITY_RULE } from "./spec_priority.ts";

export interface SectionPlan {
  name: string;
  scope: string;
}

export interface ParallelPlan {
  shared_spec: string;
  sections: SectionPlan[];
}

const PLANNER_PROMPT = `You are the lead architect/engineer splitting ONE design brief into independent sections that separate agents will build AT THE SAME TIME in separate empty IFC models, which are then merged. Because the agents cannot see each other's work, the parts only line up if you fix the shared geometry up front.

Produce:
1. "shared_spec": a precise, binding specification every section must follow, written as plain text. It MUST fix: the overall dimensions and footprint with the origin (0,0,0) at a stated corner/point and axis directions; the structural grid (spacings); the exact list of building storeys / levels as "<Name> at elevation <m>" (use simple names like "Level 0", "Level 1", "Roof"; for infrastructure use equivalent named reference levels); key heights, spans and thicknesses; the shared material/colour palette. Invent every value the client did not give, plausibly and completely. Anything the client DID state is binding and must be copied unchanged.
2. "sections": exactly N sections (N is given below). Split by independent PART or DISCIPLINE (for example: structure and foundations / envelope, roof and openings / interior, partitions, stairs and fit-out; for infrastructure: substructure / superstructure / ancillary), so that no element is built by two sections and together they make the complete design. Each section has a short "name" and a "scope" (one or two sentences listing exactly what it builds and what it must NOT build).

Respond with ONE JSON object only, no markdown:
{"shared_spec": "...", "sections": [{"name": "Structure", "scope": "..."}, {"name": "Envelope", "scope": "..."}]}`;

/** Asks the on-box agy to split the brief. Returns null on any failure (caller falls back to a single build). */
export async function planSections(brief: string, n: number): Promise<ParallelPlan | null> {
  try {
    const raw = await runAgyOneShot(
      `${PLANNER_PROMPT}\n\nDo NOT use any tools and do NOT create or edit any files - answer directly with the JSON object only.\n\n---\nN = ${n}\n\nCLIENT BRIEF:\n${brief}`,
      100000,
    );
    const data = cleanJsonResponse(raw);
    const spec = typeof data?.shared_spec === "string" ? data.shared_spec.trim() : "";
    const sections: SectionPlan[] = Array.isArray(data?.sections)
      ? data.sections
          .filter((s: any) => s && typeof s.name === "string" && typeof s.scope === "string" && s.name.trim() && s.scope.trim())
          .map((s: any) => ({ name: s.name.trim().slice(0, 40), scope: s.scope.trim().slice(0, 600) }))
      : [];
    if (spec.length < 80 || sections.length < 2) return null;
    return { shared_spec: spec.slice(0, 6000), sections: sections.slice(0, n) };
  } catch (e: any) {
    console.warn(`[parallel] planning failed, falling back to a single build: ${e?.message || e}`);
    return null;
  }
}

export function buildSectionBrief(opts: {
  userBrief: string;
  plan: ParallelPlan;
  index: number;
  imageSection: string;
  useSubagents: boolean;
}): string {
  const { userBrief, plan, index, imageSection, useSubagents } = opts;
  const mine = plan.sections[index];
  const others = plan.sections.filter((_, i) => i !== index).map((s) => `- ${s.name}: ${s.scope}`).join("\n");
  const subagentBlock = useSubagents
    ? `\n\nSUBAGENTS (optional, for speed): if YOUR section has clearly independent groups of elements (for example separate floors, wings or element families), you may start subagents with invoke_subagent so they build those groups at the same time. Give each subagent a disjoint set of elements (and distinct element names), tell it to use the shared spec above, and wait for ALL subagents to finish and report before you verify and export. All of you share the same scene, so never ask two agents to modify the same element. If in doubt, build it yourself.`
    : "";
  return `You are building ONE SECTION of a larger model. Other agents are building the other sections AT THE SAME TIME in their own separate scenes from the same shared specification; afterwards all sections are merged into one IFC. You cannot see their work, so precision on the shared spec is everything.

YOUR SECTION: ${mine.name}
${mine.scope}

OTHER SECTIONS (do NOT build any of this):
${others}

${SPEC_PRIORITY_RULE}

SHARED SPECIFICATION (binding for every section - use these exact coordinates, grid, levels and names):
${plan.shared_spec}

IMPORTANT tool-usage rule: you have direct MCP tool-calling access to functions like create_wall, build_room, create_slab, create_stairs, create_storey, create_trimesh_ifc, create_mesh_ifc, execute_ifc_code_tool, create_surface_style, apply_style_to_object, get_scene_info, export_ifc, etc. Always call these as native tool calls; never use bash/curl to talk to the MCP server.

IMPORTANT section rules (non-negotiable):
- First call initialize_project. Then create EVERY building storey/level from the shared specification with create_storey, using exactly the names and elevations given (even if your section only uses some of them) - the merge matches sections by storey name.
- Build ONLY your section's scope, at exactly the shared coordinates, so it lines up with the others. Do not build anything listed under the other sections, and do not add a surrounding building, site or extra elements of your own.
- Place every element in the correct storey. Give every element a real material/surface style (create_surface_style / apply_style_to_object) with realistic colours. Where the user asked for something explicit (e.g. transparent glass) it must actually be realised.
- Build your section with real detail and a sensible number of elements for ITS scope - do not pad it. There is no clash check against the other sections.
- execute_ifc_code_tool has a hard 60-second timeout per call: split large work into several calls and assign new elements to the storey with ONE spatial.assign_container call per batch, not one per element.
- Before exporting, call get_scene_info and check that your section is complete, styled, and matches the shared spec.${subagentBlock}

The full client brief, for context (your section is only part of it):
${userBrief}${imageSection}

When finished: call get_scene_info to confirm, then call export_ifc.`;
}

export interface SectionState {
  name: string;
  jobId: string;
  ssmCommandId: string;
  done?: boolean;
  url?: string;
  count?: number;
  error?: string;
}

/** Result shape shared with agent-bim's handler. */
export type ParallelStep =
  | { status: "continue"; continuation: any; progress: string; mcpSessionId: string }
  | { status: "success"; ifc_url: string; element_count?: number; file_size?: number; mcpSessionId: string }
  | { status: "error"; error: string; mcpSessionId?: string };

/**
 * Tries to start a parallel build. Returns null when it shouldn't or can't
 * (fewer than 2 free slots, planning failed, a section failed to start) - the
 * caller then runs the normal single-slot build.
 */
export async function startParallelBuild(opts: {
  jobId: string;
  userBrief: string;
  images: ReferenceImage[];
  imageSection: string;
  useSubagents: boolean;
}): Promise<ParallelStep | null> {
  const free = await countFreeSlots();
  console.log(`[parallel] free slots: ${free}`);
  if (free < 2) return null;
  const n = Math.min(3, free);

  const plan = await planSections(opts.userBrief, n);
  if (!plan) return null;
  console.log(`[parallel] plan: ${plan.sections.map((s) => s.name).join(" | ")}`);

  const sections: SectionState[] = [];
  try {
    for (let i = 0; i < plan.sections.length; i++) {
      const secJob = `${opts.jobId}-s${i + 1}`;
      const brief = buildSectionBrief({ userBrief: opts.userBrief, plan, index: i, imageSection: opts.imageSection, useSubagents: opts.useSubagents });
      const cmd = await startAntigravityBuild(brief, secJob, opts.images);
      sections.push({ name: plan.sections[i].name, jobId: secJob, ssmCommandId: cmd });
    }
  } catch (e: any) {
    console.warn(`[parallel] could not start all sections (${e?.message || e}); falling back to a single build`);
    // Sections already started will finish on their own; their results are simply unused.
    return null;
  }
  return {
    status: "continue",
    continuation: { kind: "parallel", phase: "sections", jobId: opts.jobId, sections },
    progress: `Building ${sections.length} parts in parallel: ${sections.map((s) => s.name).join(", ")}...`,
    mcpSessionId: opts.jobId,
  };
}

function sectionLine(s: SectionState, live: { [jobId: string]: { count?: number; queue?: number } }): string {
  if (s.error) return `${s.name} ✗`;
  if (s.done) return `${s.name} ✓${typeof s.count === "number" ? ` (${s.count.toLocaleString()})` : ""}`;
  const l = live[s.jobId];
  if (l?.queue) return `${s.name} queued`;
  return `${s.name}${typeof l?.count === "number" && l.count > 0 ? ` ${l.count.toLocaleString()}` : ""}`;
}

/** One poll of a parallel build (called from agent-bim for continuation.kind === "parallel"). */
export async function pollParallelBuild(continuation: any): Promise<ParallelStep> {
  const jobId: string = continuation.jobId;

  if (continuation.phase === "merge") {
    const r = await pollAntigravityBuild(continuation.ssmCommandId, jobId);
    if (!r.done) {
      return { status: "continue", continuation, progress: `Merging ${continuation.parts} parts into one model...`, mcpSessionId: jobId };
    }
    if (r.error || !r.ifcUrl) return { status: "error", error: `Merging the parts failed: ${r.error || "no model produced"}`, mcpSessionId: jobId };
    return { status: "success", ifc_url: r.ifcUrl, element_count: r.elementCount, file_size: r.fileSize, mcpSessionId: jobId };
  }

  // phase: sections - poll every unfinished section at once
  const sections: SectionState[] = continuation.sections.map((s: SectionState) => ({ ...s }));
  const live: { [jobId: string]: { count?: number; queue?: number } } = {};
  await Promise.all(sections.filter((s) => !s.done && !s.error).map(async (s) => {
    try {
      const r = await pollAntigravityBuild(s.ssmCommandId, s.jobId);
      if (!r.done) {
        live[s.jobId] = { count: r.elementCount, queue: r.queuePosition };
        return;
      }
      if (r.error || !r.ifcUrl) {
        s.error = r.error || "no model produced";
        return;
      }
      s.done = true;
      s.url = r.ifcUrl;
      s.count = r.elementCount;
    } catch (e: any) {
      // A transient poll failure must not kill the build; try again next round.
      console.warn(`[parallel] poll of ${s.jobId} failed: ${e?.message || e}`);
    }
  }));

  const failed = sections.filter((s) => s.error);
  if (failed.length) {
    return { status: "error", error: `Part "${failed[0].name}" failed: ${failed[0].error}. Try again, or turn off Fast build.`, mcpSessionId: jobId };
  }

  if (sections.every((s) => s.done && s.url)) {
    try {
      const mergeCmd = await startMergeJob(jobId, sections.map((s) => s.url as string));
      return {
        status: "continue",
        continuation: { kind: "parallel", phase: "merge", jobId, ssmCommandId: mergeCmd, parts: sections.length },
        progress: `All ${sections.length} parts built. Merging into one model...`,
        mcpSessionId: jobId,
      };
    } catch (e: any) {
      return { status: "error", error: `Could not start merging the parts: ${e?.message || e}`, mcpSessionId: jobId };
    }
  }

  const doneN = sections.filter((s) => s.done).length;
  return {
    status: "continue",
    continuation: { ...continuation, sections },
    progress: `Building ${sections.length} parts in parallel (${doneN} of ${sections.length} done): ${sections.map((s) => sectionLine(s, live)).join(" · ")}`,
    mcpSessionId: jobId,
  };
}
