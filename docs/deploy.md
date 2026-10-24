# Deploying the dashboard

The dashboard is a static site. GitHub Actions builds it and deploys it to a
Cloudflare Worker as that Worker's **static assets**: the Worker checks the
shared password and then serves the files itself. Nothing else hosts a copy,
so there is no way around the password. Below, `birds.example.com` stands for
the real subdomain and `example.com` for the domain.

```
browser ──> birds.example.com (Cloudflare) ──> password Worker ──> its own copy of the site
```

The workflow (`.github/workflows/pages.yml`) builds on every push to `main`,
every morning, and on demand. Until the recorder runs, it simulates the
detections on each build and fetches current weather. The Worker's settings
(name, route, assets) are in `deploy/wrangler.toml`.

> **Why not GitHub Pages?** An earlier version served the site from GitHub
> Pages with the Worker in front. Pages sites are public whatever the repo's
> visibility, and anyone who knows the subdomain can ask GitHub's servers for
> it directly, skipping Cloudflare and the password. If you set it up that way,
> follow "Moving off GitHub Pages" below.

## 1. Cloudflare: an API token for deploys

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**, template
   **Edit Cloudflare Workers**. Under *Account Resources* pick your account and
   under *Zone Resources* pick `example.com`. Create it and copy the token.
2. Copy your **Account ID** (Workers & Pages overview, right-hand side).

## 2. GitHub: give the workflow the token

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `CLOUDFLARE_API_TOKEN`: the token from step 1
- `CLOUDFLARE_ACCOUNT_ID`: the account ID

(Only the repo owner can add these.)

## 3. DNS for the subdomain

Cloudflare → `example.com` → **DNS → Records**: one record for the subdomain,
pointing nowhere in particular, because the Worker answers every request:

- Type **AAAA**, name **birds**, IPv6 address **`100::`**, **Proxied** (orange cloud)

`100::` is a reserved "discard" address; Cloudflare's proxy plus the Worker
route mean requests never go there. Check **SSL/TLS → Edge Certificates →
Always Use HTTPS** is on, so the password is never sent over plain HTTP.

## 4. Deploy, then set the password

1. Push to `main`, or **Actions → Deploy dashboard → Run workflow**. Wait for
   `build` and `deploy` to go green. The first deploy creates the Worker
   `birdtracker-password` with the route `birds.example.com/*` (both from
   `deploy/wrangler.toml`; change them there if your names differ).
2. Cloudflare → **Workers & Pages → birdtracker-password → Settings →
   Variables and Secrets → Add**: type **Secret**, name **`PASSWORD`**, value
   the shared password. Save. Until this exists the site answers with an error
   rather than opening up.
3. Open `https://birds.example.com` in a private window: you should get the
   sign-in page, and the password lets you in.

Deploys replace the Worker's code and files but keep the `PASSWORD` secret.
To change the password, edit the secret; that signs everyone out. To sign out
a single device, visit `/__signout`. The Worker's code is
`deploy/password-worker.js`; run its checks with
`node deploy/password-worker.test.mjs`.

## Moving off GitHub Pages

For a setup that followed the older version of these docs (Pages + a Worker
route in front):

1. Do steps 1–2 above, then push. The deploy reuses the existing Worker
   (same name) and its `PASSWORD` secret, and now serves the site itself.
   Check the site still works.
2. GitHub repo → **Settings → Pages**: remove the custom domain, then under
   **Build and deployment → Source** pick **GitHub Actions** and unpublish the
   site (**Unpublish site** at the top of the page, if shown).
3. Cloudflare DNS: change the `birds` record from the `CNAME` to
   `<owner>.github.io` to the `AAAA 100::` record in step 3. A CNAME left
   pointing at GitHub after Pages is off lets someone else claim the subdomain
   on GitHub.
4. Optional: under GitHub account **Settings → Pages → Verified domains**,
   verify `example.com` so no one else can ever use it with Pages.

## Notes

- **The repo stays private,** and the built site exists only inside Cloudflare.
- **If a build fails**, the Actions tab shows which step. A failed weather
  fetch doesn't stop the build; it falls back to `data/weather.csv`.
- **Real data:** when the recorder is running, the "Simulate detections" step
  gets replaced by pulling real detections. That isn't built yet.
