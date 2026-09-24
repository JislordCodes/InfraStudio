import { DISCIPLINE_LABELS, type DisciplineBucket, type DisciplineGroup } from '../lib/discipline';

interface Props {
  groups: Partial<Record<DisciplineBucket, DisciplineGroup[]>>;
  dimmed: Set<DisciplineBucket>;
  theme: 'dark' | 'light';
  onToggle: (bucket: DisciplineBucket) => void;
}

const ORDER: DisciplineBucket[] = ['structure', 'envelope', 'mep', 'other'];

/** Top-center pill row - x-rays a discipline by fading it out rather than
 *  hiding it outright, so the rest of the model stays there for context.
 *  Only rendered once 2+ disciplines actually exist in the loaded model(s);
 *  a single-discipline model (e.g. a bridge with structure only) has
 *  nothing worth toggling. */
export function DisciplineLayerBar({ groups, dimmed, theme, onToggle }: Props) {
  const present = ORDER.filter((bucket) => (groups[bucket]?.length ?? 0) > 0);
  if (present.length < 2) return null;

  const panelBg = theme === 'dark' ? 'bg-neutral-900/90 border-white/10' : 'bg-white/90 border-black/10';
  const mutedText = theme === 'dark' ? 'text-white/60 hover:text-white' : 'text-neutral-600 hover:text-neutral-900';
  const mutedHover = theme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/5';

  return (
    <div
      className={`absolute top-3 sm:top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 px-1.5 py-1.5 rounded-full border shadow-lg backdrop-blur-xl pointer-events-auto ${panelBg}`}
    >
      {present.map((bucket) => {
        const count = (groups[bucket] || []).reduce((sum, g) => sum + g.ids.length, 0);
        const isDimmed = dimmed.has(bucket);
        return (
          <button
            key={bucket}
            onClick={() => onToggle(bucket)}
            className={`px-2.5 sm:px-3 py-1.5 rounded-full text-xs font-semibold transition-all active:scale-95 whitespace-nowrap ${
              isDimmed ? `${mutedText} ${mutedHover}` : 'bg-blue-600 text-white shadow-sm hover:bg-blue-500'
            }`}
            title={isDimmed ? `Show ${DISCIPLINE_LABELS[bucket]} at full opacity` : `X-ray ${DISCIPLINE_LABELS[bucket]} (fade to 8% opacity)`}
          >
            {DISCIPLINE_LABELS[bucket]}
            <span className={isDimmed ? 'opacity-60' : 'opacity-75'}> {count}</span>
          </button>
        );
      })}
    </div>
  );
}
