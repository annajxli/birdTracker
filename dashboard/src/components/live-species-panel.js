/** Species details beside Live without navigating or interrupting its player. */
export function liveSpeciesPanel() {
  const panel = document.createElement("aside");
  panel.className = "live-species-panel";
  panel.setAttribute("aria-label", "Species details");
  panel.hidden = true;
  const toolbar = document.createElement("div");
  toolbar.className = "live-species-toolbar";
  const title = document.createElement("strong");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "live-button";
  close.textContent = "Close ×";
  close.setAttribute("aria-label", "Close species details");
  const frame = document.createElement("iframe");
  frame.title = "Species details";
  toolbar.append(title, close);
  panel.append(toolbar, frame);
  document.body.append(panel);
  let returnFocus;
  const hide = () => {
    panel.hidden = true;
    document.body.classList.remove("live-species-open");
    frame.removeAttribute("src"); // stop any species-page audio when closing
    returnFocus?.isConnected && returnFocus.focus();
  };
  close.onclick = hide;
  const escape = (event) => {
    if (event.key === "Escape" && !panel.hidden) { event.preventDefault(); hide(); }
  };
  document.addEventListener("keydown", escape);
  frame.onload = () => {
    // Same-origin embedded page; Escape works even after focus enters the frame.
    try { frame.contentDocument?.addEventListener("keydown", escape); } catch {}
  };
  return {
    open(species) {
      returnFocus = document.activeElement;
      title.textContent = species;
      frame.src = `./species?name=${encodeURIComponent(species)}&embed=live`;
      panel.hidden = false;
      document.body.classList.add("live-species-open");
      close.focus();
    },
    destroy() {
      document.removeEventListener("keydown", escape);
      document.body.classList.remove("live-species-open");
      panel.remove();
    }
  };
}
