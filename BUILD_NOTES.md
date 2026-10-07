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
the first tracked hand — follow the floating instructions, and Twinkle
Twinkle auto-starts: follow the golden light and play it with your bare
hands. Your relaxed hand height becomes the middle of the instrument,
so settle somewhere comfortable (elbow resting works) before you begin.

## Gesture → music map

| Hand | Gesture | Result |
|---|---|---|
| Right | Raise / lower hand (small motions!) | Melody pitch, continuous: the hand IS the pitch. A 0.40m window auto-centers on your relaxed hand once per session; height glides through 11 quantized pentatonic notes (C4–C6: C D E G A) with ~70ms portamento. The voice sustains while tracked — tiny wrist movements sing. |
| Right | Pinch thumb+index (25 mm engage / 35 mm release, 90 ms debounce) | Quick pinch captures your last phrase (quantized note events from the previous 8 s) as a loop — replays as a soft arpeggio while a luminous ring orbits you at ~2 m; a "looping" label floats by the ring for 3 s. Pinch again to clear ("loop cleared"). In song mode the toggle fires on RELEASE so a hold can mean "quit to songbook" instead. Pinch-and-HOLD 1.5 s: onboarding → Twinkle auto-start · song select (no orb aimed) → free play · song/free play → songbook · song complete → next song. Songbook tap = pinch ENGAGE on an aimed orb (instant, consumes the gesture). |
| Left | Hand height, 3 zones (low / mid / high) | Pad chord: low = I (C major), mid = vi (A minor), high = IV (F) / V (G), alternating on each fresh lift into the high zone. Bass follows the root an octave down. (3 cm hysteresis + 80 ms dwell retained here — chords shouldn't flutter.) |
| Left | Open palm | Swell: pad lowpass opens (380 Hz → 4 kHz) and pad/bass level rises. |
| Left | Fist | Dampens pad + bass to near silence. (Lead melody is unaffected.) |

Continuous mappings are smoothed (~60 ms pitch, ~120 ms swell). Everything
is consonant by construction: pentatonic lead, triad pads, sine sub — you
cannot play a wrong note.

## Guided onboarding → Twinkle auto-start (redesigned after playtest 5)

The first frame with a tracked hand starts a sequential tutorial — one large
floating instruction at a time (the prompt sprite at 1.6×). It never runs at
an empty room. The first two steps teach the continuous-pitch feel. **The
tutorial teaches gestures, never the why — so it now ENDS with Twinkle
Twinkle auto-starting, not at a songbook.** The orb-selection step was
removed from the critical path entirely (playtest 5: "pinch the golden orb
but there's no golden orb" — aim + pinch-release was three failure points
before the purpose began). The loop is deliberately not taught here; free
play teaches it in context with a one-time intro instead.

1. "Move your hand slowly up and down" → quantized note changes 2+ times → "You are the pitch"
2. "Tiny movements:\nyour hand is the pitch" → 4 s free explore, auto-advances
3. "Open your left palm" → swell openness > 0.75 → "Your palm swells\nthe strings"
4. "Make a fist" → openness < 0.25 → "A fist hushes them"
5. → **Twinkle Twinkle auto-starts immediately**: "Follow the golden light"
   (3 s, then fades), HUD "Twinkle Twinkle — 1/12", target rung pulsing
   gold. Zero decisions, zero aiming — the first thing a new user does is
   play a song.

**Skip:** pinch-and-HOLD for 1.5 s at any point during onboarding also
auto-starts Twinkle Twinkle — skipping the tutorial still lands on the
purpose, never on empty free play.

**Prompt text system:** `visuals.setPromptText` supports "\n" two-line
rendering (lines centered at y=44/88, slightly smaller base font) and
auto-shrinks the font until the longest line fits ~470 px, so long guide
text never clips. All prompts/confirms were audited for fit after this
change; the long ones are split across two lines (see steps above,
"Pinch: replay\nHold pinch: next song", and the free-play intro).

## First five minutes (playtest 4 → playtest 5)

Playtest 4's verdict: "does it look like it got any purpose else than making
sound when you move your hand?" The honest answer was no — the song-mode
purpose layer existed but never surfaced. The playtest-4 fix routed
onboarding into the songbook ("Pinch the golden orb"). Playtest 5's verdict:
"it says pinch the golden orb but there's no golden orb" — the gold orb
didn't read as golden among five pastel orbs, and aim + pinch-release was
three failure points before the purpose. So the selection step was removed
from the critical path entirely:

- Onboarding (and its skip) now auto-start Twinkle Twinkle directly —
  "Follow the golden light", no decisions, no aiming.
- The songbook appears only AFTER song 1: via next-song past the last song,
  pinch-hold mid-song, pinch-hold in free play, or session re-entry.
  First-time songbook visitors get a one-time "Pinch an orb\nto choose"
  prompt ("Choose a song" thereafter); the Twinkle orb keeps its gold pulse
  whenever the songbook shows.
- Songbook pinch simplified: selection fires on pinch ENGAGE (instant
  feedback); the engage consumes the gesture so a continued hold can't
  double-fire. Pinch-hold with NO orb aimed = free play (the "Free play"
  orb still exists for direct selection).
- Orbs made unmistakable anyway: base size 0.16 → 0.22, aim threshold
  0.6 m → 0.8 m, aimed highlight ×1.45 → ×1.6 plus a white-hot core lerp.
- The loop keeps its one-time, in-context intro on entering free play:
  "Pinch to capture a loop\nHold pinch: songbook" (5 s, once per session) —
  the described behavior is unchanged, so the hint text is unchanged.
- In song mode, the loop toggle is deferred to pinch RELEASE: a quick pinch
  captures/clears, a hold quits — acting at engage would do both.

**Pinch-hold (1.5 s) map:** onboarding → Twinkle auto-start · song select
(no orb aimed) → free play · song play → songbook (quit) · free play →
songbook · song complete → next song. Tap: select mode = pinch ENGAGE ·
complete = pinch release (replay) · song = pinch release (loop
capture/clear) · free = pinch engage (loop capture/clear).

## Song mode — the purpose layer (playtest 3: "what's the real purpose?")

Playtest 3's verdict: the mechanics all worked, but the app was a toy with
no goal. The purpose is now **play real songs with your bare hands** — a
follow-the-light songbook. After onboarding, the user lands on song select,
not empty free play.

**The songs** (zones 0–10 = C4 D4 E4 G4 A4 C5 D5 E5 G5 A5 C6; `hold` notes
need a 350 ms dwell vs 120 ms normal, giving phrase endings weight;
`chord` auto-changes the pad via `audio.setAutoChord`, reusing the exact
free-play voicings):

1. **Twinkle Twinkle** — pentatonic adaptation: the original's F ("up above
   the world so high") isn't in the C pentatonic set, so the second phrase
   lands on E5 instead. Still instantly recognizable; never a wrong note.
   Chords: I, then IV.
2. **Mary Had a Little Lamb** — straight transcription (E D C D E E E…).
   Chords: I, I, V, I.
3. **Merrily We Roll Along** — straight transcription. Chords: I, V, I.
4. **Auld Lang Syne** — VERIFY-CAREFULLY: G4 C5 C5 C5 E5 D5 | C5 D5 E5 C5 C5
   D5 | C5 A4 G4 A4 C5(hold), i.e. "Should auld acquaintance be forgot / and
   never brought to mind…" in C major. Every note falls in the C pentatonic
   set (no F/B). Chords: I, V, I.

**Song select:** 4 song orbs + a 5th "Free play" orb in a gentle arc at
y≈0.10, z≈−1.15 (x spread ±0.55), each with a floating title label. The user
reaches toward an orb — nearest within 0.8 m of the right hand is "aimed"
(scales ×1.6 plus a white-hot core lerp, unmistakable) — and pinches at
ENGAGE to choose: instant feedback, and the engage consumes the gesture so
a continued hold can't double-fire. Pinch-hold with NO orb aimed falls
through to free play. The Twinkle Twinkle orb keeps its gold pulse whenever
the songbook shows; first-time visitors get a one-time "Pinch an orb\nto
choose" prompt ("Choose a song" thereafter). The melody voice stays live
while choosing — noodling over the songbook is allowed. The songbook is the
hub: reached after song 1 (next-song past the last song, pinch-hold
mid-song), from free play, or on session re-entry — never before the first
song (playtest 5).

**Song play:** HUD top-center shows "Title — n/total". The target note's
ladder rung pulses **gold**, stronger than the normal active-rung pulse
(gold wins when target == the user's current rung). Matching the target
pitch for the dwell advances the song: a sparkle burst at the rung + a soft
high shimmer tone (G6+C7 sines, 0.5 s). Free tempo — no rhythm gating
(accessibility). The orchestra auto-follows the song's chords; the left
hand keeps swell/fist control but its chord zones rest during songs. Loop
capture keeps working throughout (perform → pinch → your song loops — the
shareable-performance seed).

**Song complete:** "Beautiful." + a 3-volley firework across the pillars
(reuses the burst pool), then "Pinch: replay • Hold pinch: next song".
Pinch replays; pinch-hold advances to the next song — past the last song,
"next" returns to the songbook. Session end resets song state; re-entry
returns to the songbook hub.

## Playtest-3 fixes (same build)

- **The "∞" glyph — CORRECTED identification (playtest 4):** the earlier
  "overlapping ripple rings" diagnosis was wrong; the glyph appeared again
  in the playtest-4 video (~39 s) as a small dark circle with a white ∞
  floating near the right hand. A full code audit proves it is NOT app UI:
  no sprite, canvas texture, or material in the codebase draws a dark
  filled badge — every app visual is additive/transparent. It is the
  **Horizon OS system-reserved palm-pinch indicator**: per Meta's WebXR
  Hands docs, Quest reserves palm-pinch on both hands in WebXR — look at
  your palm at eye level and hold thumb+index until the icon (menu icon on
  the left hand, the **Meta ∞ logo** on the right) fills up, then release to
  exit the session. The compositor captures it in recordings. We cannot
  remove, relabel, or restyle it. **Design implication:** our core pinch
  gesture overlaps the OS-reserved exit gesture. Quick pinches are safe;
  the risk zone is a 1.5 s hold combined with palm-at-eye-level + gaze at
  the hand — exactly what song-select aiming invites. Mitigations in
  place: holds act at 1.5 s and immediately change mode (the user is out
  before a longer fill completes); the songbook prompt says "Pinch the
  golden orb" (look at the orb, not the hand). If playtests show accidental
  session exits, shorten holds or move hold-actions to the left hand.
- **Particle-spray throttle:** note-change FX (bursts, ripples, cursor
  flash) now fire only when the previous quantized note was actually held
  ≥ 120 ms. The ladder still tracks every change — immediate instrument
  readout, no FX spam. Loop capture and note history are unaffected (they
  record every change).

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
