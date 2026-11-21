import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { IfcViewerHandle, PickedElement } from '../components/IfcViewer';
import { EngineClient } from '../engine/client';
import { buildSchedule, DEFAULT_RATES, type RateCard, type Schedule } from '../engine/schedule';
import { findOverlaps, type Overlap } from '../engine/overlaps';
import { runRules, type RuleReport } from '../engine/rules';
import type { EditInfo, EditOp, ElementRecord, ModelTable } from '../engine/types';
import { supabase } from '../lib/supabase';

const KEY = 'main';
const RATES_KEY = 'infrastudio_rates_v1';
const MAX_UNDO = 12;

export interface LoadedModel {
  bytes: Uint8Array;
  url?: string;
  name?: string;
  /** changes every time the viewer loads a different model */
  nonce: number;
}

export interface AdoptRequest {
  nonce: number;
  url: string;
  label: string;
  elementCount?: number;
  fileSize?: number;
}

function loadRates(): RateCard {
  try {
    const raw = localStorage.getItem(RATES_KEY);
    if (raw) return { ...DEFAULT_RATES, ...(JSON.parse(raw) as RateCard) };
  } catch {
    /* use defaults */
  }
  return DEFAULT_RATES;
}

export interface Studio {
  status: 'idle' | 'reading' | 'ready' | 'error';
  error: string | null;
  table: ModelTable | null;
  schedule: Schedule | null;
  baseline: { cost: number; overlaps: number; elements: number } | null;
  overlaps: Overlap[];
  rules: RuleReport | null;
  rates: RateCard;
  setRate: (cls: string, rate: number) => void;
  resetRates: () => void;
  selected: ElementRecord | null;
  selectedInfo: EditInfo | null;
  /** an edit is running */
  busy: boolean;
  edited: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** runs an edit, shows it in the viewer, and returns an error message or null */
  edit: (op: EditOp) => Promise<string | null>;
  editMany: (ops: EditOp[]) => Promise<string | null>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  pick: (el: PickedElement | null) => void;
  selectById: (id: number | null) => void;
  /** highlight elements in the viewer and fly to them */
  show: (ids: number[], color?: string, focus?: boolean) => Promise<void>;
  currentBytes: () => Promise<Uint8Array>;
  /** uploads the edited model and returns its public URL */
  upload: () => Promise<{ url: string; fileSize: number }>;
  /** URL of the model on screen, when it has not been edited since it was loaded */
  cleanUrl: string | null;
  setCleanUrl: (url: string | null) => void;
  /** the edited model now lives at this URL, so it counts as saved */
  markSaved: (url: string) => void;
  engine: EngineClient | null;
  engineKey: string;
}

