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
3. Add a second **Secret**, **`SESSION_KEY`**: a long random string nobody
   needs to remember (e.g. the output of `openssl rand -hex 32`). It signs the
   session cookies, so a stolen cookie can't be used to guess the password.
   Changing it signs everyone out.
4. Open `https://birds.example.com` in a private window: you should get the
   sign-in page, and the password lets you in.

Sign-in attempts are limited to 5 a minute per IP address by the Worker
itself (the `[[ratelimits]]` block in `deploy/wrangler.toml`), so password
guessing can't run at scale. Nothing to set up for that.

Deploys replace the Worker's code and files but keep the secrets.
To change the password, edit the secret; that signs everyone out. To sign out
a single device, visit `/__signout`. The Worker's code is
`deploy/password-worker.js`; run its checks with
`node deploy/password-worker.test.mjs`.

## 5. Recorder data: the R2 bucket

The indoor computer publishes to an R2 bucket, `birdtracker-media`
(`pipeline/publish.py`): the near-live spectrogram strips (`live/`), the
detection clips (`clips/`) and a database snapshot every 3 hours. The Worker
serves `live/` and `clips/` to signed-in visitors; the build downloads the
snapshot. One step at a time:

1. **Create the bucket.** Cloudflare → **R2 Object Storage → Create bucket**,
   name **`birdtracker-media`**, location Automatic. (R2 needs a payment
   method on file even on the free tier: 10 GB stored and millions of reads a
   month are free; this uses well under 1 GB.)
2. **Check the deploy token can reach it.** The "Edit Cloudflare Workers"
   template from step 1 includes *Workers R2 Storage: Edit*; if yours was
   made differently, add that permission. The build uses it to download the
   snapshot and the deploy to bind the bucket.
3. **A token for the indoor computer.** R2 → **Manage API tokens → Create API
   token**: permission **Object Read & Write**, applied to **birdtracker-media**
   only. Copy the Access Key ID and Secret Access Key (shown once).
4. **Put them on the indoor computer** in `publish.env` at the repo root
   (gitignored):
   ```
   R2_ACCOUNT_ID=<account ID from step 1>
   R2_ACCESS_KEY_ID=<access key ID>
   R2_SECRET_ACCESS_KEY=<secret access key>
   ```
5. **Run it** beside the analyzer:
   ```
   set -a; . ./publish.env; set +a
   .venv/bin/python pipeline/publish.py --watch --db data/recorder.sqlite
   ```

The pages load the latest detections from the bucket when they open (within
about 10 minutes of being heard, or press the refresh button); the near-live
strips and clips appear within about a minute. No rebuild is needed for new
data.

## Status

Set up for `birds.annajxli.com` on 2026-10-23/24: the Worker serves the site,
GitHub Pages is off, DNS points at `100::`, Always Use HTTPS is on, and both
`PASSWORD` and `SESSION_KEY` are set.

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
- **Real data** comes from the R2 bucket (below); without a snapshot there,
  the build simulates a year of detections.
