// Checks for the sign-in Worker, run with: node deploy/password-worker.test.mjs
import worker, {sessionToken, safeNext} from "./password-worker.js";
// Stands in for the Worker's static assets; remembers the last request it served.
let served = null;
const ASSETS = {fetch: async (req) => { served = req; return new Response("<h1>dashboard " + new URL(req.url).pathname + "</h1>", {status: 200, headers: {"Content-Type": "text/html", "Cache-Control": "max-age=600"}}); }};
const env = {PASSWORD: "robin-song", ASSETS};
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
check(r.status === 200 && body.includes("dashboard /year") && r.headers.get("Cache-Control") === "private, max-age=300", "with cookie -> site, private caching");
check(served && !served.headers.has("Cookie"), "session cookie not passed on to the static files");

r = await worker.fetch(new Request(base + "/", {headers: {Cookie: "bt_session=deadbeef"}}), env);
check(r.status === 401, "forged cookie rejected");

r = await worker.fetch(new Request(base + "/", {headers: {Cookie: value}}), {PASSWORD: "new-password", ASSETS});
check(r.status === 401, "changing PASSWORD signs everyone out");

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

r = await worker.fetch(new Request(base + "/"), {ASSETS});
check(r.status === 500, "missing secret fails closed");
console.log(fails ? `${fails} FAILED` : "all passed");
if (fails) process.exitCode = 1;