export function useStudio(viewerRef: RefObject<IfcViewerHandle | null>, loaded: LoadedModel | null): Studio {
  const engineRef = useRef<EngineClient | null>(null);
  const [status, setStatus] = useState<Studio['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState<ModelTable | null>(null);
  const [baseline, setBaseline] = useState<Studio['baseline']>(null);
  const [rates, setRates] = useState<RateCard>(loadRates);
  const [pickedGuid, setPickedGuid] = useState<string | null>(null);
  const [selectedInfo, setSelectedInfo] = useState<EditInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [edited, setEdited] = useState(false);
  const [cleanUrl, setCleanUrl] = useState<string | null>(null);
  const undoRef = useRef<Uint8Array[]>([]);
  const redoRef = useRef<Uint8Array[]>([]);
  const [, bump] = useState(0);
  const openToken = useRef(0);

  const getEngine = (): EngineClient => {
    if (!engineRef.current) engineRef.current = new EngineClient();
    return engineRef.current;
  };

  useEffect(() => () => engineRef.current?.terminate(), []);

  // A different model reached the viewer: read and measure it.
  useEffect(() => {
    if (!loaded) return;
    const token = ++openToken.current;
    setStatus('reading');
    setError(null);
    setPickedGuid(null);
    setEdited(false);
    setCleanUrl(loaded.url ?? null);
    undoRef.current = [];
    redoRef.current = [];
    bump((n) => n + 1);
    getEngine()
      .open(KEY, loaded.bytes)
      .then((t) => {
        if (token !== openToken.current) return;
        setTable(t);
        setStatus('ready');
        const sched = buildSchedule(t, loadRates());
        setBaseline({ cost: sched.totalCost, overlaps: findOverlaps(t.elements).length, elements: t.elements.length });
      })
      .catch((e: unknown) => {
        if (token !== openToken.current) return;
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [loaded?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useMemo(() => (table ? buildSchedule(table, rates) : null), [table, rates]);
  const overlaps = useMemo(() => (table ? findOverlaps(table.elements) : []), [table]);
  const rules = useMemo(() => (table ? runRules(table) : null), [table]);

  const selected = useMemo(
    () => (table && pickedGuid ? table.elements.find((e) => e.guid === pickedGuid) ?? null : null),
    [table, pickedGuid],
  );

  useEffect(() => {
    let live = true;
    setSelectedInfo(null);
    if (!selected || !engineRef.current) return;
    engineRef.current.editInfo(KEY, selected.id).then((info) => {
      if (live) setSelectedInfo(info);
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [selected?.id, table]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRate = useCallback((cls: string, rate: number) => {
    setRates((prev) => {
      const next = { ...prev, [cls]: { unit: prev[cls]?.unit ?? 'each', rate } };
      try {
        localStorage.setItem(RATES_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  const resetRates = useCallback(() => {
    try {
      localStorage.removeItem(RATES_KEY);
    } catch {
      /* ignore */
    }
    setRates(DEFAULT_RATES);
  }, []);

  const showModel = useCallback(
    async (bytes: Uint8Array, keepGuid: string | null) => {
      await viewerRef.current?.loadIfcBytes(bytes);
      if (keepGuid) await viewerRef.current?.highlightGuids([keepGuid], '#3b82f6', false);
    },
    [viewerRef],
  );

  const currentBytes = useCallback(() => getEngine().save(KEY), []);

  const runOps = useCallback(
    async (ops: EditOp[]): Promise<string | null> => {
      if (!table || busy) return 'Please wait for the current change to finish.';
      setBusy(true);
      try {
        const engine = getEngine();
        const snapshot = await engine.save(KEY);
        let last: ModelTable | null = null;
        for (const op of ops) {
          const res = await engine.apply(KEY, op);
          if (!res.ok) {
            // put the file back exactly as it was before this batch
            await engine.open(KEY, snapshot);
            return res.error || 'That change could not be made.';
          }
          last = res.table;
        }
        undoRef.current.push(snapshot);
        if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
        redoRef.current = [];
        if (last) setTable(last);
        setEdited(true);
        setCleanUrl(null);
        bump((n) => n + 1);
        await showModel(await engine.save(KEY), pickedGuid);
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        setBusy(false);
      }
    },
    [table, busy, pickedGuid, showModel],
  );

  const edit = useCallback((op: EditOp) => runOps([op]), [runOps]);
  const editMany = useCallback((ops: EditOp[]) => runOps(ops), [runOps]);

  const travel = useCallback(
    async (from: Uint8Array[], to: Uint8Array[]) => {
      if (!from.length || busy) return;
      setBusy(true);
      try {
        const engine = getEngine();
        to.push(await engine.save(KEY));
        const bytes = from.pop()!;
        const t = await engine.open(KEY, bytes);
        setTable(t);
        setEdited(undoRef.current.length > 0);
        bump((n) => n + 1);
        await showModel(bytes, pickedGuid);
      } finally {
        setBusy(false);
      }
    },
    [busy, pickedGuid, showModel],
  );

  const undo = useCallback(() => travel(undoRef.current, redoRef.current), [travel]);
  const redo = useCallback(() => travel(redoRef.current, undoRef.current), [travel]);

  const markSaved = useCallback((url: string) => {
    setCleanUrl(url);
    setEdited(false);
  }, []);

  const pick = useCallback((el: PickedElement | null) => setPickedGuid(el ? el.guid : null), []);

  const selectById = useCallback(
    (id: number | null) => {
      const rec = id == null ? null : table?.elements.find((e) => e.id === id) ?? null;
      setPickedGuid(rec ? rec.guid : null);
    },
    [table],
  );

  const show = useCallback(
    async (ids: number[], color = '#ef4444', focus = true) => {
      if (!table) return;
      const set = new Set(ids);
      const guids = table.elements.filter((e) => set.has(e.id)).map((e) => e.guid);
      await viewerRef.current?.highlightGuids(guids, color, focus);
    },
    [table, viewerRef],
  );

  const upload = useCallback(async () => {
    const bytes = await getEngine().save(KEY);
    const path = `edits/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.ifc`;
    const { error: upErr } = await supabase.storage
      .from('ifc-models')
      .upload(path, new Blob([bytes as BlobPart], { type: 'application/octet-stream' }), { contentType: 'application/octet-stream', upsert: false });
    if (upErr) throw new Error(upErr.message);
    const url = supabase.storage.from('ifc-models').getPublicUrl(path).data.publicUrl;
    return { url, fileSize: bytes.byteLength };
  }, []);

  return {
    status, error, table, schedule, baseline, overlaps, rules, rates, setRate, resetRates,
    selected, selectedInfo, busy, edited,
    canUndo: undoRef.current.length > 0,
    canRedo: redoRef.current.length > 0,
    edit, editMany, undo, redo, pick, selectById, show, currentBytes, upload,
    cleanUrl, setCleanUrl, markSaved,
    engine: engineRef.current,
    engineKey: KEY,
  };
}
