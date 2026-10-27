# Feeder camera

This page proposes a window bird feeder with a camera, so the website can show
photos of visitors and match them to BirdNET detections. Nothing on this page
is built, printed, or tested.

## Window feeder first

The first version is a printed feeder on the outside of a window, with the
camera indoors, looking out through the glass:

- The camera needs no weatherproofing, uses ordinary USB power, and sits close
  to Wi-Fi.
- A short black printed hood against the glass blocks reflections from the
  room.
- Squirrels have mostly left window feeders at this house alone.

A freestanding pole feeder can follow, with the camera distance that the
window version proves out.

## Camera

A Raspberry Pi Zero 2 W with a Raspberry Pi Camera Module 3, which has
autofocus and focuses close:

1. Motion in the feeder tray starts a short burst of photos.
2. The sharpest photo goes to the indoor computer.
3. A small bird-image model, such as Google's AIY Birds model, names the
   species. Photos in which the model finds a person aren't kept.

Point the camera at the feeder only, not at neighbors' windows or the street.

## Printed parts

The feeder comes apart for washing without tools:

- A removable seed tray with drainage holes, under a roof lip.
- A cage for a standard suet cake. Spicy suet deters squirrels and doesn't
  bother birds; hot-pepper seed in the tray works the same way.
- A suction-cup or sill mount that fixes the tray's distance from the glass,
  so the camera's focus and framing don't change.

Print the parts that touch food in PETG, and the parts in full sun in ASA. Mount
the feeder away from where a squirrel could jump from, such as branches,
railings, and roof edges, by about 2.5 to 3 m.

## On the website

- A Visitors gallery with each photo's species and time.
- Markers on the Live page where a photo was taken during a detection.
- Photo counts per species beside minutes heard, and lists of species seen
  but not heard, and heard but not seen.

## Microphone

Keep the recorder's microphone near the feeder but not on it. Pecking and
seed rattle are loud up close.
