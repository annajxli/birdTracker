"""Find where the bird is in each species photo, so cropped thumbnails keep it in frame.

For each photo in data/species_images.json, runs an ImageNet classifier (Keras MobileNetV2)
and takes a Grad-CAM heat map of its top bird class: the bright region is what the network
looked at to say "bird". The heat map's weighted centre is stored as the photo's focal point,
as fractions of width and height, in data/photo_focus.json ({scientific name: {x, y}}). The
dashboard uses it as the crop's object-position. Photos already in the file are skipped.

Usage: python pipeline/photo_focus.py [--redo]
"""

import argparse
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "data" / "species_images.json"
OUT = ROOT / "data" / "photo_focus.json"
# ImageNet classes that are birds (cock .. ostrich, the finch-to-owl run, and the waterbirds).
BIRD_CLASSES = list(range(7, 25)) + list(range(80, 101)) + list(range(127, 147))
USER_AGENT = "birdTracker/1.0 (photo focal points; https://github.com/annajxli/birdTracker)"


def fetch(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return Image.open(io.BytesIO(r.read())).convert("RGB")


def focal_point(model, grad_model, img: Image.Image) -> dict:
    import tensorflow as tf
    from tensorflow.keras.applications.mobilenet_v2 import preprocess_input

    x = preprocess_input(np.asarray(img.resize((224, 224)), dtype=np.float32))[None]
    with tf.GradientTape() as tape:
        features, preds = grad_model(x)
        cls = BIRD_CLASSES[int(tf.argmax(tf.gather(preds[0], BIRD_CLASSES)))]
        score = preds[:, cls]
    grads = tape.gradient(score, features)[0]
    cam = tf.nn.relu(tf.reduce_sum(features[0] * tf.reduce_mean(grads, axis=(0, 1)), axis=-1)).numpy()
    if cam.max() <= 0:
        return {"x": 0.5, "y": 0.5}
    cam = cam / cam.max()
    cam = np.where(cam >= 0.4, cam, 0)  # the bird, not the faint background
    h, w = cam.shape
    ys, xs = np.mgrid[0:h, 0:w]
    return {"x": round(float((cam * (xs + 0.5)).sum() / cam.sum() / w), 3),
            "y": round(float((cam * (ys + 0.5)).sum() / cam.sum() / h), 3)}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--redo", action="store_true", help="recompute photos already in photo_focus.json")
    args = p.parse_args()

    import tensorflow as tf

    images = json.loads(IMAGES.read_text())
    done = {} if args.redo or not OUT.exists() else json.loads(OUT.read_text())
    todo = [s for s in images if s not in done]
    if not todo:
        print("all photos have focal points")
        return
    model = tf.keras.applications.MobileNetV2(weights="imagenet")
    grad_model = tf.keras.Model(model.inputs, [model.get_layer("Conv_1").output, model.output])
    for i, sci in enumerate(todo, 1):
        try:
            done[sci] = focal_point(model, grad_model, fetch(images[sci]["image"]))
        except Exception as e:  # one bad photo shouldn't stop the rest
            print(f"{sci}: {e}", file=sys.stderr)
            continue
        print(f"[{i}/{len(todo)}] {sci} -> {done[sci]}")
        OUT.write_text(json.dumps(done, indent=1, sort_keys=True) + "\n")
        time.sleep(0.2)  # be gentle with Wikimedia


if __name__ == "__main__":
    main()
