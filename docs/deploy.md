# Deploy

This page explains how to deploy the website on Cloudflare, the R2 bucket, and
the pipeline on the indoor computer. For how the parts fit together, see
[Architecture](architecture.md). For what is deployed, see [Status](status.md).

On this page, `YOUR_DOMAIN` is the domain that you manage in Cloudflare, such
as `example.com`, and the dashboard runs at `birds.YOUR_DOMAIN`.

## Deploy the website

GitHub Actions builds the dashboard and deploys it as a Cloudflare Worker's
static assets. The Worker checks sign-in before it serves any file, and no
other host has a copy of the site. The Worker's name, route, and bindings are
in `deploy/wrangler.toml`.

### Before you begin

- A Cloudflare account that manages DNS for `YOUR_DOMAIN`.
- Owner access to the GitHub repository, to add secrets.
- In `deploy/wrangler.toml`, set the Worker name and the route
  `birds.YOUR_DOMAIN/*`, with `zone_name` set to `YOUR_DOMAIN`.

### Create a Cloudflare API token

1. In the Cloudflare dashboard, go to **My Profile > API Tokens**, and click
   **Create Token**.
2. Select the **Edit Cloudflare Workers** template.
3. Under **Account Resources**, select your account. Under **Zone
   Resources**, select `YOUR_DOMAIN`.
4. Create the token and copy it.
5. On the **Workers & Pages** overview page, copy your account ID.

The build needs the template's **Workers R2 Storage: Edit** permission to
download the database snapshot. If you create the token another way, add it.

### Add the token to GitHub

In the GitHub repository, go to **Settings > Secrets and variables >
Actions**, and add the following repository secrets:

- `CLOUDFLARE_API_TOKEN`: the API token.
- `CLOUDFLARE_ACCOUNT_ID`: the account ID.

### Add a DNS record for the subdomain

The Worker answers every request to the subdomain, so the record doesn't need
a real server.

1. In the Cloudflare dashboard, go to `YOUR_DOMAIN` > **DNS > Records**, and
   add an `AAAA` record named `birds`, with IPv6 address `100::` (a reserved
   discard address) and **Proxied** status.
2. Go to **SSL/TLS > Edge Certificates**, and turn on **Always Use HTTPS**, so
   browsers never send the password over plain HTTP.

### Create the R2 bucket

Create the bucket before the first deploy, because the Worker binds to it. In
the Cloudflare dashboard, go to **R2 Object Storage**, click **Create
bucket**, enter `birdtracker-media`, and select **Automatic** for the
location. R2 requires a payment method on file, even within the free tier.

### Deploy and set the secrets

1. In GitHub, go to **Actions > Deploy dashboard**, and click **Run
   workflow**. A push to `main` also deploys. The first deploy creates the
   Worker.
