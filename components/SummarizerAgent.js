import { useState, useRef, useCallback } from "react";

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
        text_sample: { type: "string", description: "Sample of text used for detection." },
        detected_language: { type: "string", description: "Detected language name." },
        confidence: { type: "number", description: "Confidence score 0-1." },
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
        summary_points: { type: "array", items: { type: "string" }, description: "3-5 bullet point summary." },
        key_topics: { type: "array", items: { type: "string" }, description: "2-4 key topics." },
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
        translated_points: { type: "array", items: { type: "string" }, description: "Translated bullet points." },
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
        hallucination_score: { type: "number", description: "Risk score 0-1. 0=none, 1=severe." },
        issues_found: { type: "array", items: { type: "string" } },
        is_faithful: { type: "boolean" },
        confidence: { type: "number" },
      },
      required: ["hallucination_score", "issues_found", "is_faithful", "confidence"],
    },
  },
];

// ─── API CALL — uses /api/claude proxy (your key stays on the server) ─────────
async function callClaude(messages, system) {
  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: GUARDRAILS.MAX_TOKENS_PER_CALL,
      system,
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
async function runAgent({ article, sourceLang, targetLang, onStep, onMonitor }) {
  let agentSteps = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolFailures = 0;
  const agentStart = Date.now();

  const targetLabel = LANGUAGES.find((l) => l.code === targetLang)?.label;
  const sourceLabel = LANGUAGES.find((l) => l.code === sourceLang)?.label;

  const system = `You are a multilingual article summarization agent. Call your tools in this exact order:
1. detect_language — identify the article's language
2. summarize_text — bullet-point summary in the article's ORIGINAL language
3. translate_summary — translate summary into ${targetLabel}
4. validate_summary — check for hallucinations against the source

Source language hint: ${sourceLabel}. Target language: ${targetLabel}.
Call each tool exactly once in order, then respond with a short completion message.`;

  const messages = [
    { role: "user", content: `Please summarize this article:\n\n${article.slice(0, GUARDRAILS.MAX_INPUT_CHARS)}` },
  ];

  let result = { detected_language: null, summary_points: [], translated_points: [], target_language: targetLabel, validation: null, key_topics: [], sentiment: null };

  while (agentSteps < GUARDRAILS.MAX_AGENT_STEPS) {
    agentSteps++;
    const stepStart = Date.now();
    onStep({ type: "thinking", step: agentSteps, message: `Agent step ${agentSteps}/${GUARDRAILS.MAX_AGENT_STEPS}...` });

    let response;
    try {
      response = await Promise.race([
        callClaude(messages, system),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), GUARDRAILS.TIMEOUT_MS)),
      ]);
    } catch (err) {
      toolFailures++;
      onMonitor({ toolFailures, totalInputTokens, totalOutputTokens, latencyMs: Date.now() - agentStart });
      throw err;
    }

    totalInputTokens += response.usage?.input_tokens || 0;
    totalOutputTokens += response.usage?.output_tokens || 0;
    onMonitor({ toolFailures, totalInputTokens, totalOutputTokens, latencyMs: Date.now() - agentStart });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const textBlocks = response.content.filter((b) => b.type === "text");

    messages.push({ role: "assistant", content: response.content });

    if (toolUses.length === 0) {
      onStep({ type: "complete", step: agentSteps, message: textBlocks.map((b) => b.text).join(" "), latencyMs: Date.now() - stepStart });
      break;
    }

    const toolResults = [];
    for (const tool of toolUses) {
      const toolStart = Date.now();
      let toolError = null;
      try {
        if (tool.name === "detect_language") result.detected_language = tool.input.detected_language;
        else if (tool.name === "summarize_text") { result.summary_points = tool.input.summary_points || []; result.key_topics = tool.input.key_topics || []; result.sentiment = tool.input.sentiment; }
        else if (tool.name === "translate_summary") { result.translated_points = tool.input.translated_points || []; result.target_language = tool.input.target_language; result.translation_notes = tool.input.translation_notes; }
        else if (tool.name === "validate_summary") result.validation = tool.input;
      } catch (err) { toolFailures++; toolError = err.message; }

      onStep({ type: "tool", step: agentSteps, tool: tool.name, latencyMs: Date.now() - toolStart, error: toolError });
      toolResults.push({ type: "tool_result", tool_use_id: tool.id, content: toolError ? `Error: ${toolError}` : JSON.stringify(tool.input) });
    }

    messages.push({ role: "user", content: toolResults });
    onMonitor({ toolFailures, totalInputTokens, totalOutputTokens, latencyMs: Date.now() - agentStart });
  }

  if (agentSteps >= GUARDRAILS.MAX_AGENT_STEPS) {
    onStep({ type: "guardrail", message: `⚠ MAX_AGENT_STEPS (${GUARDRAILS.MAX_AGENT_STEPS}) reached — agent stopped.` });
  }

  return { result, totalInputTokens, totalOutputTokens, totalLatencyMs: Date.now() - agentStart, toolFailures };
}

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
function MonitorBar({ monitor }) {
  const hallScore = monitor.hallucination_score ?? null;
  const hallColor = hallScore === null ? "#555" : hallScore < 0.2 ? "#a3e635" : hallScore < 0.5 ? "#f59e0b" : "#ef4444";
  const tiles = [
    { label: "LATENCY", value: monitor.latencyMs ? `${(monitor.latencyMs / 1000).toFixed(2)}s` : "—", color: monitor.latencyMs > 15000 ? "#f59e0b" : "#a3e635" },
    { label: "TOKENS USED", value: monitor.totalInputTokens != null ? `${(monitor.totalInputTokens + monitor.totalOutputTokens).toLocaleString()}` : "—", color: "#60a5fa" },
    { label: "TOOL FAILURES", value: monitor.toolFailures ?? 0, color: monitor.toolFailures > 0 ? "#ef4444" : "#a3e635" },
    { label: "HALLUCINATION", value: hallScore !== null ? `${(hallScore * 100).toFixed(0)}%` : "—", color: hallColor },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 }}>
      {tiles.map((t) => (
        <div key={t.label} style={{ background: "#0e0e0e", border: "1px solid #1e1e1e", borderRadius: 6, padding: "12px 14px" }}>
          <div style={{ fontSize: 9, letterSpacing: 2, color: "#555", fontFamily: "monospace", marginBottom: 6 }}>{t.label}</div>
          <div style={{ fontSize: 22, fontFamily: "monospace", color: t.color, fontWeight: 700 }}>{t.value}</div>
        </div>
      ))}
    </div>
  );
}

