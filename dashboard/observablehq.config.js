import {fileURLToPath} from "node:url";

// Data loaders (*.py) run with the repo's virtualenv so they can import the pipeline.
const python = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));

// Light/dark toggle. Runs in <head> so the saved choice applies before first paint.
// data-theme = the viewer's explicit choice (absent = follow the OS);
// data-scheme = what is actually showing, used to label the toggle.
const themeScript = `<script>
(() => {
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: dark)");
  let saved = null;
  try { saved = localStorage.getItem("birdtracker-theme"); } catch {}
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  const sync = () => (root.dataset.scheme = root.dataset.theme || (media.matches ? "dark" : "light"));
  sync();
  media.addEventListener("change", sync);
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".theme-toggle")) return;
    root.dataset.theme = root.dataset.scheme === "dark" ? "light" : "dark";
    try { localStorage.setItem("birdtracker-theme", root.dataset.theme); } catch {}
    sync();
    // Keep an open phone preview in step.
    const inner = document.querySelector("#phone-preview iframe")?.contentDocument?.documentElement;
    if (inner) Object.assign(inner.dataset, {theme: root.dataset.theme, scheme: root.dataset.scheme});
  });
})();
</script>`;

// The local preview server (`npm run dev`, i.e. `observable preview`) gets dev-only tools;
// published builds (`observable build`) leave them out.
const dev = process.argv.includes("preview");

// Reuse the last loaded size of variable-height home charts during a refresh.
// CSS supplies first-visit fallbacks; it releases the space as each cell resolves.
const layoutScript = `<script>
(() => {
  const ids = ["home-recent", "home-timeline", "home-ranking", "home-trends", "home-seasons"];
  const key = () => "birdtracker-layout-v1:" + innerWidth + "x" + innerHeight;
  let sizes = {};
  try { sizes = JSON.parse(sessionStorage.getItem(key()) || "{}"); } catch {}
  const style = document.createElement("style");
  const apply = () => {
    style.textContent = ids.filter((id) => Number.isFinite(sizes[id]) && sizes[id] > 0)
      .map((id) => "#" + id + " { --layout-saved-height: " + sizes[id] + "px; }").join("\\n");
  };
  apply();
  document.head.append(style);
  addEventListener("DOMContentLoaded", () => {
    const nodes = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!nodes.length) return;
    let frame;
    const remember = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const node of nodes) {
          if (node.querySelector("observablehq-loading, .observablehq--error")) continue;
          const height = node.getBoundingClientRect().height;
          if (height > 0) sizes[node.id] = height;
        }
        try { sessionStorage.setItem(key(), JSON.stringify(sizes)); } catch {}
        apply();
      });
    };
    const resize = new ResizeObserver(remember);
    const changes = new MutationObserver(remember);
    for (const node of nodes) {
      resize.observe(node);
      changes.observe(node, {childList: true, subtree: true});
    }
    addEventListener("resize", () => {
      try { sizes = JSON.parse(sessionStorage.getItem(key()) || "{}"); } catch { sizes = {}; }
      apply();
      remember();
    });
  });
})();
</script>`;

// Phone preview (dev only): shows the current page in an iPhone 16 Pro-sized frame
// (402 x 874 pt). The page loads in an iframe at that real width, so media queries and
// chart sizing behave exactly as on a phone. Inside the frame, the phone button is hidden.
const phoneScript = `<script>
(() => {
  const PHONE = {name: "iPhone 16 Pro", width: 402, height: 874};
  const root = document.documentElement;
  if (window.self !== window.top) { root.dataset.inFrame = ""; return; }
  const close = () => { document.getElementById("phone-preview")?.remove(); delete root.dataset.phone; };
  const fit = (frame) => {
    const scale = Math.min(1, (innerHeight - 64) / (PHONE.height + 24), (innerWidth - 32) / (PHONE.width + 24));
    frame.style.transform = "scale(" + scale + ")";
    // A transform doesn't shrink the box's layout size, so pull in the margins to match.
    const outerH = PHONE.height + 24, outerW = PHONE.width + 24;
    frame.style.margin = (-(outerH * (1 - scale)) / 2) + "px " + (-(outerW * (1 - scale)) / 2) + "px";
  };
  const open = () => {
    const overlay = document.createElement("div");
    overlay.id = "phone-preview";
    overlay.innerHTML = '<div class="phone-frame"><iframe title="Phone preview"></iframe></div>' +
      '<div class="phone-caption">' + PHONE.name + " \u00b7 " + PHONE.width + " \u00d7 " + PHONE.height + " \u00b7 Esc to close</div>";
    const frame = overlay.querySelector(".phone-frame");
    Object.assign(frame.style, {width: PHONE.width + "px", height: PHONE.height + "px"});
    overlay.querySelector("iframe").src = location.href;
    overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
    document.body.append(overlay);
    root.dataset.phone = "";
    fit(frame);
  };
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".phone-toggle")) return;
    "phone" in root.dataset ? close() : open();
  });
  addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  addEventListener("resize", () => { const f = document.querySelector("#phone-preview .phone-frame"); if (f) fit(f); });
})();
</script>`;

