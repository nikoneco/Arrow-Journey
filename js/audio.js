import { MUSIC_TRACKS, musicEvents, trackForBoard } from "./music.js";

const volume = (value) =>
  Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

// Original, procedural soundscape. No recordings or external audio requests.
export class Soundscape {
  constructor() {
    this.settings = {};
    this.context = null;
    this.voices = [];
    this.timer = null;
    this.step = 0;
    this.boardKey = null;
    this.track = MUSIC_TRACKS[0];
    this.resumePromise = null;
    this.suspendPromise = null;
    this.volumeRamps = {};
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.update();
      else void this.resume();
    });
  }
  async unlock() {
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.bgmBus = this.context.createGain();
        this.sfxBus = this.context.createGain();
        this.bgmBus.connect(this.context.destination);
        this.sfxBus.connect(this.context.destination);
        this.applyVolumes();
      }
      await this.resume();
    } catch {
      /* Audio never blocks play. */
    }
  }
  async resume() {
    if (!this.context || document.hidden || this.context.state === "closed")
      return;
    try {
      if (this.context.state !== "running") {
        this.resumePromise ||= this.context.resume();
        await this.resumePromise;
      }
      this.update();
    } catch {
      /* A later user gesture can retry. */
    } finally {
      this.resumePromise = null;
    }
  }
  configure(settings) {
    this.settings = {
      bgmEnabled: !!settings.bgmEnabled,
      bgmVolume: volume(settings.bgmVolume),
      sfxEnabled: !!settings.sfxEnabled,
      sfxVolume: volume(settings.sfxVolume),
    };
    this.applyVolumes();
    if (!this.settings.sfxEnabled) this.stopVoices("sfx");
    this.update();
  }
  applyVolumes() {
    for (const channel of ["bgm", "sfx"]) {
      const bus = this[`${channel}Bus`];
      if (!bus) continue;
      const target = volume(this.settings[`${channel}Volume`]);
      const previous = this.volumeRamps[channel];
      if (previous?.target === target) continue;
      const now = this.context.currentTime;
      const progress = previous
        ? Math.min(1, (now - previous.start) / 0.05)
        : 1;
      const from = previous
        ? previous.from + (previous.target - previous.from) * progress
        : target;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(from, now);
      if (previous) bus.gain.linearRampToValueAtTime(target, now + 0.05);
      this.volumeRamps[channel] = { from, target, start: now };
    }
  }
  setBoard(key) {
    // Home and settings retain the current piece; rendering a board is idempotent.
    if (key == null || key === "") return;
    key = String(key);
    if (key === this.boardKey) return;
    this.boardKey = key;
    const next = trackForBoard(key);
    if (next === this.track) return;
    this.track = next;
    this.step = 0;
    this.stopBgm();
    this.update();
  }
  stopVoices(channel, fade = 0) {
    for (const voice of [...this.voices]) {
      if (channel && voice.channel !== channel) continue;
      const now = this.context.currentTime;
      if (fade && voice.stopping && voice.stopTime > now) continue;
      const end = voice.stopping ? now : Math.min(now + fade, voice.endTime);
      if (fade && now > voice.startTime && end > now) {
        try {
          // Preserve the current envelope level, including a partial attack.
          // Repeated updates never reschedule this stop or extend a short note.
          voice.envelope.gain.cancelScheduledValues(now);
          voice.envelope.gain.setValueAtTime(voice.levelAt(now), now);
          voice.envelope.gain.linearRampToValueAtTime(0, end);
          voice.oscillator.stop(end);
          voice.stopTime = end;
          voice.stopping = true;
          continue;
        } catch {
          /* Fall back to immediate cleanup if fading is unavailable. */
        }
      }
      try {
        voice.oscillator.stop();
      } catch {}
      voice.dispose();
    }
  }
  stopBgm(fade = 0.1) {
    clearTimeout(this.timer);
    this.timer = null;
    this.stopVoices("bgm", fade);
  }
  tone(frequency, duration, gain = 0.05, delay = 0, options = {}) {
    if (!this.context || this.context.state !== "running" || document.hidden)
      return;
    // Also bound live nodes if a browser stops delivering ended events.
    if (this.voices.length >= 96) return;
    let oscillator, envelope, voice;
    try {
      const time = this.context.currentTime + delay;
      const channel = options.channel || "sfx";
      const attack = Math.min(options.attack || 0.025, duration / 2);
      oscillator = this.context.createOscillator();
      envelope = this.context.createGain();
      voice = {
        oscillator,
        envelope,
        channel,
        startTime: time,
        endTime: time + duration,
        stopTime: time + duration + 0.05,
        levelAt: (now) => {
          const elapsed = now - time;
          if (elapsed <= 0) return 0;
          if (elapsed < attack) return (gain * elapsed) / attack;
          if (elapsed >= duration) return 0.0001;
          return (
            gain * (0.0001 / gain) ** ((elapsed - attack) / (duration - attack))
          );
        },
        dispose: () => {
          oscillator.onended = null;
          try {
            oscillator.disconnect();
          } catch {}
          try {
            envelope.disconnect();
          } catch {}
          this.voices = this.voices.filter((item) => item !== voice);
        },
      };
      oscillator.type = options.type || "sine";
      oscillator.frequency.value = frequency;
      envelope.gain.setValueAtTime(0, time);
      envelope.gain.linearRampToValueAtTime(gain, time + attack);
      envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      oscillator
        .connect(envelope)
        .connect(channel === "bgm" ? this.bgmBus : this.sfxBus);
      oscillator.onended = voice.dispose;
      this.voices.push(voice);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.05);
    } catch {
      try {
        oscillator?.stop();
      } catch {}
      // Partially created graphs must also be released after an audio failure.
      try {
        oscillator?.disconnect();
        envelope?.disconnect();
      } catch {}
      this.voices = this.voices.filter((item) => item !== voice);
    }
  }
  update() {
    if (document.hidden) {
      this.stopBgm(0);
      this.stopVoices("sfx");
      if (this.context && !this.suspendPromise) {
        try {
          this.suspendPromise = this.context
            .suspend()
            .catch(() => {})
            .finally(() => {
              this.suspendPromise = null;
              // Handles a quick hide/show while suspension is still pending.
              if (!document.hidden) void this.resume();
            });
        } catch {}
      }
      return;
    }
    if (!this.settings.bgmEnabled || !this.settings.bgmVolume) {
      this.stopBgm();
      return;
    }
    if (this.context?.state === "running" && this.timer === null)
      this.schedule();
  }
  schedule() {
    if (
      !this.settings.bgmEnabled ||
      !this.settings.bgmVolume ||
      document.hidden ||
      this.context?.state !== "running"
    )
      return;
    try {
      for (const note of musicEvents(this.track, this.step++)) {
        this.tone(
          440 * 2 ** ((note.midi - 69) / 12),
          note.duration,
          note.gain,
          note.delay || 0,
          { ...note, channel: "bgm" },
        );
      }
    } catch {
      /* A failed note never interrupts the game or subsequent scheduling. */
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.schedule();
    }, 60000 / this.track.bpm);
  }
  effect(kind) {
    if (!this.settings.sfxEnabled || document.hidden) return;
    const v = 0.14;
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
