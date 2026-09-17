/**
 * Routes a new-build brief to the Antigravity CLI ("agy") - a real agentic
 * coding CLI driving Gemini 3.8 Flash High via the user's own Antigravity Pro
 * subscription - running headless on the EC2 MCP box via AWS SSM Run Command,
 * as an alternative to this pipeline's own direct-model orchestration and to
 * the (dormant) OpenHands/Token Harbor path in openhands_agent.ts.
 *
 * Unlike openhands_agent.ts's pollOpenHandsBuild (which blocks internally,
 * sleeping in 10s steps until its own deadline), pollAntigravityBuild does
 * exactly ONE GetCommandInvocation check per call and returns immediately -
 * SSM streams a running command's stdout into StandardOutputContent
 * progressively, before the command finishes, so a single check mid-run
 * already has real progress to show. The on-box script emits a
 * "PROGRESS:count=<n>" line to real stdout every ~10s while the agent works,
 * which this file greps out of that partial output. Returning fast (instead
 * of blocking) lets the caller's own continuation loop re-invoke every few
 * seconds and surface a fresh, live element count each time - this is what
 * actually produces "streaming" progress in the frontend, since the
 * frontend's continuation loop already renders whatever `progress` string
 * comes back on each pass.
 */
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "npm:@aws-sdk/client-ssm";
import { getMcpUrl, extractText } from "./shared.ts";

const INSTANCE_ID = "i-006cf1785c4abbb6d";
const REGION = "us-east-1";
const AGY_MODEL = "gemini-3.8-flash-high";

const ssmClient = new SSMClient({ region: REGION });

function b64(s: string): string {
  return typeof Buffer !== "undefined" ? Buffer.from(s, "utf-8").toString("base64") : btoa(s);
}

/**
 * Builds the on-box shell script for one build. The agy process itself is
 * backgrounded so this script can run a heartbeat loop alongside it that
 * polls get_scene_info and echoes progress to real stdout - the script only
 * exits (letting SSM mark the command Success) once agy itself has finished
 * and the final result has been parsed and printed as IFC_URL:/FILE_SIZE:/
 * ELEMENT_COUNT: markers, mirroring openhands_agent.ts's own marker
 * convention so the two engines can share a result-parsing shape later if
 * useful.
 *
 * Depends on infrastructure already set up once on this box this session:
 * the `agy` binary at ~/.local/bin, a login already exchanged for a Google
 * OAuth credential in gnome-keyring, and a persistent dbus session (env vars
 * in /root/dbus_env.sh) keeping that keyring unlocked and reachable. None of
 * that is created here - if the box is ever replaced/rebooted, that one-time
 * setup needs to be redone before this will work again.
 */
function buildScript(brief: string, jobId: string): string {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "job";
  const briefB64 = b64(brief);
  const inner = `#!/bin/bash
export HOME=/root
export PATH="$HOME/.local/bin:$PATH"
source /root/dbus_env.sh
mkdir -p /root/agy_jobs
pkill -9 -f "agy -p" || true

echo "${briefB64}" | base64 -d > /root/agy_jobs/task_${safeId}.txt
BRIEF=$(cat /root/agy_jobs/task_${safeId}.txt)

setsid nohup agy --model ${AGY_MODEL} --effort high -p "$BRIEF" --dangerously-skip-permissions --output-format json --print-timeout 30m > /root/agy_jobs/${safeId}.log 2>&1 < /dev/null &
AGY_PID=$!

# Nothing needs to run alongside agy here - live progress is read by the
# caller straight from the MCP server's public endpoint (see
# pollAntigravityBuild), not from this script's own output, because SSM does
# not surface a running command's stdout until it reaches a terminal state
# (confirmed directly: StandardOutputContent stays empty the whole time a
# command is InProgress, then appears all at once on Success) - a heartbeat
# echoing progress here would never actually reach the poller before the
# build was already done anyway.
wait $AGY_PID

python3 -c "
import json, re
with open('/root/agy_jobs/${safeId}.log') as f:
    content = f.read()
try:
    data = json.loads(content)
    resp = data.get('response', '') or data.get('error', '') or content
except Exception:
    resp = content

url_match = re.search(r'https://\\S+\\.ifc\\S*', resp)
size_match = re.search(r'([\\d,]+)\\s*bytes', resp)
count_match = re.search(r'[Tt]otal[^:]*:\\s*\\**\\s*([\\d,]+)', resp)
if url_match:
    url = url_match.group(0).rstrip(').,\\\"\\'')
    print(f'IFC_URL:{url}')
    if size_match:
        print(f'FILE_SIZE:{size_match.group(1).replace(\\\",\\\", \\\"\\\")}')
    if count_match:
        print(f'ELEMENT_COUNT:{count_match.group(1).replace(\\\",\\\", \\\"\\\")}')
else:
    print(f'BUILD_ERROR:{resp[-500:]}')
"
`;
  return `echo ${b64(inner)} | base64 -d > /tmp/run_agy_${safeId}.sh && bash /tmp/run_agy_${safeId}.sh`;
}

