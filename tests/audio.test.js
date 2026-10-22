import test from "node:test";
import assert from "node:assert/strict";
import { Soundscape } from "../js/audio.js";
import {
  MUSIC_TRACKS,
  effectEvents,
  musicEvents,
  trackForBoard,
} from "../js/music.js";

const settings = {
  bgmEnabled: true,
  bgmVolume: 0.4,
  sfxEnabled: true,
  sfxVolume: 0.7,
};
const boardForTrack = (track) => {
  for (let i = 0; i < 1000; i++) {
    const key = `board-${i}`;
    if (trackForBoard(key) === track) return key;
  }
  throw new Error("Track is unreachable");
};

function audioWorld(t) {
  const saved = new Map(
    ["document", "AudioContext", "setTimeout", "clearTimeout"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const timers = new Map();
  const contexts = [];
  const listeners = [];
  let now = 0;
  let timerId = 0;
  const document = {
    hidden: false,
    addEventListener: (event, listener) => {
      if (event === "visibilitychange") listeners.push(listener);
    },
  };
  class Node {
    connect(destination) {
      this.destination = destination;
      return destination;
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  class AudioContext {
    constructor() {
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
      this.oscillators = [];
      this.gains = [];
      this.resumeCount = 0;
      contexts.push(this);
    }
    resume() {
      this.resumeCount++;
      this.state = "running";
      return Promise.resolve();
    }
    suspend() {
      this.state = "suspended";
      return Promise.resolve();
    }
    createGain() {
      const gain = new Node();
      const context = this;
      gain.gain = {
        automation: [],
        events: [],
        get value() {
          const now = context.currentTime;
          const events = [...this.events].sort((a, b) => a[2] - b[2]);
          let previous = ["set", 1, 0];
          for (const event of events) {
            if (event[2] > now) {
              const fraction = (now - previous[2]) / (event[2] - previous[2]);
              if (event[0] === "linear")
                return previous[1] + (event[1] - previous[1]) * fraction;
              if (event[0] === "exponential")
                return previous[1] * (event[1] / previous[1]) ** fraction;
              break;
            }
            previous = event;
          }
          return previous[1];
        },
        cancelScheduledValues(time) {
          this.automation.push(["cancel", time]);
          this.events = this.events.filter((event) => event[2] < time);
        },
        setValueAtTime(value, time) {
          this.automation.push(["set", value, time]);
          this.events.push(["set", value, time]);
        },
        linearRampToValueAtTime(value, time) {
          this.automation.push(["linear", value, time]);
          this.events.push(["linear", value, time]);
        },
        exponentialRampToValueAtTime(value, time) {
          this.automation.push(["exponential", value, time]);
          this.events.push(["exponential", value, time]);
        },
      };
      this.gains.push(gain);
      return gain;
    }
    createOscillator() {
      const oscillator = new Node();
      oscillator.frequency = { value: 0 };
      oscillator.start = (time) => {
        oscillator.startTime = time;
      };
      oscillator.stop = (time = this.currentTime) => {
        oscillator.stopTime = time;
      };
      this.oscillators.push(oscillator);
      return oscillator;
    }
  }
  Object.assign(globalThis, {
    document,
    AudioContext,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, at: now + delay, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const moveClock = (next) => {
    for (const context of contexts) {
      if (context.state === "running")
        context.currentTime += (next - now) / 1000;
      for (const oscillator of context.oscillators) {
        if (oscillator.onended && oscillator.stopTime <= context.currentTime)
          oscillator.onended();
      }
    }
    now = next;
  };
  t.after(async () => {
    await flush();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return {
    timers,
    contexts,
    document,
    flush,
    async visibility(hidden) {
      document.hidden = hidden;
      for (const listener of listeners) listener();
      await flush();
    },
    advance(milliseconds) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        moveClock(next[1].at);
        timers.delete(next[0]);
        next[1].callback();
      }
      moveClock(end);
    },
  };
}

test("board keys deterministically distribute across five original arrangements", () => {
  const counts = new Map(MUSIC_TRACKS.map((track) => [track.id, 0]));
  for (let i = 0; i < 2000; i++) {
    const key = `play-${i}`;
    const track = trackForBoard(key);
    assert.equal(trackForBoard(key), track);
    counts.set(track.id, counts.get(track.id) + 1);
  }
  for (const count of counts.values()) assert.ok(count > 300 && count < 500);
  assert.equal(new Set(MUSIC_TRACKS.map((track) => track.bpm)).size, 5);
  assert.equal(
    new Set(MUSIC_TRACKS.map((track) => JSON.stringify(track.chords))).size,
    5,
  );
  assert.equal(
    new Set(MUSIC_TRACKS.map((track) => JSON.stringify(track.melody))).size,
    5,
  );
  assert.ok(Object.isFrozen(MUSIC_TRACKS));
});

test("scores repeat cleanly, stay gentle, and include different rhythms and timbres", () => {
  const signatures = new Set();
  for (const track of MUSIC_TRACKS) {
    const length = track.meter * track.chords.length;
    const score = Array.from({ length }, (_, step) => musicEvents(track, step));
    signatures.add(JSON.stringify(score));
    assert.deepEqual(musicEvents(track, length), score[0]);
    assert.ok(score.flat().length > 20);
    for (const note of score.flat()) {
      assert.ok(note.midi >= 40 && note.midi <= 94.02);
      assert.ok(
        Number.isFinite(note.duration) &&
          note.duration > 0 &&
          note.duration < 9,
      );
      assert.ok(note.gain > 0 && note.gain <= 0.026);
      assert.ok(note.attack > 0 && note.attack < note.duration);
      assert.ok(["sine", "triangle"].includes(note.type));
      assert.ok(note.delay >= 0);
    }
  }
  assert.equal(signatures.size, 5);
  const bells = musicEvents(
    MUSIC_TRACKS.find((track) => track.id === "lantern"),
    1,
  );
  assert.equal(bells[0].attack, 0.04);
  assert.equal(bells[1].attack, 0.04);
  assert.equal(bells[1].gain, 0.0015);
});

test("every effect uses gentle chord tones in all five arrangements without changing scores", () => {
  for (const track of MUSIC_TRACKS) {
    const length = track.meter * track.chords.length;
    const score = Array.from({ length }, (_, step) => musicEvents(track, step));
    const source = JSON.stringify(track);
    for (let step = 0; step < length; step++) {
      const chord = track.chords[Math.floor(step / track.meter)];
      for (const kind of ["remove", "blocked", "hint", "complete"])
        for (let variation = 0; variation < 4; variation++) {
          const notes = effectEvents(track, step, kind, variation);
          assert.deepEqual(effectEvents(track, step, kind, variation), notes);
          assert.deepEqual(
            effectEvents(track, step + length, kind, variation),
            notes,
          );
          for (const note of notes) {
            assert.ok(chord.some((midi) => (note.midi - midi) % 12 === 0));
            assert.ok(note.gain > 0 && note.gain <= 0.022);
            assert.ok(note.duration > note.attack && note.duration <= 1.3);
            assert.equal(note.type, "sine");
          }
        }
    }
    assert.equal(JSON.stringify(track), source);
    assert.deepEqual(
      Array.from({ length }, (_, step) => musicEvents(track, step)),
      score,
    );
  }
});

test("effects follow the currently sounding chord without advancing or restarting BGM", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  for (const track of MUSIC_TRACKS) {
    audio.setBoard(boardForTrack(track));
    for (let chordIndex = 0; chordIndex < track.chords.length; chordIndex++) {
      const chord = track.chords[chordIndex];
      assert.equal(Math.floor((audio.step - 1) / track.meter), chordIndex);
      for (const kind of ["remove", "blocked", "hint", "complete"]) {
        const step = audio.step;
        const timer = audio.timer;
        const bgm = audio.voices.filter((voice) => voice.channel === "bgm");
        audio.effect(kind);
        const effects = audio.voices.filter((voice) => voice.channel === "sfx");
        assert.equal(
          effects.length,
          kind === "complete" ? 4 : kind === "hint" ? 2 : 1,
        );
        for (const { oscillator, envelope } of effects) {
          const midi = 69 + 12 * Math.log2(oscillator.frequency.value / 440);
          assert.ok(chord.some((tone) => Math.abs((midi - tone) % 12) < 1e-9));
          assert.equal(envelope.destination, audio.sfxBus);
        }
        assert.equal(audio.step, step);
        assert.equal(audio.timer, timer);
        assert.equal(audio.track, track);
        assert.equal(world.timers.size, 1);
        assert.deepEqual(
          audio.voices.filter((voice) => voice.channel === "bgm"),
          bgm,
        );
        audio.stopVoices("sfx");
      }
      if (chordIndex < track.chords.length - 1)
        world.advance((track.meter * 60000) / track.bpm + 0.001);
    }
  }
});

test("BGM-off effects use the selected track and retain the last sounding chord", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure({ ...settings, bgmEnabled: false });
  await audio.unlock();
  for (const track of MUSIC_TRACKS) {
    audio.setBoard(boardForTrack(track));
    const step = audio.step;
    audio.effect("remove");
    const first = audio.voices.find((voice) => voice.channel === "sfx");
    const midi = Math.round(
      69 + 12 * Math.log2(first.oscillator.frequency.value / 440),
    );
    assert.ok(track.chords[0].some((tone) => (midi - tone) % 12 === 0));
    assert.equal(audio.step, step);
    assert.equal(world.timers.size, 0);
    audio.stopVoices("sfx");
    audio.configure(settings);
    world.advance((track.meter * 60000) / track.bpm + 0.001);
    audio.configure({ ...settings, bgmEnabled: false });
    world.advance(101);
    const pausedStep = audio.step;
    for (const kind of ["remove", "blocked", "hint", "complete"]) {
      audio.effect(kind);
      for (const { oscillator } of audio.voices.filter(
        (voice) => voice.channel === "sfx",
      )) {
        const midi = Math.round(
          69 + 12 * Math.log2(oscillator.frequency.value / 440),
        );
        assert.ok(track.chords[1].some((tone) => (midi - tone) % 12 === 0));
      }
      assert.equal(audio.step, pausedStep);
      assert.equal(world.timers.size, 0);
      audio.stopVoices("sfx");
    }
  }
});

test("rapid taps stay bounded and leave room for other feedback without stopping BGM", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  const bgm = audio.voices.filter((voice) => voice.channel === "bgm");
  const timer = audio.timer;
  const step = audio.step;
  for (let i = 0; i < 500; i++) audio.effect("remove");
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    4,
  );
  audio.effect("complete");
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    8,
  );
  const allocated = audio.context.oscillators.length;
  for (let i = 0; i < 500; i++) audio.effect("complete");
  assert.equal(audio.context.oscillators.length, allocated);
  assert.equal(audio.step, step);
  assert.equal(audio.timer, timer);
  assert.deepEqual(
    audio.voices.filter((voice) => voice.channel === "bgm"),
    bgm,
  );
  world.advance(1800);
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    0,
  );
  audio.effect("blocked");
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    1,
  );
  await world.visibility(true);
  assert.equal(audio.voices.length, 0);
  assert.ok(audio.context.oscillators.every((node) => node.disconnected));
});

