import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown } from 'lucide-react';
import { runGeminiAgentLoop } from '../hooks/useAgentLoop';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_details?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl }) => {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'assistant', content: "Hello! I'm your BIM Assistant powered by Gemini. Ask me to build anything — rooms, houses, offices." }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, expanded, currentSteps]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input.trim(),
    };

    let currentMessages = [...messages, userMsg];
    setMessages(currentMessages);
    setInput('');
    setIsLoading(true);
    setExpanded(true);
    setCurrentSteps([]);

    try {
      setCurrentSteps(['🤖 Agent starting...']);

      const result = await runGeminiAgentLoop(
        userMsg.content,
        (step: string) => {
          setCurrentSteps(prev => [...prev.slice(-15), step]);
        }
      );

      // Show final steps
      if (result.steps?.length > 0) setCurrentSteps(result.steps.slice(-10));

      // Auto-load IFC model if returned
      if (result.ifc_url && onLoadIfcUrl) {
        console.log('Auto-loading IFC model:', result.ifc_url);
        onLoadIfcUrl(result.ifc_url);
      }

      // Append final reply
      const replyText = result.reply || 'I have completed your request.';
      const finalMsg: Message = { id: Date.now().toString(), role: 'assistant', content: replyText };
      currentMessages = [...currentMessages, finalMsg];
      setMessages(currentMessages);
      setCurrentSteps([]);

    } catch (err) {
      console.error('Agent error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `⚠️ Agent failed: ${detail.slice(0, 300)}`,
      }]);
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  const hasMessages = messages.length > 1;

  // Filter messages for display (hide internal tool_calls and tool results, and massive background RAG/Execution context blocks)
  const displayableMessages = messages.filter(m => {
    if (m.role === 'user') {
       if (typeof m.content === 'string' && m.content.includes('[INFRASTUDIO_EXEC_ERROR]')) return false;
       return true;
    }
    if (m.role === 'assistant') {
       if (m.tool_calls) return false;
       if (typeof m.content === 'string' && m.content.includes('[INFRASTUDIO_RAG_DONE]')) return false;
       return true;
    }
    return false;
  });

  return (
    <div
      className="flex flex-col rounded-2xl overflow-hidden shadow-2xl border border-white/10"
      style={{
        background: 'rgba(10, 10, 15, 0.82)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
      }}
    >
      {/* Messages — only shown when expanded */}
      {expanded && hasMessages && (
        <div className="flex flex-col">
          {/* Collapse button */}
          <div className="flex justify-end px-3 pt-2">
            <button
              onClick={() => setExpanded(false)}
              title="Collapse chat"
              className="text-neutral-500 hover:text-white transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto px-4 pb-1 space-y-2 flex flex-col">
            {displayableMessages.map(msg => (
              <div key={msg.id} className={`flex items-end gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                    <Bot className="w-3 h-3 text-white" />
                  </div>
                )}
                <div
                  className={`max-w-[78%] rounded-2xl px-3 py-1.5 text-sm leading-snug ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-sm'
                      : 'bg-white/10 text-neutral-100 rounded-bl-sm'
                  }`}
                >
                  {msg.role === 'assistant' ? (
                    <div className="space-y-1">
                      {msg.reasoning_details && (
                        <details className="mb-2 text-xs text-neutral-400 bg-black/20 rounded p-2">
                          <summary className="cursor-pointer font-semibold text-neutral-300">Model Reasoning</summary>
                          <div className="mt-1 whitespace-pre-wrap">{msg.reasoning_details}</div>
                        </details>
                      )}
                      {msg.content.split('\n').map((line, i) => {
                        if (line.startsWith('✓')) return <div key={i} className="text-emerald-400 text-xs font-mono">{line}</div>;
                        if (line.startsWith('⚠')) return <div key={i} className="text-amber-400 text-xs font-mono">{line}</div>;
                        if (line.startsWith('✗')) return <div key={i} className="text-red-400 text-xs font-mono">{line}</div>;
                        if (line.trim() === '') return null;
                        return <div key={i}>{line}</div>;
                      })}
                    </div>
                  ) : msg.content}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex justify-start items-end gap-2">
                <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 mb-0.5">
                  <Bot className="w-3 h-3 text-white" />
                </div>
                <div className="bg-white/10 rounded-2xl rounded-bl-sm px-3 py-2 flex flex-col gap-2">
                  {currentSteps.length > 0 && (
                    <div className="space-y-1">
                      {currentSteps.map((line, i) => {
                        if (line.startsWith('✓')) return <div key={`step-${i}`} className="text-emerald-400 text-xs font-mono">{line}</div>;
                        if (line.startsWith('⚠')) return <div key={`step-${i}`} className="text-amber-400 text-xs font-mono">{line}</div>;
                        if (line.startsWith('✗')) return <div key={`step-${i}`} className="text-red-400 text-xs font-mono">{line}</div>;
                        if (line.trim() === '') return null;
                        return <div key={`step-${i}`} className="text-xs text-neutral-300 font-mono">{line}</div>;
                      })}
                    </div>
                  )}
                  <div className="flex gap-1 items-center">
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                    <span className="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSend}
        className="flex items-center gap-2 px-3 py-2.5"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => hasMessages && setExpanded(true)}
          placeholder="Ask about the IFC model..."
          className="flex-1 bg-transparent text-sm text-white placeholder-neutral-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 rounded-full text-white transition-colors"
        >
          <Send className="w-3.5 h-3.5 ml-0.5" />
        </button>
      </form>
    </div>
  );
};