export async function startAntigravityBuild(brief: string, jobId: string): Promise<string> {
  if (!brief || !brief.trim()) throw new Error("startAntigravityBuild: empty brief");
  const script = buildScript(brief, jobId);
  const res = await ssmClient.send(new SendCommandCommand({
    InstanceIds: [INSTANCE_ID],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [script] },
    TimeoutSeconds: 2400, // 40 min ceiling - covers the 30m --print-timeout plus heartbeat/export overhead
  }));
  const commandId = res.Command?.CommandId;
  if (!commandId) throw new Error("startAntigravityBuild: SendCommand returned no CommandId");
  console.log(`[antigravity_agent] Started build jobId=${jobId} ssmCommandId=${commandId}`);
  return commandId;
}

/**
 * Live element count straight from the MCP server, bypassing SSM entirely -
 * this is what actually makes progress "stream" during a build, since the
 * SSM command itself reveals nothing until it finishes. Any failure (server
 * still booting, transient network blip) just yields "no count this round",
 * not a thrown error - this is a best-effort progress hint, not a critical path.
 */
async function fetchLiveElementCount(): Promise<number | undefined> {
  try {
    const res = await fetch(getMcpUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_scene_info", arguments: {} } }),
    });
    const json = await res.json();
    const text = extractText(json?.result?.content);
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    return typeof parsed?.count === "number" ? parsed.count : undefined;
  } catch {
    return undefined;
  }
}

export interface AntigravityPollResult {
  done: boolean;
  ifcUrl?: string;
  fileSize?: number;
  elementCount?: number;
  error?: string;
  progressMessage?: string;
}

/**
 * One-shot status check - does not block/sleep internally (unlike
 * pollOpenHandsBuild). Callers loop this from outside (e.g. the frontend's
 * own continuation loop, or a short server-side delay before returning) so
 * progress can be surfaced on every round-trip rather than only once per
 * multi-minute Lambda invocation.
 */
export async function pollAntigravityBuild(commandId: string): Promise<AntigravityPollResult> {
  try {
    const res = await ssmClient.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: INSTANCE_ID }));
    const status = res.Status;
    const out = res.StandardOutputContent || "";

    if (status === "Success") {
      const urlMatch = out.match(/IFC_URL:(\S+)/);
      if (urlMatch) {
        const sizeMatch = out.match(/FILE_SIZE:(\d+)/);
        const countMatch = out.match(/ELEMENT_COUNT:(\d+)/);
        return {
          done: true,
          ifcUrl: urlMatch[1],
          fileSize: sizeMatch ? Number(sizeMatch[1]) : undefined,
          elementCount: countMatch ? Number(countMatch[1]) : undefined,
        };
      }
      const errMatch = out.match(/BUILD_ERROR:([\s\S]*)/);
      return { done: true, error: errMatch ? errMatch[1].trim().slice(0, 500) : "Antigravity run finished but produced no IFC URL and no error marker." };
    }

    if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
      const errText = res.StandardErrorContent || out || `SSM command ended with status ${status}`;
      return { done: true, error: `Antigravity SSM command ${status}: ${errText.slice(0, 500)}` };
    }

    // Pending / InProgress / Delayed - SSM gives us nothing usable here (see
    // buildScript's comment), so read the live element count straight from
    // the MCP server's own public endpoint instead. Best-effort: a failed
    // fetch (e.g. Blender still booting) just means no count this round, not
    // an error worth surfacing.
    const elementCount = await fetchLiveElementCount();
    // Without a delay here, a caller that loops this with no pacing of its
    // own (e.g. the frontend's continuation loop, which has a fixed
    // max-passes budget) burns through that whole budget in seconds against
    // a build that runs for minutes.
    await new Promise((r) => setTimeout(r, 8000));
    return {
      done: false,
      elementCount,
      progressMessage: elementCount !== undefined
        ? `Antigravity is building... ${elementCount.toLocaleString()} elements created so far`
        : "Antigravity build starting...",
    };
  } catch (err: any) {
    const msg = String(err?.name || err?.message || err);
    if (msg.includes("InvocationDoesNotExist")) {
      // A freshly-sent command can briefly 404 before it propagates to the instance.
      await new Promise((r) => setTimeout(r, 8000));
      return { done: false, progressMessage: "Antigravity build starting..." };
    }
    await new Promise((r) => setTimeout(r, 8000));
    return { done: false, progressMessage: `Antigravity status check warning: ${msg.slice(0, 200)}` };
  }
}
