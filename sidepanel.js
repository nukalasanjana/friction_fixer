// ── Friction Fixer · sidepanel.js ───────────────────────────────────────────

// ── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot    = document.getElementById("status-dot");
const statusLabel  = document.getElementById("status-label");
const contextBar   = document.getElementById("context-bar");
const ctxText      = document.getElementById("ctx-text");
const ctxClear     = document.getElementById("ctx-clear");
const chat         = document.getElementById("chat");
const optionsPanel = document.getElementById("options-panel");
const btnInspector = document.getElementById("btn-inspector");
const btnUndo      = document.getElementById("btn-undo");
const btnReset     = document.getElementById("btn-reset");
const complaint    = document.getElementById("complaint");
const btnSend      = document.getElementById("btn-send");

// ── State ────────────────────────────────────────────────────────────────────
let capturedCtx    = null;  // { selector, tag, text, html, styles, functionalAttrs }
let pendingOptions = null;  // array of { label, diagnosis, patch }
let previewState   = null;  // { index, selector, original } while a preview is live
let undoState      = null;  // { selector, original } for post-accept undo
let busy           = false;

// ── Ollama status polling ────────────────────────────────────────────────────
function setStatus(online) {
  statusDot.className    = "status-dot" + (online ? "" : " offline");
  statusLabel.textContent = online ? "Ollama online" : "Ollama offline";
}

async function pollOllama() {
  const r = await chrome.runtime.sendMessage({ type: "CHECK_OLLAMA" }).catch(() => ({ ok: false }));
  setStatus(r.ok);
}
pollOllama();
setInterval(pollOllama, 8000);

// ── Chat helpers ─────────────────────────────────────────────────────────────
function addMsg(text, role = "assistant") {
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.textContent = text;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

function addSpinner() {
  const d = document.createElement("div");
  d.className = "spinner-msg";
  d.innerHTML = `<div class="dot-pulse"><span></span><span></span><span></span></div> Generating options…`;
  chat.appendChild(d);
  chat.scrollTop = chat.scrollHeight;
  return d;
}

// ── Context bar ──────────────────────────────────────────────────────────────
function setContext(ctx) {
  capturedCtx = ctx;
  contextBar.className = "filled";
  ctxText.textContent  = ctx.selector.length > 60 ? "…" + ctx.selector.slice(-58) : ctx.selector;
  ctxClear.classList.remove("hidden");
}

function clearContext() {
  capturedCtx = null;
  contextBar.className = "empty";
  ctxText.textContent  = "No element selected — click Inspector";
  ctxClear.classList.add("hidden");
}

ctxClear.addEventListener("click", clearContext);

// ── Inspector toggle ─────────────────────────────────────────────────────────
let inspecting = false;

btnInspector.addEventListener("click", () => {
  if (inspecting) stopInspecting(); else startInspecting();
});

function startInspecting() {
  inspecting = true;
  btnInspector.classList.add("active");
  btnInspector.textContent = "✕ Cancel";
  chrome.runtime.sendMessage({ type: "START_INSPECTOR" });
  addMsg("Click any element on the page to select it.", "system");
}

function stopInspecting() {
  inspecting = false;
  btnInspector.classList.remove("active");
  btnInspector.textContent = "🔎 Inspector";
  chrome.runtime.sendMessage({ type: "STOP_INSPECTOR" });
}

// ── Incoming messages from content.js ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ELEMENT_CAPTURED") {
    stopInspecting();
    setContext(msg.data);
    addMsg(`Selected: <${msg.data.tag}> — "${msg.data.text.slice(0, 60) || "(no text)"}"`, "system");
    complaint.focus();
  }
  if (msg.type === "INSPECTOR_CANCELLED") {
    stopInspecting();
  }
});

// ── Send complaint → generate options ────────────────────────────────────────
async function sendComplaint() {
  const text = complaint.value.trim();
  if (!text) return;
  if (!capturedCtx) {
    addMsg("⚠ Please select an element first using Inspector.", "error");
    return;
  }
  if (busy) return;

  busy = true;
  setInputEnabled(false);
  addMsg(text, "user");
  complaint.value = "";

  // Clear any existing options and revert any active preview
  await revertPreview();
  clearOptions();

  const spinner = addSpinner();

  const r = await chrome.runtime.sendMessage({
    type: "GENERATE_PATCH",
    complaint: text,
    context: capturedCtx
  }).catch(e => ({ ok: false, error: e.message }));

  spinner.remove();
  busy = false;
  setInputEnabled(true);

  if (!r.ok) {
    addMsg(`Error: ${r.error}`, "error");
    return;
  }

  const options = r.patch?.options;
  if (!Array.isArray(options) || options.length === 0) {
    addMsg("No options returned — try rephrasing your complaint.", "error");
    return;
  }

  showOptions(options);
}

