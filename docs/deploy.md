# Deploy

This page explains how to deploy Bird Tracker: the website on Cloudflare, the
R2 bucket that holds recorder data, and the pipeline on the indoor computer.
For how these parts fit together, see [Architecture](architecture.md). For
what is deployed, see [Status](status.md).

On this page, `birds.example.com` stands for the dashboard's subdomain and
`example.com` for its domain. The repository's settings use
`birds.annajxli.com`.

## Deploy the website

GitHub Actions builds the dashboard and deploys it to a Cloudflare Worker as
the Worker's static assets. The Worker checks the shared password before it
serves any file, and no other host has a copy of the site, so visitors can't
bypass the password. The Worker's name, route, and bindings are in
`deploy/wrangler.toml`.

### Before you begin

Make sure that you have the following:

- A Cloudflare account that manages DNS for `example.com`
- Owner access to the GitHub repository, to add secrets
- In `deploy/wrangler.toml`, the Worker name and route that you want. The
  repository's values are `birdtracker-password` and `birds.annajxli.com/*`.

### Create a Cloudflare API token

1. In the Cloudflare dashboard, go to **My Profile > API Tokens**, and then
   click **Create Token**.
2. Select the **Edit Cloudflare Workers** template.
3. Under **Account Resources**, select your account. Under **Zone
   Resources**, select `example.com`.
4. Create the token and copy it.
5. On the **Workers & Pages** overview page, copy your account ID.

The template includes the **Workers R2 Storage: Edit** permission, which the
build uses to download the database snapshot. If you create the token another
way, add that permission.

### Add the token to GitHub

1. In the GitHub repository, go to **Settings > Secrets and variables >
   Actions**, and then click **New repository secret**.
2. Add the following secrets:
   - `CLOUDFLARE_API_TOKEN`: the API token.
   - `CLOUDFLARE_ACCOUNT_ID`: the account ID.

### Add a DNS record for the subdomain

The Worker answers every request to the subdomain, so the DNS record doesn't
need to point to a real server.

1. In the Cloudflare dashboard, go to `example.com` > **DNS > Records**.
2. Add a record with the following values:
   - **Type**: `AAAA`
   - **Name**: `birds`
   - **IPv6 address**: `100::`
   - **Proxy status**: **Proxied**

   `100::` is a reserved discard address. Because Cloudflare proxies the
   record and the Worker handles the route, requests never reach it.

3. Go to **SSL/TLS > Edge Certificates**, and turn on **Always Use HTTPS**.
   This setting stops browsers from sending the password over plain HTTP.

### Create the R2 bucket

Create the bucket before the first deploy, because the Worker binds to it.

1. In the Cloudflare dashboard, go to **R2 Object Storage**, and then click
   **Create bucket**.
2. For the name, enter `birdtracker-media`. For the location, select
   **Automatic**.

R2 requires a payment method on file, even for usage within the free tier.

### Deploy and set the secrets

1. In GitHub, go to **Actions > Deploy dashboard**, and then click **Run
   workflow**. Wait for the `build` and `deploy` jobs to finish. A push to
   `main` also starts a deploy.

   The first deploy creates the Worker with the name and route from
   `deploy/wrangler.toml`.

2. In the Cloudflare dashboard, go to **Workers & Pages >
   `birdtracker-password` > Settings > Variables and Secrets**.
3. Add a secret named `PASSWORD`, set to the shared password. Until this
   secret exists, the site returns an error instead of opening.
4. Add a secret named `SESSION_KEY`, set to a long random string, such as the
   output of `openssl rand -hex 32`. This key signs session cookies, so
   someone who steals a cookie can't use it to guess the password. A session
   lasts 30 days.
5. To check the setup, open `https://birds.example.com` in a private browser
   window. The sign-in page appears, and the password opens the site.

Deploys replace the Worker's code and files but keep its secrets. The Worker
limits sign-in attempts per IP address, as set by the `[[ratelimits]]` block in
`deploy/wrangler.toml`.

### Manage access

To manage who is signed in, do one of the following:

- To change the password, edit the `PASSWORD` secret. This signs out every
  device.
- To sign out every device without changing the password, change
  `SESSION_KEY`.
- To sign out one device, visit `/__signout` on that device.

## Set up the indoor computer

The indoor computer runs the receiver, analyzer, and publisher. The files in
`deploy/pi/` install them on a Raspberry Pi 3B+ (four Cortex-A53 cores, 1 GB
RAM) as systemd services that start at boot and restart after a crash. The
Pi doesn't need GitHub access: `deploy/pi/push.sh` copies everything it needs
from a development computer over SSH.

### Before you begin

Make sure that you have the following:

- A development computer with the repository set up. For more information,
  see [Development](development.md).
