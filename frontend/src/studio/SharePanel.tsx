import { useEffect, useRef, useState, type RefObject } from 'react';
import { Check, Copy, FileDown, Link2 } from 'lucide-react';
import type { IfcViewerHandle } from '../components/IfcViewer';
import type { Studio } from './useStudio';
import { Section } from './ui';
import { btnGhost, btnPrimary, input } from './styles';
import { pinsFor, remember } from './reviewPins';
import { buildBcf, createReview, downloadBlob, getReview, reviewLink, setResolved, type Review } from '../lib/review';

interface Props {
  studio: Studio;
  viewerRef: RefObject<IfcViewerHandle | null>;
  review: Review | null;
  setReview: (r: Review | null) => void;
}

export function SharePanel({ studio, viewerRef, review, setReview }: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [title, setTitle] = useState('');
  const reviewId = review?.id ?? null;
  const first = useRef(true);

  // Comments arrive from other people, so look for new ones while this panel is open.
  useEffect(() => {
    if (!reviewId) return;
    let live = true;
    const tick = async () => {
      try {
        const r = await getReview(reviewId);
        if (live) setReview(r);
      } catch {
        /* keep what is on screen */
      }
    };
    const t = window.setInterval(tick, 10000);
    if (first.current) {
      first.current = false;
      void tick();
    }
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [reviewId, setReview]);

  useEffect(() => {
    void viewerRef.current?.setPins(review ? pinsFor(review) : []);
  }, [review, viewerRef]);

  const create = async () => {
    setError(null);
    setCreating(true);
    try {
      // A model with unsaved edits is uploaded first, so the link shows exactly what is on screen.
      const url = studio.cleanUrl ?? (await studio.upload()).url;
      if (!studio.cleanUrl) studio.setCleanUrl(url);
      const r = await createReview(url, title.trim() || studio.table?.project || 'Shared model', studio.table?.project || '');
      remember(url, r.id);
      setReview(r);
      try {
        await navigator.clipboard.writeText(reviewLink(r.id));
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        /* clipboard not allowed, the link is on screen */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the link.');
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!review) return;
    try {
      await navigator.clipboard.writeText(reviewLink(review.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const exportBcf = () => {
    if (!review || !studio.table) return;
    const centres = new Map<string, [number, number, number]>();
    for (const e of studio.table.elements) {
      centres.set(e.guid, [(e.bbox[0] + e.bbox[3]) / 2, (e.bbox[1] + e.bbox[4]) / 2, (e.bbox[2] + e.bbox[5]) / 2]);
    }
    const bytes = buildBcf(review, centres);
    downloadBlob(bytes, `${(review.project || review.title || 'review').replace(/[^\w-]+/g, '_')}-comments.bcfzip`, 'application/zip');
  };

  const flip = async (id: string, resolved: boolean) => {
    if (!review) return;
    try {
      setReview(await setResolved(review.id, id, resolved));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update the comment.');
    }
  };

  const show = (guid: string) => {
    const rec = studio.table?.elements.find((e) => e.guid === guid);
    if (rec) void studio.show([rec.id], '#f59e0b');
  };

  return (
    <div>
      {!review ? (
        <Section title="Share this model">
          <p className="text-sm text-white/70 leading-relaxed mb-3">
            Send a link that opens the model in any browser, with no account and no install. People click a part of the building and leave a comment, and you see it pinned to that part.
          </p>
          <input className={`${input} mb-2`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={studio.table?.project || 'Name this review'} />
          <button className={btnPrimary} disabled={creating || studio.status !== 'ready'} onClick={() => void create()}>
            <Link2 size={13} className="inline mr-1" />
            {creating ? 'Creating link…' : studio.edited ? 'Create link with my edits' : 'Create share link'}
          </button>
        </Section>
      ) : (
        <>
          <Section title="Share link">
            <div className="text-sm font-medium mb-1 truncate">{review.title}</div>
            <div className="flex gap-2">
              <input className={`${input} text-[12px]`} readOnly value={reviewLink(review.id)} onFocus={(e) => e.currentTarget.select()} />
              <button className={btnPrimary} onClick={() => void copy()} title="Copy the link">
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-white/40 mt-2">Anyone with this link can view the model and comment. It shows the model as it was when you made the link.</p>
          </Section>

          <Section
            title={`Comments (${review.comments.length})`}
            right={
              <button className="text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-40" disabled={!review.comments.length} onClick={exportBcf}>
                <FileDown size={12} className="inline mr-1" />Export BCF
              </button>
            }
          >
            {review.comments.length === 0 && <p className="text-sm text-white/50">No comments yet. They appear here and as numbered pins in the model.</p>}
            <div className="space-y-2">
              {review.comments.map((c, i) => (
                <div key={c.id} className={`rounded-lg p-2.5 ${c.resolved ? 'bg-white/5 opacity-60' : 'bg-white/10'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${c.resolved ? 'bg-gray-400 text-gray-900' : 'bg-amber-400 text-gray-900'}`}>{i + 1}</span>
                    <span className="text-[12px] font-medium truncate">{c.author}</span>
                    <span className="text-[11px] text-white/40 ml-auto shrink-0">{new Date(c.created).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <div className="text-[11px] text-blue-300 mb-1 truncate">{c.elementName || c.cls}</div>
                  <div className="text-[13px] text-white/90 whitespace-pre-wrap break-words">{c.text}</div>
                  <div className="flex gap-1.5 mt-2">
                    <button className={btnGhost} onClick={() => show(c.guid)}>Show</button>
                    <button className={btnGhost} onClick={() => void flip(c.id, !c.resolved)}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
      {error && <div className="mx-4 my-2 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-200 text-xs p-2.5">{error}</div>}
    </div>
  );
}
