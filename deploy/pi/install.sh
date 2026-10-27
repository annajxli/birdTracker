#!/bin/sh
# Runs on the Pi (push.sh starts it): Python environment, then the three services.
# Safe to run again after every push; it only restarts the services.
set -eu
cd "$(dirname "$0")/../.."
HOME_DIR=$(pwd)
USER_NAME=$(id -un)

if [ ! -x .venv/bin/python ]; then
  sudo apt-get update -q
  sudo apt-get install -y -q python3-venv
  python3 -m venv .venv
fi
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r deploy/pi/requirements.txt
mkdir -p data

for unit in receiver.service analyzer.service publish.service updates.service updates.timer; do
  sed -e "s#%BIRD_HOME%#$HOME_DIR#g" -e "s#%BIRD_USER%#$USER_NAME#g" \
    "deploy/pi/birdtracker-$unit" | sudo tee "/etc/systemd/system/birdtracker-$unit" > /dev/null
done
sudo systemctl daemon-reload
for svc in receiver analyzer publish; do
  sudo systemctl enable "birdtracker-$svc" > /dev/null
  sudo systemctl restart "birdtracker-$svc"
done
# The weekly update check, and one now, so the Hardware analytics page has a result.
sudo systemctl enable --now birdtracker-updates.timer > /dev/null
sudo systemctl start --no-block birdtracker-updates.service
systemctl --no-pager --lines=0 status birdtracker-receiver birdtracker-analyzer birdtracker-publish | grep -E "●|Active:"
