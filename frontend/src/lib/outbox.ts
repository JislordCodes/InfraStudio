// Chat saves that must not be lost. A message or a model link that fails to
// reach the database is kept in this browser and sent again on the next load,
// when the connection returns, or after a delay.

const KEY = 'infrastudio_outbox_v1';

export type OutboxJob =
  | { kind: 'message'; sessionId: string; msg: Record<string, unknown> }
  | { kind: 'session'; sessionId: string; updates: Record<string, string> };

function read(): OutboxJob[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(jobs: OutboxJob[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs.slice(-500)));
  } catch {
    /* storage full or unavailable: nothing more can be done here */
  }
}

export function enqueue(job: OutboxJob) {
  write([...read(), job]);
}

export function pendingSessionUpdates(sessionId: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const j of read()) if (j.kind === 'session' && j.sessionId === sessionId) Object.assign(merged, j.updates);
  return merged;
}

/** Runs `fn` up to `attempts` times with a growing pause. Returns true when it succeeds. */
export async function retrying(fn: () => Promise<boolean>, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await fn()) return true;
    } catch {
      /* try again */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1) ** 2));
  }
  return false;
}

let flushing = false;

/** Sends every saved job again, in order. Jobs that still fail stay queued. */
export async function flushOutbox(send: (job: OutboxJob) => Promise<boolean>): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const initial = read();
    const remaining: OutboxJob[] = [];
    for (const job of initial) {
      let ok = false;
      try {
        ok = await send(job);
      } catch {
        ok = false;
      }
      if (!ok) remaining.push(job);
    }
    // Jobs queued while this flush was running sit after the ones we started with.
    write([...remaining, ...read().slice(initial.length)]);
  } finally {
    flushing = false;
  }
}
