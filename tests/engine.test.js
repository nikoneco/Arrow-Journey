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

test('metrics distinguish paths winding through one another from rectangular tiles', () => {
  const board = boardOf([
    arrow('a', [[0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [2, 2], [1, 2]]),
    arrow('b', [[2, 1], [1, 1], [0, 1], [0, 2], [0, 3], [1, 3], [2, 3]]),
  ], 4, 4);
  const { solvable, metrics } = solveBoard(board);
  assert.equal(solvable, true);
  assert.equal(metrics.nonRectangularRatio, 1);
  assert.equal(metrics.boundingBoxOverlapPairs, 1);
  assert.equal(metrics.boundingBoxInterpenetrationPairs, 1);
  assert.equal(metrics.boundingBoxInterpenetrationRatio, 1);
  assert.equal(metrics.averageNeighborDiversity, 1);
  assert.equal(metrics.dependencyDepth, 2);
});

test('legacy saved cell paths retain their geometry and remain playable after a generator update', () => {
  const legacy = { ...boardOf([arrow('a', [[0, 0], [1, 0]]), arrow('b', [[3, 0], [4, 0]])]),
    difficulty: 'easy', seed: 'legacy', rulesVersion: '1.0.0', generatorVersion: '1.0.0', difficultyProfileVersion: '1.0.0' };
  const snapshot = JSON.stringify(legacy);
  assert.deepEqual(validateBoard(legacy), { valid: true, errors: [] });
  assert.equal(solveBoard(legacy).solvable, true);
  assert.deepEqual(getRemovable(legacy, ['a', 'b']), ['b']);
  assert.equal(canRemove(legacy, ['a'], 'a').allowed, true);
  assert.equal(JSON.stringify(legacy), snapshot);
  assert.equal(RULES_VERSION, legacy.rulesVersion);
  assert.notEqual(GENERATOR_VERSION, legacy.generatorVersion);
});

test('v2 saved geometry and fingerprint remain valid without regeneration', () => {
  // Literal cell routes from generator 2.0.0, easy / legacy-v2, encoded as y * 20 + x.
  const paths = [[131,130,150,170,169,168,188,189],[119,99,79,59,58,38,39],[201,200],[234,214],[186,187,167,147,146,145,125,105,106,126,127,128,148,149,129,109,110,90],[55,35,34,14,15,16,17,18,19],[180,181,182,183,163,162,161],[86,85,84],[45,46,47,48,49,50,51],[222,202],[255,235,215,216,236,237,257,277,278,279],[243,244,245,246,247,248,249,269,268],[121,101,102,103,83],[256,276,275,274,254,253,233],[96,95,75,76],[221,220,240,260,280,281,261,241,242,262,282,302,301,300,320,321,322,323,324,344,345,346,366,365,364,363,343,342,341,340],[104,124,144,143,123,122,142,141],[139,138,118,98],[387,386,385],[303,283,263,264,284,285,265,266,267,287,286,306,307,308,309,329,349,350,351,371,370,369,368,388],[232,231],[211,212,213,193,194],[160,140,120,100,80,60,40,20,0,1,2,3,4],[166,165,164],[238,239,219,218],[259,258],[22,23,24,25,26,27,28,29,30],[399,379,359],[13,33,53,73,74,54],[298,299,319,318,317,337,338,339],[228,229,230,210,190,191,192,172,171,151,152,132],[174,175],[227,226,225,224,204,203,223],[252,272,273,293,292,291,271,251,250,270,290,289,288],[195,196,176,177,178,158,159,179,199,198,197,217],[384,383,382,362,361,381,380,360],[56,36,37,57,77,78],[5,6,7,8,9,10,11,31,32,12],[315,335,336,316,296,297],[295,294,314,313,312,311,310,330,331,332,352,353,333,334,354,355,356,376],[367,347,348,328,327,326,325,305,304],[173,153,133,113,93,94,114,115,135,134,154,155,156,157,137,136,116,117,97],[375,374,373,372],[209,208,207,206,205,185,184],[393,394,395,396,397,377,357,358,378,398],[82,81,61,62,63,64,65,66,67,68,69,70,71,91,111,112,92,72,52],[89,88,108,107,87],[392,391,390,389],[44,43,42,41,21]];
  const saved = { width: 20, height: 20, rulesVersion: '1.0.0', generatorVersion: '2.0.0', difficultyProfileVersion: '2.0.0',
    fingerprint: 'aj1-cefaf2d525077d9f3efd55c5d500da8f',
    arrows: paths.map((path, index) => ({ id: 'a' + index.toString(36), cells: path.map((cell) => [cell % 20, Math.floor(cell / 20)]) })) };
  const exactSave = JSON.stringify(saved);
  assert.deepEqual(validateBoard(saved), { valid: true, errors: [] });
  assert.equal(solveBoard(saved).solvable, true);
  assert.equal(boardFingerprint(saved), saved.fingerprint);
  assert.equal(JSON.stringify(saved), exactSave);
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

test('every difficulty shares all sizes and size selection depends only on the seed', () => {
  const sizes = new Set();
  for (const profile of Object.values(DIFFICULTIES)) {
    assert.deepEqual(profile.sizes, [20, 24, 28, 32]);
    assert.ok(Object.isFrozen(profile)); assert.ok(Object.isFrozen(profile.sizes));
  }
  for (let seed = 0; seed < 24; seed += 1) {
    const boards = Object.keys(DIFFICULTIES).map((difficulty) => generateBoard(difficulty, 'size-selection-' + seed));
    const size = boards[0].width;
    sizes.add(size);
    for (const board of boards) {
      assert.equal(board.width, size); assert.equal(board.height, size);
      assert.deepEqual(board, generateBoard(board.difficulty, board.seed, { size }));
    }
  }
  assert.deepEqual([...sizes].sort((a, b) => a - b), [20, 24, 28, 32]);
  for (const size of [0, 19, 21, 64, '20', null, NaN, Infinity]) assert.throws(() => generateBoard('easy', 'invalid', { size }), RangeError);
  for (const options of [null, [], 20]) assert.throws(() => generateBoard('easy', 'invalid', options), TypeError);
});

test('100 seeds at each size and difficulty fill the grid, independently solve and separate choice pressure', (context) => {
  const allFingerprints = new Set();
  for (const size of [20, 24, 28, 32]) {
    const summaries = [];
    for (const [difficulty, profile] of Object.entries(DIFFICULTIES)) {
      const started = performance.now();
      let maximumMs = 0, maximumAttempts = 0;
      const totals = { arrowCount: 0, initialRemovable: 0, initialRemovableRatio: 0, dependencyDepth: 0, dependencyDepthRatio: 0,
        dependencyEdges: 0, meanChoices: 0, nonRectangularRatio: 0, boundingBoxInterpenetrationRatio: 0, averageNeighborDiversity: 0 };
      const quarters = [0, 0, 0, 0, 0];
      for (let seed = 0; seed < 100; seed += 1) {
        const point = performance.now();
        const board = generateBoard(difficulty, 'acceptance-' + seed, { size });
        maximumMs = Math.max(maximumMs, performance.now() - point);
        maximumAttempts = Math.max(maximumAttempts, board.generationMetrics.boardAttempts);
        assert.deepEqual(validateBoard(board), { valid: true, errors: [] });
        assert.equal(board.width, size); assert.equal(board.height, size);
        assert.equal(board.rulesVersion, RULES_VERSION); assert.equal(board.generatorVersion, GENERATOR_VERSION);
        assert.equal(board.difficultyProfileVersion, DIFFICULTY_PROFILE_VERSION);
        assert.equal(board.fingerprint, boardFingerprint(board));
        assert.equal(allFingerprints.has(board.fingerprint), false); allFingerprints.add(board.fingerprint);
        assert.ok(board.generationMetrics.boardAttempts <= 16);
        const area = size * size;
        assert.ok(board.generationMetrics.backbiteMoves <= 16 * area * profile.mixPasses);
        assert.ok(board.generationMetrics.cutCandidates <= 16 * (area / 2) * 2 * (board.width + board.height) * 29);
        const occupied = new Set(board.arrows.flatMap((item) => item.cells.map(([x, y]) => x + ',' + y)));
        assert.equal(occupied.size, area);
        assert.equal(board.arrows.reduce((sum, item) => sum + item.cells.length, 0), area);
        const result = solveBoard(board), metrics = result.metrics;
        assert.equal(result.solvable, true); assert.equal(metrics.dagSolvable, true); assert.equal(metrics.greedySolvable, true);
        assert.equal(metrics.density, 1); assert.equal(metrics.minLength, 2); assert.equal(metrics.maxLength, 30);
        assert.ok(metrics.totalBends > 0);
        assert.ok(metrics.initialRemovable >= profile.minInitial && metrics.initialRemovable <= profile.maxInitial);
        assert.ok(metrics.dependencyDepth >= Math.ceil(profile.minDepthRatio * metrics.arrowCount));
        assert.ok(metrics.nonRectangularRatio >= profile.minNonRectangularRatio);
        assert.ok(metrics.boundingBoxInterpenetrationRatio >= profile.minInterpenetrationRatio);
        assert.ok(metrics.averageNeighborDiversity >= 4);
        assert.equal(result.order.length, board.arrows.length);
        const remaining = board.arrows.map((item) => item.id);
        for (const id of result.order) {
          assert.deepEqual(independentBlockers(board, remaining, id), []);
          remaining.splice(remaining.indexOf(id), 1);
        }
        assert.equal(remaining.length, 0);
        // A different legal branch is checked independently of the engine graph/order.
        const alternative = board.arrows.map((item) => item.id);
        while (alternative.length) {
          const legal = alternative.filter((id) => independentBlockers(board, alternative, id).length === 0);
          assert.ok(legal.length);
          const chosen = legal[(seed + alternative.length) % legal.length];
          alternative.splice(alternative.indexOf(chosen), 1);
        }
        // Exact geometry/work counters reproduce, including after rejected attempts.
        if (seed === 0 || board.generationMetrics.boardAttempts >= 4) {
          assert.deepEqual(board, generateBoard(difficulty, 'acceptance-' + seed, { size }));
        }
        for (let quarter = 0; quarter < quarters.length; quarter += 1) {
          quarters[quarter] += metrics.choicesOverTime[Math.min(metrics.arrowCount - 1, Math.floor((metrics.arrowCount - 1) * quarter / 4))];
        }
        for (const key of Object.keys(totals)) totals[key] += metrics[key];
      }
      const summary = { size, difficulty, boards: 100, totalMs: performance.now() - started, maximumGenerationMs: maximumMs,
        maximumAttempts, averages: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 100])),
        choicesAtQuarters: quarters.map((value) => value / 100) };
      summaries.push(summary);
      context.diagnostic(JSON.stringify(summary));
    }
    // Compare absolute choices and relative depth at the SAME size, never across board areas.
    for (let i = 1; i < summaries.length; i += 1) {
      const previous = summaries[i - 1].averages, current = summaries[i].averages;
      assert.ok(current.initialRemovable < previous.initialRemovable - 1.5);
      assert.ok(current.meanChoices < previous.meanChoices - 0.4);
      assert.ok(current.dependencyDepthRatio > previous.dependencyDepthRatio + 0.06);
      assert.ok(current.dependencyDepth > previous.dependencyDepth + 2);
    }
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
