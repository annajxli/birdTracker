# Deploying the dashboard

The dashboard is a static site built by GitHub Actions and served by GitHub
Pages on a subdomain of a Cloudflare-managed domain. A small Cloudflare Worker
in front of it shows a sign-in page asking for one shared password, and
remembers each device for 30 days. Below, `birds.example.com` stands
for the real subdomain and `example.com` for the domain.

```
browser ──> birds.example.com (Cloudflare) ──> password Worker ──> GitHub Pages
```

The workflow (`.github/workflows/pages.yml`) builds on every push to `main`,
every morning, and on demand. Until the recorder runs, it simulates the
detections on each build and fetches current weather.

## 1. Turn on GitHub Pages

1. In the repo on GitHub: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.

## 2. Run the first deploy

1. Push to `main`, or go to **Actions → Deploy dashboard → Run workflow**.
2. Wait for both jobs (`build`, `deploy`) to go green, about 3 minutes.
3. The site is now at `https://<owner>.github.io/birdTracker/`, with no
   password yet. Steps 3–5 put it on the subdomain behind the password.

## 3. Point the subdomain at GitHub

1. In Cloudflare, open the domain → **DNS → Records → Add record**:
   - Type **CNAME**, name **birds**, target **`<owner>.github.io`**
   - Proxy status **DNS only** (grey cloud) for now, so GitHub can issue
     its HTTPS certificate.
2. Back in GitHub, **Settings → Pages → Custom domain**: enter
   `birds.example.com` and **Save**.
3. Wait until the DNS check passes and **Enforce HTTPS** can be ticked
   (anywhere from a few minutes to an hour), then tick it.

From now on GitHub redirects the `github.io` address to the subdomain, so
everything goes through the password in step 5.

## 4. Turn on Cloudflare's proxy

1. In Cloudflare **DNS**, edit the `birds` record and switch it to
   **Proxied** (orange cloud).
2. In **SSL/TLS → Overview**, make sure the mode is **Full (strict)**.

## 5. Add the password

1. **Workers & Pages → Create → Create Worker**. Name it
   `birdtracker-password`, deploy the starter, then **Edit code**: replace
   everything with `deploy/password-worker.js` from this repo, then **Deploy**.
2. The Worker's **Settings → Variables and Secrets → Add**: type **Secret**,
   name **`PASSWORD`**, value the shared password. Save.
3. The Worker's **Settings → Domains & Routes → Add → Route**:
   route **`birds.example.com/*`**, zone **example.com**. Save.
4. Open `https://birds.example.com` in a private window. You should see the
   Bird Tracker sign-in page; the password from step 2 lets you in.

To change the password later, edit the `PASSWORD` secret; that signs everyone
out. To sign out a single device, visit `/__signout`.

To update the Worker's code later (e.g. after changes to
`deploy/password-worker.js`), open the Worker → **Edit code**, replace
everything, and **Deploy**. The secret and route stay as they are.

## Notes

- **The repo stays private.** Only the built site is published, and it's
  behind the password once step 5 is done.
- **If a build fails**, the Actions tab shows which step. A failed weather
  fetch doesn't stop the build; it falls back to `data/weather.csv`.
- **Real data:** when the recorder is running, the "Simulate detections" step
  gets replaced by pulling real detections. That isn't built yet.