// ── Options panel ─────────────────────────────────────────────────────────────
function showOptions(options) {
  pendingOptions = options;
  optionsPanel.innerHTML = "";

  options.forEach((opt, i) => {
    const card = document.createElement("div");
    card.className = "option-card";
    card.dataset.index = i;
    card.innerHTML = `
      <div class="option-header">
        <div class="option-num">${i + 1}</div>
        <div class="option-label">${opt.label}</div>
      </div>
      <div class="option-body">${opt.diagnosis}</div>
      <div class="option-actions">
        <button class="btn-preview" data-index="${i}">👁 Preview</button>
        <button class="btn-accept"  data-index="${i}">✓ Apply This Fix</button>
      </div>`;
    optionsPanel.appendChild(card);
  });

  const footer = document.createElement("div");
  footer.className = "options-footer";
  footer.innerHTML = `<button class="btn-dismiss-all">Dismiss all options</button>`;
  footer.querySelector(".btn-dismiss-all").addEventListener("click", async () => {
    await revertPreview();
    clearOptions();
    addMsg("Options dismissed.", "system");
  });
  optionsPanel.appendChild(footer);

  optionsPanel.querySelectorAll(".btn-preview").forEach(btn =>
    btn.addEventListener("click", () => handlePreview(parseInt(btn.dataset.index)))
  );
  optionsPanel.querySelectorAll(".btn-accept").forEach(btn =>
    btn.addEventListener("click", () => handleAccept(parseInt(btn.dataset.index)))
  );
}

function clearOptions() {
  optionsPanel.innerHTML = "";
  pendingOptions = null;
}

// ── Preview logic ─────────────────────────────────────────────────────────────
async function revertPreview() {
  if (!previewState) return;
  await chrome.runtime.sendMessage({
    type:     "UNDO_PATCH",
    selector: previewState.selector,
    original: previewState.original
  }).catch(() => {});
  previewState = null;
  // Reset all preview button states
  optionsPanel.querySelectorAll(".btn-preview").forEach(btn => {
    btn.textContent = "👁 Preview";
    btn.classList.remove("active");
    btn.disabled = false;
  });
  optionsPanel.querySelectorAll(".option-card").forEach(c => c.classList.remove("previewing"));
}

async function handlePreview(index) {
  if (!pendingOptions || !capturedCtx) return;
  const btn = optionsPanel.querySelector(`.btn-preview[data-index="${index}"]`);

  // Clicking the active preview button reverts it
  if (previewState && previewState.index === index) {
    await revertPreview();
    return;
  }

  // Revert any other active preview first
  await revertPreview();

  // Apply temporarily (preview: true skips storage)
  const r = await chrome.runtime.sendMessage({
    type:     "APPLY_PATCH",
    patch:    pendingOptions[index].patch,
    selector: capturedCtx.selector,
    preview:  true
  }).catch(e => ({ ok: false, error: e.message }));

  if (r.ok) {
    previewState = { index, selector: capturedCtx.selector, original: r.original };
    btn.textContent = "↩ Revert";
    btn.classList.add("active");
    optionsPanel.querySelector(`.option-card[data-index="${index}"]`).classList.add("previewing");
    // Disable other preview buttons while one is active
    optionsPanel.querySelectorAll(`.btn-preview:not([data-index="${index}"])`).forEach(b => b.disabled = true);
  } else {
    addMsg(`Preview failed: ${r.error || "unknown error"}`, "error");
  }
}

// ── Accept logic ──────────────────────────────────────────────────────────────
async function handleAccept(index) {
  if (!pendingOptions || !capturedCtx) return;

  // Always revert any active preview before committing
  await revertPreview();

  // Apply fresh (this call saves to storage)
  const r = await chrome.runtime.sendMessage({
    type:     "APPLY_PATCH",
    patch:    pendingOptions[index].patch,
    selector: capturedCtx.selector
  }).catch(() => ({ ok: false, error: "Script injection failed" }));

  if (!r.ok) {
    addMsg(`Apply failed: ${r.error}`, "error");
    return;
  }

  undoState = { selector: capturedCtx.selector, original: r.original };
  btnUndo.classList.add("visible");
  addMsg("✓ Fix applied! Click ↩ Undo if something broke.", "system");
  clearOptions();
  clearContext();
}

// ── Undo ──────────────────────────────────────────────────────────────────────
btnUndo.addEventListener("click", async () => {
  if (!undoState) return;
  const r = await chrome.runtime.sendMessage({
    type:     "UNDO_PATCH",
    selector: undoState.selector,
    original: undoState.original
  }).catch(() => ({ ok: false }));

  if (r.ok) {
    addMsg("↩ Patch undone — page restored.", "system");
    undoState = null;
    btnUndo.classList.remove("visible");
  } else {
    addMsg("Could not undo — the element may have changed.", "error");
  }
});

// ── Input controls ────────────────────────────────────────────────────────────
function setInputEnabled(on) {
  complaint.disabled = !on;
  btnSend.disabled   = !on;
}

// ── Reset page ────────────────────────────────────────────────────────────────
btnReset.addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "CLEAR_PATCHES" })
    .catch(() => ({ ok: false, error: "Message failed" }));
  if (!r.ok) {
    addMsg(`Reset failed: ${r.error}`, "error");
  }
  // Page reloads automatically on success; no further action needed.
});

btnSend.addEventListener("click", sendComplaint);

complaint.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendComplaint();
  }
});
