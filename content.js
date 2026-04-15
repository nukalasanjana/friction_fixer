// ── Friction Fixer · content.js ─────────────────────────────────────────────
// Injected into every page. Handles the element inspector and DOM capture.

(function () {
  if (window.__frictionFixerLoaded) return;
  window.__frictionFixerLoaded = true;

  // ── Re-apply persisted patches for this URL ──────────────────────────────
  // Ask background to replay patches via scripting.executeScript (world: MAIN)
  // so replay runs in the same context as the original patch application.
  chrome.runtime.sendMessage({ type: "REPLAY_PATCHES", url: window.location.href });

  let inspecting = false;
  let lastHighlighted = null;

  // ── Highlight overlay ────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.id = "__ff-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    border: "2px solid #7c3aed",
    background: "rgba(124,58,237,0.08)",
    borderRadius: "3px",
    zIndex: "2147483647",
    transition: "all 0.08s ease",
    display: "none",
    boxSizing: "border-box"
  });

  const tooltip = document.createElement("div");
  tooltip.id = "__ff-tooltip";
  Object.assign(tooltip.style, {
    position: "fixed",
    background: "#7c3aed",
    color: "#fff",
    fontSize: "11px",
    fontFamily: "monospace",
    padding: "2px 7px",
    borderRadius: "3px",
    zIndex: "2147483647",
    pointerEvents: "none",
    display: "none",
    whiteSpace: "nowrap"
  });

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);

  // ── CSS selector builder ─────────────────────────────────────────────────
  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body) {
      let part = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).filter(c => !c.startsWith("__ff")).slice(0, 2);
        if (cls.length) part += "." + cls.join(".");
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  // ── Capture element data ─────────────────────────────────────────────────
  function captureElement(el) {
    const styles = window.getComputedStyle(el);
    const html = el.outerHTML.slice(0, 1200); // truncate huge elements

    // Collect functional attributes so the model knows what must be preserved
    const FUNCTIONAL_ATTRS = [
      "href", "target", "rel",
      "onclick", "onchange", "onsubmit", "onmousedown", "onkeydown",
      "type", "name", "value", "action", "method", "for",
      "role", "aria-label", "aria-expanded", "aria-controls",
      "data-href", "data-url", "data-action", "data-toggle", "data-target"
    ];
    const functionalAttrs = {};
    FUNCTIONAL_ATTRS.forEach(attr => {
      const val = el.getAttribute(attr);
      if (val !== null) functionalAttrs[attr] = val;
    });
    // Also capture any data-* attributes not already listed
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && !(attr.name in functionalAttrs)) {
        functionalAttrs[attr.name] = attr.value;
      }
    }

    return {
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || "").slice(0, 200),
      html,
      functionalAttrs,
      styles: {
        fontSize:   styles.fontSize,
        color:      styles.color,
        background: styles.backgroundColor,
        display:    styles.display,
        fontWeight: styles.fontWeight,
        lineHeight: styles.lineHeight,
        padding:    styles.padding
      }
    };
  }

  // ── Inspector mouse events ───────────────────────────────────────────────
  function onMouseMove(e) {
    const el = e.target;
    if (el === overlay || el === tooltip || el.id === "__ff-overlay" || el.id === "__ff-tooltip") return;
    lastHighlighted = el;
    const rect = el.getBoundingClientRect();
    Object.assign(overlay.style, {
      display: "block",
      top:  rect.top  + "px",
      left: rect.left + "px",
      width:  rect.width  + "px",
      height: rect.height + "px"
    });
    const sel = getSelector(el);
    tooltip.textContent = sel.length > 60 ? sel.slice(-60) : sel;
    Object.assign(tooltip.style, {
      display: "block",
      top:  (rect.top - 22) + "px",
      left: rect.left + "px"
    });
    e.stopPropagation();
  }

  function onMouseClick(e) {
    if (!inspecting) return;
    if (e.target.id === "__ff-overlay" || e.target.id === "__ff-tooltip") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stopInspector();
    const data = captureElement(e.target);
    chrome.runtime.sendMessage({ type: "ELEMENT_CAPTURED", data });
  }

  // ── Start / Stop inspector ───────────────────────────────────────────────
  function startInspector() {
    if (inspecting) return;
    inspecting = true;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click",     onMouseClick, true);
    document.body.style.cursor = "crosshair";
  }

  function stopInspector() {
    if (!inspecting) return;
    inspecting = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click",     onMouseClick, true);
    overlay.style.display  = "none";
    tooltip.style.display  = "none";
    document.body.style.cursor = "";
  }

  // ── Listen for messages from background ─────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "START_INSPECTOR") startInspector();
    if (msg.type === "STOP_INSPECTOR")  stopInspector();
  });

  // Escape key cancels inspector
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inspecting) {
      stopInspector();
      chrome.runtime.sendMessage({ type: "INSPECTOR_CANCELLED" });
    }
  }, true);

})();
