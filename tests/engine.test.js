import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  DIFFICULTIES, GENERATOR_VERSION, RULES_VERSION, DIFFICULTY_PROFILE_VERSION,
  generateBoard, validateBoard, canRemove, getRemovable, solveBoard, boardFingerprint, sampleArrow,
} from '../js/engine.js';

const boardOf = (arrows, width = 6, height = 6) => ({ width, height, arrows });
const arrow = (id, cells) => ({ id, cells });

// Deliberately independent of engine indexing, direction helpers and solver code.
function independentBlockers(board, remaining, targetId) {
  const target = board.arrows.find((item) => item.id === targetId);
  const head = target.cells.at(-1), previous = target.cells.at(-2);
  const dx = head[0] - previous[0], dy = head[1] - previous[1];
  return board.arrows.filter((item) => remaining.includes(item.id) && item.cells.some(([x, y]) => (
    dx ? y === head[1] && (x - head[0]) * dx > 0 : x === head[0] && (y - head[1]) * dy > 0
  ))).map((item) => item.id);
}

test('head rays include immediate, distant and last in-bounds blockers', () => {
  for (const x of [2, 4, 5]) {
    const board = boardOf([arrow('a', [[0, 1], [1, 1]]), arrow('b', [[x, 1], [x, 2]])]);
    assert.equal(validateBoard(board).valid, true);
    assert.deepEqual(canRemove(board, ['a', 'b'], 'a'), { allowed: false, blockers: ['b'] });
    assert.deepEqual(canRemove(board, ['a'], 'a'), { allowed: true, blockers: [] });
  }
});

test('outside-facing heads and cells outside the head ray do not block', () => {
  const outward = boardOf([arrow('a', [[4, 2], [5, 2]])]);
  assert.equal(canRemove(outward, ['a'], 'a').allowed, true);
  const bent = boardOf([
    arrow('a', [[1, 3], [1, 2], [2, 2], [3, 2]]),
    arrow('b', [[2, 3], [3, 3]]),
  ]);
  assert.equal(canRemove(bent, ['a', 'b'], 'a').allowed, true);
  assert.equal(canRemove(bent, ['b'], 'a').allowed, false);
  assert.equal(canRemove(bent, ['a', 'unknown'], 'a').allowed, false);
  assert.deepEqual(getRemovable(bent, ['unknown']), []);
});

test('rejects malformed dimensions, IDs, bounds, nonadjacency, overlaps and direction mismatches', () => {
  const invalid = [
    null, {}, { width: 1, height: 2, arrows: [] }, { width: Infinity, height: 2, arrows: [] },
    boardOf([]), boardOf([arrow('', [[0, 0], [1, 0]])]),
    boardOf([arrow('a', [[0, 0], [1, 0]]), arrow('a', [[0, 2], [1, 2]])]),
    boardOf([arrow('a', [[0, 0], [6, 0]])]),
    boardOf([arrow('a', [[0, 0], [1.5, 0]])]),
    boardOf([arrow('a', [[0, 0], [1, 1]])]),
    boardOf([arrow('a', [[0, 0], [2, 0]])]),
    boardOf([arrow('a', [[0, 0], [1, 0], [0, 0]])]),
    boardOf([arrow('a', [[0, 0], [1, 0]]), arrow('b', [[1, 0], [1, 1]])]),
    boardOf([{ ...arrow('a', [[0, 0], [1, 0]]), direction: [0, 1] }]),
    boardOf([arrow('a', [[0, 0]])]),
    { width: 32, height: 2, arrows: [arrow('a', Array.from({ length: 31 }, (_, x) => [x, 0]))] },
  ];
  for (const board of invalid) {
    assert.equal(validateBoard(board).valid, false, JSON.stringify(board));
    assert.equal(solveBoard(board).solvable, false);
    assert.equal(canRemove(board, ['a'], 'a').allowed, false);
    assert.deepEqual(getRemovable(board, ['a']), []);
  }
});

test('rejects self interference and safely refuses to remove it', () => {
  const board = boardOf([arrow('u', [[3, 2], [3, 1], [2, 1], [1, 1], [1, 2], [2, 2]])]);
  assert.equal(validateBoard(board).valid, false);
  assert.match(validateBoard(board).errors.join(' '), /own head ray/);
  assert.equal(canRemove(board, ['u'], 'u').allowed, false);
});