2. In the Cloudflare dashboard, go to **Workers & Pages > WORKER_NAME >
   Settings > Variables and Secrets**, where `WORKER_NAME` is the name in
   `deploy/wrangler.toml`, and add the following secrets:
   - `PASSWORD`: the shared password. Until it exists, the site returns an
     error.
   - `SESSION_KEY`: a long random string, such as the output of
     `openssl rand -hex 32`. It signs session cookies.
   - Optional: `CONTROL_PASSWORD`, a different password that lets the
     Hardware analytics page [pause the recorder](architecture.md#pause-the-recorder).
     Without it, pausing is off.
3. To check the setup, open `https://birds.YOUR_DOMAIN` in a private browser
   window and sign in.

Deploys keep the Worker's secrets. The `[[ratelimits]]` block in
`deploy/wrangler.toml` limits sign-in attempts per IP address.

### Manage access

- To change the password, edit `PASSWORD`. This signs out every device.
- To sign out every device without changing the password, change
  `SESSION_KEY`.
- To sign out one device, visit `/__signout` on it.

## Set up the indoor computer

The files in `deploy/pi/` install the receiver, analyzer, and publisher on a
Raspberry Pi 3B+ as systemd services that start at boot and restart after a
crash. The Pi doesn't need GitHub access: `deploy/pi/push.sh` copies
everything from a development computer over SSH.

### Before you begin

- A development computer with the repository set up. See
  [Development](development.md).
- A Raspberry Pi 3B+ with a 5 V 2.5 A power supply and a heatsink.
- The [R2 bucket](#create-the-r2-bucket).
- A bench recorder with `firmware/recorder_test/secrets.h` filled in. See
  [Recorder hardware](hardware.md#build-the-bench-recorder).

### Create an R2 token for the publisher

1. In the Cloudflare dashboard, go to **R2 Object Storage > Manage API
   tokens**, and click **Create API token**.
2. Select **Object Read & Write**, applied to the `birdtracker-media` bucket
   only.
3. Copy the access key ID and the secret access key, which Cloudflare shows
   only once.
4. On the development computer, create `publish.env` in the repository root.
   Git ignores it.

   ```
   R2_ACCOUNT_ID=ACCOUNT_ID
   R2_ACCESS_KEY_ID=ACCESS_KEY_ID
   R2_SECRET_ACCESS_KEY=SECRET_ACCESS_KEY
   ```

   Replace `ACCOUNT_ID` with your Cloudflare account ID, and the other two
   with the keys from the previous step. `push.sh` copies only the `R2_`
   lines to the Pi.

### Prepare the SD card

1. In Raspberry Pi Imager, select **Raspberry Pi 3** and **Raspberry Pi OS
   Lite (64-bit)**.
2. In the OS customization settings, set the hostname to `birdtracker`, a user
   name and password, your Wi-Fi network, your time zone, and SSH with
   public-key authentication only. If you have no key, create one with
   `ssh-keygen -t ed25519`.
3. Write the card and start the Pi. If Ethernet is available, connect it.
4. In your router, reserve the Pi's IP address. The recorder sends audio to
   this address.

### Install the services

1. Optional: To keep data from a computer that ran the pipeline before, copy
   its `data/recorder.sqlite`, `data/clips/`, and `data/live/` to
   `~/birdtracker/data/` on the Pi, and stop the services on the old computer.
2. From the development computer, run the following:

   ```bash
   BIRDNET_MODELS=MODELS_FOLDER deploy/pi/push.sh USER@birdtracker.local
   ```

   Replace the following:

   - `MODELS_FOLDER`: the folder with the BirdNET V2.4 model and label files.
     If you omit `BIRDNET_MODELS`, the script uses an installed
     `birdnet-analyzer` package, and stops if it finds neither.
   - `USER`: the user name on the Pi.

   The script copies the pipeline, the model files, and the service
   definitions, and runs `deploy/pi/install.sh` on the Pi. The first time, it
   writes `~/birdtracker/birdtracker.env` with the R2 keys, the receiver token
   from `secrets.h`, and `BIRDNET_MODELS`. Later runs don't change that file.

3. In `firmware/recorder_test/secrets.h`, set `RECEIVER_URL` to
   `http://PI_ADDRESS:8765`, where `PI_ADDRESS` is the Pi's reserved IP
   address, and flash the recorder again.
4. Optional: To rebuild the site after each database snapshot, add
   `GITHUB_TOKEN=GITHUB_TOKEN_VALUE` to `~/birdtracker/birdtracker.env`, where
   `GITHUB_TOKEN_VALUE` is a token that can run this repository's workflows.
   Then run `sudo systemctl restart birdtracker-publish`.

### Update the services

To update the Pi, run `deploy/pi/push.sh` again with the same
`BIRDNET_MODELS`. The Hardware analytics page shows whether the Pi runs the
latest code on `main`.

**Caution:** `push.sh` restarts all three services, so recording stops briefly.
Make sure every change in your checkout is meant for the Pi.

If `firmware/recorder_test/.pio/build/firebeetle/firmware.bin` exists,
`push.sh` also copies it to `~/birdtracker/ota/firebeetle.bin`, and the
recorder installs it at its next update check. To avoid installing an old
image, build the firmware in the same checkout first, or delete the `.pio`
folder. See [Update the FireBeetle over Wi-Fi](hardware.md#update-the-firebeetle-over-wi-fi).

To change how often the publisher checks for reviews or updates the Live
page's day files, add `--reviews-seconds` or `--history-seconds` to the
`ExecStart` line of `deploy/pi/birdtracker-publish.service`, commit it, and
run `push.sh`.

### Restore after losing the data folder

The publisher refuses to replace the bucket's data with an empty database, so
the bucket survives a lost SD card. To restore on a new card:

1. Follow [Install the services](#install-the-services).
2. On the Pi, stop the services that use the data folder:

   ```
   sudo systemctl stop birdtracker-analyzer birdtracker-publish
   ```

3. From `~/birdtracker`, fetch the clips, Live files, and database snapshot.
   The command keeps a local database that already has detections.

   ```
   set -a; . ./birdtracker.env; set +a
   .venv/bin/python pipeline/publish.py --restore --db data/recorder.sqlite
   ```

4. Start the services:

   ```
   sudo systemctl start birdtracker-analyzer birdtracker-publish
   ```

The snapshot is as old as the last `--snapshot-hours` upload. For an earlier
copy, put one from `data/snapshots/` in the bucket at `data/recorder.sqlite`
while the services are stopped.

If the publisher logs `the data folder looks lost` or `the database looks lost`
after a shrink that you intended, restart it once with `--allow-shrink`.

### Update the operating system

The Pi installs Debian security updates weekly, at the time in
`deploy/pi/birdtracker-upgrade.timer`. Other updates, such as kernel and
firmware packages, wait for an install by hand. On the Pi:

- To install security updates now, run `sudo systemctl start birdtracker-upgrade`.
- To install all updates, run `sudo apt-get update` and then
  `sudo apt-get full-upgrade`. If the Hardware analytics page then shows that
  a reboot is required, run `sudo reboot`.
- To refresh the page's update report, run
  `sudo systemctl start birdtracker-updates`.

### Check the services

To follow a service's log on the Pi, run the following command:

```bash
journalctl -u birdtracker-analyzer -f
```

The other units are `birdtracker-receiver`, `birdtracker-publish`,
`birdtracker-updates`, and `birdtracker-upgrade`.

To see the publisher's R2 calls and upload bytes per UTC day, read
`~/birdtracker/data/publish-usage.json`. Before you estimate a month's cost,
compare a few complete days with the R2 metrics in the Cloudflare dashboard.

## Troubleshoot

- **A build fails.** On the **Actions** tab, open the run to see which step
  failed. A failed weather fetch doesn't stop the build.
- **The build simulates data.** The log shows `No snapshot in R2 yet` when
  it finds no snapshot. Check that the publisher is running and that the API
  token has **Workers R2 Storage: Edit**.
- **Pages show old or simulated data.** Pages fall back to the built-in data
  only when `/api/data/` fails. Check those requests in the browser's
  developer tools.
