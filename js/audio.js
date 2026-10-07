// Handphony — audio engine. All synthesized, no samples.
// Chain: voices -> master gain -> DynamicsCompressor (gentle limiter)
//        -> dry to destination, plus parallel convolver reverb (wet ~0.33).
// Melody (theremin principle): a SUSTAINED voice — two detuned oscillators
// (triangle + sine) through a gentle lowpass with a subtle slow tremolo.
// Hand height drives pitch continuously, quantized to the pentatonic set
// with a ~70ms portamento glide between notes. The voice fades in when play
// begins and sustains while the hand is tracked; note EVENTS (for particles,
// ladder, loop capture) fire only when the quantized note index changes.
// Musical safety: pentatonic melody, consonant triad pads, sine sub-bass.
// Nothing dissonant is reachable by design.

export const PENT_MIDIS = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84]; // C4..C6
export const NOTE_NAMES = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5', 'A5', 'C6'];

// Named pad voicings for the song driver (auto-chords). Same consonant
// triads as the free-play chord map: I=C, vi=Am, IV=F, V=G.
export const CHORD_VOICINGS = {
  I: { midis: [60, 64, 67], root: 48 },
  vi: { midis: [57, 60, 64], root: 45 },
  IV: { midis: [53, 57, 60], root: 41 },
  V: { midis: [55, 59, 62], root: 43 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.melPulse = 0;   // set to 1 when the quantized note changes; main loop consumes
    this.melVoice = null; // sustained theremin voice nodes
    this.loopPulse = 0;  // set to 1 on loop-note onset
    this.bassPulse = 0;  // set to 1 on chord change
    this.loop = null;    // {notes:[{midi,dt}], idx, t0, total}
    this.pad = null;     // {bus, oscs}
  }

  mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = 0.85;

    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.24;

    this.verb = c.createConvolver();
    this.verb.buffer = this.makeIR(2.5); // 2.5s exponentially-decaying noise
    this.wet = c.createGain();
    this.wet.gain.value = 0.33;

    this.master.connect(this.comp);
    this.comp.connect(c.destination);          // dry path
    this.comp.connect(this.verb);              // parallel wet path
    this.verb.connect(this.wet);
    this.wet.connect(c.destination);

    // Melody bus: sustained theremin voice through a fixed gentle lowpass.
    this.melFilter = c.createBiquadFilter();
    this.melFilter.type = 'lowpass';
    this.melFilter.frequency.value = 2600;
    this.melFilter.Q.value = 0.4;
    this.melodyBus = c.createGain();
    this.melFilter.connect(this.melodyBus);
    this.melodyBus.connect(this.master);

    // Pad bus: shared lowpass (cutoff driven by palm swell) -> swell gain.
    this.padFilter = c.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.6;
    this.swellGain = c.createGain();
    this.swellGain.gain.value = 0.25;
    this.padFilter.connect(this.swellGain);
    this.swellGain.connect(this.master);

    // Bass: one continuous sine, frequency ramps on chord change, soft.
    this.bassOsc = c.createOscillator();
    this.bassOsc.type = 'sine';
    this.bassOsc.frequency.value = this.mtof(48); // C3
    this.bassGain = c.createGain();
    this.bassGain.gain.value = 0.20;
    this.bassOsc.connect(this.bassGain);
    this.bassGain.connect(this.swellGain); // fist dampens pad+bass together
    this.bassOsc.start();

    // Loop voice filter (soft arpeggio sits under the lead).
    this.loopFilter = c.createBiquadFilter();
    this.loopFilter.type = 'lowpass';
    this.loopFilter.frequency.value = 1800;
    this.loopFilter.connect(this.melodyBus);

    this.ready = true;
  }

  makeIR(dur) {
    const c = this.ctx, rate = c.sampleRate, len = Math.floor(rate * dur);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
    }
    return buf;
  }

  // Sustained theremin voice, built lazily on first use. Two detuned
  // oscillators (triangle + sine) -> voice gain -> slow tremolo -> melFilter.
  ensureMelody() {
    if (this.melVoice || !this.ready) return;
    const c = this.ctx, t = c.currentTime;
    const vGain = c.createGain();
    vGain.gain.value = 0.0001;
    const trem = c.createGain();
    trem.gain.value = 1.0;
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 4.5; // subtle slow tremolo
    const lfoDepth = c.createGain();
    lfoDepth.gain.value = 0.10;
    lfo.connect(lfoDepth);
    lfoDepth.connect(trem.gain);
    lfo.start(t);
    vGain.connect(trem);
    trem.connect(this.melFilter);
    const oscs = [];
    for (const [type, det] of [['triangle', -6], ['sine', 7]]) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = this.mtof(72); // C5; ramps to the hand's note
      o.detune.value = det;
      o.connect(vGain);
      o.start(t);
      oscs.push(o);
    }
    this.melVoice = { vGain, oscs };
    this.melMidi = -1;
  }

  // Quantized note change: glide pitch (~70ms portamento) and fire the
  // note EVENT that drives particles, ladder flash, and loop capture.
  // quiet=true adopts the first note silently (no event on voice start).
  setMelodyNote(midi, quiet = false) {
    if (!this.ready) return;
    this.ensureMelody();
    if (!this.melVoice || midi === this.melMidi) return;
    this.melMidi = midi;
    const t = this.ctx.currentTime, f = this.mtof(midi);
    for (const o of this.melVoice.oscs) o.frequency.setTargetAtTime(f, t, 0.023);
    if (!quiet) this.melPulse = 1;
  }

  // Voice level: 1 = playing (gentle attack), 0 = silent (soft release).
  setMelodyLevel(v) {
    if (!this.ready) return;
    this.ensureMelody();
    if (!this.melVoice) return;
    const t = this.ctx.currentTime;
    this.melVoice.vGain.gain.setTargetAtTime(
      Math.max(0.0001, 0.40 * v), t, v > 0.5 ? 0.18 : 0.25);
  }

  // Pad: 2 detuned saws per chord tone, slow attack, crossfaded on change.
  // Bass root ramps to the new root an octave below the chord.
  setChord(midis, rootMidi) {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime;
    if (this.pad) {
      const old = this.pad;
      old.bus.gain.cancelScheduledValues(t);
      old.bus.gain.setTargetAtTime(0.0001, t, 0.35);
      for (const o of old.oscs) { try { o.stop(t + 1.8); } catch (e) { /* already stopped */ } }
    }
    this.bassOsc.frequency.cancelScheduledValues(t);
    this.bassOsc.frequency.setTargetAtTime(this.mtof(rootMidi), t, 0.4);
    this.bassPulse = 1;

    const bus = c.createGain();
    bus.gain.value = 0.0001;
    bus.connect(this.padFilter);
    const oscs = [];
    for (const m of midis) {
      const f = this.mtof(m);
      for (const det of [-7, 7]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const og = c.createGain();
        og.gain.value = 0.11;
        o.connect(og);
        og.connect(bus);
        o.start(t);
        oscs.push(o);
      }
    }
    bus.gain.setTargetAtTime(0.5, t, 0.7); // slow bloom
    this.pad = { bus, oscs };
  }

  // Song driver: change the pad to a named chord (I/vi/IV/V).
  // Reuses the exact pad voicings above — the orchestra follows the song.
  setAutoChord(sym) {
    const v = CHORD_VOICINGS[sym];
    if (v) this.setChord(v.midis, v.root);
  }

  // Soft high shimmer (G6 + C7 sines, 0.5s): the reward tone when a song
  // note is matched. Quiet by design — it kisses the melody, not covers it.
  playShimmer() {
    if (!this.ready) return;
    const c = this.ctx, t = c.currentTime;
    for (const [f, g0] of [[1568.0, 0.055], [2093.0, 0.035]]) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(g0, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + 0.6);
    }
  }

  // Palm openness 0..1 -> pad lowpass cutoff + pad/bass level. Smoothed.
  setSwell(o) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.padFilter.frequency.setTargetAtTime(380 + o * 3600, t, 0.12);
    this.swellGain.gain.setTargetAtTime(0.03 + o * 0.55, t, 0.12);
  }

  startLoop(notes) { // notes: [{midi, dt}] dt = seconds since phrase start
    if (!this.ready || !notes.length) return;
    this.loop = {
      notes,
      idx: 0,
      t0: this.ctx.currentTime + 0.15,
      total: notes[notes.length - 1].dt + 0.7,
    };
  }

  stopLoop() { this.loop = null; }
  get looping() { return !!this.loop; }

  playLoopNote(midi, when) {
    const c = this.ctx, f = this.mtof(midi);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.15, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.55);
    g.connect(this.loopFilter);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(g);
    o.start(when);
    o.stop(when + 0.7);
    this.loopPulse = 1;
  }

  // Call every frame: lookahead scheduler replays the captured phrase
  // with its original rhythm, looping.
  update() {
    if (!this.loop || !this.ready) return;
    const t = this.ctx.currentTime, L = this.loop;
    let guard = 0;
    while (L.idx < L.notes.length && L.t0 + L.notes[L.idx].dt <= t + 0.06 && guard++ < 32) {
      const when = Math.max(L.t0 + L.notes[L.idx].dt, t + 0.01);
      this.playLoopNote(L.notes[L.idx].midi, when);
      L.idx++;
    }
    if (L.idx >= L.notes.length) { L.idx = 0; L.t0 += L.total; }
  }
}
