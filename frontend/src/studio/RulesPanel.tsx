import { useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import type { Studio } from './useStudio';
import { Section, Spinner } from './ui';
import { btnGhost, btnPrimary } from './styles';
import type { Finding } from '../engine/rules';

export function RulesPanel({ studio }: { studio: Studio }) {
  const { rules, busy } = studio;
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!rules) return <Spinner label="Checking the model…" />;

  const fixable = rules.findings.filter((f) => f.fix);
  const failing = rules.findings.filter((f) => f.severity === 'fail').length;

  const showFinding = (f: Finding) => {
    const ids = [...(f.elementId != null ? [f.elementId] : []), ...(f.extraIds ?? [])];
    void studio.show(ids, f.severity === 'fail' ? '#ef4444' : '#f59e0b');
  };

  const fix = async (f: Finding) => {
    if (!f.fix) return;
    setMessage(null);
    const err = await studio.edit(f.fix.op);
    if (err) setMessage(err);
  };

  const fixAll = async () => {
    setMessage(null);
    const err = await studio.editMany(fixable.map((f) => f.fix!.op));
    if (err) setMessage(err);
  };

  return (
    <div>
      <Section title="Result">
        <div className="flex items-center gap-2 text-sm">
          {rules.findings.length === 0 ? (
            <><CheckCircle2 size={16} className="text-emerald-400" /> Every check passes.</>
          ) : (
            <>{failing > 0 ? <XCircle size={16} className="text-red-400" /> : <AlertTriangle size={16} className="text-amber-400" />} {failing} to fix, {rules.findings.length - failing} to look at.</>
          )}
        </div>
        {fixable.length > 0 && (
          <button className={`${btnPrimary} mt-3`} disabled={busy} onClick={() => void fixAll()}>
            Fix {fixable.length} {fixable.length === 1 ? 'problem' : 'problems'} automatically
          </button>
        )}
        <p className="text-[11px] text-white/40 mt-2">
          A screening check against common International Building Code values, for early design. It is not a compliance certificate.
        </p>
      </Section>

      <Section title="Checks">
        <div className="rounded-lg border border-white/10 divide-y divide-white/10 text-[12px]">
          {rules.summaries.map((s) => (
            <div key={s.rule.id}>
              <button
                className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-white/5"
                onClick={() => setOpen(open === s.rule.id ? null : s.rule.id)}
              >
                {s.checked === 0 ? (
                  <span className="w-3.5 h-3.5 rounded-full border border-white/30" />
                ) : s.failed === 0 ? (
                  <CheckCircle2 size={14} className="text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle size={14} className="text-amber-400 shrink-0" />
                )}
                <span className="flex-1">{s.rule.title}</span>
                <span className="text-white/40">{s.checked === 0 ? 'nothing to check' : s.failed === 0 ? `${s.checked} ok` : `${s.failed} of ${s.checked}`}</span>
              </button>
              {open === s.rule.id && (
                <div className="px-2.5 pb-2 space-y-1.5">
                  <div className="text-[11px] text-white/40">{s.rule.source}</div>
                  {rules.findings.filter((f) => f.rule === s.rule.id).slice(0, 30).map((f, i) => (
                    <div key={i} className="rounded-md bg-white/5 p-2">
                      <div className="text-[12px] text-white/90">{f.elementName}</div>
                      <div className="text-[11px] text-white/60">{f.message}</div>
                      <div className="flex gap-1.5 mt-1.5">
                        <button className={btnGhost} onClick={() => showFinding(f)}>Show</button>
                        {f.fix && <button className={btnPrimary} disabled={busy} onClick={() => void fix(f)}>{f.fix.label}</button>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>
      {message && <div className="mx-4 my-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs p-2.5">{message}</div>}
    </div>
  );
}