const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400&family=Public+Sans:ital,wght@0,400..900;1,400..700&display=swap">`;

// Favicon (src/favicon.svg): a perched songbird with song waves, in the dashboard's olive and cream.
const icon = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`;

// Page links: one icon button per page in the header; mark the current one.
const menuScript = `<script>
addEventListener("DOMContentLoaded", () => {
  const here = location.pathname.replace(/\\.html$/, "").replace(/\\/$/, "").split("/").pop() || "index";
  for (const a of document.querySelectorAll(".page-icons a")) {
    const page = a.getAttribute("href").replace("./", "") || "index";
    if (page === here) a.setAttribute("aria-current", "page");
  }
});
</script>`;

const header = `<div class="site-header">
  <div class="header-left">
    <span class="eyebrow">Seattle, WA</span>
  </div>
  <div class="header-buttons">
  ${dev ? `<button class="phone-toggle" type="button" aria-label="Preview this page at phone size" title="Preview at phone size">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>
    <span>Phone</span>
  </button>` : ""}
  <nav class="page-icons" aria-label="Pages">
    <a class="icon-link" href="./" aria-label="Overview" title="Overview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5"/><path d="M6.5 10v9h11v-9"/><path d="M10.5 19v-5h3v5"/></svg>
    </a>
    <a class="icon-link" href="./live" aria-label="Live" title="Live">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>
    </a>
    <a class="icon-link" href="./display" aria-label="Display" title="Display">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16.5V20"/></svg>
    </a>
    <a class="icon-link" href="./species" aria-label="Species" title="Species">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16c3 0 5-1.2 6-4 .9-2.6 3-4.5 5.5-4.5 1.6 0 2.8.9 3.3 2.2L21 10l-2.2 1c0 3.6-3 6.5-7 6.5H7z"/><path d="M10.5 17.5 9 20.5M13.5 17.5l.5 3"/><circle cx="16.2" cy="9.6" r="0.4" fill="currentColor"/></svg>
    </a>
    <a class="icon-link" href="./detections" aria-label="Detections" title="Detections">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="15.5" r="3.5"/><circle cx="17" cy="15.5" r="3.5"/><path d="M10.5 15.5h3M5 12.5 7 5.5h2.5l1 7M19 12.5 17 5.5h-2.5l-1 7"/></svg>
    </a>
    <a class="icon-link" href="./hardware" aria-label="Hardware analytics" title="Hardware analytics">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/></svg>
    </a>
  </nav>
  <button class="refresh-button" type="button" aria-label="Refresh: load the latest detections" title="Load the latest detections" onclick="location.reload()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/></svg>
  </button>
  <button class="theme-toggle" type="button" aria-label="Switch between light and dark mode">
    <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>
    <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
    <span class="label-dark">Dark</span><span class="label-light">Light</span>
  </button>
  </div>
</div>`;

export default {
  title: "Bird Tracker",
  root: "src",
  style: "style.css",
  pages: [
    {name: "Overview", path: "/"},
    {name: "Live", path: "/live"},
    {name: "Species", path: "/species"},
    {name: "Display", path: "/display"},
    {name: "Hardware analytics", path: "/hardware"},
    {name: "Detections", path: "/detections"}
  ],
  sidebar: false,
  pager: false, // no "Next page" link at the bottom of each page
  head: `${fonts}\n${icon}\n${themeScript}\n${layoutScript}\n${dev ? phoneScript : ""}\n${menuScript}`,
  header,
  interpreters: {".py": [python]},
  search: false,
  footer: 'Detections by <a href="https://github.com/birdnet-team/BirdNET-Analyzer">BirdNET</a>. Bird photos from <a href="https://commons.wikimedia.org">Wikimedia Commons</a>; tap the ⓘ on a photo for its credit and license.'
};
