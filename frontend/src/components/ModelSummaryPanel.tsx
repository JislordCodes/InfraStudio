import { X, Boxes, Ruler, ChartBar } from 'lucide-react';
import { humanizeCategory } from './ElementInspector';

export interface CategoryCount {
  category: string;
  count: number;
}

export interface ModelSummaryData {
  /** Sum of every category's count below - excludes pure spatial containers
   *  (Project/Site/Building/Storey), which aren't "built" elements. */
  totalElements: number;
  /** Sorted highest count first. */
  categories: CategoryCount[];
  /** m³, summed across every element with resolvable geometry - null if the
   *  model exposed nothing to sum. */
  totalVolume: number | null;
  /** Overall bounding-box footprint, X x Z - the site's built extent, not a
   *  true gross floor area (that needs per-storey IfcElementQuantity psets
   *  most generated models don't carry). */
  footprint: { x: number; z: number } | null;
  height: number | null;
}

interface Props {
  data: ModelSummaryData | null;
  loading: boolean;
  theme: 'dark' | 'light';
  onClose: () => void;
}

const fmtNumber = (n: number): string =>
  n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);

export function ModelSummaryPanel({ data, loading, theme, onClose }: Props) {
  if (!data && !loading) return null;

  const panelBg = theme === 'dark' ? 'bg-neutral-900/90 border-white/10 text-white' : 'bg-white/95 border-black/10 text-neutral-900';
  const mutedText = theme === 'dark' ? 'text-white/50' : 'text-neutral-500';
  const barTrack = theme === 'dark' ? 'bg-white/10' : 'bg-black/5';
  const rowBorder = theme === 'dark' ? 'border-white/10' : 'border-black/10';

  const maxCount = data?.categories[0]?.count || 1;

  return (
    <div
      className={`absolute top-0 right-0 z-30 h-full w-[320px] sm:w-[360px] max-w-[85vw] backdrop-blur-xl border-l shadow-2xl overflow-y-auto pointer-events-auto transition-transform duration-200 ${panelBg}`}
    >
      <div className="sticky top-0 backdrop-blur-xl bg-inherit border-b px-4 py-3 flex items-start justify-between gap-2 border-inherit">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-400">Model Summary</div>
          <div className="text-sm font-medium truncate">
            {loading ? 'Counting elements…' : `${data?.totalElements ?? 0} elements`}
          </div>
        </div>
        <button
          onClick={onClose}
          className={`shrink-0 p-1.5 rounded-lg hover:bg-blue-600 hover:text-white transition-colors ${mutedText}`}
          title="Close"
        >
          <X size={16} strokeWidth={2.5} />
        </button>
      </div>

      {loading && (
        <div className="p-4 flex items-center gap-2 text-sm">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className={mutedText}>Reading model data…</span>
        </div>
      )}

      {data && !loading && (
        <div className="p-4 space-y-4 text-sm">
          {/* Overall quantities - proves this is a real, measured model. */}
          {(data.totalVolume !== null || data.footprint) && (
            <section>
              <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                <Ruler size={13} /> Quantities
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
                {data.footprint && (
                  <>
                    <div className={mutedText}>Footprint (X)</div><div>{fmtNumber(data.footprint.x)} m</div>
                    <div className={mutedText}>Footprint (Z)</div><div>{fmtNumber(data.footprint.z)} m</div>
                  </>
                )}
                {data.height !== null && (
                  <>
                    <div className={mutedText}>Height (Y)</div><div>{fmtNumber(data.height)} m</div>
                  </>
                )}
                {data.totalVolume !== null && (
                  <>
                    <div className={mutedText}>Total Volume</div><div>{fmtNumber(data.totalVolume)} m³</div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Per-class element counts - the actual "how many real IFC entities" tally. */}
          {data.categories.length > 0 && (
            <section>
              <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                <Boxes size={13} /> Elements by Class
              </div>
              <div className={`rounded-lg border divide-y ${rowBorder}`}>
                {data.categories.map((c) => (
                  <div key={c.category} className="px-2.5 py-1.5">
                    <div className="flex justify-between gap-3 text-[12px] mb-1">
                      <span className="truncate">{humanizeCategory(c.category)}</span>
                      <span className={`shrink-0 font-mono ${mutedText}`}>{c.count}</span>
                    </div>
                    <div className={`h-1 rounded-full overflow-hidden ${barTrack}`}>
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${Math.max(4, (c.count / maxCount) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.categories.length === 0 && (
            <div className={`flex items-center gap-1.5 ${mutedText}`}>
              <ChartBar size={14} /> No countable elements found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
