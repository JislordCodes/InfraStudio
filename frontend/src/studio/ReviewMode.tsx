import { useEffect, useRef, useState, type RefObject } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { IfcViewerHandle, PickedElement } from '../components/IfcViewer';
import { addComment, getReview, type Review } from '../lib/review';
import { pinsFor } from './reviewPins';
import { Spinner } from './ui';
import { btnPrimary, input } from './styles';
import { niceClass } from '../engine/schedule';

interface Props {
  reviewId: string;
  viewerRef: RefObject<IfcViewerHandle | null>;
  picked: PickedElement | null;
  onLoadModel: (url: string) => void;
}

const NAME_KEY = 'infrastudio_reviewer_name';

/** What a person sees when they open a share link: the model, a comment box and the comments so far. */
export function ReviewMode({ reviewId, viewerRef, picked, onLoadModel }: Props) {
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  });
  const [posting, setPosting] = useState(false);
  const loaded = useRef(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const r = await getReview(reviewId);
        if (!live) return;
        setReview(r);
        setError(null);
        if (!loaded.current) {
          loaded.current = true;
          onLoadModel(r.modelUrl);
        }
      } catch (e) {
        if (live && !loaded.current) setError(e instanceof Error ? e.message : 'Could not open this review.');
      }
    };
    void load();
    const t = window.setInterval(load, 10000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The model takes a while to appear, so place the pins again a few times after comments change.
  useEffect(() => {
    if (!review) return;
    const timers = [1500, 5000, 12000].map((ms) => window.setTimeout(() => void viewerRef.current?.setPins(pinsFor(review)), ms));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [review, viewerRef]);

  const post = async () => {
    if (!picked || !text.trim()) return;
    setPosting(true);
    setError(null);
    try {
      try {
        localStorage.setItem(NAME_KEY, author.trim());
      } catch {
        /* storage unavailable */
      }
      const r = await addComment(reviewId, {
        guid: picked.guid,
        elementName: picked.name || '',
        cls: picked.cls || '',
        text: text.trim(),
        author: author.trim() || 'Guest',
      });
      setReview(r);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post the comment.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="absolute left-3 top-[84px] bottom-3 z-20 w-[340px] max-w-[calc(100vw-1.5rem)] flex flex-col rounded-2xl border border-white/10 bg-neutral-900/92 backdrop-blur-xl shadow-2xl text-white pointer-events-auto overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 shrink-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-blue-400">Model review</div>
        <div className="text-sm font-medium truncate">{review?.title || 'Opening…'}</div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!review && !error && <Spinner label="Opening the review…" />}
        {error && !review && <div className="m-4 rounded-lg bg-red-500/15 border border-red-500/30 text-red-200 text-sm p-3">{error}</div>}

        {review && (
          <>
            <div className="px-4 py-3 border-b border-white/10">
              <p className="text-[13px] text-white/70 leading-relaxed mb-3">
                Click any part of the model to pick it, then write your comment. It is pinned to that part for everyone who has this link.
              </p>
              <div className={`rounded-lg p-2.5 mb-2 text-[12px] ${picked ? 'bg-blue-500/15 border border-blue-500/30' : 'bg-white/5 border border-white/10 text-white/50'}`}>
                {picked ? (
                  <>
                    <span className="text-blue-300 font-medium">{picked.cls ? niceClass(picked.cls) : 'Element'}</span>
                    {picked.name ? ` · ${picked.name}` : ''}
                  </>
                ) : (
                  'Nothing picked yet. Click the model.'
                )}
              </div>
              <input className={`${input} mb-2`} value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Your name" maxLength={60} />
              <textarea
                className={`${input} min-h-[84px] resize-y`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={picked ? 'What should change here?' : 'Pick a part of the model first'}
                maxLength={2000}
                disabled={!picked}
              />
              <button className={`${btnPrimary} mt-2`} disabled={!picked || !text.trim() || posting} onClick={() => void post()}>
                <MessageSquarePlus size={13} className="inline mr-1" />
                {posting ? 'Posting…' : 'Post comment'}
              </button>
              {error && <div className="mt-2 text-xs text-amber-200">{error}</div>}
            </div>

            <div className="px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-white/50 mb-2">Comments ({review.comments.length})</div>
              {review.comments.length === 0 && <p className="text-sm text-white/50">No comments yet.</p>}
              <div className="space-y-2">
                {review.comments.map((c, i) => (
                  <button
                    key={c.id}
                    className={`w-full text-left rounded-lg p-2.5 hover:bg-white/15 ${c.resolved ? 'bg-white/5 opacity-60' : 'bg-white/10'}`}
                    onClick={() => void viewerRef.current?.highlightGuids([c.guid], '#f59e0b', true)}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center ${c.resolved ? 'bg-gray-400 text-gray-900' : 'bg-amber-400 text-gray-900'}`}>{i + 1}</span>
                      <span className="text-[12px] font-medium truncate">{c.author}</span>
                      {c.resolved && <span className="text-[10px] text-emerald-300 ml-auto">Resolved</span>}
                    </div>
                    <div className="text-[11px] text-blue-300 mb-1 truncate">{c.elementName || c.cls}</div>
                    <div className="text-[13px] text-white/90 whitespace-pre-wrap break-words">{c.text}</div>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
