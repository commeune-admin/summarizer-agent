import { useState, useRef, useEffect, useCallback } from "react";

// ─── GUARDRAILS ───────────────────────────────────────────────────────────────
const GUARDRAILS = {
  MAX_AGENT_STEPS: 5,
  MAX_INPUT_CHARS: 8000,
  MAX_TOKENS_PER_CALL: 1500,
  TIMEOUT_MS: 30000,
  MIN_ARTICLE_LENGTH: 50,
};

const LANGUAGES = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fr", label: "French", flag: "🇫🇷" },
  { code: "es", label: "Spanish", flag: "🇪🇸" },
  { code: "zh", label: "Chinese", flag: "🇨🇳" },
];

const TOOLS = [
  {
    name: "detect_language",
    description: "Detect the language of the provided article text.",
    input_schema: {
      type: "object",
      properties: {
        text_sample: { type: "string" },
        detected_language: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["text_sample", "detected_language", "confidence"],
    },
  },
  {
    name: "summarize_text",
    description: "Summarize the article into 3-5 key bullet points in the ORIGINAL language.",
    input_schema: {
      type: "object",
      properties: {
        summary_points: { type: "array", items: { type: "string" } },
        key_topics: { type: "array", items: { type: "string" } },
        sentiment: { type: "string", enum: ["positive", "neutral", "negative", "mixed"] },
      },
      required: ["summary_points", "key_topics", "sentiment"],
    },
  },
  {
    name: "translate_summary",
    description: "Translate the summary bullet points into the target language.",
    input_schema: {
      type: "object",
      properties: {
        translated_points: { type: "array", items: { type: "string" } },
        target_language: { type: "string" },
        translation_notes: { type: "string" },
      },
      required: ["translated_points", "target_language"],
    },
  },
  {
    name: "validate_summary",
    description: "Check the summary for hallucinations against the source article.",
    input_schema: {
      type: "object",
      properties: {
        hallucination_score: { type: "number" },
        issues_found: { type: "array", items: { type: "string" } },
        is_faithful: { type: "boolean" },
        confidence: { type: "number" },
      },
      required: ["hallucination_score", "issues_found", "is_faithful", "confidence"],
    },
  },
];

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Linguo, a warm and intelligent multilingual assistant specialised in summarizing articles. You speak naturally and conversationally — like a knowledgeable friend, not a robot.

You support: English, French, Spanish, Chinese.

YOUR PERSONALITY:
- Friendly, concise, occasionally witty
- Ask clarifying questions when needed (e.g. which language to summarize into)
- Confirm what you're about to do before doing it
- After summarizing, offer follow-ups like "Want me to translate this into another language?" or "Would you like a shorter version?"
- If the user chats casually (greetings, questions about you), respond naturally
- Never say "As an AI language model..." — just talk like a person

SUMMARIZATION FLOW:
When the user shares an article and asks for a summary:
1. If no target language is specified, ask which language they'd like
2. Once you know the target language, use tools in order: detect_language → summarize_text → translate_summary → validate_summary
3. Present results in a friendly readable way using numbered points
4. Start with a one-line intro like "Here's what the article covers:"
5. End with a friendly offer to help further

If someone asks what you can do, tell them you summarize articles from/into English, French, Spanish, and Chinese — and you're happy to chat too.`;

// ─── API CALL ─────────────────────────────────────────────────────────────────
async function callClaude(messages) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: GUARDRAILS.MAX_TOKENS_PER_CALL,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `API error ${response.status}`);
  }
  return response.json();
}

// ─── AGENT LOOP ───────────────────────────────────────────────────────────────
async function runAgentTurn(messages, onThinking) {
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolFailures = 0;
  let hallucinationScore = null;

  while (steps < GUARDRAILS.MAX_AGENT_STEPS) {
    steps++;
    onThinking(true);

    let response;
    try {
      response = await Promise.race([
        callClaude(messages),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Request timed out after 30s")), GUARDRAILS.TIMEOUT_MS)
        ),
      ]);
    } catch (err) {
      toolFailures++;
      onThinking(false);
      throw err;
    }

    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const textBlocks = response.content.filter((b) => b.type === "text");

    messages = [...messages, { role: "assistant", content: response.content }];

    if (toolUses.length === 0) {
      onThinking(false);
      const text = textBlocks.map((b) => b.text).join("\n").trim();
      return { text, messages, inputTokens, outputTokens, toolFailures, hallucinationScore };
    }

    const toolResults = toolUses.map((tool) => {
      try {
        if (tool.name === "validate_summary") {
          hallucinationScore = tool.input?.hallucination_score ?? null;
        }
        return { type: "tool_result", tool_use_id: tool.id, content: JSON.stringify(tool.input) };
      } catch (e) {
        toolFailures++;
        return { type: "tool_result", tool_use_id: tool.id, content: `Error: ${e.message}` };
      }
    });

    messages = [...messages, { role: "user", content: toolResults }];
  }

  onThinking(false);
  return {
    text: "I reached my processing limit on that one. Could you try a shorter article?",
    messages, inputTokens, outputTokens, toolFailures, hallucinationScore,
  };
}

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
function TypingDots() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "2px 0" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: "50%", background: "#34d399",
          animation: "bounce 1.2s infinite", animationDelay: `${i * 0.18}s`,
        }} />
      ))}
    </div>
  );
}

