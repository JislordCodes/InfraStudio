import { useState } from 'react';
import { Send } from 'lucide-react';
import type { Studio } from './useStudio';
import { Section, Spinner } from './ui';
import { btnGhost, input } from './styles';
import { parseQuestion, runQuery, validateQuery, type Answer, type Query } from '../engine/query';
import type { ModelTable } from '../engine/types';
import { BACKEND_BASE } from '../lib/backend';

const EXAMPLES = [
  'How many doors are there?',
  'Total area of walls',
  'Which levels have no windows?',
  'List columns taller than 4 m',
  'How many fire doors?',
  'What is the total cost of slabs?',
];

/** Sends the question to the server when it was not understood on the device. */
async function askServer(question: string, table: ModelTable): Promise<{ query?: Query; note?: string }> {
  const classes = [...new Set(table.elements.map((e) => e.cls))];
  const materials = [...new Set(table.elements.flatMap((e) => e.materials))];
  const props = [...new Set(table.elements.flatMap((e) => Object.keys(e.props)))];
  const res = await fetch(`${BACKEND_BASE}/agent-bim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'ask_model',
      question,
      context: { classes, storeys: table.storeys.map((s) => s.name), materials, props },
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.unanswerable) return { note: String(data.unanswerable) };
  if (data?.status !== 'success') return { note: data?.error || 'I could not answer that.' };
  const query = validateQuery(data.query);
  return query ? { query } : { note: 'I could not turn that into a question the model can answer.' };
}

export function AskPanel({ studio }: { studio: Studio }) {
  const [q, setQ] = useState('');
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState<(Answer & { question: string }) | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (!studio.table) return <Spinner label="Reading the model…" />;
  const table = studio.table;

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question) return;
    setQ(question);
    setNote(null);
    setAnswer(null);
    setThinking(true);
    try {
      let query = parseQuestion(question, table);
      if (!query) {
        const r = await askServer(question, table);
        if (r.note) {
          setNote(r.note);
          return;
        }
        query = r.query ?? null;
      }
      if (!query) {
        setNote('I could not understand that question.');
        return;
      }
      const result = runQuery(table, query, studio.rates);
      setAnswer({ ...result, question });
      if (result.ids.length) void studio.show(result.ids, '#3b82f6');
      else void studio.show([], '#3b82f6', false);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setThinking(false);
    }
  };

  return (
    <div>
      <Section title="Ask about this model">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <input className={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Which levels have no windows?" />
          <button className="px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40" disabled={thinking || !q.trim()} type="submit" title="Ask">
            <Send size={15} />
          </button>
        </form>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {EXAMPLES.map((ex) => (
            <button key={ex} className={btnGhost} onClick={() => void ask(ex)}>{ex}</button>
          ))}
        </div>
      </Section>

      {thinking && <Spinner label="Working it out…" />}
      {note && <div className="mx-4 my-3 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 p-3">{note}</div>}

      {answer && (
        <Section title="Answer">
          <div className="text-sm text-white/95 mb-1">{answer.text}</div>
          {answer.ids.length > 0 && <div className="text-[11px] text-blue-300 mb-2">Shown in the model.</div>}
          {answer.rows.length > 0 && (
            <div className="rounded-lg border border-white/10 divide-y divide-white/10 text-[12px] max-h-[44vh] overflow-y-auto">
              {answer.rows.map((r, i) => (
                <button
                  key={`${r.label}-${i}`}
                  className="w-full flex justify-between gap-3 px-2.5 py-1.5 text-left hover:bg-white/5"
                  onClick={() => void studio.show(r.ids, '#3b82f6')}
                >
                  <span className="truncate">{r.label}</span>
                  <span className="text-white/60 shrink-0">{r.value}</span>
                </button>
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
