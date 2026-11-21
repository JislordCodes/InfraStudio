import { useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp, Redo2, Save, Trash2, Undo2, Download } from 'lucide-react';
import type { Studio } from './useStudio';
import { Section } from './ui';
import { btn, btnDanger, btnGhost, btnPrimary, input } from './styles';
import { humanClass } from '../engine/schedule';
import { downloadBlob } from '../lib/review';

interface Props {
  studio: Studio;
  onSaveVersion: () => Promise<void>;
  saving: boolean;
}

const STEPS = [0.1, 0.5, 1, 5];

/** Resets its fields whenever a different element, or the same element after a change, is selected. */
export function EditPanel(props: Props) {
  const sel = props.studio.selected;
  return <EditBody key={sel ? `${sel.id}:${sel.bbox.join(',')}:${sel.name}` : 'none'} {...props} />;
}

function EditBody({ studio, onSaveVersion, saving }: Props) {
  const { selected, selectedInfo, busy } = studio;
  const [message, setMessage] = useState<string | null>(null);
  const [step, setStep] = useState(0.5);
  const [anchor, setAnchor] = useState<'base' | 'centre'>('base');
  const [name, setName] = useState(selected?.name ?? '');
  const [sizes, setSizes] = useState<Record<number, string>>({});

  const run = async (p: Promise<string | null>) => {
    const err = await p;
    setMessage(err);
  };

  const move = (dx: number, dy: number, dz: number) =>
    selected && run(studio.edit({ kind: 'move', ids: [selected.id], delta: [dx * step, dy * step, dz * step] }));

  const applySize = (index: number) => {
    if (!selected || !selectedInfo) return;
    const raw = sizes[index];
    if (raw == null || raw.trim() === '') return;
    const v = Number(raw);
    const axis = selectedInfo.axes.find((a) => a.index === index)!;
    if (!Number.isFinite(v) || v < 0.01) {
      setMessage('Enter a size of at least 0.01 m.');
      return;
    }
    if (Math.abs(v - axis.size) < 0.0005) return;
    void run(studio.edit({ kind: 'resize', id: selected.id, sizes: { [index]: v }, anchor }));
  };

  const download = async () => {
    const bytes = await studio.currentBytes();
    downloadBlob(bytes, `${(studio.table?.project || 'model').replace(/[^\w-]+/g, '_')}-edited.ifc`, 'application/octet-stream');
  };

  return (
    <div>
      <Section title="History">
        <div className="flex flex-wrap gap-2">
          <button className={btnGhost} disabled={!studio.canUndo || busy} onClick={() => void studio.undo()} title="Undo the last change">
            <Undo2 size={13} className="inline mr-1" />Undo
          </button>
          <button className={btnGhost} disabled={!studio.canRedo || busy} onClick={() => void studio.redo()} title="Redo">
            <Redo2 size={13} className="inline mr-1" />Redo
          </button>
          <button className={btnPrimary} disabled={!studio.edited || busy || saving} onClick={() => void onSaveVersion()} title="Save the edited model as a new version in this chat">
            <Save size={13} className="inline mr-1" />{saving ? 'Saving…' : 'Save as version'}
          </button>
          <button className={btnGhost} disabled={busy} onClick={() => void download()} title="Download the edited IFC file">
            <Download size={13} className="inline mr-1" />IFC
          </button>
        </div>
        {studio.edited && <p className="text-[11px] text-white/50 mt-2">This model has changes that are not saved to a version yet.</p>}
      </Section>

      {!selected && (
        <div className="px-4 py-6 text-sm text-white/60 leading-relaxed">
          Click any element in the model to move it, resize it, rename it or delete it. The quantities, cost and checks update at once.
        </div>
      )}

      {selected && (
        <>
          <Section title="Selected">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-400">{humanClass(selected.cls, false)}</div>
            <div className="text-xs text-white/50 mb-2">{selected.storey ?? 'No level'}{selected.materials.length ? ` · ${selected.materials.join(', ')}` : ''}</div>
            <div className="flex gap-2">
              <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
              <button
                className={btnGhost}
                disabled={busy || name.trim() === selected.name}
                onClick={() => void run(studio.edit({ kind: 'rename', id: selected.id, name: name.trim() }))}
              >
                Rename
              </button>
            </div>
          </Section>

          <Section title="Size (metres)">
            {selectedInfo?.resizable ? (
              <>
                <div className="grid grid-cols-[1fr_88px] gap-x-3 gap-y-2 items-center">
                  {selectedInfo.axes.map((a) => (
                    <div key={a.index} className="contents">
                      <label className="text-sm text-white/70">{a.label}</label>
                      <input
                        className={`${input} text-right`}
                        inputMode="decimal"
                        disabled={busy}
                        value={sizes[a.index] ?? a.size.toFixed(2)}
                        onChange={(e) => setSizes((s) => ({ ...s, [a.index]: e.target.value }))}
                        onBlur={() => applySize(a.index)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex gap-1.5 mt-3 items-center">
                  <span className="text-[11px] text-white/50 mr-1">Keep</span>
                  {(['base', 'centre'] as const).map((a) => (
                    <button key={a} className={`${btn} ${anchor === a ? 'bg-blue-600 text-white' : 'bg-white/10 text-white/80'}`} onClick={() => setAnchor(a)}>
                      {a === 'base' ? 'the base fixed' : 'the centre fixed'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-white/40 mt-2">Type a size and press Enter.</p>
              </>
            ) : (
              <p className="text-sm text-white/60">{selectedInfo ? selectedInfo.reason : 'Reading what can be changed…'}</p>
            )}
          </Section>

          <Section title="Move">
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-[11px] text-white/50 mr-1">Step</span>
              {STEPS.map((s) => (
                <button key={s} className={`${btn} ${step === s ? 'bg-blue-600 text-white' : 'bg-white/10 text-white/80'}`} onClick={() => setStep(s)}>
                  {s} m
                </button>
              ))}
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 items-center">
              <span className="text-xs text-white/60">East / west</span>
              <div className="flex gap-1.5">
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(-1, 0, 0)}><ArrowLeft size={14} /></button>
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(1, 0, 0)}><ArrowRight size={14} /></button>
              </div>
              <span className="text-xs text-white/60">North / south</span>
              <div className="flex gap-1.5">
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(0, -1, 0)}><ArrowDown size={14} /></button>
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(0, 1, 0)}><ArrowUp size={14} /></button>
              </div>
              <span className="text-xs text-white/60">Up / down</span>
              <div className="flex gap-1.5">
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(0, 0, -1)}><ChevronsDown size={14} /></button>
                <button className={btnGhost} disabled={busy || !selectedInfo?.movable} onClick={() => void move(0, 0, 1)}><ChevronsUp size={14} /></button>
              </div>
            </div>
          </Section>

          <Section title="Remove">
            <button className={btnDanger} disabled={busy} onClick={() => void run(studio.edit({ kind: 'delete', ids: [selected.id] }))}>
              <Trash2 size={13} className="inline mr-1" />Delete this element
            </button>
            <p className="text-[11px] text-white/40 mt-2">Undo brings it back.</p>
          </Section>
        </>
      )}

      {busy && <div className="px-4 py-2 text-xs text-blue-300">Updating the model…</div>}
      {message && <div className="mx-4 my-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs p-2.5">{message}</div>}
    </div>
  );
}
