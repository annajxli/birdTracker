// Cloudflare Worker: the site's sign-in, in front of the dashboard.
//
// Serves the built site from its static assets (env.ASSETS; see wrangler.toml), so there is no
// public origin to go around it. Visitors without a valid session cookie get a sign-in page; the
// right password sets the cookie. Setup is in docs/deploy.md.
//
// The cookie is "<expiry>.<signature>": an HMAC over the expiry and a hash of the password, keyed
// with the SESSION_KEY secret, so it stops working when it expires or either secret changes, and a
// stolen cookie reveals nothing about the password. Without SESSION_KEY the password is the key,
// which lets a stolen cookie be used to guess the password offline, so set SESSION_KEY.
//
// Signed-in routes, all backed by the R2 bucket bound as MEDIA (written by pipeline/publish.py):
//   GET  /api/clips/<key>   serves <key> (keys start with clips/)
//   GET  /api/live/<name>   serves live/<name>
//   GET  /api/data/detections.parquet, /api/data/recordings.parquet
//   POST /api/reviews       {"verdict": "rejected" | "confirmed" | null (clears),
//                            "detections": [{"at": "<UTC time>", "scientific": "<name>"}, ...]},
//                           saved as reviews/<time>-<id>.json for publish.py to apply
//   GET  /api/pause         {"until": "<UTC time>" | null, "set_at": ...}
//   POST /api/pause         {"password": ..., "minutes": 30 | 60 | 90 | 120 | 0 (resume now)};
//                           needs CONTROL_PASSWORD, rate-limited like sign-in, saves
//                           control/pause.json for the Pi. Pauses always end on their own.

const COOKIE = "bt_session";
const DATA = new Set(["/api/data/detections.parquet", "/api/data/recordings.parquet"]);
const SESSION_DAYS = 30;
const VERDICTS = new Set(["rejected", "confirmed", null]);
const MAX_REVIEWED = 500; // detections in one review
const SIGN_IN = "/__signin";
const SIGN_OUT = "/__signout";
const PAUSE_KEY = "control/pause.json";
const PAUSE_MINUTES = new Set([0, 30, 60, 90, 120]); // 0 ends the pause now

