// ── Friction Fixer · sidepanel.js ───────────────────────────────────────────

// ── DOM refs ─────────────────────────────────────────────────────────────────
const statusDot    = document.getElementById("status-dot");
const statusLabel  = document.getElementById("status-label");
const contextBar   = document.getElementById("context-bar");
const ctxText      = document.getElementById("ctx-text");
const ctxClear     = document.getElementById("ctx-clear");
const chat         = document.getElementById("chat");
const patchCard    = document.getElementById("patch-card");
const strategyPill = document.getElementById("strategy-pill");
const cardDiag     = document.getElementById("card-diagnosis");
const cardRat      = document.getElementById("card-rationale");
const cardCode     = document.getElementById("card-code");
const btnApply     = document.getElementById("btn-apply");
const btnDismiss   = document.getElementById("btn-dismiss");
const btnInspector = document.getElementById("btn-inspector");
const btnUndo      = document.getElementById("btn-undo");
const btnReset     = document.getElementById("btn-reset");
const complaint    = document.getElementById("complaint");
const btnSend      = document.getElementById("btn-send");

// ── State ────────────────────────────────────────────────────────────────────
let capturedCtx  = null;   // { selector, tag, text, html, styles }
let pendingPatch = null;   // { strategy, diagnosis, rationale, patch }
let undoState    = null;   // { selector, original } for undo
let busy         = false;

// ── Ollama status polling ────────────────────────────────────────────────────
function setStatus(online) {
  statusDot.className   = "status-dot" + (online ? "" : " offline");
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
  d.innerHTML = `<div class="dot-pulse"><span></span><span></span><span></span></div> Generating patch…`;
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
  if (inspecting) {
    stopInspecting();
  } else {
    startInspecting();
  }
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

// ── Send complaint → generate patch ─────────────────────────────────────────
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

  // Hide any existing patch card
  hidePatchCard();

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

  pendingPatch = r.patch;
  showPatchCard(r.patch);
}

// ── Patch card ───────────────────────────────────────────────────────────────
function showPatchCard(patch) {
  strategyPill.textContent  = patch.strategy || "Patch";
  strategyPill.className    = `strategy-pill ${patch.strategy || "Conservation"}`;
  cardDiag.textContent      = patch.diagnosis || "";
  cardRat.textContent       = patch.rationale || "";
  cardCode.textContent      = patch.patch || "";
  btnApply.disabled = false;
  patchCard.classList.add("visible");
  chat.scrollTop = chat.scrollHeight;
}

function hidePatchCard() {
  patchCard.classList.remove("visible");
  pendingPatch = null;
}

// ── Apply patch ───────────────────────────────────────────────────────────────
btnApply.addEventListener("click", async () => {
  if (!pendingPatch || !capturedCtx) return;
  btnApply.disabled = true;
  btnApply.textContent = "Applying…";

  const r = await chrome.runtime.sendMessage({
    type:     "APPLY_PATCH",
    patch:    pendingPatch.patch,
    selector: capturedCtx.selector
  }).catch(() => ({ ok: false, error: "Script injection failed" }));

  btnApply.textContent = "✓ Apply Patch";

  if (r.ok) {
    // Store undo state
    undoState = { selector: capturedCtx.selector, original: r.original };
    btnUndo.classList.add("visible");
    addMsg("✓ Patch applied! Click ↩ Undo if something broke.", "system");
    hidePatchCard();
    clearContext();
  } else {
    addMsg(`Apply failed: ${r.error}`, "error");
    btnApply.disabled = false;
  }
});

btnDismiss.addEventListener("click", () => {
  hidePatchCard();
  addMsg("Patch dismissed.", "system");
});

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
