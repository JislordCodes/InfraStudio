import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown, PanelLeftOpen, PanelLeftClose, Plus, MessageSquare, Loader2, Trash2, X, Download, Paperclip, Image as ImageIcon } from 'lucide-react';
import { runAntigravityBuild } from '../hooks/useMultiAgentLoop';
import { useSessions, type ChatMessage } from '../hooks/useSessions';
import { supabase } from '../lib/supabase';

interface AttachedImage {
  id: string;
  file: File;
  previewUrl: string;
  caption: string;
}

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
  /** Fired whenever the active session's model changes - including to `null`
   *  when switching to a session that doesn't have one yet - so a caller can
   *  show/hide something like a download button without duplicating session
   *  state of its own. */
  onActiveIfcUrlChange?: (url: string | null) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl, onActiveIfcUrlChange }) => {
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
  useEffect(() => {
    if (!activeSessionId) return;
    const session = sessions.find(s => s.id === activeSessionId);
    if (session?.last_ifc_url && onLoadIfcUrl) {
      onLoadIfcUrl(session.last_ifc_url);
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

  // ── Send ──

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && attachedImages.length === 0) || isLoading) return;

    // Every build call resets the MCP scene from scratch (Antigravity has no
    // edit mode in this pipeline) - sending a second message into a session
    // that already produced a model would silently overwrite it with
    // something unrelated. Block that here instead of losing work quietly.
    const currentSession = sessions.find(s => s.id === activeSessionId);
    if (currentSession?.last_ifc_url) {
      const warnMsg: ChatMessage = {
        role: 'assistant',
        content: '⚠️ This project already has a generated model. Building again here would overwrite it. Start a new project (tap "New" in the sidebar) to create something different.',
      };
      setMessages(prev => [...prev, warnMsg]);
      saveMessage(currentSession.id, warnMsg).catch(() => {});
      setInput('');
      setExpanded(true);
      return;
    }

    const userContent = input.trim() || 'Build a model based on the attached reference image(s).';
    const userMsg: ChatMessage = { role: 'user', content: userContent };
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

      setCurrentSteps(['🤖 Agent starting...']);

      const sessionObj = sessions.find(s => s.id === sid);
      const clientMcpId = sessionObj?.mcp_session_id || localStorage.getItem(`infrastudio_mcp_${sid}`) || '';

      const result = await runAntigravityBuild(
        userContent,
        clientMcpId,
        (step) => setCurrentSteps(prev => [...prev.slice(-12), step]),
        async (assistantObj: any) => {
          await saveMessage(sid!, {
            role: 'assistant',
            content: assistantObj.content || '',
            tool_calls: assistantObj.tool_calls,
          });
        },
        uploadedImages,
      );

      if (result.steps?.length) setCurrentSteps(result.steps.slice(-8));

      const reply: ChatMessage = { role: 'assistant', content: result.reply || 'Done.' };
      setMessages(prev => [...prev, reply]);
      await saveMessage(sid, reply);

      const activeMcpId = result.mcp_session_id || clientMcpId;
      if (activeMcpId) {
        localStorage.setItem(`infrastudio_mcp_${sid}`, activeMcpId);
      }
      if (activeMcpId || result.ifc_url) {
        await updateSessionData(sid, activeMcpId, result.ifc_url);
      }

      if (result.ifc_url && onLoadIfcUrl) {
        onLoadIfcUrl(result.ifc_url);
      }
      if (result.ifc_url) {
        onActiveIfcUrlChange?.(result.ifc_url);
      }

      setCurrentSteps([]);
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
                        </div>
                      ) : (
                        <span className="select-text cursor-text">{msg.content}</span>
                      )}
                    </div>
                  </div>
                ))
              )}

              {isLoading && (
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
              )}
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
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => (hasContent || loadingMessages) && setExpanded(true)}
            placeholder={attachedImages.length > 0 ? 'Add instructions (optional)...' : activeSession ? `Continue "${activeSession.title}"...` : 'Describe structure to build...'}
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
