// Five original arrangements, expressed as MIDI notes. No stored play history,
// external media, or network dependency is needed to choose or play a piece.
export const MUSIC_TRACKS = Object.freeze(
  [
    {
      id: "river",
      bpm: 68,
      meter: 8,
      chords: [
        [48, 55, 59, 64],
        [45, 52, 55, 60],
        [41, 48, 52, 57],
        [43, 50, 55, 59],
      ],
      melody: [0, 2, 1, 3, 2, 1, 3, 1],
    },
    {
      id: "grove",
      bpm: 56,
      meter: 8,
      chords: [
        [50, 57, 59, 66],
        [43, 50, 54, 59],
        [47, 54, 57, 62],
        [45, 52, 59, 64],
      ],
      melody: [2, null, 1, 3, null, 2, 1, null],
    },
    {
      id: "lantern",
      bpm: 76,
      meter: 8,
      chords: [
        [52, 59, 63, 66],
        [49, 56, 59, 64],
        [45, 52, 56, 61],
        [47, 54, 61, 66],
      ],
      melody: [3, 2, null, 1, 2, null, 3, 1],
    },
    {
      id: "clouds",
      bpm: 60,
      meter: 6,
      chords: [
        [41, 48, 52, 57],
        [50, 57, 60, 64],
        [46, 53, 57, 62],
        [48, 55, 62, 64],
      ],
      melody: [2, 1, 0, 2, 3, 1],
    },
    {
      id: "tide",
      bpm: 64,
      meter: 8,
      chords: [
        [43, 50, 55, 64],
        [40, 47, 55, 62],
        [48, 55, 59, 64],
        [50, 57, 59, 66],
      ],
      melody: [null, 3, 2, null, 1, null, 2, 0],
    },
  ].map((track) =>
    Object.freeze({
      ...track,
      chords: Object.freeze(track.chords.map((chord) => Object.freeze(chord))),
      melody: Object.freeze(track.melody),
    }),
  ),
);

export function trackForBoard(key) {
  // Avalanche a string hash so nearby generated IDs also spread across pieces.
  let hash = 2166136261;
  for (const char of String(key)) {
    hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return MUSIC_TRACKS[(hash >>> 0) % MUSIC_TRACKS.length];
}

const chordForStep = (track, step) =>
  track.chords[Math.floor(step / track.meter) % track.chords.length];

// Short chord-tone replies share the playing arrangement's harmony. The
// variation belongs to game input, never to the BGM's scheduling position.
export function effectEvents(track, step, kind, variation = 0) {
  const chord = chordForStep(track, step);
  const beat = 60 / track.bpm;
  const note = (degree, duration, gain, delay = 0, octave = 12) => ({
    midi: chord[degree] + octave,
    duration,
    gain,
    type: "sine",
    delay,
    attack: 0.035,
  });
  if (kind === "blocked") return [note(0, 0.22, 0.018, 0, 0)];
  if (kind === "hint")
    return [note(1, 0.45, 0.02), note(2, 0.55, 0.016, beat / 8)];
  if (kind === "complete")
    return [0, 1, 2, 3].map((degree, index) =>
      note(degree, 1.3, 0.014, (index * beat) / 8),
    );
  const degree = track.melody[step % track.meter] ?? 1;
  return [note((degree + variation) % chord.length, 0.4, 0.022)];
}

export function musicEvents(track, step) {
  const beat = 60 / track.bpm;
  const position = step % track.meter;
  const chord = chordForStep(track, step);
  const degree = track.melody[position];
  const notes = [];
  const add = (midi, duration, gain, type = "sine", delay = 0, attack = 0.05) =>
    notes.push({ midi, duration, gain, type, delay, attack });

  if (track.id === "river") {
    // Flowing harp-like eighth-note replies over a soft low foundation.
    add(chord[degree] + 12, beat * 2.8, 0.026);
    if (position % 2 === 0)
      add(
        chord[track.melody[(position + 1) % 8]] + 12,
        beat * 2,
        0.012,
        "sine",
        beat / 2,
      );
    if (position === 0) add(chord[0], beat * 7, 0.018, "sine", 0, 0.3);
  } else if (track.id === "grove") {
    // Warm triangle lead with generous rests and slowly opening chord tones.
    if (degree !== null)
      add(chord[degree] + 12, beat * 2.5, 0.018, "triangle", 0, 0.18);
    if (position === 0)
      for (const midi of chord) add(midi, beat * 7.5, 0.007, "sine", 0, 0.75);
  } else if (track.id === "lantern") {
    // Quiet bell pairs; the upper partial decays before the fundamental.
    if (degree !== null) {
      add(chord[degree] + 12, beat * 3.6, 0.023, "sine", 0, 0.04);
      add(chord[degree] + 24.02, beat * 1.1, 0.0015, "sine", 0, 0.04);
    }
    if (position % 4 === 0)
      add(chord[0], beat * 3.8, 0.017, "triangle", 0, 0.15);
  } else if (track.id === "clouds") {
    // A six-beat rocking phrase with bass on one and soft answers on two/three.
    add(chord[degree] + 12, beat * 2.3, 0.02, "sine", 0, 0.1);
    if (position % 3 === 0)
      add(chord[0], beat * 2.8, 0.018, "triangle", 0, 0.18);
    else add(chord[position % 2 ? 1 : 2], beat * 1.7, 0.01, "sine", beat / 4);
  } else {
    // Sparse, long notes float above an open fifth instead of a running arpeggio.
    if (degree !== null) {
      add(chord[degree] + 12, beat * 4.3, 0.018, "sine", 0, 0.32);
      add(chord[degree], beat * 3.5, 0.006, "triangle", beat / 3, 0.4);
    }
    if (position === 0) {
      add(chord[0], beat * 7.8, 0.013, "sine", 0, 0.8);
      add(chord[1], beat * 7, 0.008, "sine", beat / 2, 0.9);
    }
  }
  return notes;
}
