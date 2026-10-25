// Checks for the sign-in Worker, run with: node deploy/password-worker.test.mjs
import worker, {sessionToken, validSession, safeNext} from "./password-worker.js";
// Stands in for the Worker's static assets; remembers the last request it served.
let served = null;
const ASSETS = {fetch: async (req) => { served = req; return new Response("<h1>dashboard " + new URL(req.url).pathname + "</h1>", {status: 200, headers: {"Content-Type": "text/html", "Cache-Control": "max-age=600"}}); }};
const env = {PASSWORD: "robin-song", SESSION_KEY: "k".repeat(40), ASSETS};
const base = "https://birds.example.com";
let fails = 0;
const check = (ok, name, extra = "") => { console.log(ok ? "ok  " : "FAIL", name, extra); if (!ok) fails++; };
const post = (pw, next) => new Request(base + "/__signin", {method: "POST", body: new URLSearchParams({password: pw, next, username: "site"})});

let r = await worker.fetch(new Request(base + "/species?name=Pacific%20Wren"), env);
let body = await r.text();
check(r.status === 401 && body.includes('name="password"') && body.includes('value="/species?name=Pacific%20Wren"'), "no cookie -> sign-in page, remembers where you were going");
check(r.headers.get("Cache-Control") === "no-store", "sign-in page not cached");

r = await worker.fetch(post("wrong", "/year"), env);
body = await r.text();
check(r.status === 401 && body.includes("didn't work") && !r.headers.get("Set-Cookie"), "wrong password -> error, no cookie");

r = await worker.fetch(post("robin-song", "/year"), env);
const cookie = r.headers.get("Set-Cookie");
check(r.status === 303 && r.headers.get("Location") === "/year", "right password -> back to /year", r.headers.get("Location"));
check(/HttpOnly/.test(cookie) && /Secure/.test(cookie) && /Max-Age=2592000/.test(cookie) && /SameSite=Lax/.test(cookie), "cookie is HttpOnly, Secure, 30 days");

const value = cookie.split(";")[0];
r = await worker.fetch(new Request(base + "/year", {headers: {Cookie: "theme=x; " + value}}), env);
body = await r.text();
check(r.status === 200 && body.includes("dashboard /year") && r.headers.get("Cache-Control") === "no-store", "with cookie -> site, pages not cached");
check(r.headers.get("Content-Security-Policy") === "frame-ancestors 'none'" && r.headers.get("X-Content-Type-Options") === "nosniff" && r.headers.get("Referrer-Policy") === "no-referrer", "security headers on pages");
check(served && !served.headers.has("Cookie"), "session cookie not passed on to the static files");

r = await worker.fetch(new Request(base + "/", {headers: {Cookie: "bt_session=deadbeef"}}), env);
check(r.status === 401, "forged cookie rejected");

r = await worker.fetch(new Request(base + "/", {headers: {Cookie: value}}), {...env, PASSWORD: "new-password"});
check(r.status === 401, "changing PASSWORD signs everyone out");
r = await worker.fetch(new Request(base + "/", {headers: {Cookie: value}}), {...env, SESSION_KEY: "j".repeat(40)});
check(r.status === 401, "changing SESSION_KEY signs everyone out");
const past = Math.floor(Date.now() / 1000) - 60;
check(!(await validSession(env, await sessionToken(env, past))), "expired session rejected");
const future = Math.floor(Date.now() / 1000) + 3600;
check(await validSession(env, await sessionToken(env, future)), "unexpired session accepted");
const tampered = (await sessionToken(env, future)).replace(/^\d+/, String(future + 10 * 365 * 86400));
check(!(await validSession(env, tampered)), "extending the expiry by hand breaks the signature");
const noKey = {PASSWORD: "robin-song", ASSETS};
check(await validSession(noKey, await sessionToken(noKey, future)) && !(await validSession(env, await sessionToken(noKey, future))), "works without SESSION_KEY, but those cookies differ");

r = await worker.fetch(post("robin-song", "https://evil.example/phish"), env);
check(r.headers.get("Location") === "/", "external next ignored", r.headers.get("Location"));
check(safeNext("//evil.example") === "/" && safeNext("/\\evil.example") === "/", "protocol-relative next ignored");
for (const sneaky of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ /evil.example".replace(" ", "\u0000"), "/x\\..\\/evil.example"]) {
  check(new URL(safeNext(sneaky), base).origin === base, "next stays on this site: " + JSON.stringify(sneaky), safeNext(sneaky));
}
check(safeNext("/species?name=Pacific%20Wren#top") === "/species?name=Pacific%20Wren#top", "ordinary next kept as is");
r = await worker.fetch(post("robin-song", "/\t/evil.example"), env);
check(r.headers.get("Location") === "/", "tab trick ignored on sign-in", r.headers.get("Location"));
r = await worker.fetch(new Request(base + "/__signin", {method: "POST", body: "not a form", headers: {"Content-Type": "application/json"}}), env);
check(r.status === 401, "malformed sign-in post -> sign-in page, not a crash");

