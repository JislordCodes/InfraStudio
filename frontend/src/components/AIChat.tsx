import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, PanelLeftOpen, PanelLeftClose, Plus, MessageSquare, Loader2, Trash2, X, Download, Paperclip, Image as ImageIcon, History } from 'lucide-react';
import { runAntigravityBuild, clarifyBrief, type ActiveBuildState, type ClarifyQuestion } from '../hooks/useMultiAgentLoop';
import { useSessions, type ChatMessage } from '../hooks/useSessions';
import { supabase } from '../lib/supabase';
import { addVersion, listVersions, type IfcVersion } from '../lib/versions';
import { STAGES, nextStage, stageIndex, loadStageState, saveStageState, clearStageState, loadStagedPref, saveStagedPref, type StageId } from '../lib/stages';

interface AttachedImage {
  id: string;
  file: File;
  previewUrl: string;
  caption: string;
}

// ── Resumable build persistence ──────────────────────────────────────────
// A build keeps running on the box regardless of whether this tab is open
// (see ec2/setup_mcp_slots.sh + antigravity_agent.ts's 3-slot queue) - saving
// everything needed to resume polling means closing the tab (as the queue
// banner explicitly invites people to do) never loses the build. localStorage
// on purpose, not sessionStorage: it must survive the tab actually closing.
const ACTIVE_BUILD_KEY = 'infrastudio_active_build';
// Anything older than this is treated as abandoned (box replaced, or the job
// errored before ever writing a status) so a stale entry can't resurrect
// itself forever - comfortably past the 800-pass/~3hr poll ceiling.
const ACTIVE_BUILD_MAX_AGE_MS = 4 * 60 * 60 * 1000;

/** What to record in version history / the staged workflow once a build finishes. */
interface BuildMeta {
  label?: string;
  stage?: string;
  projectBrief?: string;
}

interface PersistedActiveBuild {
  sid: string;
  userContent: string;
  continuation: any;
  sessionId: string;
  meta?: BuildMeta;
  ts: number;
}

