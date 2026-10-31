#!/bin/sh
# Run on the laptop: copy the pipeline, BirdNET's model files and the settings to the Pi, then
# install or update it there (install.sh). The Pi needs no GitHub access.
#
#   deploy/pi/push.sh bird@birdtracker.local
#
# Settings: the Pi's birdtracker.env is written from publish.env (R2 keys) plus the receiver
# token from the firmware's secrets.h, the first time only; edit it on the Pi after that.
set -eu
HOST=${1:?usage: deploy/pi/push.sh user@host}
cd "$(dirname "$0")/../.."
DEST=birdtracker

MODELS=$(.venv/bin/python -c 'import sys; sys.path.insert(0, "pipeline"); import birdnet_lite; print(birdnet_lite.models_dir())')
ssh "$HOST" "mkdir -p $DEST/models $DEST/pipeline $DEST/deploy/pi $DEST/dashboard/src/data"
rsync -az --delete --exclude __pycache__ pipeline/ "$HOST:$DEST/pipeline/"
rsync -az deploy/pi/ "$HOST:$DEST/deploy/pi/"
rsync -az dashboard/src/data/detections.parquet.py dashboard/src/data/recordings.parquet.py "$HOST:$DEST/dashboard/src/data/"
rsync -az "$MODELS/BirdNET_GLOBAL_6K_V2.4_Model_FP32.tflite" "$MODELS/BirdNET_GLOBAL_6K_V2.4_MData_Model_V2_FP16.tflite" \
  "$MODELS/BirdNET_GLOBAL_6K_V2.4_Labels.txt" "$HOST:$DEST/models/"
# A built recorder image, for the recorder's over-the-air update (receiver.py serves ota/).
FIRMWARE=firmware/recorder_test/.pio/build/firebeetle/firmware.bin
if [ -f "$FIRMWARE" ]; then
  ssh "$HOST" "mkdir -p $DEST/ota"
  rsync -az "$FIRMWARE" "$HOST:$DEST/ota/firebeetle.bin"
  echo "recorder firmware: $(shasum -a 256 "$FIRMWARE" | cut -c1-12), built $(date -r "$FIRMWARE" '+%Y-%m-%d %H:%M')"
fi
# Which commit this is, for the Hardware analytics page (pipeline/code_version.py).
.venv/bin/python pipeline/code_version.py | ssh "$HOST" "cat > $DEST/deployed.json"

if ! ssh "$HOST" "test -f $DEST/birdtracker.env"; then
  TOKEN=$(sed -n 's/.*RECEIVER_TOKEN "\(.*\)"/\1/p' firmware/recorder_test/secrets.h)
  { grep '^R2_' publish.env; echo "RECEIVER_TOKEN=$TOKEN"; echo "BIRDNET_MODELS=models"; } \
    | ssh "$HOST" "umask 077; cat > $DEST/birdtracker.env"
fi
ssh -t "$HOST" "sh $DEST/deploy/pi/install.sh"  # -t: sudo can ask for the password