function StepLog({ steps }) {
  const icons = { thinking: "◌", tool: "⚡", complete: "✓", guardrail: "⚠" };
  const colors = { thinking: "#555", tool: "#60a5fa", complete: "#a3e635", guardrail: "#f59e0b" };
  return (
    <div style={{ background: "#080808", border: "1px solid #1a1a1a", borderRadius: 8, padding: 14, maxHeight: 200, overflowY: "auto" }}>
      <div style={{ fontSize: 9, letterSpacing: 3, color: "#444", fontFamily: "monospace", marginBottom: 10 }}>AGENT LOG</div>
      {steps.length === 0 && <div style={{ color: "#333", fontFamily: "monospace", fontSize: 12 }}>Awaiting execution...</div>}
      {steps.map((s, i) => (
        <div key={i} style={{ display: "flex", gap: 10, marginBottom: 6, fontFamily: "monospace", fontSize: 11 }}>
          <span style={{ color: colors[s.type] || "#555", minWidth: 14 }}>{icons[s.type] || "·"}</span>
          <span style={{ color: "#444", minWidth: 56 }}>Step {s.step || "—"}</span>
          <span style={{ color: s.error ? "#ef4444" : "#888", flex: 1 }}>
            {s.tool && <span style={{ color: "#60a5fa" }}>[{s.tool}] </span>}
            {s.message || (s.error ? `ERROR: ${s.error}` : s.tool ? `✓ ${s.latencyMs || 0}ms` : "")}
          </span>
        </div>
      ))}
    </div>
  );
}

