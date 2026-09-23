import { X, Box as BoxIcon, Layers, Ruler, MapPin } from 'lucide-react';

export interface InspectedProperty {
  name: string;
  value: string;
}

export interface InspectedPset {
  name: string;
  properties: InspectedProperty[];
}

export interface InspectedElement {
  category: string | null;
  name: string | null;
  guid: string | null;
  /** m³, from the model's actual geometry (FragmentsModel.getItemsVolume) - not a
   *  guess, and not dependent on the generation pipeline having written an
   *  IfcElementQuantity pset (most builds don't). */
  volume: number | null;
  dimensions: { x: number; y: number; z: number } | null;
  /** Material names resolved via the item's HasAssociations relation
   *  (IfcRelAssociatesMaterial) - the same real material the harness assigned
   *  during generation, not just the render color. */
  materials: string[];
  psets: InspectedPset[];
  /** Root-to-leaf, e.g. ["Site", "Building", "Level 01"] - falls back to the
   *  IFC category name for any ancestor that has no readable Name. */
  spatialPath: string[];
}

interface Props {
  data: InspectedElement | null;
  loading: boolean;
  theme: 'dark' | 'light';
  onClose: () => void;
}

const fmtNumber = (n: number): string =>
  n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3);

/** IfcWallStandardCase -> "Wall Standard Case". Falls back to the raw string
 *  for anything that doesn't match the usual Ifc-prefixed PascalCase shape.
 *  Exported so ModelSummaryPanel's category list reads the same way. */
export function humanizeCategory(category: string): string {
  const stripped = category.replace(/^Ifc/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced || category;
}

export function ElementInspector({ data, loading, theme, onClose }: Props) {
  if (!data && !loading) return null;

  const panelBg = theme === 'dark' ? 'bg-neutral-900/90 border-white/10 text-white' : 'bg-white/95 border-black/10 text-neutral-900';
  const mutedText = theme === 'dark' ? 'text-white/50' : 'text-neutral-500';
  const chipBg = theme === 'dark' ? 'bg-white/10 text-white/90' : 'bg-black/5 text-neutral-800';
  const rowBorder = theme === 'dark' ? 'border-white/10' : 'border-black/10';

  return (
    <div
      className={`absolute top-0 right-0 z-30 h-full w-[320px] sm:w-[360px] max-w-[85vw] backdrop-blur-xl border-l shadow-2xl overflow-y-auto pointer-events-auto transition-transform duration-200 ${panelBg}`}
    >
      <div className="sticky top-0 backdrop-blur-xl bg-inherit border-b px-4 py-3 flex items-start justify-between gap-2 border-inherit">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-blue-400">
            {loading ? 'Inspecting…' : data ? humanizeCategory(data.category || 'Element') : ''}
          </div>
          <div className="text-sm font-medium truncate">
            {loading ? 'Reading IFC data…' : data?.name || data?.category || 'Unnamed element'}
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
          <span className={mutedText}>Reading element data…</span>
        </div>
      )}

      {data && !loading && (
        <div className="p-4 space-y-4 text-sm">
          {/* Entity + IFC class - the actual proof this is a real IFC entity, not a mesh */}
          <section>
            <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
              <BoxIcon size={13} /> Entity
            </div>
            <div className="font-mono text-[13px]">{data.category || 'Unknown'}</div>
            {data.guid && <div className={`font-mono text-[11px] mt-0.5 truncate ${mutedText}`}>GUID: {data.guid}</div>}
          </section>

          {/* Spatial containment */}
          {data.spatialPath.length > 0 && (
            <section>
              <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                <MapPin size={13} /> Location
              </div>
              <div className="text-[13px] leading-relaxed">
                {data.spatialPath.join(' › ')}
              </div>
            </section>
          )}

          {/* Materials */}
          {data.materials.length > 0 && (
            <section>
              <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                <Layers size={13} /> Material{data.materials.length > 1 ? 's' : ''}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {data.materials.map((m, i) => (
                  <span key={i} className={`px-2 py-0.5 rounded-full text-[12px] ${chipBg}`}>{m}</span>
                ))}
              </div>
            </section>
          )}

          {/* Dimensions / quantities - real, computed from the actual geometry */}
          {(data.volume !== null || data.dimensions) && (
            <section>
              <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                <Ruler size={13} /> Quantities
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[13px]">
                {data.dimensions && (
                  <>
                    <div className={mutedText}>Width (X)</div><div>{fmtNumber(data.dimensions.x)} m</div>
                    <div className={mutedText}>Depth (Z)</div><div>{fmtNumber(data.dimensions.z)} m</div>
                    <div className={mutedText}>Height (Y)</div><div>{fmtNumber(data.dimensions.y)} m</div>
                  </>
                )}
                {data.volume !== null && (
                  <>
                    <div className={mutedText}>Volume</div><div>{fmtNumber(data.volume)} m³</div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Property sets - whatever the model actually carries */}
          {data.psets.length > 0 && (
            <section>
              <div className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${mutedText}`}>
                Property Sets
              </div>
              <div className="space-y-3">
                {data.psets.map((pset, i) => (
                  <div key={i}>
                    <div className="text-[12px] font-semibold mb-1">{pset.name}</div>
                    <div className={`rounded-lg border divide-y ${rowBorder}`}>
                      {pset.properties.map((p, j) => (
                        <div key={j} className="flex justify-between gap-3 px-2 py-1 text-[12px]">
                          <span className={mutedText}>{p.name}</span>
                          <span className="text-right truncate">{p.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