test("configuration and board selection do not create audio before a user unlock", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  audio.setBoard("saved-board");
  audio.effect("complete");
  await world.visibility(true);
  await world.visibility(false);
  assert.equal(world.contexts.length, 0);
  assert.equal(world.timers.size, 0);
  await audio.unlock();
  assert.equal(world.contexts.length, 1);
  assert.equal(world.timers.size, 1);
});

test("repeated rendering, settings, home, and unlock preserve the playing phrase", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  audio.setBoard("same-board");
  await audio.unlock();
  world.advance(2400);
  const before = {
    step: audio.step,
    timer: audio.timer,
    nodes: audio.context.oscillators.length,
    track: audio.track,
  };
  for (let i = 0; i < 20; i++) {
    audio.setBoard("same-board");
    audio.configure({ ...settings, unrelatedSetting: i });
    audio.setBoard(null);
    await audio.unlock();
  }
  assert.equal(audio.step, before.step);
  assert.equal(audio.timer, before.timer);
  assert.equal(audio.track, before.track);
  assert.equal(audio.context.oscillators.length, before.nodes);
  assert.equal(world.timers.size, 1);
});

test("new arrangements replace only BGM while effects and a single timer survive", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  audio.effect("complete");
  const effects = audio.voices.filter((voice) => voice.channel === "sfx");
  for (const track of MUSIC_TRACKS.slice(1)) {
    world.advance(60);
    const oldMusic = audio.voices.filter((voice) => voice.channel === "bgm");
    audio.setBoard(boardForTrack(track));
    assert.equal(audio.track, track);
    assert.equal(audio.step, 1);
    assert.equal(world.timers.size, 1);
    assert.ok(
      oldMusic.every(
        (voice) => voice.stopping || voice.oscillator.disconnected,
      ),
    );
    world.advance(101);
    assert.ok(oldMusic.every((voice) => voice.oscillator.disconnected));
    assert.ok(effects.every((voice) => audio.voices.includes(voice)));
    assert.ok(effects.every((voice) => !voice.oscillator.disconnected));
  }
  audio.configure({ ...settings, bgmEnabled: false });
  assert.equal(world.timers.size, 0);
  world.advance(101);
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "bgm").length,
    0,
  );
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    4,
  );
  audio.effect("blocked");
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    5,
  );
});