function ResultCard({ result }) {
  if (!result?.translated_points?.length) return null;
  const sentimentColors = { positive: "#a3e635", negative: "#ef4444", neutral: "#60a5fa", mixed: "#f59e0b" };
  return (
    <div style={{ background: "#070707", border: "1px solid #1e1e1e", borderRadius: 10, padding: 20, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: 3, color: "#555" }}>SUMMARY OUTPUT</div>
        <div style={{ display: "flex", gap: 8 }}>
          {result.detected_language && <span style={{ background: "#111", border: "1px solid #1e1e1e", borderRadius: 4, padding: "3px 9px", fontSize: 10, color: "#888", fontFamily: "monospace" }}>Detected: {result.detected_language}</span>}
          {result.sentiment && <span style={{ background: "#111", border: `1px solid ${sentimentColors[result.sentiment]}33`, borderRadius: 4, padding: "3px 9px", fontSize: 10, color: sentimentColors[result.sentiment], fontFamily: "monospace" }}>{result.sentiment}</span>}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "monospace", fontSize: 10, color: "#444", marginBottom: 10 }}>Summary in {result.target_language}</div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {result.translated_points.map((p, i) => (
            <li key={i} style={{ display: "flex", gap: 10, marginBottom: 8, color: "#ccc", fontSize: 13, lineHeight: 1.6 }}>
              <span style={{ color: "#a3e635", minWidth: 16, fontFamily: "monospace", fontSize: 11, paddingTop: 2 }}>{String(i + 1).padStart(2, "0")}</span>
              {p}
            </li>
          ))}
        </ul>
      </div>
      {result.key_topics?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: 2, color: "#444", marginBottom: 8 }}>KEY TOPICS</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {result.key_topics.map((t, i) => <span key={i} style={{ background: "#1a1a1a", borderRadius: 4, padding: "3px 10px", fontSize: 11, color: "#888", fontFamily: "monospace" }}>{t}</span>)}
          </div>
        </div>
      )}
      {result.validation && (
        <div style={{ background: "#0a0a0a", border: `1px solid ${result.validation.is_faithful ? "#a3e63522" : "#ef444422"}`, borderRadius: 6, padding: 12 }}>
          <div style={{ fontFamily: "monospace", fontSize: 9, letterSpacing: 2, color: "#444", marginBottom: 8 }}>VALIDATION</div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ fontSize: 11, fontFamily: "monospace" }}>
              <span style={{ color: "#444" }}>Faithful: </span>
              <span style={{ color: result.validation.is_faithful ? "#a3e635" : "#ef4444" }}>{result.validation.is_faithful ? "YES" : "NO"}</span>
            </div>
            <div style={{ fontSize: 11, fontFamily: "monospace" }}>
              <span style={{ color: "#444" }}>Hallucination risk: </span>
              <span style={{ color: result.validation.hallucination_score < 0.2 ? "#a3e635" : result.validation.hallucination_score < 0.5 ? "#f59e0b" : "#ef4444" }}>
                {(result.validation.hallucination_score * 100).toFixed(0)}%
              </span>
            </div>
          </div>
          {result.validation.issues_found?.length > 0 && result.validation.issues_found.map((issue, i) => (
            <div key={i} style={{ fontSize: 11, color: "#f59e0b", fontFamily: "monospace", marginTop: 4 }}>⚠ {issue}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE COMPONENT ──────────────────────────────────────────────────────
export default function SummarizerAgent() {
  const [article, setArticle] = useState("");
  const [sourceLang, setSourceLang] = useState("en");
  const [targetLang, setTargetLang] = useState("fr");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState([]);
  const [monitor, setMonitor] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const logRef = useRef(null);

  const addStep = useCallback((step) => {
    setSteps((prev) => [...prev, step]);
    setTimeout(() => logRef.current?.scrollTo({ top: 9999, behavior: "smooth" }), 50);
  }, []);

  const updateMonitor = useCallback((data) => setMonitor((prev) => ({ ...prev, ...data })), []);

  const handleRun = async () => {
    if (!article.trim()) return;
    if (article.length < GUARDRAILS.MIN_ARTICLE_LENGTH) { setError(`Article too short. Minimum ${GUARDRAILS.MIN_ARTICLE_LENGTH} characters.`); return; }
    if (sourceLang === targetLang) { setError("Source and target language must be different."); return; }
    setRunning(true); setSteps([]); setMonitor({}); setResult(null); setError(null);
    try {
      const { result: agentResult } = await runAgent({ article, sourceLang, targetLang, onStep: addStep, onMonitor: updateMonitor });
      setResult(agentResult);
      if (agentResult.validation) setMonitor((prev) => ({ ...prev, hallucination_score: agentResult.validation.hallucination_score }));
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const charPct = Math.min((article.length / GUARDRAILS.MAX_INPUT_CHARS) * 100, 100);

  return (
    <>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #050505; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
        textarea:focus, select:focus { outline: none; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        .fade-in { animation: fadeIn 0.3s ease forwards; }
      `}</style>

      <div style={{ minHeight: "100vh", background: "#050505", color: "#ddd", fontFamily: "monospace" }}>
        {/* Header */}
        <div style={{ borderBottom: "1px solid #111", padding: "20px 32px", display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#a3e635", boxShadow: "0 0 8px #a3e635" }} />
          <div>
            <div style={{ fontSize: 11, letterSpacing: 3, color: "#666" }}>MULTILINGUAL</div>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1, color: "#eee" }}>SUMMARIZATION AGENT</div>
          </div>
          <div style={{ marginLeft: "auto", fontSize: 10, color: "#333", textAlign: "right" }}>
            <div>MODEL: claude-sonnet-4</div>
            <div>TOOLS: {TOOLS.length} registered</div>
          </div>
        </div>

        <div style={{ maxWidth: 900, margin: "0 auto", padding: "28px 24px" }}>
          {/* Guardrail badges */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
            {Object.entries(GUARDRAILS).map(([k, v]) => (
              <div key={k} style={{ background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 4, padding: "4px 10px", fontSize: 10, fontFamily: "monospace", color: "#555" }}>
                {k} <span style={{ color: "#a3e635" }}>{v}</span>
              </div>
            ))}
          </div>

          <MonitorBar monitor={monitor} />

          {/* Language selectors */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            {[{ label: "SOURCE LANGUAGE", val: sourceLang, set: setSourceLang }, { label: "TARGET LANGUAGE", val: targetLang, set: setTargetLang }].map(({ label, val, set }) => (
              <div key={label}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "#444", marginBottom: 6 }}>{label}</div>
                <select value={val} onChange={(e) => set(e.target.value)} disabled={running}
                  style={{ width: "100%", background: "#0a0a0a", border: "1px solid #1e1e1e", borderRadius: 6, color: "#ddd", padding: "10px 12px", fontFamily: "monospace", fontSize: 12, cursor: "pointer" }}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Textarea */}
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: "#444" }}>ARTICLE TEXT</div>
              <div style={{ fontSize: 9, color: charPct > 90 ? "#f59e0b" : "#444" }}>{article.length.toLocaleString()} / {GUARDRAILS.MAX_INPUT_CHARS.toLocaleString()}</div>
            </div>
            <div style={{ position: "relative" }}>
              <textarea value={article} onChange={(e) => setArticle(e.target.value.slice(0, GUARDRAILS.MAX_INPUT_CHARS))} disabled={running}
                placeholder="Paste your article here... (English, French, Spanish, or Chinese)"
                style={{ width: "100%", minHeight: 160, background: "#080808", border: "1px solid #1a1a1a", borderRadius: 8, color: "#ccc", padding: 14, fontFamily: "serif", fontSize: 13, lineHeight: 1.7, resize: "vertical" }} />
              <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: "#111", borderRadius: "0 0 8px 8px" }}>
                <div style={{ height: "100%", width: `${charPct}%`, background: charPct > 90 ? "#f59e0b" : "#a3e635", transition: "width 0.2s" }} />
              </div>
            </div>
          </div>

          {error && <div className="fade-in" style={{ background: "#1a0a0a", border: "1px solid #ef444433", borderRadius: 6, padding: "10px 14px", marginBottom: 12, fontSize: 11, color: "#ef4444" }}>✗ {error}</div>}

          <button onClick={handleRun} disabled={running || !article.trim()}
            style={{ width: "100%", padding: 14, background: running ? "#0a0a0a" : "#a3e635", color: running ? "#444" : "#000", border: "none", borderRadius: 8, fontFamily: "monospace", fontSize: 12, fontWeight: 700, letterSpacing: 2, cursor: running ? "not-allowed" : "pointer", marginBottom: 16 }}>
            {running ? <span style={{ animation: "pulse 1.2s infinite" }}>◌ AGENT RUNNING...</span> : "▶ RUN AGENT"}
          </button>

          <div ref={logRef}><StepLog steps={steps} /></div>
          {result?.translated_points?.length > 0 && <div className="fade-in"><ResultCard result={result} /></div>}
        </div>
      </div>
    </>
  );
}
