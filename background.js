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
  return `You are an expert UI engineer and accessibility specialist. Your job is to suggest fixes for broken or hard-to-use web UI elements — improving appearance without breaking functionality.

You MUST respond with a single valid JSON object — no markdown fences, no extra text:
{
  "options": [
    {
      "label": "short human-readable name for this fix (4-7 words, e.g. 'Larger, bolder text')",
      "diagnosis": "one sentence describing the problem and how this option solves it",
      "patch": "EXECUTABLE JavaScript that manipulates the DOM. Runs via eval() — must be self-contained, no import/export/require, no async at top level."
    },
    {
      "label": "...",
      "diagnosis": "...",
      "patch": "..."
    }
  ]
}

Provide exactly 2 options with meaningfully different visual approaches to the same complaint.

MANDATORY — every patch MUST follow this exact structure, no exceptions:
var orig = window.__ff_target;
if (!orig) return;
// ... your changes here, operating on orig ...

ALLOWED operations on orig:
- orig.style.X = 'Y'                          (style tweak — safest, use for option 1)
- orig.textContent = 'new label'              (text change)
- orig.className += ' extra-class'            (class addition)
- orig.insertAdjacentHTML('afterend', '...')  (insert sibling)
- var neo = orig.cloneNode(true); /* restyle neo */; orig.replaceWith(neo);  (safe replace — use for option 2)

FORBIDDEN — causes errors:
- Do NOT call document.querySelector() — use window.__ff_target (already set for you).
- Do NOT declare a variable and then use it before that line runs.
- Do NOT use return outside the patch body (the patch already runs inside a function).
- Do NOT access .style or any property on a value that could be null.

CRITICAL — never break functionality:
- Every attribute in "Functional attributes" MUST survive unchanged on the patched element.
- NEVER remove href, target, onclick, onchange, type, name, value, action, role, aria-*, or data-*.
- For <a> elements: keep them as <a> with original href/target intact.
- For form controls (<input>, <select>, <textarea>): style only, never replace.
- Safe replace pattern (copies all attributes automatically):
  var neo = orig.cloneNode(false);
  neo.style.X = 'Y';
  orig.replaceWith(neo);

Other rules:
- Keep each patch focused on orig and its direct children only.
- No setTimeout, no fetch, no external deps.`;
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
            try { eval(`(function(){${patchCode}})()`); } catch (e) { console.warn("[FrictionFixer] replay failed:", e); }
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
          const el = document.querySelector(selector);
          if (!el) return { ok: false, error: `Element not found: ${selector}` };
          const original = el.outerHTML;
          // Expose element under every name the model tends to use
          window.__ff_target = el;
          window.orig = el;
          window.el = el;
          try {
            // Wrap in IIFE so `return` statements inside patches are legal
            // eslint-disable-next-line no-eval
            eval(`(function(){${patchCode}})()`);
            return { ok: true, original };
          } catch (e) {
            return { ok: false, error: e.message };
          } finally {
            delete window.__ff_target;
            delete window.orig;
            delete window.el;
          }
        },
        args: [msg.patch, msg.selector]
      }).then(results => {
        const r = results?.[0]?.result ?? { ok: false, error: "Script failed" };
        if (r.ok && !msg.preview) {
          // Persist the patch so it survives page refreshes (skip for previews)
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