function loadActiveBuild(): PersistedActiveBuild | null {
  try {
    const raw = localStorage.getItem(ACTIVE_BUILD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedActiveBuild;
    if (!parsed?.continuation || !parsed.sid) return null;
    if (Date.now() - (parsed.ts || 0) > ACTIVE_BUILD_MAX_AGE_MS) {
      localStorage.removeItem(ACTIVE_BUILD_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveActiveBuild(record: Omit<PersistedActiveBuild, 'ts'>) {
  try {
    localStorage.setItem(ACTIVE_BUILD_KEY, JSON.stringify({ ...record, ts: Date.now() }));
  } catch { /* storage full/unavailable - just no resume, not fatal */ }
}

function clearActiveBuild() {
  try { localStorage.removeItem(ACTIVE_BUILD_KEY); } catch { /* ignore */ }
}

/** A clarifying-questions exchange waiting for the user's answer. */
interface PendingClarify {
  brief: string;
  answers: string[];
  questions: ClarifyQuestion[];
  round: number;
  images: { url: string; caption?: string }[];
}

/** Short replies that mean "stop asking, just build" (only honoured while questions are pending). */
const SKIP_REPLY_RE = /^\s*(skip|just build|build( it)?( now)?|use (the |sensible )?defaults?|defaults?|go ahead|you decide|up to you|whatever)\b/i;

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
  /** Fired whenever the active session's model changes - including to `null`
   *  when switching to a session that doesn't have one yet - so a caller can
   *  show/hide something like a download button without duplicating session
   *  state of its own. */
  onActiveIfcUrlChange?: (url: string | null) => void;
  /** Fired when the user switches to a chat that has no model yet, so the
   *  viewer doesn't keep showing the previous chat's model. */
  onClearModel?: () => void;
  /** An IFC file picked with the viewer's upload button: imported as a new
   *  editable project. */
  importRequest?: File | null;
  onImportHandled?: () => void;
  /** Import couldn't be stored for editing - the caller can still show it read-only. */
  onImportFailed?: (file: File) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl, onActiveIfcUrlChange, onClearModel, importRequest, onImportHandled, onImportFailed }) => {
  const {
    sessions,
    activeSessionId,
    setActiveSessionId,
    messages,
    setMessages,
    loadingMessages,
    createSession,
    deleteSession,
    saveMessage,
    updateSessionData,
  } = useSessions();

  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth < 640 : false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [isUploadingImages, setIsUploadingImages] = useState(false);
  const [stagedPref, setStagedPref] = useState<boolean>(() => loadStagedPref());
  const [versions, setVersions] = useState<IfcVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  // Bumped to re-render when the per-chat stage state (kept in localStorage) changes.
  const [, setStageTick] = useState(0);
  const importingRef = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Reference image attachments (floor plans, sketches, aerial views, etc.) ──

  const handleFilesSelected = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const next: AttachedImage[] = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .map(f => ({ id: `${Date.now()}-${f.name}-${Math.random().toString(36).slice(2, 8)}`, file: f, previewUrl: URL.createObjectURL(f), caption: '' }));
    if (next.length) setAttachedImages(prev => [...prev, ...next]);
  };

  const removeAttachedImage = (id: string) => {
    setAttachedImages(prev => {
      const found = prev.find(img => img.id === id);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter(img => img.id !== id);
    });
  };

  const updateImageCaption = (id: string, caption: string) => {
    setAttachedImages(prev => prev.map(img => img.id === id ? { ...img, caption } : img));
  };

  // Uploads every attached image to the public "reference-images" Supabase
  // Storage bucket and returns their public URLs - Antigravity runs headless
  // on a remote EC2 box with no access to the browser's local files, so the
  // image has to live somewhere fetchable by URL before the build can see it.
  const uploadAttachedImages = async (images: AttachedImage[]): Promise<{ url: string; caption?: string }[]> => {
    const results: { url: string; caption?: string }[] = [];
    for (const img of images) {
      const ext = img.file.name.split('.').pop() || 'jpg';
      const path = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const { error } = await supabase.storage.from('reference-images').upload(path, img.file, {
        contentType: img.file.type || 'image/jpeg',
        upsert: false,
      });
      if (error) throw new Error(`Failed to upload ${img.file.name}: ${error.message}`);
      const { data } = supabase.storage.from('reference-images').getPublicUrl(path);
      results.push({ url: data.publicUrl, caption: img.caption.trim() || undefined });
    }
    return results;
  };

  // Responsive window resize listener
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 640);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (expanded) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, expanded, currentSteps]);

  // When active session changes — load IFC into viewer & expand chat
  // Kept current every render so async callbacks (a build finishing, a resumed
  // build) can tell whether their chat is still the one on screen.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const prevSessionRef = useRef<string | null>(null);

  // Version history follows the active chat.
  useEffect(() => {
    setViewingVersion(null);
    setShowHistory(false);
    if (!activeSessionId) { setVersions([]); return; }
    void refreshVersions(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) return;
    const switched = prevSessionRef.current !== null && prevSessionRef.current !== activeSessionId;
    prevSessionRef.current = activeSessionId;
    const session = sessions.find(s => s.id === activeSessionId);
    if (session?.last_ifc_url && onLoadIfcUrl) {
      onLoadIfcUrl(session.last_ifc_url);
    } else if (switched && !importingRef.current) {
      // The chat we switched to has no model: empty the viewer rather than
      // leaving the previous chat's model on screen.
      onClearModel?.();
    }
    // Always fire, including with null - a session with no model yet must
    // clear any download affordance left over from a previously active one.
    onActiveIfcUrlChange?.(session?.last_ifc_url || null);
    if (messages.length > 0 || loadingMessages) {
      setExpanded(true);
    }
  }, [activeSessionId, sessions.length, loadingMessages]);

  // Expand when messages finish loading
  useEffect(() => {
    if (!loadingMessages && messages.length > 0 && activeSessionId) {
      setExpanded(true);
    }
  }, [loadingMessages, messages.length, activeSessionId]);

  // ── Session Actions ──

  const handleSelectSession = (id: string) => {
    if (id === activeSessionId) return;
    setActiveSessionId(id);
    setConfirmDeleteId(null);
    if (isMobile) setShowSidebar(false);
  };

  const handleNewSession = async () => {
    try {
      await createSession('Design ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }));
      setExpanded(true);
      setShowSidebar(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (confirmDeleteId === id) {
      deleteSession(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => setConfirmDeleteId(null), 3000);
    }
  };

  // ── Shared build result handling (used by both a fresh send and a resumed
  //    build picked back up after the tab was closed and reopened) ──

  const applyBuildResult = async (result: Awaited<ReturnType<typeof runAntigravityBuild>>, sid: string, meta?: BuildMeta) => {
    // A second tab (or a remount) can resume the same in-flight build; whichever
    // finishes first applies it, the other must not repeat the messages/versions.
    const jobKey = result.mcp_session_id && result.ifc_url ? `infrastudio_applied_${result.mcp_session_id}` : null;
    try {
      if (jobKey && localStorage.getItem(jobKey)) {
        setCurrentSteps([]);
        return;
      }
      if (jobKey) localStorage.setItem(jobKey, '1');
    } catch { /* storage unavailable - apply normally */ }

    if (result.steps?.length) setCurrentSteps(result.steps.slice(-8));

    const reply: ChatMessage = { role: 'assistant', content: result.reply || 'Done.' };
    // Saved to its own chat below either way; only shown live if still on screen.
    if (sid === activeSessionIdRef.current) setMessages(prev => [...prev, reply]);
    await saveMessage(sid, reply);

    const activeMcpId = result.mcp_session_id;
    if (activeMcpId) {
      localStorage.setItem(`infrastudio_mcp_${sid}`, activeMcpId);
    }
    if (activeMcpId || result.ifc_url) {
      await updateSessionData(sid, activeMcpId, result.ifc_url);
    }

    // Every successful build/edit/stage becomes a version users can compare and roll back to.
    if (result.ifc_url) {
      await addVersion(sid, {
        ifc_url: result.ifc_url,
        label: meta?.label || 'Initial build',
        stage: meta?.stage,
        element_count: result.element_count,
        file_size: result.file_size,
      });
      await refreshVersions(sid);
    }

    // The build may finish after the user switched to another chat. It is
    // already saved on its own session above (shown when they switch back), so
    // only touch the viewer if this chat is still the active one.
    if (sid === activeSessionIdRef.current) {
      setViewingVersion(null);
      if (result.ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(result.ifc_url);
      }
      if (result.ifc_url) {
        onActiveIfcUrlChange?.(result.ifc_url);
      }
    }

    // Staged workflow: this stage is now on screen, waiting for review/approval.
    if (meta?.stage && result.ifc_url) {
      const st = loadStageState(sid);
      saveStageState(sid, {
        stage: meta.stage as StageId,
        approved: st?.approved ?? [],
        brief: meta.projectBrief || st?.brief || '',
      });
      setStageTick(t => t + 1);
      const idx = stageIndex(meta.stage);
      const cur = STAGES[idx];
      const nxt = idx >= 0 ? nextStage(meta.stage as StageId) : null;
      if (cur) {
        await appendAssistant(sid, {
          role: 'assistant',
          content: `✓ ${cur.label} stage ready (${idx + 1} of ${STAGES.length}). Look it over in the viewer. Ask for changes (e.g. "make it taller"), or approve to ${nxt ? `continue to ${nxt.label}` : 'finish'}.`,
        });
      }
    }

    setCurrentSteps([]);
  };

  // Auto-resume a build that was still queued or running when this browser
  // last closed the tab (see the queue banner's "close this tab" message) -
  // runs once on mount, before the user does anything. The build itself never
  // stopped on the box; this just reconnects the polling loop to it.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    resumedRef.current = true;
    const saved = loadActiveBuild();
    if (!saved) return;

    if (saved.sid !== activeSessionId) setActiveSessionId(saved.sid);
    setExpanded(true);
    setIsLoading(true);
    setCurrentSteps(['🔄 Reconnecting to your build...']);

    (async () => {
      try {
        const result = await runAntigravityBuild(
          saved.userContent,
          '',
          (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
          async (assistantObj: any) => {
            await saveMessage(saved.sid, {
              role: 'assistant',
              content: assistantObj.content || '',
              tool_calls: assistantObj.tool_calls,
            });
          },
          [],
          { continuation: saved.continuation, sessionId: saved.sessionId },
          (state: ActiveBuildState | null) => {
            if (state) saveActiveBuild({ sid: saved.sid, userContent: saved.userContent, continuation: state.continuation, sessionId: state.sessionId, meta: saved.meta });
            else clearActiveBuild();
          },
        );
        await applyBuildResult(result, saved.sid, saved.meta);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const errMsg: ChatMessage = { role: 'assistant', content: `⚠️ Agent failed: ${detail.slice(0, 300)}` };
        setMessages(prev => [...prev, errMsg]);
        await saveMessage(saved.sid, errMsg);
        setCurrentSteps([]);
      } finally {
        setIsLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Clarifying questions (pre-build design conversation) ──
  // A vague brief gets a few short questions before anything is built; the
  // pending exchange lives in localStorage per chat so a reload mid-answer
  // doesn't lose the original brief.

  const loadPendingClarify = (sid: string): PendingClarify | null => {
    try {
      const raw = localStorage.getItem(`infrastudio_clarify_${sid}`);
      return raw ? (JSON.parse(raw) as PendingClarify) : null;
    } catch {
      return null;
    }
  };
  const savePendingClarify = (sid: string, p: PendingClarify) => {
    try { localStorage.setItem(`infrastudio_clarify_${sid}`, JSON.stringify(p)); } catch { /* ignore */ }
  };
  const clearPendingClarify = (sid: string) => {
    try { localStorage.removeItem(`infrastudio_clarify_${sid}`); } catch { /* ignore */ }
  };

  const formatQuestions = (questions: ClarifyQuestion[], round: number): string => {
    const lines = questions.map((q, i) => {
      const opts = q.options.length ? ` (${q.options.join(' / ')})` : '';
      const def = q.default ? ` — default: ${q.default}` : '';
      return `${i + 1}. ${q.question}${opts}${def}`;
    });
    const intro = round <= 1
      ? 'A few quick questions so I get the design right:'
      : 'Thanks. Just a couple more:';
    return `${intro}\n\n${lines.join('\n')}\n\nAnswer in one message (e.g. "30 storeys, steel frame, podium"), or skip and I'll use the defaults.`;
  };

  const appendAssistant = async (sid: string, msg: ChatMessage) => {
    if (sid === activeSessionIdRef.current) setMessages(prev => [...prev, msg]);
    await saveMessage(sid, { role: msg.role, content: msg.content });
  };

  // ── Send ──

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    void submitText(input);
  };

  /** Resume bookkeeping for one build: remembers what's needed to reconnect
   *  to it (and what to record in version history when it finishes). */
  const persistFor = (sid: string, brief: string, meta?: BuildMeta) => (state: ActiveBuildState | null) => {
    if (state) saveActiveBuild({ sid, userContent: brief, continuation: state.continuation, sessionId: state.sessionId, meta });
    else clearActiveBuild();
  };

  const submitText = async (rawText: string, opts: { stageOverride?: StageId; displayText?: string } = {}) => {
    if ((!rawText.trim() && attachedImages.length === 0) || isLoading) return;

    const userContent = rawText.trim() || 'Build a model based on the attached reference image(s).';
    const userMsg: ChatMessage = { role: 'user', content: opts.displayText || userContent };
    const imagesToUpload = attachedImages;

    setIsLoading(true);
    setExpanded(true);
    setInput('');
    setAttachedImages([]);
    setCurrentSteps(['🚀 Initializing session...']);

    let sid = activeSessionId;

    try {
      let uploadedImages: { url: string; caption?: string }[] = [];
      if (imagesToUpload.length > 0) {
        setIsUploadingImages(true);
        setCurrentSteps(['📎 Uploading reference image(s)...']);
        try {
          uploadedImages = await uploadAttachedImages(imagesToUpload);
        } finally {
          setIsUploadingImages(false);
          imagesToUpload.forEach(img => URL.revokeObjectURL(img.previewUrl));
        }
      }

      if (!sid) {
        try {
          const s = await createSession(userContent.slice(0, 40) || 'New Design');
          sid = s.id;
        } catch {
          sid = 'session_' + Date.now();
          setActiveSessionId(sid);
        }
      }

      setMessages(prev => [...prev, userMsg]);
      saveMessage(sid, userMsg).catch(err => console.warn('saveMessage non-fatal:', err));

      const sessionObj = sessions.find(s => s.id === sid);
      const clientMcpId = sessionObj?.mcp_session_id || localStorage.getItem(`infrastudio_mcp_${sid}`) || '';

      // ── Edit the existing / imported model in place ──
      // A chat that already has a model keeps refining it: the model is loaded
      // into the build scene and only the requested change is made. If an older
      // version is on screen, the edit starts from THAT version.
      const viewed = viewingVersion != null ? versions.find(v => v.version === viewingVersion) : undefined;
      const baseUrl = viewed?.ifc_url || sessionObj?.last_ifc_url || undefined;
      if (baseUrl) {
        const st = loadStageState(sid);
        const stage = opts.stageOverride ?? st?.stage;
        const meta: BuildMeta = { label: (opts.displayText || userContent).slice(0, 120), stage, projectBrief: st?.brief };
        // A model that predates version history has no v1: save it as the
        // baseline first so the user can always roll back to what they had.
        if (versions.length === 0) {
          await addVersion(sid, { ifc_url: baseUrl, label: 'Original model' });
        }
        setCurrentSteps(['✏️ Editing your model...']);
        const sidEdit = sid;
        const result = await runAntigravityBuild(
          userContent,
          clientMcpId,
          (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
          async (assistantObj: any) => {
            await saveMessage(sidEdit, { role: 'assistant', content: assistantObj.content || '', tool_calls: assistantObj.tool_calls });
          },
          uploadedImages,
          undefined,
          persistFor(sid, userContent, meta),
          { baseIfcUrl: baseUrl, stage, projectBrief: st?.brief },
        );
        await applyBuildResult(result, sid, meta);
        return;
      }

      // ── Clarify before building ──
      const pending = loadPendingClarify(sid);
      const skip = !!pending && userContent.length <= 60 && SKIP_REPLY_RE.test(userContent);
      const allImages = [...(pending?.images || []), ...uploadedImages];
      setCurrentSteps(['🧠 Reviewing your brief...']);
      const answers = pending ? [...pending.answers, ...(skip ? [] : [userContent])] : [];
      const clarified = await clarifyBrief({
        client_requirements: pending ? pending.brief : userContent,
        answers: answers.join('\n'),
        round: pending ? pending.round : 0,
        skip,
        has_images: allImages.length > 0,
        questions_asked: pending?.questions,
      });

      if (clarified.needs_clarification) {
        savePendingClarify(sid, {
          brief: pending ? pending.brief : userContent,
          answers,
          questions: clarified.questions,
          round: clarified.round,
          images: allImages,
        });
        await appendAssistant(sid, {
          role: 'assistant',
          content: formatQuestions(clarified.questions, clarified.round),
        });
        setCurrentSteps([]);
        return;
      }

      clearPendingClarify(sid);
      const buildBrief = clarified.refined_brief?.trim() || (pending ? pending.brief : userContent);
      if (clarified.assumptions.length > 0) {
        await appendAssistant(sid, {
          role: 'assistant',
          content: `Got it, building now. Anything not specified, I'm assuming:\n${clarified.assumptions.map(a => `• ${a}`).join('\n')}`,
        });
      }

      // Staged mode: this first build is the MASSING stage only; later stages
      // are approved and built one at a time as edits of the previous result.
      const staged = stagedPref;
      const meta: BuildMeta | undefined = staged ? { label: 'Massing', stage: 'massing', projectBrief: buildBrief } : undefined;
      setCurrentSteps([staged ? '🧱 Stage 1: massing...' : '🤖 Agent starting...']);

      const sidForPersist = sid;
      const result = await runAntigravityBuild(
        buildBrief,
        clientMcpId,
        (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
        async (assistantObj: any) => {
          await saveMessage(sid!, {
            role: 'assistant',
            content: assistantObj.content || '',
            tool_calls: assistantObj.tool_calls,
          });
        },
        allImages,
        undefined,
        persistFor(sidForPersist, buildBrief, meta),
        staged ? { stage: 'massing', projectBrief: buildBrief } : undefined,
      );

      await applyBuildResult(result, sid, meta);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const errMsg: ChatMessage = { role: 'assistant', content: `⚠️ Agent failed: ${detail.slice(0, 300)}` };
      setMessages(prev => [...prev, errMsg]);
      if (sid) {
        await saveMessage(sid, errMsg);
      }
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  // ── Staged design: approve the stage on screen and build the next one ──

  const approveStage = async () => {
    if (isLoading || !activeSessionId) return;
    const sid = activeSessionId;
    const st = loadStageState(sid);
    if (!st) return;
    const cur = STAGES[stageIndex(st.stage)];
    const nxt = nextStage(st.stage);
    if (!nxt) {
      clearStageState(sid);
      setStageTick(t => t + 1);
      await appendAssistant(sid, {
        role: 'assistant',
        content: '✓ All five stages approved - the design is complete. Keep refining it with follow-up requests, or download the IFC.',
      });
      return;
    }
    saveStageState(sid, { ...st, approved: st.approved.includes(st.stage) ? st.approved : [...st.approved, st.stage] });
    setStageTick(t => t + 1);
    await submitText(
      `Approved the ${cur.label} stage. Now design the ${nxt.label} stage (${nxt.blurb}).`,
      { stageOverride: nxt.id, displayText: `✓ Approve ${cur.label} → continue to ${nxt.label}` },
    );
  };

  // ── Version history ──

  const refreshVersions = async (sid: string) => {
    const list = await listVersions(sid);
    if (sid === activeSessionIdRef.current) setVersions(list);
  };

  const viewVersion = (v: IfcVersion) => {
    setViewingVersion(v.version);
    onLoadIfcUrl?.(v.ifc_url);
  };

  const backToLatest = () => {
    setViewingVersion(null);
    const url = sessions.find(s => s.id === activeSessionId)?.last_ifc_url;
    if (url) onLoadIfcUrl?.(url);
  };

  const restoreVersion = async (v: IfcVersion) => {
    const sid = activeSessionId;
    if (!sid || isLoading) return;
    await updateSessionData(sid, undefined, v.ifc_url);
    await addVersion(sid, {
      ifc_url: v.ifc_url,
      label: `Restored v${v.version}`,
      stage: v.stage ?? undefined,
      element_count: v.element_count ?? undefined,
      file_size: v.file_size ?? undefined,
    });
    setViewingVersion(null);
    onActiveIfcUrlChange?.(v.ifc_url);
    onLoadIfcUrl?.(v.ifc_url);
    await refreshVersions(sid);
    await appendAssistant(sid, { role: 'assistant', content: `↩ Restored version ${v.version}. New edits will build on it.` });
  };

  // ── Import an external IFC project and iterate on it ──

  const importIfc = async (file: File) => {
    if (isLoading) return;
    importingRef.current = true;
    setExpanded(true);
    setIsLoading(true);
    setCurrentSteps([`📥 Importing ${file.name}...`]);
    try {
      const path = `imports/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.ifc`;
      const { error } = await supabase.storage.from('ifc-models').upload(path, file, { contentType: 'application/octet-stream', upsert: false });
      if (error) throw new Error(error.message);
      const url = supabase.storage.from('ifc-models').getPublicUrl(path).data.publicUrl;

      const title = `Imported - ${file.name.replace(/\.ifc$/i, '')}`.slice(0, 40);
      const s = await createSession(title);
      await updateSessionData(s.id, undefined, url);
      await addVersion(s.id, { ifc_url: url, label: `Imported ${file.name}` });
      clearStageState(s.id);
      setStageTick(t => t + 1);
      onActiveIfcUrlChange?.(url);
      onLoadIfcUrl?.(url);
      await refreshVersions(s.id);
      await appendAssistant(s.id, {
        role: 'assistant',
        content: `✓ Imported ${file.name}. It's loaded in the viewer. Tell me what to change, for example "add a floor" or "widen the deck" - everything you don't mention stays as it is.`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn('[import] failed:', detail);
      onImportFailed?.(file);
      const sid = activeSessionIdRef.current;
      const msg: ChatMessage = { role: 'assistant', content: `⚠️ Couldn't import ${file.name} for editing (${detail.slice(0, 160)}). It's shown in the viewer, but it can't be edited.` };
      setMessages(prev => [...prev, msg]);
      if (sid) await saveMessage(sid, { role: msg.role, content: msg.content });
    } finally {
      importingRef.current = false;
      setCurrentSteps([]);
      setIsLoading(false);
    }
  };

  // The App hands over a file picked with the viewer's upload button.
  useEffect(() => {
    if (importRequest) {
      onImportHandled?.();
      void importIfc(importRequest);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importRequest]);

  const displayMsgs = messages.filter(m => {
    if (m.role === 'user') return true;
    if (m.role === 'assistant') {
      if (m.tool_calls) return false;
      if (!m.content || m.content.trim() === '') return false;
      return true;
    }
    return false;
  });

  const hasContent = displayMsgs.length > 0;
  const activeSession = sessions.find(s => s.id === activeSessionId);
  // Read straight from storage each render (cheap); setStageTick forces a refresh after changes.
  const stageState = activeSessionId ? loadStageState(activeSessionId) : null;
  const nextStageInfo = stageState ? nextStage(stageState.stage) : null;

  // ── Render ──

  // Collapsed: a single floating button, nothing else in the DOM - pressing it
  // opens the full panel below. A small dot signals there's an existing
  // conversation worth reopening, distinct from the pulsing spinner used
  // while a build is actively running.
  if (!expanded) {
    return (
      <button
        onClick={() => {
          setExpanded(true);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="relative flex items-center justify-center w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 active:scale-90 text-white shadow-2xl shadow-blue-600/40 border border-blue-400/30 transition-all pointer-events-auto"
        title="Open chat"
      >
        {isLoading ? <Loader2 className="w-6 h-6 animate-spin" /> : <Bot className="w-6 h-6" />}
        {hasContent && !isLoading && (
          <span className="absolute top-0.5 right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-neutral-950" />
        )}
      </button>
    );
  }

  return (
    <div className="flex z-10 max-w-2xl w-full relative" style={{ isolation: 'isolate' }}>

      {/* ═══ Projects Sidebar (Desktop: floating side panel; Mobile: clean overlay drawer) ═══ */}
      <div
        className={`flex flex-col rounded-2xl overflow-hidden border border-white/10 z-30 transition-all duration-200 ${
          isMobile
            ? `fixed inset-x-3 bottom-16 top-16 bg-neutral-950/98 backdrop-blur-2xl ${showSidebar ? 'opacity-100 pointer-events-auto scale-100' : 'opacity-0 pointer-events-none scale-95'}`
            : `absolute bottom-0 left-0 ${showSidebar ? 'w-[220px] opacity-100 pointer-events-auto -translate-x-[228px]' : 'w-0 opacity-0 pointer-events-none translate-x-0'}`
        }`}
        style={{
          maxHeight: isMobile ? 'calc(100dvh - 120px)' : '420px',
          background: 'rgba(12, 12, 18, 0.98)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
        }}
      >
        {/* Sidebar Header */}
        <div className="flex items-center justify-between px-3.5 py-3 border-b border-white/10 shrink-0">
          <span className="text-xs font-bold text-neutral-300 uppercase tracking-wider">Projects</span>
          <div className="flex items-center gap-2">
            <button onClick={handleNewSession} title="New Project" className="px-2.5 py-1 flex items-center gap-1 rounded-lg bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-xs font-medium transition-all">
              <Plus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
            {isMobile && (
              <button onClick={() => setShowSidebar(false)} className="p-1 rounded-lg text-neutral-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Sidebar Project List */}
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-1">
          {sessions.length === 0 ? (
            <p className="text-center text-neutral-500 text-xs mt-8 px-2 leading-relaxed">
              No projects yet.<br/>Send a message to start building.
            </p>
          ) : (
            sessions.map(s => {
              const isActive = s.id === activeSessionId;
              const isConfirming = confirmDeleteId === s.id;
              return (
                <div
                  key={s.id}
                  onClick={() => handleSelectSession(s.id)}
                  className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl cursor-pointer transition-all ${
                    isActive
                      ? 'bg-blue-600/25 text-white font-semibold border border-blue-500/30'
                      : 'text-neutral-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-60" />
                  <span className="text-xs truncate flex-1">{s.title || 'Untitled Project'}</span>
                  {isActive && s.last_ifc_url && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0 shadow-[0_0_8px_rgba(52,211,153,0.8)]" title="Has IFC 3D Model" />
                  )}
                  <button
                    onClick={(e) => handleDeleteClick(e, s.id)}
                    title={isConfirming ? 'Confirm delete' : 'Delete'}
                    className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-all ${
                      isConfirming
                        ? 'bg-red-500/30 text-red-300 opacity-100'
                        : 'opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400'
                    }`}
                  >
                    {isConfirming ? <X className="w-3.5 h-3.5" /> : <Trash2 className="w-3 h-3" />}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ═══ Main Chat Container ═══ */}
      <div
        className="flex-1 flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10 w-full"
        style={{
          background: 'rgba(10, 10, 15, 0.92)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
        }}
      >
        {/* Expanded Chat Messages Panel */}
        {expanded && (
          <div className="flex flex-col min-h-0">
            {/* Header Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 gap-2">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <button
                  onClick={() => setShowSidebar(v => !v)}
                  className={`p-1.5 rounded-lg transition-colors shrink-0 ${showSidebar ? 'text-white bg-white/15' : 'text-neutral-400 hover:text-white'}`}
                  title="Toggle Projects"
                >
                  {showSidebar ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
                </button>
                {activeSession && (
                  <span className="text-xs text-neutral-400 truncate font-medium max-w-[130px] sm:max-w-[200px]">
                    {activeSession.title}
                  </span>
                )}
                {activeSession?.last_ifc_url && (
                  <a
                    href={activeSession.last_ifc_url}
                    download={`model-${activeSession.title.toLowerCase().replace(/\s+/g, '-')}.ifc`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600/35 hover:bg-blue-600/60 text-blue-200 text-[10px] sm:text-xs font-bold transition-all border border-blue-400/30 shrink-0"
                    title="Download 3D IFC Model"
                  >
                    <Download className="w-3 h-3" />
                    <span className="hidden xs:inline">Download IFC</span>
                    <span className="xs:hidden">IFC</span>
                  </a>
                )}
                {versions.length > 0 && (
                  <button
                    onClick={() => setShowHistory(v => !v)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] sm:text-xs font-semibold border shrink-0 transition-all ${showHistory ? 'bg-white/15 text-white border-white/20' : 'text-neutral-300 border-white/10 hover:bg-white/10'}`}
                    title="Version history"
                  >
                    <History className="w-3 h-3" />
                    <span>v{viewingVersion ?? versions[versions.length - 1].version}</span>
                  </button>
                )}
                <div
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 text-[10px] sm:text-xs font-medium border border-emerald-500/20 shrink-0"
                  title="InfraStudio Engine (High Reasoning)"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>🧠 InfraStudio Engine</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-200 uppercase font-semibold">High</span>
                </div>
              </div>
              <button onClick={() => setExpanded(false)} className="p-1 text-neutral-400 hover:text-white transition-colors shrink-0">
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>

            {/* Version history: view, compare and roll back */}
            {showHistory && versions.length > 0 && (
              <div className="px-3 py-2 border-b border-white/5 max-h-[30vh] overflow-y-auto space-y-1">
                {viewingVersion != null && (
                  <div className="flex items-center justify-between gap-2 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-400/20 rounded-lg px-2 py-1">
                    <span>Viewing v{viewingVersion}. Your next edit builds from it.</span>
                    <button onClick={backToLatest} className="underline shrink-0">Back to latest</button>
                  </div>
                )}
                {[...versions].reverse().map((v, i, arr) => {
                  const prev = arr[i + 1];
                  const delta = prev && v.element_count != null && prev.element_count != null ? v.element_count - prev.element_count : null;
                  const latest = v.version === versions[versions.length - 1].version;
                  const shown = (viewingVersion ?? versions[versions.length - 1].version) === v.version;
                  return (
                    <div key={v.id} className={`flex items-center gap-2 text-[11px] rounded-lg px-2 py-1 border ${shown ? 'bg-blue-600/20 border-blue-400/30 text-white' : 'border-white/5 text-neutral-300'}`}>
                      <span className="font-bold shrink-0">v{v.version}</span>
                      <span className="truncate flex-1" title={v.label || ''}>
                        {v.stage ? `[${v.stage}] ` : ''}{v.label || 'Build'}
                      </span>
                      <span className="shrink-0 text-neutral-400 hidden sm:inline">
                        {v.element_count != null ? `${v.element_count.toLocaleString()} el` : ''}
                        {delta != null && delta !== 0 ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}
                        {v.file_size != null ? ` · ${(v.file_size / 1048576).toFixed(1)} MB` : ''}
                      </span>
                      {!shown && <button onClick={() => viewVersion(v)} className="shrink-0 underline text-blue-300">View</button>}
                      {!latest && <button onClick={() => void restoreVersion(v)} disabled={isLoading} className="shrink-0 underline text-emerald-300 disabled:opacity-40">Restore</button>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Messages Scroll Area */}
            <div className="overflow-y-auto px-3 py-2.5 space-y-2.5 max-h-[35vh] sm:max-h-[280px] select-text">
              {loadingMessages ? (
                <div className="flex items-center justify-center gap-2 h-20">
                  <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-xs text-neutral-400">Loading conversation...</span>
                </div>
              ) : !hasContent && !isLoading ? (
                <div className="flex items-center justify-center h-16">
                  <span className="text-xs text-neutral-500">Send a message to generate your 3D BIM model.</span>
                </div>
              ) : (
                displayMsgs.map((msg, idx) => (
                  <div key={msg.id || `msg-${idx}`} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    {msg.role === 'assistant' && (
                      <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mb-0.5 shadow-sm">
                        <Bot className="w-3 h-3 text-white" />
                      </div>
                    )}
                    <div className={`max-w-[85%] sm:max-w-[78%] rounded-2xl px-3.5 py-2 text-xs sm:text-sm leading-relaxed select-text cursor-text ${
                      msg.role === 'user' ? 'bg-blue-600 text-white rounded-br-xs' : 'bg-white/10 text-neutral-100 rounded-bl-xs border border-white/5'
                    }`}>
                      {msg.role === 'assistant' ? (
                        <div className="space-y-1 select-text cursor-text">
                          {(msg.content || '').split('\n').map((line, i) => {
                            if (!line.trim()) return null;
                            if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono select-text">{line}</div>;
                            if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono select-text">{line}</div>;
                            if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono select-text">{line}</div>;
                            return <div key={i} className="select-text">{line}</div>;
                          })}
                          {msg.cta && (
                            <a
                              href={msg.cta.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 mt-1 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 active:scale-95 text-white text-xs font-semibold transition-all"
                            >
                              {msg.cta.label} →
                            </a>
                          )}
                        </div>
                      ) : (
                        <span className="select-text cursor-text">{msg.content}</span>
                      )}
                    </div>
                  </div>
                ))
              )}

              {/* Quick reply while clarifying questions are waiting for an answer. Derived
                  from the pending state (not stored on the message) so it survives a reload. */}
              {!isLoading && !loadingMessages && activeSessionId && loadPendingClarify(activeSessionId) && (
                <div className="flex justify-start pl-7">
                  <button
                    type="button"
                    onClick={() => void submitText('Skip the questions and use sensible defaults')}
                    className="px-3 py-1.5 rounded-full bg-white/10 hover:bg-white/20 active:scale-95 border border-white/10 text-neutral-100 text-xs font-medium transition-all"
                  >
                    Skip — use defaults
                  </button>
                </div>
              )}

              {isLoading && (() => {
                const latestStep = currentSteps[currentSteps.length - 1] || '';
                // Queue messages come from the backend prefixed with 🕒 (see
                // antigravity_agent.ts's pollAntigravityBuild) - shown as a
                // distinct highlighted banner instead of the usual scrolling
                // build-progress lines, since "we're full, come back later"
                // is a different kind of message than normal build chatter.
                const isQueued = latestStep.startsWith('🕒');
                if (isQueued) {
                  return (
                    <div className="flex justify-start items-end gap-2">
                      <div className="w-5 h-5 rounded-full bg-amber-500 flex items-center justify-center shrink-0 mb-0.5">
                        <Bot className="w-3 h-3 text-white" />
                      </div>
                      <div className="bg-amber-500/10 border border-amber-400/30 rounded-2xl rounded-bl-xs px-4 py-3 flex flex-col gap-1 max-w-[85%] sm:max-w-[78%] select-text cursor-text">
                        <div className="text-xs font-semibold text-amber-300">We're at capacity right now</div>
                        <div className="text-xs text-amber-100/90 leading-snug select-text">{latestStep.replace(/^🕒\s*/, '')}</div>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="flex justify-start items-end gap-2">
                    <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mb-0.5">
                      <Bot className="w-3 h-3 text-white" />
                    </div>
                    <div className="bg-white/10 rounded-2xl rounded-bl-xs px-3.5 py-2.5 flex flex-col gap-1.5 max-w-[85%] sm:max-w-[78%] border border-white/5 select-text cursor-text">
                      {currentSteps.slice(-4).map((line, i) => (
                        <div key={i} className="text-xs text-neutral-200 font-mono leading-tight select-text">{line}</div>
                      ))}
                      <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin mt-1" />
                    </div>
                  </div>
                );
              })()}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        {/* Attached Reference Images (floor plans, sketches, aerial views, schematics) */}
        {attachedImages.length > 0 && (
          <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 border-t border-white/5 overflow-x-auto">
            {attachedImages.map(img => (
              <div key={img.id} className="relative shrink-0 group">
                <img src={img.previewUrl} alt="attached reference" className="w-14 h-14 rounded-lg object-cover border border-white/15" />
                <button
                  type="button"
                  onClick={() => removeAttachedImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-red-500 text-white shadow-md"
                  title="Remove image"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
                <input
                  type="text"
                  value={img.caption}
                  onChange={(e) => updateImageCaption(img.id, e.target.value)}
                  placeholder="label (e.g. floor plan)"
                  className="mt-1 w-14 bg-transparent text-[9px] text-neutral-400 placeholder-neutral-600 focus:outline-none text-center truncate"
                />
              </div>
            ))}
          </div>
        )}

        {/* Staged design progress: massing -> zones -> facade -> structure -> detail */}
        {stageState && !loadingMessages && (
          <div className="flex items-center gap-2 px-3 py-2 border-t border-white/5">
            <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
              {STAGES.map(st => {
                const done = stageState.approved.includes(st.id);
                const current = stageState.stage === st.id;
                return (
                  <span
                    key={st.id}
                    title={st.blurb}
                    className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                      current ? 'bg-blue-600/30 text-blue-200 border-blue-400/40'
                      : done ? 'bg-emerald-500/15 text-emerald-300 border-emerald-400/20'
                      : 'text-neutral-500 border-white/10'}`}
                  >
                    {done ? '✓ ' : ''}{st.label}
                  </span>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => void approveStage()}
              disabled={isLoading}
              className="shrink-0 px-3 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:opacity-40 text-white text-[11px] font-semibold transition-all"
            >
              {nextStageInfo ? `Approve → ${nextStageInfo.label}` : 'Approve & finish'}
            </button>
          </div>
        )}

        {/* Chat Input Bar (16px text-base on mobile prevents iOS auto-zoom) */}
        <form onSubmit={handleSend} className={`flex items-center gap-2 px-3 py-2.5 ${attachedImages.length > 0 ? '' : 'border-t border-white/5'}`}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { handleFilesSelected(e.target.files); e.target.value = ''; }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Attach floor plan, sketch, aerial view, or schematic"
            className="p-1.5 text-neutral-400 hover:text-white transition-colors shrink-0 disabled:opacity-30"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          {!activeSession?.last_ifc_url && !stageState && (
            <button
              type="button"
              onClick={() => { const n = !stagedPref; setStagedPref(n); saveStagedPref(n); }}
              disabled={isLoading}
              title="Staged design: build massing, zones, facade, structure and detail one step at a time, reviewing each before moving on"
              className={`shrink-0 px-2 py-1 rounded-full text-[10px] font-semibold border transition-all disabled:opacity-30 ${stagedPref ? 'bg-blue-600/30 text-blue-200 border-blue-400/40' : 'text-neutral-400 border-white/10 hover:text-white'}`}
            >
              Staged
            </button>
          )}
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => (hasContent || loadingMessages) && setExpanded(true)}
            placeholder={attachedImages.length > 0 ? 'Add instructions (optional)...' : activeSession?.last_ifc_url ? 'Describe a change (e.g. "add a floor")...' : activeSession ? `Continue "${activeSession.title}"...` : 'Describe structure to build...'}
            className="flex-1 bg-transparent text-base sm:text-sm text-white placeholder-neutral-500 focus:outline-none py-1"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={(!input.trim() && attachedImages.length === 0) || isLoading}
            className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center bg-blue-600 hover:bg-blue-500 active:scale-95 disabled:opacity-30 rounded-full text-white transition-all shadow-md"
          >
            {isUploadingImages ? <ImageIcon className="w-4 h-4 animate-pulse" /> : <Send className="w-4 h-4 ml-0.5" />}
          </button>
        </form>
      </div>
    </div>
  );
};