test('detects cyclic dependencies through both graph and direct greedy solvers', () => {
  const board = boardOf([arrow('a', [[0, 0], [1, 0]]), arrow('b', [[3, 0], [2, 0]])], 4, 2);
  assert.match(validateBoard(board).errors.join(' '), /cycle/);
  const result = solveBoard(board);
  assert.equal(result.solvable, false);
  assert.equal(result.metrics.dagSolvable, false);
  assert.equal(result.metrics.greedySolvable, false);
  assert.deepEqual(getRemovable(board, ['a', 'b']), []);
  assert.deepEqual(canRemove(board, ['a', 'b'], 'a').blockers, ['b']);
});

test('every legal branch on a small board completes and removal is monotone', () => {
  const board = boardOf([
    arrow('a', [[0, 0], [1, 0]]), arrow('b', [[3, 0], [4, 0]]), arrow('c', [[0, 2], [1, 2]]),
  ]);
  let endings = 0;
  function visit(remaining) {
    if (!remaining.length) { endings += 1; return; }
    const choices = getRemovable(board, remaining);
    assert.ok(choices.length);
    for (const choice of choices) {
      const next = remaining.filter((id) => id !== choice);
      const nextChoices = getRemovable(board, next);
      for (const alreadyFree of choices.filter((id) => id !== choice)) assert.ok(nextChoices.includes(alreadyFree));
      visit(next);
    }
  }
  visit(['a', 'b', 'c']);
  assert.equal(endings, 3);
});

test('samples a bent arrow along Q without rigid translation or shrinking', () => {
  const source = arrow('a', [[1, 3], [1, 2], [2, 2], [3, 2]]);
  assert.deepEqual(sampleArrow(source, 0), source.cells);
  assert.deepEqual(sampleArrow(source, 0.5), [[1, 2.5], [1, 2], [2, 2], [3, 2], [3.5, 2]]);
  assert.deepEqual(sampleArrow(source, 1), [[1, 2], [2, 2], [3, 2], [4, 2]]);
  assert.deepEqual(sampleArrow(source, 3), [[3, 2], [6, 2]]);
  assert.deepEqual(sampleArrow(source, 5), [[5, 2], [8, 2]]);
  for (const distance of [0, 0.1, 0.5, 1, 1.2, 2.5, 3, 5, 12]) {
    const points = sampleArrow(source, distance);
    const length = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - points[index][0], point[1] - points[index][1]), 0);
    assert.ok(Math.abs(length - 3) < 1e-10);
    assert.deepEqual(points.at(-1), [3 + distance, 2]);
  }
  assert.throws(() => sampleArrow(source, -1), RangeError);
  assert.throws(() => sampleArrow(source, NaN), RangeError);
  assert.throws(() => sampleArrow({ cells: [[0, 0], [1, 1]] }, 0), TypeError);
});

test('fingerprints canonical geometry rather than IDs, enumeration or metadata', () => {
  const source = generateBoard('easy', 'identity');
  const variant = structuredClone(source);
  variant.arrows.reverse();
  variant.arrows.forEach((item, index) => { item.id = `renamed-${index}`; });
  variant.difficulty = 'expert'; variant.seed = 'different'; variant.generatorVersion = 'future';
  assert.equal(boardFingerprint(source), boardFingerprint(variant));
  const mirrored = structuredClone(source);
  mirrored.arrows.forEach((item) => { item.cells = item.cells.map(([x, y]) => [source.width - x - 1, y]); });
  assert.notEqual(boardFingerprint(source), boardFingerprint(mirrored));
  assert.match(boardFingerprint(source), /^aj1-[0-9a-f]{32}$/);
});

test('same seed reproduces exact geometry and functions preserve inputs', () => {
  const first = generateBoard('hard', '再現テスト🌙');
  const snapshot = JSON.stringify(first);
  assert.deepEqual(first, generateBoard('hard', '再現テスト🌙'));
  const remaining = first.arrows.map((item) => item.id);
  validateBoard(first); solveBoard(first); boardFingerprint(first); getRemovable(first, remaining);
  canRemove(first, remaining, remaining[0]); sampleArrow(first.arrows[0], 2.3);
  assert.equal(JSON.stringify(first), snapshot);
  assert.equal(remaining.length, first.arrows.length);
  assert.throws(() => generateBoard('__proto__', 'seed'), RangeError);
  assert.throws(() => generateBoard('easy', {}), TypeError);
  assert.throws(() => generateBoard('easy', 'x'.repeat(1025)), RangeError);
});

