# Handphony — build notes

Playable WebXR conducting prototype for the Meta VR Start Developer
Competition (Entertainment track, New Experience division — all code written
fresh for this build; three.js r160 via CDN importmap is the only dependency).

## Core mechanic — redesigned after playtest 2 (2026-10-07)

**Why:** the in-headset verdict was "doesn't feel magical at all… I feel
like I am just waving hand a lot, might be tiring." Diagnosis from the test
video: (1) discrete zone-crossing note triggers turned music into tiring
whole-arm button presses — every note cost a deliberate arm motion;
(2) the pitch ladder rendered as a giant wall dominating the view;
(3) the 25-joint point clouds read as bead swarms, not hands.

**The redesign (theremin principle):** the right hand IS the pitch. A 0.40m
vertical window auto-centers once per session on the relaxed hand's height;
hand height maps CONTINUOUSLY to the 11-note C-major pentatonic set
(C4–C6), quantized with a ~70ms portamento glide between notes. The melody
is now a SUSTAINED voice (two detuned oscillators — triangle + sine —
through a gentle lowpass with a subtle slow tremolo): it fades in when play
begins, sustains while the hand is tracked, and glides as the hand moves.
Note EVENTS fire only when the quantized note index changes — these drive
particles, the ladder flash, the note-name display, and the 8s loop capture
(pitch + timing, as before). The 80ms zone dwell and 3cm hysteresis are gone
(obsolete under continuous control); ~60ms of height smoothing keeps
micro-tremor from fluttering the quantization boundary.

**Design goal:** playable seated with the elbow resting — wrist/forearm
motion only. The window clamps at the edges (pitch holds at the edge note);
deliberately pushing past an edge expands it by 0.05m/frame, capped at
+0.10m per edge so the window can't bloat back into fatigue. Watch in the
next playtest: after a big excursion the mapping drifts slightly
(expand-only never shrinks) — acceptable if players stay in the window,
which the auto-centering is designed to ensure.

## How to open it

Module scripts + CDN imports require http(s), not `file://`.

1. `cd ~/workspace/handphony/deploy && python3 -m http.server 8000`
2. On the Quest 3, open the browser to `http://<this-machine's-LAN-IP>:8000`
3. Tap **HANDPHONY** to enter VR (this gesture also unlocks audio).
4. Enable hand tracking on the Quest if prompted (Settings → Movement).

Inside: no menus, no buttons, no controllers. A guided tutorial starts on
the first tracked hand — follow the floating instructions, then conduct.
Your relaxed hand height becomes the middle of the instrument, so settle
somewhere comfortable (elbow resting works) before you begin.

## Gesture → music map

| Hand | Gesture | Result |
|---|---|---|
| Right | Raise / lower hand (small motions!) | Melody pitch, continuous: the hand IS the pitch. A 0.40m window auto-centers on your relaxed hand once per session; height glides through 11 quantized pentatonic notes (C4–C6: C D E G A) with ~70ms portamento. The voice sustains while tracked — tiny wrist movements sing. |
| Right | Pinch thumb+index (25 mm engage / 35 mm release, 90 ms debounce) | Captures your last phrase (quantized note events from the previous 8 s) as a loop — replays as a soft arpeggio while a luminous ring orbits you at ~2 m; a "looping" label floats by the ring for 3 s. Pinch again to clear ("loop cleared"). Pinch-and-HOLD 1.5 s during onboarding skips straight to free play. |
| Left | Hand height, 3 zones (low / mid / high) | Pad chord: low = I (C major), mid = vi (A minor), high = IV (F) / V (G), alternating on each fresh lift into the high zone. Bass follows the root an octave down. (3 cm hysteresis + 80 ms dwell retained here — chords shouldn't flutter.) |
| Left | Open palm | Swell: pad lowpass opens (380 Hz → 4 kHz) and pad/bass level rises. |
| Left | Fist | Dampens pad + bass to near silence. (Lead melody is unaffected.) |

Continuous mappings are smoothed (~60 ms pitch, ~120 ms swell). Everything
is consonant by construction: pentatonic lead, triad pads, sine sub — you
cannot play a wrong note.

## Guided onboarding (rewritten for the theremin mechanic)

The first frame with a tracked hand starts a sequential tutorial — one large
floating instruction at a time (the prompt sprite at 1.6×). It never runs at
an empty room. The first two steps teach the continuous-pitch feel:

1. "Move your hand slowly up and down" → quantized note changes 2+ times → "You are the pitch"
2. "Tiny movements — your hand is the pitch" → 4 s free explore, auto-advances
3. "Open your left palm" → swell openness > 0.75 → "Your palm swells the strings"
4. "Make a fist" → openness < 0.25 → "A fist hushes them"
5. "Pinch thumb and finger" → loop captured → "You captured a loop" (pinching with <2 recent notes shows "Play a few notes first, then pinch" and stays on this step; if a loop was already captured earlier, the step auto-completes)
6. "Conduct." for 3 s → fades → free play

Step-1 and confirmations show ~2 s. **Skip:** pinch-and-HOLD for 1.5 s at any
point during onboarding jumps straight to free play (deliberately
undocumented in the UI — it's an escape hatch, not a feature).

## What's in the scene

Near-black concert void with drifting dust, a glowing stage disc beneath
you, and four light pillars in an arc ahead (strings / winds / brass / low)
that pulse with their layer. Quantized note changes burst soft round
particles (shared radial-gradient sprite texture — no more squares) + an
expanding ripple ring at your hand, colored by pitch (deep blue → gold).
The pitch ladder is a small reference panel now, not a wall: fixed at
(0.35, 0.02, −1.25), scaled 0.55 — beam, 11 rungs, a note-name sprite
(e.g. "E5") above the active rung, and a bright cursor ring riding the
ladder at your right hand's height that flashes when the quantized note
changes. The ladder tracks the auto-centered pitch window.

## Hands are rendered by the app

WebXR does NOT draw hands for you — the Quest browser only reports joint
poses. The week-1 spike rendered nothing, so the playtester waved blindly;
playtest 2 showed the 25-joint point clouds alone read as bead swarms. Now
each tracked hand draws its joints as glowing points PLUS bone skeletons
(LineSegments over the standard hand topology: wrist → five finger chains +
palm fan) so it reads INSTANTLY as a hand — plus a soft palm orb for
presence. **Gold right (melody), teal left (harmony)**, which also teaches
the mapping. A bright pulse flashes at the pinch point whenever a pinch
registers. Hidden whenever a hand isn't tracked. Points + lines are cheap —
the 72 fps budget is untouched. (Joints are stored at fixed indices with a
validity mask so bone pairs with a missing joint are skipped, never
misconnected.)

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
