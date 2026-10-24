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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400..600;1,6..72,400&family=Public+Sans:wght@400..900&display=swap">`;

const icon = `<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🐦</text></svg>">`;

// Page menu: a hamburger button that opens a small panel (replaces Framework's sidebar).
const menuPages = [
  ["Overview", "./"],
  ["Species", "./species"],
  ["Year", "./year"],
  ["Detections", "./detections"]
];

const menuScript = `<script>
(() => {
  const root = document.documentElement;
  const setOpen = (open) => {
    root.toggleAttribute("data-menu-open", open);
    document.querySelector(".menu-toggle")?.setAttribute("aria-expanded", String(open));
  };
  document.addEventListener("click", (event) => {
    if (event.target.closest(".menu-toggle")) return setOpen(!root.hasAttribute("data-menu-open"));
    if (!event.target.closest(".site-menu")) setOpen(false);
  });
  addEventListener("keydown", (event) => { if (event.key === "Escape") setOpen(false); });
  // Mark the current page in the menu.
  addEventListener("DOMContentLoaded", () => {
    const here = location.pathname.replace(/\\.html$/, "").replace(/\\/$/, "").split("/").pop() || "index";
    for (const a of document.querySelectorAll(".site-menu a")) {
      const page = a.getAttribute("href").replace("./", "") || "index";
      if (page === here) a.setAttribute("aria-current", "page");
    }
  });
})();
</script>`;

const header = `<div class="site-header">
  <div class="header-left">
    <button class="menu-toggle" type="button" aria-label="Pages" aria-expanded="false" aria-controls="site-menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
    </button>
    <span class="eyebrow">Backyard station · Seattle, WA</span>
    <nav class="site-menu" id="site-menu">${menuPages.map(([name, href]) => `<a href="${href}">${name}</a>`).join("")}</nav>
  </div>
  <div class="header-buttons">
  ${dev ? `<button class="phone-toggle" type="button" aria-label="Preview this page at phone size" title="Preview at phone size">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>
    <span>Phone</span>
  </button>` : ""}
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
    {name: "Species", path: "/species"},
    {name: "Year", path: "/year"},
    {name: "Detections", path: "/detections"}
  ],
  sidebar: false,
  head: `${fonts}\n${icon}\n${themeScript}\n${dev ? phoneScript : ""}\n${menuScript}`,
  header,
  interpreters: {".py": [python]},
  search: false,
  footer: 'Detections by <a href="https://github.com/birdnet-team/BirdNET-Analyzer">BirdNET</a>. Bird photos from <a href="https://commons.wikimedia.org">Wikimedia Commons</a>; tap the ⓘ on a photo for its credit and license. Data is simulated for now.'
};
