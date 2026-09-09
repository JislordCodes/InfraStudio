import { callQwen, cleanJsonResponse, mcpCallTool } from "./shared.ts";
import { synthesizeBuildingPythonCode } from "../agent-architect/index.ts";

export interface AntigravityAgentOptions {
  maxRetries?: number;
  model?: string;
  onStep?: (msg: string) => void;
}

export interface AntigravityAgentResult {
  success: boolean;
  python_code: string;
  mcpSessionId: string;
  resultText?: string;
  iterations: number;
  steps: string[];
  error?: string;
}

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity, Google DeepMind's elite Autonomous Coding Agent and Master Computational Architect.
Your task is to generate complete, high-performance, watertight, clash-free Python scripts that build stunning architectural BIM models using IfcOpenShell and InfraStudioHarness.

RULES OF ENGAGEMENT:
1. ALWAYS WRITE RUNNABLE PYTHON CODE USING InfraStudioHarness.
2. Watertight geometry is mandatory: never overlap solid geometry.
3. For walls with doors or windows, use create_wall(..., openings=[...]) which creates genuine physical rectangular voids in the wall assembly, and add corresponding framed windows/doors inside those openings.
4. Structural integrity: Provide a structural column grid (add_column) at corner intersections, continuous floor plates (create_slab), cantilevered upper-level balconies with safety railings (add_railing), and a solid roof (create_roof or flat slab with parapets).
5. All dimensions in meters:
   - Ground slab: thickness 0.30m, z_elevation -0.30m
   - Walls: height 3.2m, thickness 0.25m
   - Columns: radius 0.20m or square 0.30m
   - Railings: height 1.05m
   - Doors: width 0.90m to 1.10m, height 2.10m
   - Windows: width 1.20m to 2.40m, height 1.40m, sill_height 0.90m
6. Structure of script:
   - Retrieve IFC: ifc = get_ifc_file()
   - Storey setup: storey = ifc.by_type("IfcBuildingStorey")[0]
   - Harness: h = InfraStudioHarness(ifc, storey)
   - Primitives: h.create_slab, h.create_wall, h.add_column, h.add_beam, h.add_railing, h.add_window, h.add_door, h.create_stairs, h.create_roof
   - Commit: count = h.commit()
   - Finalize: save_and_load_ifc()
   - Print: print(f"Committed {count} elements.")

Output format:
Return a JSON object with:
{
  "thought_process": "Your step-by-step spatial and structural reasoning",
  "structure_name": "Descriptive Name",
  "python_code": "Complete executable Python script"
}`;

/**
 * Extracts raw Python code from LLM response (supports JSON or markdown code block).
 */
export function extractPythonCode(response: string): string {
  if (!response || typeof response !== "string") return "";
  const trimmed = response.trim();

  // 1. Try parsing JSON
  try {
    const parsed = cleanJsonResponse(trimmed);
    if (parsed && typeof parsed.python_code === "string" && parsed.python_code.trim().length > 20) {
      return parsed.python_code.trim();
    }
  } catch {
    // Not valid JSON, proceed to extract code block
  }

  // 2. Extract from markdown code fence
  const codeBlockMatch = trimmed.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1].trim().length > 20) {
    return codeBlockMatch[1].trim();
  }

  // 3. Fallback if entire string is python code
  if (trimmed.includes("InfraStudioHarness") && trimmed.includes("commit()")) {
    return trimmed;
  }

  return "";
}

/**
 * Runs the Antigravity Agentic ReAct self-correction loop using Kimi K3 on AWS.
 */
export async function runAntigravityKimiAgent(
  brief: any,
  initialSessionId: string,
  options: AntigravityAgentOptions = {}
): Promise<AntigravityAgentResult> {
  const maxRetries = options.maxRetries ?? 3;
  const model = options.model || "kimi-k3";
  const onStep = options.onStep || (() => {});
  const steps: string[] = [];

  const logStep = (msg: string) => {
    steps.push(msg);
    onStep(msg);
  };

  logStep(`🧠 Antigravity Agent (${model}): Analyzing design brief & calculating spatial grids...`);

  let currentSessionId = initialSessionId;
  let code = "";
  let promptText = typeof brief === "string" ? brief : JSON.stringify(brief);
  let errorFeedback = "";
  let iterations = 0;

  while (iterations < maxRetries) {
    iterations++;

    try {
      let promptMessage = "";
      if (iterations === 1) {
        promptMessage = `User Design Brief: ${promptText}\n\nDesign a complete, high-quality, watertight architectural BIM model using InfraStudioHarness. Return JSON with thought_process and python_code.`;
      } else {
        logStep(`🔧 Antigravity Agent: Self-healing error from previous pass (Attempt ${iterations}/${maxRetries})...`);
        promptMessage = `PREVIOUS PYTHON CODE EXECUTION FAILED ON EC2 BONSAI WITH ERROR:\n${errorFeedback}\n\nFAILED CODE:\n\`\`\`python\n${code}\n\`\`\`\n\nAnalyze why this failed, repair the geometry/parameters, ensure all InfraStudioHarness methods are valid, and return the corrected JSON with repaired python_code.`;
      }

      const rawResponse = await callQwen(
        ANTIGRAVITY_SYSTEM_PROMPT,
        promptMessage,
        true,
        model
      );

      code = extractPythonCode(rawResponse);
      if (!code || code.length < 50) {
        throw new Error(`Failed to extract valid Python code from ${model} response.`);
      }

      logStep(`⚡ Antigravity Agent: Executing ${code.length} bytes of Python code on EC2 Bonsai MCP...`);

      // Execute on EC2 Bonsai MCP server
      const toolRes = await mcpCallTool("execute_ifc_code_tool", { code }, currentSessionId);
      currentSessionId = toolRes.session;

      logStep(`✅ Antigravity Agent: Execution succeeded! Model generated cleanly.`);
      return {
        success: true,
        python_code: code,
        mcpSessionId: currentSessionId,
        resultText: toolRes.resultText,
        iterations,
        steps
      };

    } catch (err: any) {
      const errMsg = err?.message || String(err);
      console.warn(`[AntigravityAgent] Attempt ${iterations} failed: ${errMsg.slice(0, 300)}`);
      errorFeedback = errMsg;

      if (iterations >= maxRetries) {
        logStep(`⚠️ Antigravity Agent: Max retries reached (${maxRetries}). Engaging deterministic architectural fallback.`);
        break;
      }
    }
  }

  // If retries exhausted, produce deterministic clean synthesis
  const fallbackCode = synthesizeBuildingPythonCode(brief);
  try {
    const fallbackRes = await mcpCallTool("execute_ifc_code_tool", { code: fallbackCode }, currentSessionId);
    currentSessionId = fallbackRes.session;
    return {
      success: true,
      python_code: fallbackCode,
      mcpSessionId: currentSessionId,
      resultText: fallbackRes.resultText,
      iterations,
      steps: [...steps, "✅ Deterministic architectural fallback executed cleanly."]
    };
  } catch (finalErr: any) {
    return {
      success: false,
      python_code: fallbackCode,
      mcpSessionId: currentSessionId,
      error: finalErr?.message || String(finalErr),
      iterations,
      steps
    };
  }
}
