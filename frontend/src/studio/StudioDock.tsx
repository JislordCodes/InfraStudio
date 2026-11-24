import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Calculator, FileText, MessageCircleQuestion, MousePointer2, Share2, ShieldCheck, X } from 'lucide-react';
import type { IfcViewerHandle, PickedElement } from '../components/IfcViewer';
import { useStudio, type AdoptRequest, type LoadedModel } from './useStudio';
import { EditPanel } from './EditPanel';
import { SchedulePanel } from './SchedulePanel';
import { RulesPanel } from './RulesPanel';
import { AskPanel } from './AskPanel';
import { SharePanel } from './SharePanel';
import { pinsFor, rememberedReview } from './reviewPins';
import { DrawingsPanel } from './DrawingsPanel';
import { Spinner } from './ui';
import { getReview, type Review } from '../lib/review';
import { summarizeModel } from '../engine/summary';

type Tab = 'edit' | 'schedule' | 'rules' | 'ask' | 'share' | 'drawings';

const TABS: { id: Tab; label: string; Icon: typeof Calculator }[] = [
  { id: 'edit', label: 'Edit', Icon: MousePointer2 },
  { id: 'schedule', label: 'Quantities and cost', Icon: Calculator },
  { id: 'rules', label: 'Code check', Icon: ShieldCheck },
  { id: 'ask', label: 'Ask the model', Icon: MessageCircleQuestion },
  { id: 'share', label: 'Share and comment', Icon: Share2 },
  { id: 'drawings', label: 'Drawings', Icon: FileText },
];

interface Props {
  viewerRef: RefObject<IfcViewerHandle | null>;
  loaded: LoadedModel | null;
  onAdopt: (req: AdoptRequest) => void;
  /** The app points this at the studio so clicks in the viewer select elements. */
  pickRef: { current: ((el: PickedElement | null) => void) | null };
  /** Receives a text description of the open model for the chat, or null when there is none. */
  onSummary?: (summary: string | null) => void;
}

export function StudioDock({ viewerRef, loaded, onAdopt, pickRef, onSummary }: Props) {
  const studio = useStudio(viewerRef, loaded);
  useEffect(() => {
    pickRef.current = studio.pick;
    return () => {
      pickRef.current = null;
    };
  }, [studio.pick, pickRef]);
  useEffect(() => {
    if (!onSummary) return;
    if (studio.table && studio.schedule) onSummary(summarizeModel(studio.table, studio.schedule, studio.rules, studio.overlaps.length));
    else onSummary(null);
  }, [studio.table, studio.schedule, studio.rules, studio.overlaps, onSummary]);
  const [tab, setTab] = useState<Tab | null>(null);
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const reviewFor = useRef<number | null>(null);

  // A new model on screen means any share link on screen belongs to the previous one.
  useEffect(() => {
    if (!loaded) return;
    if (reviewFor.current !== loaded.nonce) {
      reviewFor.current = loaded.nonce;
      setReview(null);
      const id = rememberedReview(loaded.url ?? null);
      if (id) void getReview(id).then(setReview).catch(() => undefined);
    }
  }, [loaded?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pins follow the model through reloads after an edit.
  useEffect(() => {
    if (!review) return;
    const t = window.setTimeout(() => void viewerRef.current?.setPins(pinsFor(review)), 1800);
    return () => window.clearTimeout(t);
  }, [studio.table, review, viewerRef]);

  const saveVersion = useCallback(async () => {
    if (!studio.table) return;
    setSaving(true);
    try {
      const { url, fileSize } = await studio.upload();
      studio.markSaved(url);
      onAdopt({ nonce: Date.now(), url, label: 'Hand edits', elementCount: studio.table.elements.length, fileSize });
    } finally {
      setSaving(false);
    }
  }, [studio, onAdopt]);

  // Picking an element while on a tab that is not about elements keeps that tab open.
  const hasModel = !!loaded;
  if (!hasModel) return null;

  return (
    <>
      <div className="absolute left-2 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-1.5 p-1.5 rounded-2xl border border-white/10 bg-neutral-900/85 backdrop-blur-xl shadow-lg pointer-events-auto">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(active ? null : id)}
              title={label}
              className={`relative p-2.5 rounded-xl transition-all active:scale-90 ${active ? 'bg-blue-600 text-white' : 'text-white/75 hover:text-white hover:bg-white/10'}`}
            >
              <Icon size={18} strokeWidth={2.2} />
              {id === 'edit' && studio.selected && !active && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-blue-400" />}
              {id === 'rules' && studio.rules && studio.rules.findings.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-[10px] leading-4 text-center font-bold text-white">
                  {studio.rules.findings.length > 99 ? '99+' : studio.rules.findings.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab && (
        <div className="absolute left-16 top-[84px] bottom-3 z-20 w-[350px] max-w-[calc(100vw-5rem)] flex flex-col rounded-2xl border border-white/10 bg-neutral-900/92 backdrop-blur-xl shadow-2xl text-white pointer-events-auto overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-400">{TABS.find((t) => t.id === tab)!.label}</div>
              <div className="text-sm font-medium truncate max-w-[250px]">{studio.table?.project || 'Model'}</div>
            </div>
            <button className="p-1.5 rounded-lg text-white/60 hover:bg-blue-600 hover:text-white" onClick={() => setTab(null)} title="Close">
              <X size={16} strokeWidth={2.5} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {studio.status === 'reading' && <Spinner label="Reading and measuring the model…" />}
            {studio.status === 'error' && (
              <div className="m-4 rounded-lg bg-red-500/15 border border-red-500/30 text-red-200 text-sm p-3">
                This model could not be read for editing. {studio.error}
              </div>
            )}
            {studio.status === 'ready' && (
              <>
                {tab === 'edit' && <EditPanel studio={studio} onSaveVersion={saveVersion} saving={saving} />}
                {tab === 'schedule' && <SchedulePanel studio={studio} />}
                {tab === 'rules' && <RulesPanel studio={studio} />}
                {tab === 'ask' && <AskPanel studio={studio} />}
                {tab === 'share' && <SharePanel studio={studio} viewerRef={viewerRef} review={review} setReview={setReview} />}
                {tab === 'drawings' && <DrawingsPanel studio={studio} />}
              </>
            )}
          </div>
        </div>
      )}

    </>
  );
}
