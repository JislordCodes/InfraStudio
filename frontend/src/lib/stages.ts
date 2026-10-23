/** Staged design workflow: coarse -> fine, one reviewed step at a time. The ids
 *  match the backend (supabase/functions/_shared/design_stages.ts). */
export const STAGES = [
  { id: 'massing', label: 'Massing', blurb: 'overall form and volume' },
  { id: 'zones', label: 'Zones', blurb: 'functional blocks and stacking' },
  { id: 'facade', label: 'Facade', blurb: 'envelope, glazing and materials' },
  { id: 'structure', label: 'Structure', blurb: 'structural system' },
  { id: 'detail', label: 'Detail', blurb: 'stairs, partitions, fit-out' },
] as const;

export type StageId = typeof STAGES[number]['id'];

export function stageIndex(id: string): number {
  return STAGES.findIndex(s => s.id === id);
}

export function nextStage(id: StageId): (typeof STAGES)[number] | null {
  return STAGES[stageIndex(id) + 1] ?? null;
}

/** Where a chat is in the staged workflow. Kept per chat in localStorage. */
export interface StageState {
  /** The stage currently shown for review (not yet approved). */
  stage: StageId;
  /** Stages the user has approved, in order. */
  approved: StageId[];
  /** The original project brief, sent along so later stages keep the context. */
  brief: string;
}

const key = (sid: string) => `infrastudio_stage_${sid}`;

export function loadStageState(sid: string): StageState | null {
  try {
    const raw = localStorage.getItem(key(sid));
    return raw ? (JSON.parse(raw) as StageState) : null;
  } catch {
    return null;
  }
}

export function saveStageState(sid: string, state: StageState): void {
  try { localStorage.setItem(key(sid), JSON.stringify(state)); } catch { /* ignore */ }
}

export function clearStageState(sid: string): void {
  try { localStorage.removeItem(key(sid)); } catch { /* ignore */ }
}

/** User preference: start new designs in staged mode. */
const PREF_KEY = 'infrastudio_staged_pref';
export function loadStagedPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) === '1'; } catch { return false; }
}
export function saveStagedPref(on: boolean): void {
  try { localStorage.setItem(PREF_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