export default {
  async fetch(request, env) {
    if (!env.PASSWORD) return new Response("PASSWORD secret is not set", {status: 500});
    const url = new URL(request.url);

    if (url.pathname === SIGN_IN && request.method === "POST") {
      // Too many attempts from one address: refuse before even looking at the password.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (env.SIGN_IN_LIMIT && !(await env.SIGN_IN_LIMIT.limit({key: ip})).success) {
        return signInPage(env, url, "/", false, "Too many attempts. Wait a minute and try again.", 429);
      }
      let form;
      try {
        form = await request.formData();
      } catch {
        return signInPage(env, url, "/", false);
      }
      const next = safeNext(form.get("next"));
      if (await sameSecret(String(form.get("password") ?? ""), env.PASSWORD)) {
        const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
        return redirect(next, `${COOKIE}=${await sessionToken(env, expires)}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      }
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing a little
      return signInPage(env, url, next, true);
    }

    if (url.pathname === SIGN_OUT) return redirect("/", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);

    if (!(await validSession(env, readCookie(request, COOKIE)))) {
      return signInPage(env, url, url.pathname + url.search, false);
    }

    if (url.pathname === "/api/pause") return request.method === "POST" ? setPause(request, env, url) : request.method === "GET" ? getPause(env) : new Response("GET or POST only", {status: 405});

    if (url.pathname === "/api/reviews") return request.method === "POST" ? review(request, env, url) : new Response("POST only", {status: 405});

    if (url.pathname.startsWith("/api/clips/") || url.pathname.startsWith("/api/live/") || DATA.has(url.pathname)) {
      return media(request, env, url.pathname);
    }

    // The session cookie stays here; the static files don't need it.
    const inner = new Request(request);
    inner.headers.delete("Cookie");
    const response = await env.ASSETS.fetch(inner);
    // Keep shared caches and search engines from holding on to private pages.
    const headers = new Headers(response.headers);
    // Pages aren't cached at all (so signing out really hides them); hashed assets briefly, privately.
    const html = (headers.get("Content-Type") ?? "").startsWith("text/html");
    headers.set("Cache-Control", html ? "no-store" : "private, max-age=300");
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  }
};

// A verdict on some detections, saved for the Pi to apply. Only from the site's own pages.
async function review(request, env, url) {
  if (request.headers.get("Origin") !== url.origin) return new Response("forbidden", {status: 403});
  if (!env.MEDIA) return new Response("no bucket", {status: 503});
  if (Number(request.headers.get("Content-Length") ?? 0) > 64 * 1024) return new Response("too large", {status: 413});
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("not JSON", {status: 400});
  }
  const list = Array.isArray(body?.detections) ? body.detections : [];
  const ok = body !== null && typeof body === "object" && VERDICTS.has(body.verdict) && list.length > 0 && list.length <= MAX_REVIEWED &&
    list.every((d) => typeof d?.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(d.at) &&
      typeof d.scientific === "string" && /^[A-Za-z][A-Za-z .'-]{1,79}$/.test(d.scientific));
  if (!ok) return new Response("bad review", {status: 400});
  const at = new Date().toISOString();
  const record = {at, verdict: body.verdict, detections: list.map((d) => ({at: d.at, scientific: d.scientific}))};
  await env.MEDIA.put(`reviews/${at.replace(/[-:.]/g, "")}-${crypto.randomUUID()}.json`, JSON.stringify(record),
    {httpMetadata: {contentType: "application/json"}});
  return new Response(JSON.stringify({ok: true}), {headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});
}

const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}});

// The saved pause while it lasts, else null.
async function currentPause(env) {
  const object = await env.MEDIA.get(PAUSE_KEY);
  let pause = null;
  try { pause = object ? JSON.parse(await object.text()) : null; } catch {}
  return typeof pause?.until === "string" && Date.parse(pause.until) > Date.now() ? pause : null;
}

// The recorder's pause, or none.
async function getPause(env) {
  if (!env.MEDIA) return new Response("no bucket", {status: 503});
  const pause = await currentPause(env);
  return json({until: pause?.until ?? null, set_at: pause?.set_at ?? null});
}

// Pause the recorder, or end a pause. Only from the site's own pages, with the control password.
async function setPause(request, env, url) {
  if (request.headers.get("Origin") !== url.origin) return new Response("forbidden", {status: 403});
  if (!env.MEDIA) return new Response("no bucket", {status: 503});
  if (!env.CONTROL_PASSWORD) return new Response("CONTROL_PASSWORD secret is not set", {status: 503});
  if (Number(request.headers.get("Content-Length") ?? 0) > 4 * 1024) return new Response("too large", {status: 413});
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (env.SIGN_IN_LIMIT && !(await env.SIGN_IN_LIMIT.limit({key: "pause:" + ip})).success) return json({error: "limit"}, 429);
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("not JSON", {status: 400});
  }
  if (body === null || typeof body !== "object" || typeof body.password !== "string" || !PAUSE_MINUTES.has(body.minutes)) return new Response("bad pause", {status: 400});
  if (!(await sameSecret(body.password, env.CONTROL_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing a little
    return json({error: "password"}, 403);
  }
  // A new end for a pause that's on keeps its start, so the receiver still drops audio recorded
  // since then that arrives late.
  const now = Date.now(), on = body.minutes ? await currentPause(env) : null;
  const record = {until: body.minutes ? new Date(now + body.minutes * 6e4).toISOString() : null,
    set_at: typeof on?.set_at === "string" ? on.set_at : new Date(now).toISOString()};
  await env.MEDIA.put(PAUSE_KEY, JSON.stringify(record), {httpMetadata: {contentType: "application/json"}});
  return json(record);
}

// A file from the MEDIA bucket. Supports Range requests: Safari won't play audio without them.
async function media(request, env, path) {
  const key = DATA.has(path) ? path.slice("/api/".length)
    : path.startsWith("/api/live/") ? "live/" + path.slice("/api/live/".length) : path.slice("/api/clips/".length);
  const valid = DATA.has(path) || (/^(clips|live)\/[\w\-./]+$/.test(key) && !key.includes(".."));
  if (!env.MEDIA || !valid) return new Response("not found", {status: 404});
  const head = request.method === "HEAD";
  const object = head ? await env.MEDIA.head(key) : await env.MEDIA.get(key, {range: request.headers});
  if (!object) return new Response("not found", {status: 404});
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  // live.json and the detections change all the time; strips and clips never change once written.
  headers.set("Cache-Control", key.endsWith(".json") || key.startsWith("data/") ? "no-store" : "private, max-age=86400");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  let status = 200;
  if (object.range && request.headers.has("Range")) {
    const offset = object.range.offset ?? object.size - object.range.suffix;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }
  return new Response(head ? null : object.body, {status, headers});
}

// Sent with every page: no framing, no MIME sniffing, no referrer, HTTPS only.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Robots-Tag": "noindex, nofollow"
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(keyText, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** The cookie value for a session expiring at `expires` (Unix seconds): "<expires>.<hmac>". */
export async function sessionToken(env, expires) {
  const passwordHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.PASSWORD)));
  return `${expires}.${await hmac(env.SESSION_KEY || env.PASSWORD, `bird-tracker-session-v2|${expires}|${passwordHash}`)}`;
}

/** A cookie value that this Worker issued, with the current secrets, and that hasn't expired. */
export async function validSession(env, value) {
  const match = /^(\d{1,12})\.[0-9a-f]{64}$/.exec(value ?? "");
  if (!match || Number(match[1]) * 1000 <= Date.now()) return false;
  return sameSecret(value, await sessionToken(env, Number(match[1])));
}

/** Equal strings? Compares digests so the time taken doesn't depend on how close a guess is. */
export async function sameSecret(given, expected) {
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  return a.every((byte, i) => byte === b[i]);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/**
 * Only same-site paths, so the sign-in form can't be used to bounce people elsewhere.
 * Browsers drop tabs and newlines from URLs and treat "\\" like "/", so "/\t/evil.example"
 * would become "//evil.example": reject control characters and backslashes outright, then
 * check that the path really resolves on this site.
 */
export function safeNext(next) {
  const path = String(next ?? "/");
  if (!path.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(path)) return "/";
  const here = "https://same-site.invalid";
  const url = new URL(path, here);
  return url.origin === here ? url.pathname + url.search + url.hash : "/";
}

function redirect(location, cookie) {
  return new Response(null, {status: 303, headers: {Location: location, "Set-Cookie": cookie, "Cache-Control": "no-store"}});
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]);

// The chart beside the password (pipeline/signin_chart.py, written into the built site), kept for
// a few minutes per Worker instance. Without it, the page shows the password card alone.
const CHART_PATH = "/signin-chart.svg";
const CHART_SECONDS = 600;
const chartCache = new WeakMap(); // env.ASSETS -> {svg, at}
async function signInChart(env, url) {
  const cached = chartCache.get(env.ASSETS);
  if (cached && Date.now() - cached.at < CHART_SECONDS * 1000) return cached.svg;
  let svg = "";
  try {
    const r = await env.ASSETS.fetch(new Request(new URL(CHART_PATH, url)));
    const text = r.ok && (r.headers.get("Content-Type") ?? "").includes("svg") ? await r.text() : "";
    svg = text.startsWith("<svg") ? text : "";
  } catch {}
  chartCache.set(env.ASSETS, {svg, at: Date.now()});
  return svg;
}

async function signInPage(env, url, next, failed, message = "That password didn't work.", status = 401) {
  const chart = await signInChart(env, url);
  const html = SIGN_IN_HTML.replace("{{next}}", escapeHtml(safeNext(next))).replace("{{error}}", failed || status !== 401 ? message : "")
    .replace("{{layout}}", chart ? "signin with-chart" : "signin").replace("{{chart}}", chart ? `<aside class="chart-card">${chart}</aside>` : "");
  return new Response(html, {
    status,
    headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS}
  });
}

// Styled like the dashboard. No site name or location before sign-in; the chart shows no dates.
const SIGN_IN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Password</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400..700&display=swap">
<script>try { const t = localStorage.getItem("birdtracker-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}</script>
<style>
  :root { --bg: #f3ede2; --card: #faf6ee; --ink: #2a221b; --muted: #7a7064; --rule: #d4c8b2; --accent: #5a6b1f; --on-accent: #faf6ee; --error: #a3402c; --series: #6f8a2a; --grid: #e4dccb; --sun: #d9a53b; --wet: #5b8fd6; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #17130f; --card: #201b16; --ink: #ece3d3; --muted: #a39a8a; --rule: #3d352b; --accent: #c2cf7a; --on-accent: #17130f; --error: #e8907c; --series: #829c35; --grid: #2e2821; color-scheme: dark; } }
  :root[data-theme="dark"] { --bg: #17130f; --card: #201b16; --ink: #ece3d3; --muted: #a39a8a; --rule: #3d352b; --accent: #c2cf7a; --on-accent: #17130f; --error: #e8907c; --series: #829c35; --grid: #2e2821; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 "Public Sans", system-ui, sans-serif; }
  main { width: 100%; background: var(--card); border: 1px solid var(--rule); border-top: 2px solid var(--ink); padding: 28px 28px 24px; }
  label { display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--muted); }
  input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
  input[type="password"]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: 600 1rem "Public Sans", system-ui, sans-serif; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .error { min-height: 1.4em; margin: 10px 0 0; font-size: 0.85rem; color: var(--error); }
  .hidden { display: none; }
  /* The password card alone, or beside the chart at the same height; stacked at the same width on a phone. */
  .signin { width: 100%; max-width: 360px; display: grid; gap: 16px; }
  .signin.with-chart { max-width: 1000px; grid-template-columns: 360px minmax(0, 1fr); }
  .signin main, .chart-card { display: flex; flex-direction: column; justify-content: center; }
  .chart-card { min-width: 0; background: var(--card); border: 1px solid var(--rule); border-top: 2px solid var(--ink); padding: 16px 18px 14px; }
  @media (max-width: 760px) { .signin.with-chart { max-width: 560px; grid-template-columns: minmax(0, 1fr); } }
  .chart-card svg { display: block; width: 100%; height: auto; overflow: visible; }
  .chart-card text { fill: var(--muted); font: 11px "Public Sans", system-ui, sans-serif; font-variant-numeric: tabular-nums; }
  .chart-card .axis { font-size: 10.5px; }
  .chart-card .grid { stroke: var(--grid); }
  .chart-card .bar { fill: var(--series); }
  .chart-card .icon .stroke { fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
  .chart-card .icon-sun { fill: var(--sun); color: var(--sun); }
  .chart-card .icon-dry { fill: var(--muted); color: var(--muted); }
  .chart-card .icon-wet { fill: var(--wet); color: var(--wet); }
</style>
</head>
<body>
<div class="{{layout}}">
<main>
  <form method="post" action="${SIGN_IN}">
    <input class="hidden" type="text" name="username" value="site" autocomplete="username" tabindex="-1" aria-hidden="true">
    <input type="hidden" name="next" value="{{next}}">
    <label for="password">Password</label>
    <input id="password" type="password" name="password" autocomplete="current-password" autofocus required>
    <button type="submit">Enter</button>
    <p class="error" role="alert">{{error}}</p>
  </form>
</main>
{{chart}}
</div>
</body>
</html>`;
