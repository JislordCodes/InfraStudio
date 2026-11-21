export const btn =
  'px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all active:scale-95 disabled:opacity-40 disabled:pointer-events-none';
export const btnPrimary = `${btn} bg-blue-600 hover:bg-blue-500 text-white`;
export const btnGhost = `${btn} bg-white/10 hover:bg-white/20 text-white/90`;
export const btnDanger = `${btn} bg-red-600/80 hover:bg-red-500 text-white`;
export const input =
  'w-full rounded-lg bg-white/10 border border-white/10 px-2.5 py-1.5 text-sm text-white placeholder-white/40 outline-none focus:border-blue-500';

export const money = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n).toLocaleString('en-US')}`;
