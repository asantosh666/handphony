# Handphony — week-1 spike · build notes

Playable WebXR conducting prototype for the Meta VR Start Developer
Competition (Entertainment track, New Experience division — all code written
fresh for this spike; three.js r160 via CDN importmap is the only dependency).

## How to open it

Module scripts + CDN imports require http(s), not `file://`.

1. `cd ~/workspace/handphony/deploy && python3 -m http.server 8000`
2. On the Quest 3, open the browser to `http://<this-machine's-LAN-IP>:8000`
3. Tap **HANDPHONY** to enter VR (this gesture also unlocks audio).
4. Enable hand tracking on the Quest if prompted (Settings → Movement).

Inside: no menus, no buttons, no controllers. A "raise your hand" prompt
floats ahead of you and fades on your first note.

## Gesture → music map

| Hand | Gesture | Result |
|---|---|---|
| Right | Raise / lower palm height | Melody pitch: 11 zones across C4–C6, C-major pentatonic (C D E G A). A note fires when you cross into a new zone (3 cm hysteresis kills boundary flutter). Height range auto-calibrates (expand-only) to your reach. |
| Right | Pinch thumb+index (25 mm engage / 35 mm release, 90 ms debounce) | Captures your last phrase (notes from the previous 8 s) as a loop — replays as a soft arpeggio while a luminous ring orbits you at ~2 m. Pinch again to clear. |
| Left | Hand height, 3 zones (low / mid / high) | Pad chord: low = I (C major), mid = vi (A minor), high = IV (F) / V (G), alternating on each fresh lift into the high zone. Bass follows the root an octave down. |
| Left | Open palm | Swell: pad lowpass opens (380 Hz → 4 kHz) and pad/bass level rises. |
| Left | Fist | Dampens pad + bass to near silence. (Lead melody is unaffected.) |

Continuous mappings are smoothed over ~120 ms. Everything is consonant by
construction: pentatonic lead, triad pads, sine sub — you cannot play a wrong
note.

## What's in the scene

Near-black concert void with drifting dust, a glowing stage disc beneath
you, and four light pillars in an arc ahead (strings / winds / brass / low)
that pulse with their layer. Note onsets burst additive particles + an
expanding ripple ring at your hand, colored by pitch (deep blue → gold). A
faint pitch ladder floats beside your right hand; the active rung lights up.

## Known simplifications (week-1 spike)

- Reference space is `local` (origin ≈ headset at session start); the stage
  disc sits at an estimated floor height (−1.15 m) for a seated user.
- Left-hand high zone plays IV on the first lift and V on the next — the
  documented interpretation of "3 zones, 4 chords" (the lift pair).
- The loop preserves your original rhythm and replays it softly; max 24 notes.
- Reverb is a parallel wet path (0.33), not a fully-wet insert.
- No eye input anywhere (Quest 3 has none); no desktop mouse fallback — if
  WebXR or hand tracking is missing you get a text prompt instead.
- If no hands are seen 8 s after entering, the prompt suggests enabling
  hand tracking in Quest settings.