r = await worker.fetch(new Request(base + '/x"><script>alert(1)</script>'), env);
body = await r.text();
check(!body.includes("<script>alert(1)"), "next is escaped in the page");

r = await worker.fetch(new Request(base + "/__signout", {headers: {Cookie: value}}), env);
check(r.status === 303 && /Max-Age=0/.test(r.headers.get("Set-Cookie")), "sign out clears cookie");

// Rate limit: a stand-in for Workers' limiter allowing 2 tries per address.
const tries = new Map();
const limited = {...env, SIGN_IN_LIMIT: {limit: async ({key}) => { tries.set(key, (tries.get(key) ?? 0) + 1); return {success: tries.get(key) <= 2}; }}};
const from = (ip, pw) => new Request(base + "/__signin", {method: "POST", body: new URLSearchParams({password: pw, next: "/"}), headers: {"CF-Connecting-IP": ip}});
await worker.fetch(from("1.2.3.4", "a"), limited);
await worker.fetch(from("1.2.3.4", "b"), limited);
r = await worker.fetch(from("1.2.3.4", "robin-song"), limited);
body = await r.text();
check(r.status === 429 && body.includes("Too many attempts") && !r.headers.get("Set-Cookie"), "third try in a minute refused, even with the right password");
r = await worker.fetch(from("5.6.7.8", "robin-song"), limited);
check(r.status === 303, "other addresses unaffected");

// Media from R2 (MEDIA binding): a stand-in bucket with one clip and live.json.
const files = {"clips/2026-10-25/Poecile_atricapillus_171918.ogg": "0123456789", "live/live.json": "{}"};
const MEDIA = {get: async (key, opts) => {
  if (!(key in files)) return null;
  const data = files[key];
  const m = /bytes=(\d+)-(\d*)/.exec(opts?.range?.get?.("Range") ?? "");
  const range = m ? {offset: +m[1], length: (m[2] ? +m[2] + 1 : data.length) - +m[1]} : undefined;
  return {size: data.length, range, httpEtag: '"e"', body: range ? data.slice(range.offset, range.offset + range.length) : data,
          writeHttpMetadata: (h) => h.set("Content-Type", key.endsWith(".json") ? "application/json" : "audio/ogg")};
}};
const menv = {...env, MEDIA};
r = await worker.fetch(new Request(base + "/api/clips/clips/2026-10-25/Poecile_atricapillus_171918.ogg"), menv);
check(r.status === 401, "media needs a session too");
r = await worker.fetch(new Request(base + "/api/clips/clips/2026-10-25/Poecile_atricapillus_171918.ogg", {headers: {Cookie: value}}), menv);
check(r.status === 200 && (await r.text()) === "0123456789" && r.headers.get("Content-Type") === "audio/ogg" && /private/.test(r.headers.get("Cache-Control")), "clip served from R2");
r = await worker.fetch(new Request(base + "/api/clips/clips/2026-10-25/Poecile_atricapillus_171918.ogg", {headers: {Cookie: value, Range: "bytes=2-5"}}), menv);
check(r.status === 206 && (await r.text()) === "2345" && r.headers.get("Content-Range") === "bytes 2-5/10", "range request -> 206");
r = await worker.fetch(new Request(base + "/api/live/live.json", {headers: {Cookie: value}}), menv);
check(r.status === 200 && r.headers.get("Cache-Control") === "no-store", "live.json not cached");
r = await worker.fetch(new Request(base + "/api/clips/data/detections.sqlite", {headers: {Cookie: value}}), menv);
check(r.status === 404, "only clips/ and live/ are served, not the database");
r = await worker.fetch(new Request(base + "/api/live/missing.webp", {headers: {Cookie: value}}), menv);
check(r.status === 404, "missing media -> 404");

r = await worker.fetch(new Request(base + "/"), {ASSETS});
check(r.status === 500, "missing secret fails closed");
console.log(fails ? `${fails} FAILED` : "all passed");
if (fails) process.exitCode = 1;
