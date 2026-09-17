/**
 * Routes a new-build brief to OpenHands (a real agentic coding CLI, driving
 * deepseek-v4.1-flash via Token Harbor) running headless on the EC2 MCP box,
 * via AWS SSM Run Command - instead of this pipeline's own direct-model
 * orchestration. See infrastudio-kimi-pipeline-no-fallback memory / the plan
 * this was built from for the full rationale.
 *
 * Every DashScope-hosted model tried before this (qwen3.8-max, qwen3.8-27b,
 * deepseek-v4.1-flash, deepseek-v4-pro, kimi-k2.7-code, glm-5.1/5.2/5.3) ran
 * into free-tier quota exhaustion during real agentic use - Token Harbor's
 * free deepseek-v4.1-flash:free tier is a separate account/provider with its
 * own quota, used here as a straight swap of the LLM endpoint/model/key,
 * nothing else in this file's flow changes.
 *
 * ssm:SendCommand returns immediately with a CommandId - the actual script
 * keeps running on the instance independently of any Lambda invocation
 * watching it, so a build that outlives one Lambda invocation's time budget
 * is resumed by simply polling the same CommandId again next time, via the
 * existing status:"continue" contract every other action in this file
 * already uses.
 */
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";

const INSTANCE_ID = "i-006cf1785c4abbb6d";
const REGION = "us-east-1";
const LLM_SECRET_ID = "infrastudio/tokenharbor-api-key";
const LLM_ENDPOINT_BASE_URL = "https://tokenharbor.ai/v1";
const LLM_MODEL_NAME = "openai/deepseek-v4.1-flash:free";

const ssmClient = new SSMClient({ region: REGION });

function b64(s: string): string {
  return typeof Buffer !== "undefined" ? Buffer.from(s, "utf-8").toString("base64") : btoa(s);
}

/**
 * Builds the on-box shell script for one build. Keyed by jobId (the build's
 * own mcpSessionId) so concurrent/sequential builds don't collide on
 * filenames - config.toml itself (LLM/MCP wiring) is shared and static, only
 * the task text and log are per-job. Prints ONLY a final single-line marker
 * to real stdout - GetCommandInvocation's StandardOutputContent is capped at
 * 24,000 characters and a full OpenHands run's own log routinely exceeds
 * that, so the full log is kept in a file and never sent through SSM output.
 */
function buildScript(brief: string, jobId: string): string {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "job";
  const taskB64 = b64(brief);
  const inner = `#!/bin/bash
export HOME=/root
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/openhands-workspace"

echo "${taskB64}" | base64 -d > "task_${safeId}.txt"

LLM_RAW=$(aws secretsmanager get-secret-value --secret-id ${LLM_SECRET_ID} --region ${REGION} --query SecretString --output text)
if echo "$LLM_RAW" | head -c1 | grep -q '{'; then
  KEY=$(echo "$LLM_RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('api_key') or d.get('key') or list(d.values())[0]; print(v)")
else
  KEY="$LLM_RAW"
fi
export LLM_API_KEY="$KEY"
export LLM_MODEL=${LLM_MODEL_NAME}
export LLM_BASE_URL=${LLM_ENDPOINT_BASE_URL}

# This install's CLI (OpenHands SDK, not the legacy config.toml-driven
# OpenHands) ignores config.toml's [mcp] section entirely - MCP servers must
# be registered via 'openhands mcp add' into ~/.openhands/mcp.json instead.
# Confirmed via direct testing: without this, the agent has no native BIM
# tool calls at all and has to hand-craft raw JSON-RPC over curl for every
# operation, which is both slower and less reliable. Idempotent (safe to
# re-run every invocation) so a rebuilt/replaced instance self-heals.
openhands mcp list 2>/dev/null | grep -q "infrastudio-bim" || \
  openhands mcp add infrastudio-bim --transport http http://localhost:8000/mcp >/dev/null 2>&1
export OPENHANDS_SUPPRESS_BANNER=1
unset LLM_RAW KEY

# The agent sometimes fails silently - no tool calls, no real work, just
# echoes its own (huge, irrelevant-to-BIM) default system prompt back as if
# that were an answer, observed repeatedly this session across several prior
# DashScope-hosted models on both simple and complex briefs alike (most often
# caused by free-tier quota exhaustion on the underlying model, which the
# LiteLLM layer surfaces as garbage output rather than a clean error).
# OpenHands still exits 0 in this failure mode, but
# every genuinely successful run so far printed "Agent finished" and every
# one of these silent failures did not - so retry (same approach, just
# tried again, exactly like a person re-running a flaky command) up to 3
# total attempts before giving up honestly.
AGENT_OK=0
for ATTEMPT in 1 2 3; do
  timeout 1500 openhands --headless --override-with-envs -f "task_${safeId}.txt" > "run_${safeId}.log" 2>&1
  OH_EXIT=$?
  CLEAN_LOG=$(sed -r "s/\\x1B\\[[0-9;]*[a-zA-Z]//g" "run_${safeId}.log")
  if echo "$CLEAN_LOG" | grep -q "Agent finished"; then
    AGENT_OK=1
    break
  fi
  echo "[retry] attempt $ATTEMPT did not finish cleanly, $([ $ATTEMPT -lt 3 ] && echo retrying || echo giving up)" >> "run_${safeId}.log"
done

# Exporting unconditionally after a failed run just re-exports whatever was
# already in the shared MCP scene from an earlier build and reports someone
# else's old result as a fresh success - a real bug caught this session, not
# a hypothetical - so this stays gated on a genuine finish even after retries.
if [ "$AGENT_OK" != "1" ]; then
  CLEAN_TAIL=$(echo "$CLEAN_LOG" | tail -c 400 | tr '\\n' ' ')
  echo "BUILD_ERROR:openhands_exit=$OH_EXIT agent_did_not_finish=true after_attempts=3 log_tail=$CLEAN_TAIL"
else
  # Always do a direct, deterministic export_ifc call after a genuinely
  # finished run - the same raw MCP call pattern used everywhere else in
  # this pipeline (exportWithMaterials) - rather than trying to parse a URL
  # out of the agent's own final message. The agent often describes the
  # export in prose ("downloaded from the export URL") without literally
  # pasting the link, so grepping its log for a URL is unreliable even on a
  # fully successful build.
  EXPORT_JSON=$(curl -s -m 60 -X POST http://localhost:8000/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"export_ifc","arguments":{}}}')
  URL=$(echo "$EXPORT_JSON" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    text = d['result']['content'][0][0]['text']
    inner = json.loads(text)
    print(inner.get('file_url') or inner.get('ifc_url') or '')
except Exception:
    print('')
" 2>/dev/null)

  if [ -n "$URL" ]; then
    echo "IFC_URL:$URL"
  else
    CLEAN_TAIL=$(echo "$CLEAN_LOG" | tail -c 400 | tr '\\n' ' ')
    echo "BUILD_ERROR:openhands_exit=$OH_EXIT export_call=$(echo "$EXPORT_JSON" | head -c 200) log_tail=$CLEAN_TAIL"
  fi
fi
`;
  return `echo ${b64(inner)} | base64 -d > /tmp/run_${safeId}.sh && bash /tmp/run_${safeId}.sh`;
}

