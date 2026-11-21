import { useState } from 'react';
import type { Studio } from './useStudio';
import { Delta, Section, Spinner } from './ui';
import { btnGhost, money } from './styles';
import { CURRENCY, formatQuantity } from '../engine/schedule';

export function SchedulePanel({ studio }: { studio: Studio }) {
  const { schedule, baseline, overlaps } = studio;
  const [editRates, setEditRates] = useState(false);
  if (!schedule || !baseline) return <Spinner label="Measuring the model…" />;

  return (
    <div>
      <Section title="Whole model">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] text-white/50">Indicative cost ({CURRENCY})</div>
            <div className="text-xl font-semibold">{money(schedule.totalCost)}</div>
            <Delta now={schedule.totalCost} before={baseline.cost} unit="$" good="down" />
          </div>
          <div>
            <div className="text-[11px] text-white/50">Elements</div>
            <div className="text-xl font-semibold">{schedule.totalElements.toLocaleString('en-US')}</div>
            <Delta now={schedule.totalElements} before={baseline.elements} good="up" />
          </div>
          <div>
            <div className="text-[11px] text-white/50">Floor area (slabs)</div>
            <div className="text-base font-medium">{Math.round(schedule.floorArea).toLocaleString('en-US')} m²</div>
          </div>
          <div>
            <div className="text-[11px] text-white/50">Structural overlaps</div>
            <button
              className="text-base font-medium underline decoration-dotted underline-offset-2 disabled:no-underline"
              disabled={!overlaps.length}
              onClick={() => void studio.show(overlaps.flatMap((o) => [o.a, o.b]), '#f59e0b')}
              title="Show the overlapping elements"
            >
              {overlaps.length}
            </button>
            <Delta now={overlaps.length} before={baseline.overlaps} good="down" />
          </div>
        </div>
        <p className="text-[11px] text-white/40 mt-2">
          Costs use editable unit rates and are for early comparison only. Overlaps are structural elements sharing more than 15 cm of space.
        </p>
      </Section>

      <Section
        title="By element type"
        right={<button className="text-[11px] text-blue-400 hover:text-blue-300" onClick={() => setEditRates((v) => !v)}>{editRates ? 'Hide rates' : 'Edit rates'}</button>}
      >
        <div className="rounded-lg border border-white/10 divide-y divide-white/10 text-[12px]">
          <div className="grid grid-cols-[1.3fr_0.5fr_1fr_0.9fr] gap-2 px-2.5 py-1.5 text-white/50">
            <span>Type</span><span className="text-right">No.</span><span className="text-right">Quantity</span><span className="text-right">Cost</span>
          </div>
          {schedule.rows.map((r) => (
            <button
              key={r.cls}
              className="grid grid-cols-[1.3fr_0.5fr_1fr_0.9fr] gap-2 px-2.5 py-1.5 w-full text-left hover:bg-white/5"
              onClick={() => void studio.show(r.ids, '#3b82f6')}
              title="Show these in the model"
            >
              <span className="truncate capitalize">{r.label}</span>
              <span className="text-right text-white/70">{r.count}</span>
              <span className="text-right text-white/70">{formatQuantity(r.quantity, r.unit)}</span>
              <span className="text-right">{r.cost ? money(r.cost) : '-'}</span>
            </button>
          ))}
        </div>
      </Section>

      {editRates && (
        <Section title="Unit rates" right={<button className="text-[11px] text-blue-400" onClick={studio.resetRates}>Reset</button>}>
          <div className="space-y-1.5">
            {schedule.rows.filter((r) => studio.rates[r.cls]).map((r) => (
              <div key={r.cls} className="grid grid-cols-[1fr_92px] gap-2 items-center text-[12px]">
                <span className="capitalize text-white/70">{r.label} <span className="text-white/40">per {r.unit === 'm3' ? 'm³' : r.unit === 'm2' ? 'm²' : r.unit === 'm' ? 'm' : 'each'}</span></span>
                <input
                  type="number"
                  min={0}
                  className="w-full rounded-md bg-white/10 border border-white/10 px-2 py-1 text-right text-white outline-none focus:border-blue-500"
                  value={studio.rates[r.cls].rate}
                  onChange={(e) => studio.setRate(r.cls, Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="By level">
        <div className="rounded-lg border border-white/10 divide-y divide-white/10 text-[12px]">
          {schedule.storeys.map((s) => (
            <div key={s.storey} className="grid grid-cols-[1.6fr_0.5fr_0.9fr] gap-2 px-2.5 py-1.5">
              <span className="truncate">{s.storey}</span>
              <span className="text-right text-white/70">{s.count}</span>
              <span className="text-right">{s.cost ? money(s.cost) : '-'}</span>
            </div>
          ))}
        </div>
        <button className={`${btnGhost} mt-3`} onClick={() => void studio.show([], '#3b82f6', false)}>Clear highlight</button>
      </Section>
    </div>
  );
}
