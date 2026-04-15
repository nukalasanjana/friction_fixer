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
  return `You are an expert UI engineer and accessibility specialist. Your job is to fix broken or hard-to-use web UI elements by improving their appearance — without breaking their functionality.

STRATEGY — fix appearance while preserving behaviour:
- Fix unreadable text by updating styles on the existing element or wrapping it in a new <span>/<p>.
- Fix broken nav items by restyling the existing <a> or <button> — keep the element type.
- Fix inaccessible inputs by adding a <label> alongside; do not replace the <input> itself.
- Fix cluttered sections by adjusting padding, font-size, and layout on existing elements.
- Only create a brand-new element and use replaceWith() when the tag itself is wrong AND the element has NO functional attributes (href, onclick, data-*, etc.).

You MUST respond with a single valid JSON object — no markdown fences, no extra text:
{
  "strategy": "Replacement" | "Simplification" | "Restructure" | "Conservation",
  "diagnosis": "one sentence describing the UX problem",
  "rationale": "one sentence explaining why your patch solves it",
  "patch": "EXECUTABLE JavaScript (no async/await at top level) that directly manipulates the DOM. The script runs via eval() so it must be self-contained. Use document.querySelector, createElement, replaceWith, innerHTML, etc. The script must NOT use import/export or require."
}

CRITICAL — never break functionality:
- The user message will include a "Functional attributes" list. Every attribute listed there MUST appear on the patched element unchanged.
- If you use replaceWith(), copy ALL functional attributes from the original to the new element using setAttribute().
- NEVER remove or overwrite href, target, onclick, onchange, onsubmit, type, name, value, action, role, aria-*, or any data-* attribute.
- For <a> elements: always keep them as <a> tags with the original href and target intact. Never convert a link to a plain <button> or <div>.
- For elements with onclick or other inline handlers: prefer style-only edits. If you must replace, copy the handler: newEl.setAttribute('onclick', orig.getAttribute('onclick')).
- For form controls (<input>, <select>, <textarea>): never replace the element — only add wrapping labels or adjust styles.
- Safe replacement pattern (use this when replaceWith is needed):
  (function() {
    const orig = document.querySelector(SELECTOR);
    const neo = document.createElement(TAG);
    // copy ALL attributes first
    for (const a of orig.attributes) neo.setAttribute(a.name, a.value);
    // then apply visual changes
    neo.style.XXX = YYY;
    orig.replaceWith(neo);
  })();

Other rules:
- patch must be pure JS that runs immediately when eval()'d in the page context.
- Keep the patch focused on the selected element and its direct children.
- Do NOT touch unrelated parts of the page.
- Make it fast: no setTimeout, no fetch, no external deps.`;
}

// ── Call Ollama ──────────────────────────────────────────────────────────────
async function callOllama(complaint, context) {
  const funcAttrs = context.functionalAttrs && Object.keys(context.functionalAttrs).length
    ? Object.entries(context.functionalAttrs).map(([k, v]) => `  ${k}="${v}"`).join("\n")
    : "  (none)";

  const userMessage = `
SELECTED ELEMENT CONTEXT:
Selector: ${context.selector}
Tag: ${context.tag}
Text content: ${context.text}
Outer HTML (truncated): ${context.html}
Computed styles (key): font-size=${context.styles.fontSize}, color=${context.styles.color}, background=${context.styles.background}, display=${context.styles.display}
Functional attributes (MUST be preserved on the patched element):
${funcAttrs}

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

  if (msg.type === "REPLAY_PATCHES") {
    const tabId = _sender.tab?.id;
    if (!tabId) return false;
    chrome.storage.local.get([msg.url], (stored) => {
      const patches = stored[msg.url] || [];
      patches.forEach(({ patch }) => {
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (patchCode) => {
            try { eval(patchCode); } catch (e) { console.warn("[FrictionFixer] replay failed:", e); }
          },
          args: [patch]
        }).catch(() => {});
      });
    });
    return false;
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
        if (r.ok) {
          // Persist the patch so it survives page refreshes
          const url = tab.url;
          chrome.storage.local.get([url], (stored) => {
            const patches = stored[url] || [];
            patches.push({ selector: msg.selector, patch: msg.patch });
            chrome.storage.local.set({ [url]: patches });
          });
        }
        sendResponse(r);
      }).catch(e => sendResponse({ ok: false, error: e.message }));
    });
    return true;
  }

  if (msg.type === "CLEAR_PATCHES") {
    // Remove all saved patches for the active tab's URL and reload
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab) return sendResponse({ ok: false, error: "No active tab" });
      chrome.storage.local.remove(tab.url, () => {
        chrome.tabs.reload(tab.id);
        sendResponse({ ok: true });
      });
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
