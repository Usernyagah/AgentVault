// ────────────────────────────────────────────────
// Agent Chat Page – Human Oversight & Communication
// ────────────────────────────────────────────────
"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  id: string;
  role: "user" | "agent" | "system";
  content: string;
  timestamp: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "system-1",
      role: "system",
      content:
        "Treasury Agent is online. I can help you manage payments, check balances, forecast cash flow, and explain any past decisions. All actions are logged to the audit ledger.",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || loading) return;

    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
      const res = await fetch(`${apiUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMsg.content }),
      });

      const json = await res.json();

      if (json.success && json.data) {
        setMessages((prev) => [...prev, json.data]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "system",
            content: `Error: ${json.error || "Failed to get response"}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `error-${Date.now()}`,
          role: "system",
          content: `Connection error: ${err.message}. Make sure the API is running on port 4000.`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Agent Chat</h1>
          <p className="page-subtitle">
            Talk to your treasury agent – ask questions, give instructions, review decisions
          </p>
        </div>
        <div className="agent-status idle">
          <span className="agent-status-dot" />
          {loading ? "Thinking…" : "Online"}
        </div>
      </div>

      <div className="card chat-container" id="chat-panel">
        <div className="chat-messages">
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-bubble ${msg.role}`}>
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="chat-bubble agent" style={{ opacity: 0.6 }}>
              Analyzing your request…
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-input-area">
          <input
            id="chat-input"
            className="chat-input"
            type="text"
            placeholder="Ask about balances, payments, forecasts, or past decisions…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={loading}
          />
          <button
            id="chat-send"
            className="btn btn-primary"
            onClick={handleSend}
            disabled={loading || !input.trim()}
          >
            Send
          </button>
        </div>
      </div>
    </>
  );
}