function MessageBubble({ msg }) {
  const isUser = msg.role === "user";

  const renderContent = (text) =>
    text.split("\n").map((line, i) => {
      const trimmed = line.trim();
      const isNum = /^\d+[.)]\s/.test(trimmed);
      const isBullet = /^[-•]\s/.test(trimmed);
      const isEmpty = trimmed === "";
      return (
        <div key={i} style={{
          marginBottom: isEmpty ? 10 : isNum ? 7 : 3,
          paddingLeft: isNum || isBullet ? 6 : 0,
          color: isNum ? "#e2e8f0" : isEmpty ? "transparent" : "#94a3b8",
          fontSize: isNum ? 14 : 14,
          fontWeight: isNum ? 500 : 400,
          lineHeight: 1.65,
        }}>
          {line || "\u00A0"}
        </div>
      );
    });

  return (
    <div style={{
      display: "flex", justifyContent: isUser ? "flex-end" : "flex-start",
      marginBottom: 14, gap: 10, alignItems: "flex-end",
      animation: "slideUp 0.22s ease forwards",
    }}>
      {!isUser && (
        <div style={{
          width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
          background: "linear-gradient(135deg, #064e3b 0%, #065f46 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, boxShadow: "0 0 16px #06b86033", marginBottom: 2,
        }}>🌍</div>
      )}

      <div style={{
        maxWidth: "72%",
        background: isUser ? "linear-gradient(135deg, #065f46, #047857)" : "#0b1628",
        border: isUser ? "none" : "1px solid #162032",
        borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
        padding: "12px 16px",
        boxShadow: isUser ? "0 4px 24px #06b86025" : "0 2px 14px #00000033",
      }}>
        {isUser ? (
          <p style={{ color: "#ecfdf5", fontSize: 14, lineHeight: 1.65, margin: 0, fontFamily: "'Georgia', serif" }}>
            {msg.content}
          </p>
        ) : (
          <div style={{ fontFamily: "'Georgia', serif" }}>{renderContent(msg.content)}</div>
        )}
      </div>

      {isUser && (
        <div style={{
          width: 34, height: 34, borderRadius: "50%", flexShrink: 0,
          background: "#0f172a", border: "1px solid #1e293b",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 11, color: "#475569", fontFamily: "monospace", marginBottom: 2,
        }}>YOU</div>
      )}
    </div>
  );
}