test("independent channel volume and toggles do not reset the other channel", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  audio.effect("hint");
  const timer = audio.timer;
  const step = audio.step;
  audio.configure({ ...settings, bgmVolume: 0.2, sfxVolume: 0.9 });
  assert.equal(audio.bgmBus.gain.value, settings.bgmVolume);
  assert.equal(audio.sfxBus.gain.value, settings.sfxVolume);
  world.advance(50);
  assert.equal(audio.bgmBus.gain.value, 0.2);
  assert.equal(audio.sfxBus.gain.value, 0.9);
  assert.equal(audio.timer, timer);
  assert.equal(audio.step, step);
  audio.configure({ ...settings, sfxEnabled: false });
  assert.equal(audio.timer, timer);
  assert.equal(
    audio.voices.filter((voice) => voice.channel === "sfx").length,
    0,
  );
  const count = audio.voices.length;
  audio.effect("complete");
  assert.equal(audio.voices.length, count);
  audio.configure({ ...settings, bgmVolume: 0 });
  assert.equal(world.timers.size, 0);
  world.advance(101);
  audio.effect("hint");
  assert.equal(audio.voices.length, 2);
  audio.configure({ ...settings, bgmVolume: Infinity, sfxVolume: -5 });
  world.advance(50);
  assert.equal(audio.bgmBus.gain.value, 0);
  assert.equal(audio.sfxBus.gain.value, 0);
  audio.configure(settings);
  assert.equal(world.timers.size, 1);
  assert.equal(audio.step, step + 1);
});

