import React, { useState, useRef, useEffect } from 'react';
import { Send, Bot, ChevronDown } from 'lucide-react';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_details?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

// Map our internal roles
const toGeminiRole = (role: 'user' | 'assistant' | 'tool') => {
  if (role === 'tool') return 'tool';
  return role === 'assistant' ? 'assistant' : 'user';
};

interface AIChatProps {
  onLoadIfcUrl?: (url: string) => void;
}

export const AIChat: React.FC<AIChatProps> = ({ onLoadIfcUrl }) => {
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'assistant', content: "Hello! I'm your BIM Assistant powered by Gemini AI. Ask me anything about this model." }
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

    let accumSteps: string[] = [];

    try {
      let isCompleted = false;
      let turnCount = 0;
      
      while (!isCompleted && turnCount < 20) {
        turnCount++;
        
        // Build conversation history for the AI
        const history = currentMessages
          .filter(m => m.id !== '1')  // exclude the static welcome message
          .map(m => {
            const out: any = { role: toGeminiRole(m.role), content: m.content || "" };
            if (m.reasoning_details) out.reasoning_details = m.reasoning_details;
            if (m.tool_calls) out.tool_calls = m.tool_calls;
            if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
            return out;
          });

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 180000); // 180s max per API turn

        const res = await fetch('https://gitfkenmwzrldzqunvww.supabase.co/functions/v1/gemini-chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU',
            'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdpdGZrZW5td3pybGR6cXVudnd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3Nzg4NzYsImV4cCI6MjA3MTM1NDg3Nn0.7WQtp9TSHnJjoq39_LVhqjDYU2HbGAxfnleaHMS5VZU',
          },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        // Update steps live
        if (data.steps && data.steps.length > 0) {
          accumSteps = [...accumSteps, ...data.steps];
          setCurrentSteps(accumSteps);
        }

        // If the response includes an IFC file URL, auto-load it in the viewer
        if (data.ifc_url && onLoadIfcUrl) {
          console.log('Auto-loading IFC model from:', data.ifc_url);
          onLoadIfcUrl(data.ifc_url);
        }

        if (data.status === 'completed') {
          isCompleted = true;
          // Build final reply with step details
          let replyText = data.reply ?? 'Sorry, I could not generate a response.';
          if (accumSteps.length > 0) {
            replyText += '\n\n' + accumSteps.join('\n');
          }

          const finalMsg: Message = {
            id: Date.now().toString(),
            role: 'assistant',
            content: replyText,
            reasoning_details: data.reasoning_details
          };
          currentMessages = [...currentMessages, finalMsg];
          setMessages(currentMessages);
          setCurrentSteps([]); // clear pending steps
        } else if (data.status === 'pending_turn') {
          // Append hidden tool calls and results to the history
          const newMsgs = (data.new_messages || []).map((m: any, i: number) => ({
            id: Date.now().toString() + '_' + i,
            role: m.role,
            content: m.content || "",
            reasoning_details: m.reasoning_details || m.reasoning_content,
            tool_calls: m.tool_calls,
            tool_call_id: m.tool_call_id
          }));
          currentMessages = [...currentMessages, ...newMsgs];
          setMessages(currentMessages);
          // Loop continues...
        } else {
          throw new Error("Unknown orchestrator status: " + data.status);
        }
      }
      
      if (!isCompleted && turnCount >= 20) {
         throw new Error("Safety limit reached: 20 sequential loops aborted.");
      }
      
    } catch (err) {
      console.error('Gemini chat error:', err);
      const detail = err instanceof Error ? err.message : String(err);
      const isTimeout = detail.toLowerCase().includes('timeout') || detail.toLowerCase().includes('aborted');
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: isTimeout
          ? '⏱️ A network timeout occurred while attempting to process the code.'
          : `⚠️ Failed to complete task: ${detail.slice(0, 200)}`,
      }]);
      setCurrentSteps([]);
    } finally {
      setIsLoading(false);
    }
  };

  const hasMessages = messages.length > 1;

  // Filter messages for display (hide internal tool_calls and tool results)
  const displayableMessages = messages.filter(m => m.role === 'user' || (m.role === 'assistant' && !m.tool_calls));

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
