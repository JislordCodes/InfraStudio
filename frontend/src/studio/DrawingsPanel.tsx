import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileDown, X } from 'lucide-react';
import type { Studio } from './useStudio';
import { Section, Spinner } from './ui';
import { btnGhost, btnPrimary } from './styles';
import { layoutSheet, planLevels, sheetsToPdf, sheetToSvg, type Sheet } from '../engine/drawings';
import { downloadBlob } from '../lib/review';

interface Made {
  sheet: Sheet;
  url: string;
}

export function DrawingsPanel({ studio }: { studio: Studio }) {
  const [made, setMade] = useState<Made[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState<Made | null>(null);
  const urls = useRef<string[]>([]);
  const forModel = useRef<unknown>(null);

  // Drawings describe one version of the model. A change makes them out of date.
  useEffect(() => {
    if (forModel.current && forModel.current !== studio.table) {
      for (const u of urls.current) URL.revokeObjectURL(u);
      urls.current = [];
      setMade([]);
    }
  }, [studio.table]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const table = studio.table;
  if (!table || !studio.engine) return <Spinner label="Reading the model…" />;
  const engine = studio.engine;

  const generate = async () => {
    setError(null);
    setMade([]);
    for (const u of urls.current) URL.revokeObjectURL(u);
    urls.current = [];
    const out: Made[] = [];
    try {
      const project = table.project || 'Untitled project';
      const levels = planLevels(table, 6);
      let n = 1;
      for (const lv of levels) {
        setProgress(`Cutting the plan for ${lv.names[0]}…`);
        const cut = await engine.slice(studio.engineKey, { kind: 'plan', z: lv.elevation + 1.2 });
        const sheet = layoutSheet({
          segments: cut.segments, kind: 'plan', project, number: `A-${100 + n}`,
          title: `${lv.names.join(' / ')} plan`,
        });
        const url = URL.createObjectURL(new Blob([sheetToSvg(sheet)], { type: 'image/svg+xml' }));
        urls.current.push(url);
        out.push({ sheet, url });
        n++;
      }
      if (table.bbox) {
        const b = table.bbox;
        const marks = table.storeys.map((s) => ({ name: s.name, elevation: s.elevation }));
        const cuts: { plane: { kind: 'sectionY'; y: number } | { kind: 'sectionX'; x: number }; title: string }[] = [
          { plane: { kind: 'sectionY', y: (b[1] + b[4]) / 2 }, title: 'Long section' },
          { plane: { kind: 'sectionX', x: (b[0] + b[3]) / 2 }, title: 'Cross section' },
        ];
        let m = 1;
        for (const c of cuts) {
          setProgress(`Cutting the ${c.title.toLowerCase()}…`);
          const cut = await engine.slice(studio.engineKey, c.plane);
          const sheet = layoutSheet({ segments: cut.segments, kind: 'section', project, number: `A-${200 + m}`, title: c.title, levels: marks });
          const url = URL.createObjectURL(new Blob([sheetToSvg(sheet)], { type: 'image/svg+xml' }));
          urls.current.push(url);
          out.push({ sheet, url });
          m++;
        }
      }
      forModel.current = table;
      setMade(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make the drawings.');
    } finally {
      setProgress(null);
    }
  };

  const pdf = async () => {
    setProgress('Building the PDF…');
    try {
      const blob = await sheetsToPdf(made.map((m) => m.sheet));
      downloadBlob(blob, `${(table.project || 'drawings').replace(/[^\w-]+/g, '_')}-drawings.pdf`, 'application/pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not build the PDF.');
    } finally {
      setProgress(null);
    }
  };

  return (
    <div>
      <Section title="Drawings from this model">
        <p className="text-sm text-white/70 leading-relaxed mb-3">
          Plans for each level and two sections, cut from the model as it is now, with scale, dimensions, north arrow and title block on A3 sheets.
        </p>
        <div className="flex gap-2">
          <button className={btnPrimary} disabled={!!progress} onClick={() => void generate()}>{made.length ? 'Make them again' : 'Make drawings'}</button>
          <button className={btnGhost} disabled={!made.length || !!progress} onClick={() => void pdf()}>
            <FileDown size={13} className="inline mr-1" />PDF
          </button>
        </div>
        {studio.edited && made.length === 0 && <p className="text-[11px] text-white/40 mt-2">These will include your edits.</p>}
      </Section>
      {progress && <Spinner label={progress} />}
      {error && <div className="mx-4 my-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs p-2.5">{error}</div>}

      {made.length > 0 && (
        <Section title={`${made.length} sheets`}>
          <div className="grid grid-cols-2 gap-2.5">
            {made.map((m) => (
              <button key={m.sheet.number} className="text-left rounded-lg overflow-hidden bg-white border border-white/20 hover:border-blue-400" onClick={() => setBig(m)}>
                <img src={m.url} alt={m.sheet.title} className="w-full block" />
                <div className="px-2 py-1 bg-neutral-100 text-neutral-800 text-[11px] flex justify-between gap-2">
                  <span className="truncate">{m.sheet.title}</span>
                  <span className="shrink-0 text-neutral-500">{m.sheet.scale}</span>
                </div>
              </button>
            ))}
          </div>
        </Section>
      )}

      {big && createPortal(
        <div className="fixed inset-0 z-[20000] bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-4" onClick={() => setBig(null)}>
          <div className="w-full max-w-[1400px] flex justify-between items-center text-white mb-2" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium">{big.sheet.number} · {big.sheet.title} · {big.sheet.scale}</div>
            <button className="p-2 rounded-lg bg-white/10 hover:bg-white/20" onClick={() => setBig(null)}><X size={16} /></button>
          </div>
          <img src={big.url} alt={big.sheet.title} className="max-h-[88vh] max-w-full bg-white rounded-md shadow-2xl" onClick={(e) => e.stopPropagation()} />
        </div>
        , document.body)}
    </div>
  );
}