test('100 seeded boards per difficulty fill the grid, stay bounded and independently solve', (context) => {
  const summaries = [];
  const allFingerprints = new Set();
  for (const [difficulty, profile] of Object.entries(DIFFICULTIES)) {
    const started = performance.now();
    let maximumMs = 0;
    const totals = { arrows: 0, averageLength: 0, averageBends: 0, initialRemovableRatio: 0, dependencyDepth: 0 };
    for (let seed = 0; seed < 100; seed += 1) {
      const point = performance.now();
      const board = generateBoard(difficulty, `acceptance-${seed}`);
      maximumMs = Math.max(maximumMs, performance.now() - point);
      assert.deepEqual(validateBoard(board), { valid: true, errors: [] });
      assert.equal(board.width, profile.width); assert.equal(board.height, profile.height);
      assert.equal(board.rulesVersion, RULES_VERSION); assert.equal(board.generatorVersion, GENERATOR_VERSION);
      assert.equal(board.difficultyProfileVersion, DIFFICULTY_PROFILE_VERSION);
      assert.equal(board.fingerprint, boardFingerprint(board));
      assert.equal(allFingerprints.has(board.fingerprint), false); allFingerprints.add(board.fingerprint);
      assert.ok(board.generationMetrics.boardAttempts <= 4);
      assert.ok(board.generationMetrics.tiles <= 4 * board.width * board.height / 2);
      const result = solveBoard(board), metrics = result.metrics;
      assert.equal(result.solvable, true); assert.equal(metrics.dagSolvable, true); assert.equal(metrics.greedySolvable, true);
      assert.equal(metrics.density, 1); assert.equal(metrics.minLength, 2); assert.equal(metrics.maxLength, 30);
      assert.ok(metrics.totalBends > 0);
      assert.equal(result.order.length, board.arrows.length);
      const remaining = board.arrows.map((item) => item.id);
      for (const id of result.order) {
        assert.deepEqual(independentBlockers(board, remaining, id), []);
        remaining.splice(remaining.indexOf(id), 1);
      }
      assert.equal(remaining.length, 0);
      // A second, different legal removal order cannot create a new blockage.
      const alternative = board.arrows.map((item) => item.id);
      while (alternative.length) {
        const legal = alternative.filter((id) => independentBlockers(board, alternative, id).length === 0);
        assert.ok(legal.length);
        const chosen = legal[(seed + alternative.length) % legal.length];
        alternative.splice(alternative.indexOf(chosen), 1);
      }
      totals.arrows += metrics.arrowCount; totals.averageLength += metrics.averageLength; totals.averageBends += metrics.averageBends;
      totals.initialRemovableRatio += metrics.initialRemovableRatio; totals.dependencyDepth += metrics.dependencyDepth;
    }
    const summary = { difficulty, boards: 100, totalMs: performance.now() - started, maximumGenerationMs: maximumMs,
      averages: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 100])) };
    summaries.push(summary);
    context.diagnostic(JSON.stringify(summary));
  }
  for (let i = 1; i < summaries.length; i += 1) {
    assert.ok(summaries[i].averages.averageLength > summaries[i - 1].averages.averageLength + 2);
    assert.ok(summaries[i].averages.averageBends > summaries[i - 1].averages.averageBends + 0.5);
  }
});

test('worker returns a board or an error with the original request ID', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'self');
  let listener;
  const messages = [];
  globalThis.self = { addEventListener: (type, callback) => { assert.equal(type, 'message'); listener = callback; }, postMessage: (data) => messages.push(data) };
  try {
    await import('../js/generator-worker.js');
    listener({ data: { requestId: 'valid-request', difficulty: 'normal', seed: 'worker-seed' } });
    assert.equal(messages[0].requestId, 'valid-request');
    assert.deepEqual(messages[0].board, generateBoard('normal', 'worker-seed'));
    listener({ data: { requestId: 'invalid-request', difficulty: 'unsupported', seed: 'worker-seed' } });
    assert.equal(messages[1].requestId, 'invalid-request');
    assert.match(messages[1].error, /Unknown difficulty/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'self', descriptor);
    else delete globalThis.self;
  }
});