function MonitorBar({ stats }) {
  if (!stats) return null;
  const items = [
    { label: "Latency", value: `${(stats.latencyMs / 1000).toFixed(2)}s`, good: stats.latencyMs < 15000 },
    { label: "Tokens", value: (stats.inputTokens + stats.outputTokens).toLocaleString(), good: true },
    { label: "Failures", value: stats.toolFailures, good: stats.toolFailures === 0 },
    {
      label: "Hallucination",
      value: stats.hallucinationScore != null ? `${(stats.hallucinationScore * 100).toFixed(0)}%` : "—",
      good: stats.hallucinationScore == null || stats.hallucinationScore < 0.3,
    },
  ];
  return (
    <div style={{
      display: "flex", gap: 20, justifyContent: "center", flexWrap: "wrap",
      padding: "7px 16px", background: "#020817", borderTop: "1px solid #0d1829",
    }}>
      {items.map((it) => (
        <div key={it.label} style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "monospace", fontSize: 10 }}>
          <span style={{ color: "#1e3a5f" }}>{it.label}</span>
          <span style={{ color: it.good ? "#4ade80" : "#f87171", fontWeight: 700 }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

const SUGGESTIONS = [
  "Can you summarize this article for me?",
  "Résume cet article en français",
  "Summarize in Spanish",
  "What can you do?",
];

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function SummarizerAgent() {
  const [chatMessages, setChatMessages] = useState([
    {
      role: "assistant",
      content: "Hey! I'm Linguo 🌍 — your multilingual reading assistant.\n\nPaste any article and tell me which language you'd like the summary in. I support English 🇬🇧, French 🇫🇷, Spanish 🇪🇸, and Chinese 🇨🇳.\n\nWhat can I help you with today?",
    },
  ]);
  const [apiMessages, setApiMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [lastStats, setLastStats] = useState(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, thinking]);

  const sendMessage = useCallback(async (text) => {
    const userText = (text || input).trim();
    if (!userText || thinking) return;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    setChatMessages((prev) => [...prev, { role: "user", content: userText }]);

    const newApiMessages = [...apiMessages, { role: "user", content: userText }];
    setApiMessages(newApiMessages);

    const start = Date.now();
    try {
      const { text: reply, messages: updated, inputTokens, outputTokens, toolFailures, hallucinationScore } =
        await runAgentTurn(newApiMessages, setThinking);

      setLastStats({ latencyMs: Date.now() - start, inputTokens, outputTokens, toolFailures, hallucinationScore });
      setApiMessages(updated);
      setChatMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setThinking(false);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Hmm, something went wrong: ${err.message}. Mind trying again?` },
      ]);
    }
  }, [input, thinking, apiMessages]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const isFirstMessage = chatMessages.length === 1;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=JetBrains+Mono:wght@400;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; background: #020817; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #162032; border-radius: 4px; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-7px); } }
        @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
        textarea:focus { outline: none; }
        .send-btn:hover:not(:disabled) { transform: scale(1.05); }
        .chip:hover { background: #0d1e33 !important; border-color: #065f46 !important; color: #6ee7b7 !important; }
      `}</style>

      <div style={{
        height: "100vh", display: "flex", flexDirection: "column",
        background: "#020817", fontFamily: "'Fraunces', serif",
        maxWidth: 780, margin: "0 auto",
      }}>

        {/* Header */}
        <div style={{
          padding: "14px 22px", borderBottom: "1px solid #0d1829",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          background: "#020817",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 42, height: 42, borderRadius: "50%",
              background: "linear-gradient(135deg, #064e3b, #065f46)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, boxShadow: "0 0 24px #06b86044",
            }}>🌍</div>
            <div>
              <div style={{ fontSize: 16, fontWeight: 500, color: "#ecfdf5" }}>Linguo</div>
              <div style={{
                fontSize: 11, color: "#34d399", fontFamily: "'JetBrains Mono', monospace",
                display: "flex", alignItems: "center", gap: 5,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34d399", display: "inline-block", animation: "pulse 2s infinite" }} />
                Multilingual Summarization Agent
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, opacity: 0.5 }}>
            {LANGUAGES.map((l) => <span key={l.code} style={{ fontSize: 20 }} title={l.label}>{l.flag}</span>)}
          </div>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "22px 18px 12px" }}>
          {chatMessages.map((msg, i) => <MessageBubble key={i} msg={msg} />)}

          {thinking && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 14, animation: "slideUp 0.2s ease" }}>
              <div style={{
                width: 34, height: 34, borderRadius: "50%",
                background: "linear-gradient(135deg, #064e3b, #065f46)",
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
              }}>🌍</div>
              <div style={{ background: "#0b1628", border: "1px solid #162032", borderRadius: "18px 18px 18px 4px", padding: "13px 18px" }}>
                <TypingDots />
              </div>
            </div>
          )}

          {isFirstMessage && !thinking && (
            <div style={{ marginTop: 6, marginBottom: 12 }}>
              <div style={{ textAlign: "center", fontSize: 10, color: "#1e3a5f", fontFamily: "'JetBrains Mono', monospace", marginBottom: 10, letterSpacing: 2 }}>
                TRY ASKING
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="chip" onClick={() => sendMessage(s)} style={{
                    background: "#07111f", border: "1px solid #162032", borderRadius: 20,
                    padding: "7px 15px", fontSize: 12, color: "#475569",
                    cursor: "pointer", fontFamily: "'Fraunces', serif", transition: "all 0.18s",
                  }}>{s}</button>
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Monitor */}
        <MonitorBar stats={lastStats} />

        {/* Input */}
        <div style={{ padding: "12px 16px 16px", background: "#020817", borderTop: "1px solid #0d1829" }}>
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-end",
            background: "#07111f", border: "1px solid #162032",
            borderRadius: 18, padding: "10px 12px",
          }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, GUARDRAILS.MAX_INPUT_CHARS))}
              onKeyDown={handleKeyDown}
              disabled={thinking}
              placeholder="Ask me anything, or paste an article to summarize..."
              rows={1}
              style={{
                flex: 1, background: "transparent", border: "none",
                color: "#e2e8f0", fontSize: 14, lineHeight: 1.6,
                maxHeight: 160, overflowY: "auto", fontFamily: "'Fraunces', serif",
              }}
              onInput={(e) => {
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
            />
            <button
              className="send-btn"
              onClick={() => sendMessage()}
              disabled={!input.trim() || thinking}
              style={{
                width: 38, height: 38, borderRadius: "50%", border: "none", flexShrink: 0,
                background: input.trim() && !thinking ? "linear-gradient(135deg, #065f46, #059669)" : "#0d1829",
                color: input.trim() && !thinking ? "#ecfdf5" : "#1e3a5f",
                cursor: input.trim() && !thinking ? "pointer" : "not-allowed",
                fontSize: 16, transition: "all 0.18s",
                boxShadow: input.trim() && !thinking ? "0 0 14px #06b86044" : "none",
              }}
            >↑</button>
          </div>
          <div style={{ textAlign: "center", marginTop: 7, fontSize: 10, color: "#0d1829", fontFamily: "'JetBrains Mono', monospace" }}>
            Enter to send · Shift+Enter for new line
          </div>
        </div>
      </div>
    </>
  );
}
