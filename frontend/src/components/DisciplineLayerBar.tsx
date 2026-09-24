import { Layers } from 'lucide-react';
import { DISCIPLINE_LABELS, type DisciplineBucket, type DisciplineGroup } from '../lib/discipline';

interface Props {
  groups: Partial<Record<DisciplineBucket, DisciplineGroup[]>>;
  dimmed: Set<DisciplineBucket>;
  theme: 'dark' | 'light';
  onToggle: (bucket: DisciplineBucket) => void;
  exploded: boolean;
  exploding: boolean;
  onToggleExplode: () => void;
}

const ORDER: DisciplineBucket[] = ['structure', 'envelope', 'mep', 'other'];

/** Top-center pill row - x-rays a discipline by fading it out rather than
 *  hiding it outright, so the rest of the model stays there for context, and
 *  a leading "Explode" pill vertically separates every present discipline
 *  into its own layer. Only rendered once 2+ disciplines actually exist in
 *  the loaded model(s); a single-discipline model (e.g. a bridge with
 *  structure only) has nothing worth toggling or exploding. */
export function DisciplineLayerBar({ groups, dimmed, theme, onToggle, exploded, exploding, onToggleExplode }: Props) {
  const present = ORDER.filter((bucket) => (groups[bucket]?.length ?? 0) > 0);
  if (present.length < 2) return null;

  const panelBg = theme === 'dark' ? 'bg-neutral-900/90 border-white/10' : 'bg-white/90 border-black/10';
  const mutedText = theme === 'dark' ? 'text-white/60 hover:text-white' : 'text-neutral-600 hover:text-neutral-900';
  const mutedHover = theme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/5';
  const divider = theme === 'dark' ? 'bg-white/15' : 'bg-black/15';

  return (
    <div
      className={`absolute top-3 sm:top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 px-1.5 py-1.5 rounded-full border shadow-lg backdrop-blur-xl pointer-events-auto ${panelBg}`}
    >
      <button
        onClick={onToggleExplode}
        disabled={exploding}
        className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full text-xs font-semibold transition-all active:scale-95 whitespace-nowrap disabled:opacity-60 disabled:cursor-wait ${
          exploded ? 'bg-blue-600 text-white shadow-sm hover:bg-blue-500' : `${mutedText} ${mutedHover}`
        }`}
        title={exploded ? 'Collapse back to the normal layout' : 'Explode - pull every discipline apart into its own layer'}
      >
        <Layers size={13} className={exploding ? 'animate-pulse' : ''} strokeWidth={2.5} />
        {exploding ? 'Exploding…' : exploded ? 'Collapse' : 'Explode'}
      </button>

      <div className={`h-4 w-px mx-0.5 rounded-full ${divider}`} />

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
