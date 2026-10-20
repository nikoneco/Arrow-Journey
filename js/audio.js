// Original, procedural soundscape. No recordings or external audio requests.
export class Soundscape {
  constructor() {
    this.settings = {};
    this.context = null;
    this.voices = [];
    this.timer = null;
    this.step = 0;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.context?.state === "suspended")
        this.context
          .resume()
          .then(() => this.update())
          .catch(() => {});
      else this.update();
    });
  }
  async unlock() {
    try {
      let changed = false;
      if (!this.context) {
        this.context = new AudioContext();
        changed = true;
      }
      if (this.context.state === "suspended" && !document.hidden) {
        await this.context.resume();
        changed = true;
      }
      if (changed) this.update();
    } catch {
      /* Audio never blocks play. */
    }
  }
  configure(settings) {
    if (JSON.stringify(this.settings) === JSON.stringify(settings)) return;
    this.settings = settings;
    for (const v of this.voices)
      try {
        v.stop();
      } catch {}
    this.voices = [];
    this.update();
  }
  tone(frequency, duration, volume = 0.05, delay = 0) {
    if (!this.context || this.context.state !== "running") return;
    const t = this.context.currentTime + delay,
      o = this.context.createOscillator(),
      g = this.context.createGain();
    o.type = "sine";
    o.frequency.value = frequency;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(this.context.destination);
    o.start(t);
    o.stop(t + duration + 0.05);
    this.voices.push(o);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
      this.voices = this.voices.filter((v) => v !== o);
    };
  }
  update() {
    clearTimeout(this.timer);
    this.timer = null;
    if (document.hidden || !this.settings.bgmEnabled) {
      for (const v of this.voices)
        try {
          v.stop();
        } catch {}
      this.voices = [];
      if (document.hidden) this.context?.suspend().catch(() => {});
      return;
    }
    if (this.context?.state === "running") this.schedule();
  }
  schedule() {
    if (!this.settings.bgmEnabled || document.hidden) return;
    const chords = [
      [130.81, 196, 261.63, 329.63],
      [110, 164.81, 220, 293.66],
      [146.83, 196, 293.66, 369.99],
      [130.81, 174.61, 261.63, 349.23],
    ];
    const notes = chords[Math.floor(this.step / 4) % chords.length];
    const i = this.step++ % 4;
    this.tone(notes[i], 4, this.settings.bgmVolume * 0.065);
    this.tone(notes[i] * 2, 2.5, this.settings.bgmVolume * 0.018, 0.4);
    this.timer = setTimeout(() => this.schedule(), 1700);
  }
  effect(kind) {
    if (!this.settings.sfxEnabled || document.hidden) return;
    const v = this.settings.sfxVolume * 0.14;
    if (kind === "blocked") this.tone(196, 0.22, v * 0.6);
    else if (kind === "hint") {
      this.tone(523.25, 0.55, v);
      this.tone(659.25, 0.7, v, 0.12);
    } else if (kind === "complete") {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        this.tone(f, 1.3, v, i * 0.14),
      );
    } else this.tone(440 + Math.random() * 160, 0.4, v * 0.7);
  }
}