- A Raspberry Pi 3B+ with a 5 V 2.5 A power supply and a heatsink.
- The R2 bucket from [Create the R2 bucket](#create-the-r2-bucket).
- A bench recorder with `firmware/recorder_test/secrets.h` filled in. For more
  information, see [Recorder hardware](hardware.md#build-the-bench-recorder).

### Create an R2 token for the publisher

1. In the Cloudflare dashboard, go to **R2 Object Storage > Manage API
   tokens**, and then click **Create API token**.
2. For the permission, select **Object Read & Write**, and apply it to the
   `birdtracker-media` bucket only.
3. Copy the access key ID and the secret access key. Cloudflare shows the
   secret only once.
4. On the development computer, create `publish.env` in the repository root
   with the following contents. Git ignores this file.

   ```
   R2_ACCOUNT_ID=ACCOUNT_ID
   R2_ACCESS_KEY_ID=ACCESS_KEY_ID
   R2_SECRET_ACCESS_KEY=SECRET_ACCESS_KEY
   ```

   Replace the following:

   - `ACCOUNT_ID`: your Cloudflare account ID.
   - `ACCESS_KEY_ID`: the access key ID.
   - `SECRET_ACCESS_KEY`: the secret access key.

   `push.sh` copies only the `R2_` lines of `publish.env` to the Pi.

### Prepare the SD card

1. In Raspberry Pi Imager, select **Raspberry Pi 3** and **Raspberry Pi OS
   Lite (64-bit)**.
2. In the OS customization settings, set the following values:
   - **Hostname**: `birdtracker`
   - **Username and password**: your choice
   - **Wireless LAN**: your Wi-Fi network
   - **Time zone**: `America/Los_Angeles`
   - **SSH**: public-key authentication only. Imager fills in your public
     key. If you don't have one, create it with `ssh-keygen -t ed25519`.
3. Write the card, insert it in the Pi, and start the Pi. If Ethernet is
   available, connect it.
4. In your router, reserve the Pi's IP address. The recorder sends audio to
   this address.

### Install the services

1. Optional: To keep data from a computer that ran the pipeline before, copy
   its `data/recorder.sqlite`, `data/clips/`, and `data/live/` to
   `~/birdtracker/data/` on the Pi. Then stop the receiver, analyzer, and
   publisher on that computer.
2. From the development computer, install the pipeline on the Pi:

   ```bash
   deploy/pi/push.sh USER@birdtracker.local
   ```

   Replace `USER` with the user name on the Pi.

   The script copies the pipeline, the BirdNET model files, and the service
   definitions, and then runs `deploy/pi/install.sh` on the Pi. The first time,
   it also writes `~/birdtracker/birdtracker.env` on the Pi with the R2 keys
   from `publish.env`, the receiver token from `secrets.h`, and
   `BIRDNET_MODELS`. Later runs don't change that file; to change a setting,
   edit it on the Pi.

3. In `firmware/recorder_test/secrets.h`, set `RECEIVER_URL` to
   `http://PI_ADDRESS:8765`, where `PI_ADDRESS` is the Pi's reserved IP
   address. Then flash the recorder again.
4. Optional: To rebuild the site after each database snapshot, and not only on
   the schedule in `.github/workflows/pages.yml`, add a line to
   `~/birdtracker/birdtracker.env` on the Pi:

   ```
   GITHUB_TOKEN=GITHUB_TOKEN_VALUE
   ```

   Replace `GITHUB_TOKEN_VALUE` with a GitHub token that can run this
   repository's workflows. Then restart the publisher with
   `sudo systemctl restart birdtracker-publish`.

### Update the services

To update the Pi after a pipeline change, run `deploy/pi/push.sh` again.

**Caution:** `push.sh` restarts all three services, so recording stops for a
short time. Before you run it, make sure that every change in your checkout is
meant for the Pi.

### Check the services

To follow a service's log, on the Pi, run the following command:

```bash
journalctl -u birdtracker-analyzer -f
```

The other services are `birdtracker-receiver` and `birdtracker-publish`.

The pages load the newest data from R2 when they open, so new detections
appear without a rebuild. How often the publisher uploads each kind of data
depends on its flags; for details, run `pipeline/publish.py --help`.

### Check the publisher's R2 usage

To see how many R2 API calls and upload bytes the publisher used each UTC day,
on the Pi, run the following command:

```bash
cat ~/birdtracker/data/publish-usage.json
```

These counts are for planning, not billing. Before you estimate a month's
cost, compare a few complete days with the R2 metrics in the Cloudflare
dashboard. A partial day, such as the day of a deployment, undercounts.

### Change how often the publisher checks

To change how often the publisher checks for reviews or updates the Live page's
day files, add `--reviews-seconds` or `--history-seconds` to the `ExecStart`
line of `deploy/pi/birdtracker-publish.service`, and run `deploy/pi/push.sh`.
Keep the change in the repository, so that a later `push.sh` doesn't replace it,
and record it in the [deployment log](status.md#deployment-log).

## Migrate from a GitHub Pages setup

An earlier version of this setup served the site from GitHub Pages with the
password Worker in front. GitHub Pages sites are public, so visitors could
bypass the Worker. To move such a setup to the Worker's static assets, do the
following:

1. Complete [Create a Cloudflare API token](#create-a-cloudflare-api-token)
   and [Add the token to GitHub](#add-the-token-to-github), and then push to
   `main`. The deploy reuses the existing Worker and its `PASSWORD` secret.
   Check that the site works.
2. In the GitHub repository, go to **Settings > Pages**. Remove the custom
   domain, and set **Build and deployment > Source** to **GitHub Actions**. If
   **Unpublish site** appears, click it.
3. In Cloudflare DNS, replace the `CNAME` record for `birds` that points to
   GitHub with the `AAAA` record from
   [Add a DNS record for the subdomain](#add-a-dns-record-for-the-subdomain).
   A `CNAME` record left pointing to GitHub after Pages is off lets someone
   else claim the subdomain on GitHub.
4. Optional: In your GitHub account, go to **Settings > Pages > Verified
   domains**, and verify `example.com` so that no one else can use it with
   GitHub Pages.

## Troubleshoot

The following list describes common problems:

- **A build fails.** To see which step failed, on the **Actions** tab, open
  the run. A failed weather fetch doesn't stop the build. Instead, the build
  uses the checked-in `data/weather.csv`.
- **The build simulates data.** The build log shows `No snapshot in R2 yet`
  when it finds no database snapshot. Check that the publisher is running and
  that the API token has the **Workers R2 Storage: Edit** permission.
- **Pages show old or simulated data.** Pages load the newest data from
  `/api/data/` and fall back to the copy built into the site only when that
  request fails. In the browser's developer tools, check the requests to
  `/api/data/`.
