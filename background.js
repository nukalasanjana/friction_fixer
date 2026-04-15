// ── Friction Fixer · background.js ──────────────────────────────────────────
// Service worker: receives messages from sidepanel, calls Ollama, returns patch.

const OLLAMA_MODEL = "qwen2.5-coder:7b"; // change to "mistral", "codellama", "phi3", etc.
const OLLAMA_BASE  = "http://localhost:11434";

// ── Check Ollama is alive ────────────────────────────────────────────────────
async function checkOllama() {
  try {
    const r = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Build the system prompt ──────────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are an expert UI engineer and accessibility specialist. Your job is to fix broken or hard-to-use web UI elements by REPLACING them with better components — not just editing CSS styles.

STRATEGY — always prefer component replacement:
- Replace unreadable text nodes with new <span> or <p> elements with proper contrast and sizing.
- Replace broken nav items with clear <button> or <a> elements with visible labels.
- Replace inaccessible inputs with labeled <label>+<input> pairs.
- Replace cluttered sections with clean, simplified equivalents.
- Only use CSS when a full replacement is overkill (e.g., fixing a single color).

You MUST respond with a single valid JSON object — no markdown fences, no extra text:
{
  "strategy": "Replacement" | "Simplification" | "Restructure" | "Conservation",
  "diagnosis": "one sentence describing the UX problem",
  "rationale": "one sentence explaining why your patch solves it",
  "patch": "EXECUTABLE JavaScript (no async/await at top level) that directly manipulates the DOM. The script runs via eval() so it must be self-contained. Use document.querySelector, createElement, replaceWith, innerHTML, etc. The script must NOT use import/export or require."
}

Rules:
- patch must be pure JS that runs immediately when eval()'d in the page context.
- Prefer creating new elements and using el.replaceWith(newEl) over style edits.
- Keep the patch focused on the selected element and its direct children.
- Do NOT touch unrelated parts of the page.
- Make it fast: no setTimeout, no fetch, no external deps.`;
}

// ── Call Ollama ──────────────────────────────────────────────────────────────
async function callOllama(complaint, context) {
  const userMessage = `
SELECTED ELEMENT CONTEXT:
Selector: ${context.selector}
Tag: ${context.tag}
Text content: ${context.text}
Outer HTML (truncated): ${context.html}
Computed styles (key): font-size=${context.styles.fontSize}, color=${context.styles.color}, background=${context.styles.background}, display=${context.styles.display}

USER COMPLAINT: ${complaint}

Respond with only the JSON object described in the system prompt.`.trim();

  const response = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system",  content: buildSystemPrompt() },
        { role: "user",    content: userMessage }
      ],
      stream: false,
      options: { temperature: 0.3, num_predict: 800 }
    })
  });

  if (!response.ok) throw new Error(`Ollama error: ${response.status}`);
  const data = await response.json();
  const raw = data.message?.content ?? "";

  // Strip possible markdown fences
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === "CHECK_OLLAMA") {
    checkOllama().then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === "GENERATE_PATCH") {
    callOllama(msg.complaint, msg.context)
      .then(patch => sendResponse({ ok: true, patch }))
      .catch(err  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "APPLY_PATCH") {
    // Run the patch script on the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return sendResponse({ ok: false, error: "No active tab" });
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (patchCode, selector) => {
          // Snapshot original HTML for undo
          const el = document.querySelector(selector);
          const original = el ? el.outerHTML : null;
          try {
            // eslint-disable-next-line no-eval
            eval(patchCode);
            return { ok: true, original };
          } catch (e) {
            return { ok: false, error: e.message };
          }
        },
        args: [msg.patch, msg.selector]
      }).then(results => {
        const r = results?.[0]?.result ?? { ok: false, error: "Script failed" };
        sendResponse(r);
      }).catch(e => sendResponse({ ok: false, error: e.message }));
    });
    return true;
  }

  if (msg.type === "UNDO_PATCH") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return sendResponse({ ok: false });
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: (selector, originalHtml) => {
          const el = document.querySelector(selector);
          if (el && originalHtml) {
            const tmp = document.createElement("div");
            tmp.innerHTML = originalHtml;
            el.replaceWith(tmp.firstElementChild);
            return { ok: true };
          }
          // Fallback: remove injected style tags
          document.querySelectorAll("style[data-friction-fixer]").forEach(s => s.remove());
          return { ok: true };
        },
        args: [msg.selector, msg.original]
      }).then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }

  if (msg.type === "START_INSPECTOR") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: "START_INSPECTOR" });
    });
    return false;
  }

  if (msg.type === "STOP_INSPECTOR") {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return;
      chrome.tabs.sendMessage(tab.id, { type: "STOP_INSPECTOR" });
    });
    return false;
  }
});

// Open side panel on toolbar click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
