import type { ReactNode } from 'react';

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="px-4 py-3 border-b border-white/10">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-white/50">{title}</div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Delta({ now, before, unit = '', good = 'down' }: { now: number; before: number; unit?: string; good?: 'up' | 'down' }) {
  const d = now - before;
  if (Math.abs(d) < 0.5) return null;
  const up = d > 0;
  const isGood = good === 'down' ? !up : up;
  return (
    <span className={`ml-1.5 text-[11px] font-medium ${isGood ? 'text-emerald-400' : 'text-amber-400'}`}>
      {up ? '+' : '-'}
      {unit}
      {Math.abs(d) >= 1000 ? Math.round(Math.abs(d)).toLocaleString('en-US') : Math.abs(d).toFixed(0)} since opened
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-white/70 p-4">
      <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      {label}
    </div>
  );
}