test("BGM fade preserves the current envelope and never extends a short or stopping voice", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure({ ...settings, bgmEnabled: false });
  await audio.unlock();
  audio.tone(220, 2, 0.01, 0, { channel: "bgm", attack: 0.1 });
  audio.tone(330, 0.06, 0.01, 0, { channel: "bgm" });
  audio.tone(440, 2, 0.01, 0.15, { channel: "bgm" });
  const [long, short, pending] = audio.voices;
  world.advance(20);
  const levels = [long.envelope.gain.value, short.envelope.gain.value];
  audio.stopBgm();
  assert.equal(world.timers.size, 0);
  assert.ok(Math.abs(long.envelope.gain.value - levels[0]) < 1e-12);
  assert.ok(Math.abs(short.envelope.gain.value - levels[1]) < 1e-12);
  assert.ok(Math.abs(long.stopTime - 0.12) < 1e-12);
  assert.equal(short.stopTime, 0.06);
  assert.ok(pending.oscillator.disconnected);
  const reservations = [long, short].map(
    (voice) => voice.envelope.gain.automation.length,
  );
  world.advance(20);
  for (let i = 0; i < 10; i++)
    audio.configure({ ...settings, bgmEnabled: false });
  assert.ok(Math.abs(long.stopTime - 0.12) < 1e-12);
  assert.equal(short.stopTime, 0.06);
  assert.deepEqual(
    [long, short].map((voice) => voice.envelope.gain.automation.length),
    reservations,
  );
  assert.ok(Math.abs(long.envelope.gain.value - levels[0] * 0.8) < 1e-12);
  world.advance(21);
  assert.ok(short.oscillator.disconnected);
  assert.equal(long.oscillator.disconnected, undefined);
  world.advance(60);
  assert.equal(audio.voices.length, 0);
  assert.ok(long.oscillator.disconnected);
  assert.equal(world.timers.size, 0);
});

test("rapid volume changes join the current 50 ms ramp and identical settings do not extend it", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  const timer = audio.timer;
  const step = audio.step;
  audio.configure({ ...settings, bgmVolume: 0.2 });
  world.advance(25);
  assert.ok(Math.abs(audio.bgmBus.gain.value - 0.3) < 1e-12);
  audio.configure({ ...settings, bgmVolume: 0.8 });
  assert.ok(Math.abs(audio.bgmBus.gain.value - 0.3) < 1e-12);
  const reservation = audio.bgmBus.gain.automation.length;
  world.advance(15);
  audio.configure({ ...settings, bgmVolume: 0.8 });
  assert.equal(audio.bgmBus.gain.automation.length, reservation);
  world.advance(35);
  assert.ok(Math.abs(audio.bgmBus.gain.value - 0.8) < 1e-12);
  assert.equal(audio.timer, timer);
  assert.equal(audio.step, step);
  assert.equal(world.timers.size, 1);
});

