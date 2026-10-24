// Cloudflare Worker: a shared password in front of the dashboard.
//
// Runs on the dashboard's subdomain and serves the built site itself, from the
// Worker's static assets (env.ASSETS; see wrangler.toml), so there is no public
// origin to go around it. Visitors without a valid session cookie get a small
// sign-in page styled like the dashboard; the right password sets a cookie good
// for 30 days. The cookie is derived from the PASSWORD secret, so changing the
// password signs everyone out. Setup is in docs/deploy.md.

const COOKIE = "bt_session";
const SESSION_DAYS = 30;
const SIGN_IN = "/__signin";
const SIGN_OUT = "/__signout";

export default {
  async fetch(request, env) {
    if (!env.PASSWORD) return new Response("PASSWORD secret is not set", {status: 500});
    const url = new URL(request.url);
    const session = await sessionToken(env.PASSWORD);

    if (url.pathname === SIGN_IN && request.method === "POST") {
      let form;
      try {
        form = await request.formData();
      } catch {
        return signInPage("/", false);
      }
      const next = safeNext(form.get("next"));
      if (await sameSecret(String(form.get("password") ?? ""), env.PASSWORD)) {
        return redirect(next, `${COOKIE}=${session}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      }
      await new Promise((r) => setTimeout(r, 600)); // slow down guessing a little
      return signInPage(next, true);
    }

    if (url.pathname === SIGN_OUT) return redirect("/", `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);

    if (!(await sameSecret(readCookie(request, COOKIE) ?? "", session))) {
      return signInPage(url.pathname + url.search, false);
    }

    // The session cookie stays here; the static files don't need it.
    const inner = new Request(request);
    inner.headers.delete("Cookie");
    const response = await env.ASSETS.fetch(inner);
    // Keep shared caches and search engines from holding on to private pages.
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, max-age=300");
    headers.set("X-Robots-Tag", "noindex, nofollow");
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  }
};

/** The cookie value for a password: HMAC-SHA256(password, fixed label), hex. */
export async function sessionToken(password) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("bird-tracker-session-v1"));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
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

function signInPage(next, failed) {
  return new Response(SIGN_IN_HTML.replace("{{next}}", escapeHtml(safeNext(next))).replace("{{error}}", failed ? "That password didn't work." : ""), {
    status: 401,
    headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"}
  });
}

// Cedar & Olive, like the dashboard (colors, font, light/dark), but deliberately
// anonymous: no site name or location until someone signs in.
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
  :root { --bg: #f3ede2; --card: #faf6ee; --ink: #2a221b; --muted: #7a7064; --rule: #d4c8b2; --accent: #5a6b1f; --on-accent: #faf6ee; --error: #a3402c; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #17130f; --card: #201b16; --ink: #ece3d3; --muted: #a39a8a; --rule: #3d352b; --accent: #c2cf7a; --on-accent: #17130f; --error: #e8907c; color-scheme: dark; } }
  :root[data-theme="dark"] { --bg: #17130f; --card: #201b16; --ink: #ece3d3; --muted: #a39a8a; --rule: #3d352b; --accent: #c2cf7a; --on-accent: #17130f; --error: #e8907c; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink); font: 16px/1.5 "Public Sans", system-ui, sans-serif; }
  main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--rule); border-top: 2px solid var(--ink); padding: 28px 28px 24px; }
  label { display: block; margin-bottom: 6px; font-size: 0.85rem; color: var(--muted); }
  input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; }
  input[type="password"]:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: 600 1rem "Public Sans", system-ui, sans-serif; cursor: pointer; }
  button:hover { filter: brightness(1.06); }
  .error { min-height: 1.4em; margin: 10px 0 0; font-size: 0.85rem; color: var(--error); }
  .hidden { display: none; }
</style>
</head>
<body>
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
</body>
</html>`;