export async function startOpenHandsBuild(brief: string, jobId: string): Promise<string> {
  if (!brief || !brief.trim()) throw new Error("startOpenHandsBuild: empty brief");
  const script = buildScript(brief, jobId);
  const res = await ssmClient.send(new SendCommandCommand({
    InstanceIds: [INSTANCE_ID],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [script] },
    // Up to 3 attempts internally now (see buildScript) - failures are fast
    // (~15-20s observed) but a genuine multi-minute build on a later attempt
    // needs real headroom too, so this ceiling covers a worst case of three
    // full-length attempts rather than just one.
    TimeoutSeconds: 4500,
  }));
  const commandId = res.Command?.CommandId;
  if (!commandId) throw new Error("startOpenHandsBuild: SendCommand returned no CommandId");
  console.log(`[openhands_agent] Started build jobId=${jobId} ssmCommandId=${commandId}`);
  return commandId;
}

export async function pollOpenHandsBuild(commandId: string, deadline: number): Promise<{ done: boolean; ifcUrl?: string; error?: string }> {
  // A freshly-sent command can briefly 404 (InvocationDoesNotExist) before it
  // propagates to the instance - treat that as "not started yet", not a real
  // error, and keep polling within the same deadline.
  while (Date.now() < deadline) {
    try {
      const res = await ssmClient.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: INSTANCE_ID }));
      const status = res.Status;
      if (status === "Success") {
        const out = res.StandardOutputContent || "";
        const urlMatch = out.match(/IFC_URL:(\S+)/);
        if (urlMatch) return { done: true, ifcUrl: urlMatch[1] };
        const errMatch = out.match(/BUILD_ERROR:(.*)/);
        return { done: true, error: errMatch ? errMatch[1].trim() : "OpenHands run finished but produced no IFC URL and no error marker." };
      }
      if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
        const errText = res.StandardErrorContent || res.StandardOutputContent || `SSM command ended with status ${status}`;
        return { done: true, error: `OpenHands SSM command ${status}: ${errText.slice(0, 500)}` };
      }
      // Pending / InProgress / Delayed - keep polling.
    } catch (err: any) {
      const msg = String(err?.name || err?.message || err);
      if (!msg.includes("InvocationDoesNotExist")) {
        console.warn(`[openhands_agent] GetCommandInvocation error (will retry): ${msg}`);
      }
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  return { done: false };
}