test("hiding during a fade immediately releases its remaining nodes", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  world.advance(60);
  audio.configure({ ...settings, bgmEnabled: false });
  assert.ok(audio.voices.some((voice) => voice.stopping));
  await world.visibility(true);
  assert.equal(audio.voices.length, 0);
  assert.equal(world.timers.size, 0);
  assert.ok(audio.context.oscillators.every((node) => node.disconnected));
});

test("hiding stops voices and timers; returning continues the chosen piece", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  audio.setBoard("continue-after-hidden");
  await audio.unlock();
  world.advance(2500);
  audio.effect("complete");
  const step = audio.step;
  const track = audio.track;
  await world.visibility(true);
  assert.equal(audio.context.state, "suspended");
  assert.equal(audio.voices.length, 0);
  assert.equal(world.timers.size, 0);
  world.advance(10000);
  assert.equal(audio.step, step);
  await world.visibility(false);
  assert.equal(audio.context.state, "running");
  assert.equal(audio.track, track);
  assert.equal(audio.step, step + 1);
  assert.equal(world.timers.size, 1);
});

test("quick hide/show reconciles an asynchronously finishing suspension", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  let finishSuspend;
  audio.context.suspend = () =>
    new Promise((resolve) => {
      finishSuspend = () => {
        audio.context.state = "suspended";
        resolve();
      };
    });
  await world.visibility(true);
  await world.visibility(false);
  finishSuspend();
  await world.flush();
  assert.equal(audio.context.state, "running");
  assert.equal(world.timers.size, 1);
});

test("long playback and repeated track changes release ended and cancelled nodes", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  await audio.unlock();
  for (let pass = 0; pass < 5; pass++) {
    for (const track of MUSIC_TRACKS) {
      audio.setBoard(boardForTrack(track));
      for (let minute = 0; minute < 2; minute++) {
        world.advance(60000);
        assert.ok(audio.voices.length < 24);
        assert.equal(world.timers.size, 1);
      }
    }
  }
  audio.configure({ ...settings, bgmEnabled: false, sfxEnabled: false });
  world.advance(101);
  assert.equal(audio.voices.length, 0);
  assert.equal(world.timers.size, 0);
  assert.ok(audio.context.oscillators.every((node) => node.disconnected));
  assert.ok(audio.context.gains.slice(2).every((node) => node.disconnected));
});

test("audio failures stay contained, clean partial nodes, and permit retry", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure(settings);
  const Context = globalThis.AudioContext;
  globalThis.AudioContext = class {
    constructor() {
      throw new Error("audio unavailable");
    }
  };
  await assert.doesNotReject(audio.unlock());
  assert.equal(audio.context, null);
  globalThis.AudioContext = Context;
  await audio.unlock();
  const createOscillator = audio.context.createOscillator.bind(audio.context);
  audio.context.createOscillator = () => {
    const node = createOscillator();
    node.start = () => {
      throw new Error("device interrupted");
    };
    return node;
  };
  assert.doesNotThrow(() => audio.effect("complete"));
  assert.doesNotThrow(() => world.advance(10000));
  assert.equal(world.timers.size, 1);
  assert.equal(audio.voices.length, 0);
  assert.ok(audio.context.oscillators.every((node) => node.disconnected));
  audio.context.createOscillator = createOscillator;
  world.advance(2000);
  assert.ok(audio.voices.length > 0);
  await world.visibility(true);
  const resume = audio.context.resume.bind(audio.context);
  audio.context.resume = () => Promise.reject(new Error("gesture needed"));
  await world.visibility(false);
  assert.equal(world.timers.size, 0);
  audio.context.resume = resume;
  await audio.unlock();
  assert.equal(world.timers.size, 1);
});

test("voice count remains bounded even when ended events are not delivered", async (t) => {
  const world = audioWorld(t);
  const audio = new Soundscape();
  audio.configure({ ...settings, bgmEnabled: false });
  await audio.unlock();
  for (let i = 0; i < 500; i++) audio.effect("complete");
  assert.equal(audio.voices.length, 8);
  const expired = [...audio.voices];
  for (const voice of expired) voice.oscillator.onended = null;
  world.advance(2000);
  audio.effect("blocked");
  assert.equal(audio.voices.length, 1);
  assert.ok(expired.every((voice) => voice.oscillator.disconnected));
  assert.ok(expired.every((voice) => voice.envelope.disconnected));
  audio.configure({ ...settings, bgmEnabled: false, sfxEnabled: false });
  assert.equal(audio.voices.length, 0);
});
