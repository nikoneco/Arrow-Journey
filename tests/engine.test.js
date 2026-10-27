import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import {
  DIFFICULTIES, BOARD_SHAPES, GENERATOR_VERSION, RULES_VERSION, DIFFICULTY_PROFILE_VERSION,
  generateBoard, validateBoard, canRemove, getRemovable, solveBoard, boardFingerprint, sampleArrow,
} from '../js/engine.js';

const boardOf = (arrows, width = 6, height = 6) => ({ width, height, arrows });
const arrow = (id, cells) => ({ id, cells });
const supportedSizes = [20, 24, 28, 32, 36, 40];

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

test('mask validation rejects malformed, duplicate, out-of-bounds, void and uncovered cells', () => {
  const source = boardOf([arrow('a', [[0, 0], [1, 0]])]);
  const mask = [[0, 0], [1, 0]];
  assert.equal(validateBoard({ ...source, mask }).valid, true);
  assert.equal(solveBoard({ ...source, mask }).metrics.density, 1);
  assert.equal(solveBoard({ ...source, mask }).metrics.boundingBoxDensity, 2 / 36);
  for (const badMask of [undefined, null, [], [[0, 0]], 'mask', [[0, 0], [0, 0]],
    [[0, 0], [6, 0]], [[0, 0], [1.5, 0]], [[0, 0], [1]], [[0, 0], [1, 1]], [...mask, [2, 0]]]) {
    const board = { ...source, mask: badMask };
    assert.equal(validateBoard(board).valid, false, JSON.stringify(badMask));
    assert.equal(solveBoard(board).solvable, false);
    assert.equal(canRemove(board, ['a'], 'a').allowed, false);
    assert.deepEqual(getRemovable(board, ['a']), []);
    assert.throws(() => boardFingerprint(board), TypeError);
  }
  // A legacy sparse rectangle without a mask is still valid, with its old density.
  assert.equal(validateBoard(source).valid, true);
  assert.equal(solveBoard(source).metrics.density, 2 / 36);
});

test('head rays cross void cells and still see another lobe of a masked board', () => {
  const board = boardOf([
    arrow('a', [[0, 0], [1, 0]]), arrow('b', [[4, 0], [5, 0]]),
    arrow('c', [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]),
  ]);
  board.mask = board.arrows.flatMap((item) => item.cells.map((point) => point.slice()));
  assert.equal(validateBoard(board).valid, true);
  assert.deepEqual(canRemove(board, ['a', 'b', 'c'], 'a'), { allowed: false, blockers: ['b'] });
  assert.deepEqual(canRemove(board, ['a', 'c'], 'a'), { allowed: true, blockers: [] });
  assert.deepEqual(getRemovable(board, ['a', 'b', 'c']), ['b', 'c']);
  assert.equal(solveBoard(board).solvable, true);
});

test('rays cross a genuinely enclosed hole in all four directions', () => {
  const source = boardOf([], 6, 6);
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 2) {
      if (x === 2 && (y === 2 || y === 3)) continue;
      source.arrows.push(arrow(`${x},${y}`, [[x, y], [x + 1, y]]));
    }
  }
  source.mask = source.arrows.flatMap((item) => item.cells);
  for (let turns = 0; turns < 4; turns += 1) {
    const rotate = ([x, y]) => {
      for (let turn = 0; turn < turns; turn += 1) [x, y] = [5 - y, x];
      return [x, y];
    };
    const board = { ...source, mask: source.mask.map(rotate),
      arrows: source.arrows.map((item) => ({ ...item, cells: item.cells.map(rotate) })) };
    const ids = board.arrows.map((item) => item.id);
    assert.equal(validateBoard(board).valid, true);
    assert.deepEqual(independentBlockers(board, ids, '0,2'), ['4,2']);
    assert.deepEqual(canRemove(board, ids, '0,2'), { allowed: false, blockers: ['4,2'] });
    assert.equal(getRemovable(board, ids).includes('0,2'), false);
    assert.deepEqual(canRemove(board, ids.filter((id) => id !== '4,2'), '0,2'), { allowed: true, blockers: [] });
    const solution = solveBoard(board);
    assert.equal(solution.solvable, true);
    assert.ok(solution.order.indexOf('4,2') < solution.order.indexOf('0,2'));
  }
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
  variant.shape = 'metadata'; variant.mask.reverse();
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

test('greedy metrics observe a known three-arrow unlock burst and retain FIFO metrics', () => {
  const board = boardOf([
    arrow('hub', Array.from({ length: 6 }, (_, y) => [5, y])),
    ...[0, 2, 4].map((y) => arrow('child-' + y, [[0, y], [1, y]])),
  ]);
  const { metrics } = solveBoard(board);
  assert.equal(metrics.greedyPolicy, 'max-immediate-unlocks-longest-first');
  assert.deepEqual(metrics.greedyRemovalOrder, ['hub', 'child-0', 'child-2', 'child-4']);
  assert.deepEqual(metrics.greedyChoicesOverTime, [1, 3, 2, 1]);
  assert.deepEqual(metrics.greedyUnlocksOverTime, [3, 0, 0, 0]);
  assert.equal(metrics.greedyMeanChoices, 1.75);
  assert.equal(metrics.greedyMaxUnlocks, 3);
  assert.equal(metrics.greedyLargeChoiceRatio, 0);
  assert.equal(metrics.greedyEarlyMeanChoices, 1.75);
  assert.equal(metrics.greedyFinalQuarterMeanChoices, 1);
  assert.equal(metrics.greedyTerminalFreeRatio, 0.75);
  assert.deepEqual(metrics.choicesOverTime, [1, 3, 2, 1]);
  assert.equal(metrics.meanChoices, 1.75);
});

test('greedy ties prefer longer arrows and its complete order is independently legal', () => {
  const board = boardOf([
    arrow('short', [[6, 4], [7, 4]]),
    arrow('long', [[3, 1], [3, 0], [4, 0], [5, 0], [5, 1], [6, 1], [6, 0]]),
    arrow('upper', [[0, 1], [1, 1]]), arrow('lower', [[0, 4], [1, 4]]),
  ], 8, 6);
  const { metrics } = solveBoard(board);
  assert.equal(metrics.greedyRemovalOrder[0], 'long');
  assert.deepEqual(metrics.greedyUnlocksOverTime, [1, 1, 0, 0]);
  const remaining = board.arrows.map((item) => item.id);
  for (const id of metrics.greedyRemovalOrder) {
    assert.deepEqual(independentBlockers(board, remaining, id), []);
    remaining.splice(remaining.indexOf(id), 1);
  }
  assert.equal(remaining.length, 0);
});

test('literal v4.1 saved mask and paths keep their original fingerprint without regeneration', async () => {
  const saved = JSON.parse(await readFile(new URL('./engine-v4.1.fixture.json', import.meta.url), 'utf8'));
  const exactSave = JSON.stringify(saved);
  assert.equal(saved.generatorVersion, '4.1.0');
  assert.equal(saved.fingerprint, 'aj1-f14fa2f2794ce7adccb3733144b0366e');
  assert.deepEqual(validateBoard(saved), { valid: true, errors: [] });
  const solution = solveBoard(saved);
  assert.equal(solution.solvable, true);
  assert.equal(boardFingerprint(saved), saved.fingerprint);
  const remaining = saved.arrows.map((item) => item.id);
  for (const id of solution.order) {
    assert.deepEqual(independentBlockers(saved, remaining, id), []);
    remaining.splice(remaining.indexOf(id), 1);
  }
  assert.equal(remaining.length, 0);
  assert.equal(JSON.stringify(saved), exactSave);
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

test('v3 saved square geometry remains playable with its original fingerprint and no mask', () => {
  // Literal generator 3.0.0 expert / legacy-v3 / size 20 routes from base 90ac76f.
  const paths = [[257,277,278,279,299,319,339,338,337,357,377,378,358,359,379,399,398,397],[58,57,56],[396,395,394,374,354,334,333,353,352,332,312,311,331,351,350,370,371,372,373,393,392,391,390,389],[50,51,52,53,73,93,92,72,71,70,90,91,111,112,113,114,115,95,94,74,75,55,54,34],[33,32,31,30,29,28],[308,309],[38,37,17,16,15,14,13,12,11,10,9,8,7,27,26,6,5,4,3,23,24,25,45,44,43,42,41,21,22,2],[122,142,162,182,202,201,181,180,200,220,221,241,240,260,280,281,261,262,282,283,263,264,265,245,244,243,242,222,223,203],[152,172,192,191,171,170,190,210,230,250,270,271,291,290,289,288],[48,68],[258,259],[303,304],[61,60,40,20,0,1],[18,19,39,59],[49,69],[217,197,177,176,156,157,137,136,135,134,133,153,173,174,154,155,175],[347,346,366,365,345,344,324,325,305,306,326,327,307,287,286,285,284],[97,77,76,96,116,117,118,138,158,178,198,218,238,237],[229,249,269,268,248,228,227,247,267,266,246,226,225,224,204],[121,141,161,160,140,120,100,80,81,101,102,82,62],[215,235,236,256,255,254,253,273,274,275,276,296,297,298,318,317,316,336,356,376,375,355,335,315,295,294,314,313,293,292],[110,109,89,88,108,128,129,149,148,147,127,107,87,67,47,46,66,65,85,86,106,105,104,84,64],[388,387,386,385,384,364,363,383,382,362,361,381,380,360,340,320,300,301,321,341,342,343,323,322,302],[367,368,369,349,348,328,329,330,310],[36,35],[213,212,211],[130,150,151,131,132],[209,189,169,168,188,208,207,206,205,185,186,187,167,166,146,126,125,124,144,145,165,164,184,183,163,143,123,103,83,63],[272,252,251,231,232,233,234,214,194,193],[239,219,199,179,159,139,119,99,79,78,98],[216,196,195]];
  const saved = { width: 20, height: 20, rulesVersion: '1.0.0', generatorVersion: '3.0.0', difficultyProfileVersion: '3.0.0',
    fingerprint: 'aj1-324d2307c22fe611ca7419573a16dc41',
    arrows: paths.map((path, index) => ({ id: 'a' + index.toString(36), cells: path.map((cell) => [cell % 20, Math.floor(cell / 20)]) })) };
  const exactSave = JSON.stringify(saved);
  assert.deepEqual(validateBoard(saved), { valid: true, errors: [] });
  assert.equal(solveBoard(saved).solvable, true);
  assert.equal(boardFingerprint(saved), saved.fingerprint);
  assert.equal(solveBoard(saved).metrics.density, 1);
  assert.equal(JSON.stringify(saved), exactSave);
});

test('v4 saved masked geometry keeps its original paths, mask and fingerprint without regeneration', () => {
  // Literal generator 4.0.0 normal / legacy-v4 / circle / size 20 routes from base 6c7153d.
  const paths = [[44,43,42,62,63,83,82,102,103,104,124,123,122,142,141,121,120,140,160,180,200,220,240,260,261,262,282,302,322,342],[195,196,176,177,197,217,216,236,237,257,258,238,218,198,178,158,157,156,155,154],[131,130,150,151,171,170,169,149,148],[293,313,333,334],[153,152,172,173,193,192,191,211,231,230,210,190,189,209,229,249,248,247,227,228,208,188,168,167,166,165,164,144,143],[187,207,206,205,225,226],[132,133,134,135,115,114,113,112,111,91,71,70,50,51,52,53,54,55,75,74,73,72,92,93,94,95,96,76,56],[185,186],[90,89,69,49,48,47,27,28,29,30,31,32,33],[184,204,224,244,243,242,241,221,201,181,161,162,182,202,222,223,203,183,163],[110,109,129,128],[255,256,276,275,295,296,297,277,278,279],[308,328,327,307,287,267,266,286,306,326,346,347,348,368,367,366],[57,77,97,117,116,136,137,138,139,159,179,199,219,239,259],[354,353,373,393,392,391,371,372,352,332,331],[125,126,106,105,85,84,64],[246,245,265,285,305,304,284,264,263,283,303,323,324,325,345,344,343],[9,8,7,6,26,46,66,86,87,67,68,88,108,107,127,147,146,145],[175,174,194,214,215,235,234,233,213,212,232,252,253,273,272,292,312],[351,350,330,329,349,369,370,390,389,388,387,386],[288,268,269,289,309,310,290,270,250,251,271,291,311],[65,45],[13,12,11,10],[336,335,355,356,357,337,317,316,315,314,294,274,254]];
  const point = (cell) => [cell % 20, Math.floor(cell / 20)];
  const saved = { width: 20, height: 20, shape: 'circle', difficulty: 'normal', seed: 'legacy-v4',
    rulesVersion: '1.0.0', generatorVersion: '4.0.0', difficultyProfileVersion: '3.0.0',
    fingerprint: 'aj1-6b452e4e59d63335e1406476d3d3790d',
    mask: paths.flat().sort((a, b) => a - b).map(point),
    arrows: paths.map((path, index) => ({ id: 'a' + index.toString(36), cells: path.map(point) })) };
  const exactSave = JSON.stringify(saved);
  assert.deepEqual(validateBoard(saved), { valid: true, errors: [] });
  assert.equal(solveBoard(saved).solvable, true);
  assert.equal(boardFingerprint(saved), saved.fingerprint);
  const remaining = saved.arrows.map((item) => item.id);
  for (const id of solveBoard(saved).order) {
    assert.equal(canRemove(saved, remaining, id).allowed, true);
    remaining.splice(remaining.indexOf(id), 1);
  }
  assert.equal(JSON.stringify(saved), exactSave);
});

test('every difficulty shares all sizes and size selection depends only on the seed', () => {
  const sizes = new Set();
  assert.deepEqual(BOARD_SHAPES.map((shape) => shape.id), ['square', 'circle', 'diamond', 'cross', 'heart', 'ring']);
  assert.equal(BOARD_SHAPES.find((shape) => shape.id === 'ring').label, 'ドーナツ');
  assert.ok(Object.isFrozen(BOARD_SHAPES));
  for (const shape of BOARD_SHAPES) { assert.ok(Object.isFrozen(shape)); assert.equal(typeof shape.label, 'string'); }
  for (const profile of Object.values(DIFFICULTIES)) {
    assert.deepEqual(profile.sizes, [28, 32, 36, 40]);
    assert.ok(Object.isFrozen(profile)); assert.ok(Object.isFrozen(profile.sizes));
  }
  for (let seed = 0; seed < 24; seed += 1) {
    const boards = Object.keys(DIFFICULTIES).map((difficulty) => generateBoard(difficulty, 'size-selection-' + seed));
    const size = boards[0].width;
    const shape = boards[0].shape;
    sizes.add(size);
    for (const board of boards) {
      assert.equal(board.width, size); assert.equal(board.height, size);
      assert.equal(board.shape, shape);
      assert.deepEqual(board, generateBoard(board.difficulty, board.seed, { size, shape }));
      assert.deepEqual(board, generateBoard(board.difficulty, board.seed, { shape }));
      assert.deepEqual(board, generateBoard(board.difficulty, board.seed, { size }));
    }
    for (const otherSize of supportedSizes) assert.equal(generateBoard('easy', boards[0].seed, { size: otherSize }).shape, shape);
    for (const otherShape of BOARD_SHAPES) assert.equal(generateBoard('easy', boards[0].seed, { shape: otherShape.id }).width, size);
  }
  assert.deepEqual([...sizes].sort((a, b) => a - b), [28, 32, 36, 40]);
  for (const size of [0, 19, 21, 64, '20', null, NaN, Infinity]) assert.throws(() => generateBoard('easy', 'invalid', { size }), RangeError);
  for (const options of [null, [], 20]) assert.throws(() => generateBoard('easy', 'invalid', options), TypeError);
  for (const shape of ['annulus', '__proto__', {}, 1, null]) assert.throws(() => generateBoard('easy', 'invalid', { shape }), RangeError);
});

test('default shape selection favors squares while occasionally retaining every other silhouette', () => {
  const counts = new Map(BOARD_SHAPES.map((shape) => [shape.id, 0]));
  for (let seed = 0; seed < 512; seed += 1) {
    const board = generateBoard('easy', 'shape-distribution-' + seed);
    counts.set(board.shape, counts.get(board.shape) + 1);
  }
  const squareRatio = counts.get('square') / 512;
  assert.ok(squareRatio >= 0.75 && squareRatio <= 0.85, JSON.stringify([...counts]));
  for (const { id } of BOARD_SHAPES.filter((shape) => shape.id !== 'square')) {
    assert.ok(counts.get(id) >= 5 && counts.get(id) < 51, JSON.stringify([...counts]));
  }
});

test('weighted default Expert generation stays bounded across 512 seeds and prior failing large squares', (context) => {
  let maximumAttempts = 0, maximumMs = 0;
  const seeds = [...Array.from({ length: 512 }, (_, index) => 'weighted-expert-' + index),
    'balance-random-0', 'balance-random-85', 'balance-random-144'];
  for (const seed of seeds) {
    const started = performance.now();
    const board = generateBoard('expert', seed);
    maximumMs = Math.max(maximumMs, performance.now() - started);
    maximumAttempts = Math.max(maximumAttempts, board.generationMetrics.boardAttempts);
    assert.ok(board.generationMetrics.boardAttempts <= 32, seed);
    assert.deepEqual(validateBoard(board), { valid: true, errors: [] });
    const solution = solveBoard(board);
    assert.equal(solution.solvable, true);
    assert.ok(solution.metrics.greedyMaxUnlocks <= 4, seed);
    if (seed.startsWith('balance-random-')) assert.deepEqual(board, generateBoard('expert', seed));
  }
  context.diagnostic(JSON.stringify({ weightedExpertBoards: seeds.length, maximumAttempts, maximumMs }));
});

test('additional bounded attempts retain Expert quality and exactly reproduce a previously exhausted square', () => {
  const board = generateBoard('expert', 'size-selection-11');
  assert.equal(board.width, 40); assert.equal(board.shape, 'square');
  assert.equal(board.generationMetrics.boardAttempts, 20);
  assert.equal(board.fingerprint, 'aj1-7491407d2a981fae56fab5ec08f3ea3f');
  const solution = solveBoard(board);
  assert.equal(solution.solvable, true);
  assert.equal(solution.metrics.greedyMaxUnlocks, 4);
  assert.ok(solution.metrics.dependencyDepthRatio >= DIFFICULTIES.expert.minDepthRatio);
  assert.ok(solution.metrics.initialRemovable >= 1 && solution.metrics.initialRemovable <= 3);
  assert.deepEqual(board, generateBoard('expert', 'size-selection-11'));
});

test('100 seeds at each size and difficulty fill the grid, independently solve and separate choice pressure', (context) => {
  const allFingerprints = new Set();
  for (const size of supportedSizes) {
    const summaries = [];
    for (const [difficulty, profile] of Object.entries(DIFFICULTIES)) {
      const started = performance.now();
      let maximumMs = 0, maximumAttempts = 0;
      const totals = { arrowCount: 0, initialRemovable: 0, initialRemovableRatio: 0, dependencyDepth: 0, dependencyDepthRatio: 0,
        dependencyEdges: 0, meanChoices: 0, nonRectangularRatio: 0, boundingBoxInterpenetrationRatio: 0, averageNeighborDiversity: 0 };
      const quarters = [0, 0, 0, 0, 0];
      for (let seed = 0; seed < 100; seed += 1) {
        const point = performance.now();
        const board = generateBoard(difficulty, 'acceptance-' + seed, { size, shape: 'square' });
        maximumMs = Math.max(maximumMs, performance.now() - point);
        maximumAttempts = Math.max(maximumAttempts, board.generationMetrics.boardAttempts);
        assert.deepEqual(validateBoard(board), { valid: true, errors: [] });
        assert.equal(board.width, size); assert.equal(board.height, size);
        assert.equal(board.rulesVersion, RULES_VERSION); assert.equal(board.generatorVersion, GENERATOR_VERSION);
        assert.equal(board.difficultyProfileVersion, DIFFICULTY_PROFILE_VERSION);
        assert.equal(board.fingerprint, boardFingerprint(board));
        assert.equal(allFingerprints.has(board.fingerprint), false); allFingerprints.add(board.fingerprint);
        assert.ok(board.generationMetrics.boardAttempts <= 32);
        const area = size * size;
        assert.ok(board.generationMetrics.backbiteMoves <= 32 * area * profile.mixPasses);
        assert.ok(board.generationMetrics.cutCandidates <= 32 * (area / 2) * 2 * (board.width + board.height) * 29);
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
        if (difficulty === 'expert') {
          assert.ok(metrics.greedyMaxUnlocks <= profile.maxGreedyUnlocks);
        }
        assert.ok(metrics.averageNeighborDiversity >= 4);
        assert.equal(result.order.length, board.arrows.length);
        const ids = board.arrows.map((item) => item.id);
        const remaining = new Set(ids);
        // Numeric rays are static: removing arrows only removes existing blockers.
        // Cache this independent relation once, as in the shaped-board acceptance below.
        const blockers = new Map(ids.map((id) => [id, independentBlockers(board, ids, id)]));
        for (const id of result.order) {
          assert.equal(blockers.get(id).some((other) => remaining.has(other)), false);
          remaining.delete(id);
        }
        assert.equal(remaining.size, 0);
        // A different legal branch is checked independently of the engine graph/order.
        const alternative = new Set(ids);
        while (alternative.size) {
          const legal = [...alternative].filter((id) => !blockers.get(id).some((other) => alternative.has(other)));
          assert.ok(legal.length);
          const chosen = legal[(seed + alternative.size) % legal.length];
          alternative.delete(chosen);
        }
        // Exact geometry/work counters reproduce, including after rejected attempts.
        if (seed === 0 || board.generationMetrics.boardAttempts >= 4) {
          assert.deepEqual(board, generateBoard(difficulty, 'acceptance-' + seed, { size, shape: 'square' }));
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

test('25 seeds per shape, size and difficulty cover connected masks and independently complete in two legal orders', (context) => {
  const fingerprints = new Set();
  for (const { id: shape } of BOARD_SHAPES) {
    for (const size of supportedSizes) {
      const summaries = [];
      let expectedMask;
      for (const [difficulty, profile] of Object.entries(DIFFICULTIES)) {
        let maximumMs = 0, maximumAttempts = 0;
        const totals = { initialRemovable: 0, meanChoices: 0, dependencyDepth: 0, dependencyDepthRatio: 0,
          nonRectangularRatio: 0, boundingBoxInterpenetrationRatio: 0 };
        for (let seed = 0; seed < 25; seed += 1) {
          const point = performance.now();
          const options = { size, shape };
          const board = generateBoard(difficulty, 'shaped-acceptance-' + seed, options);
          maximumMs = Math.max(maximumMs, performance.now() - point);
          maximumAttempts = Math.max(maximumAttempts, board.generationMetrics.boardAttempts);
          assert.equal(board.width, size); assert.equal(board.height, size); assert.equal(board.shape, shape);
          assert.deepEqual(validateBoard(board), { valid: true, errors: [] });
          assert.equal(board.rulesVersion, '1.0.0'); assert.equal(board.generatorVersion, '5.0.0');
          assert.equal(board.difficultyProfileVersion, '4.0.0');
          assert.equal(board.fingerprint, boardFingerprint(board));
          assert.equal(fingerprints.has(board.fingerprint), false); fingerprints.add(board.fingerprint);
          // The silhouette is independent of difficulty, seed and generated path geometry.
          expectedMask ??= board.mask;
          assert.deepEqual(board.mask, expectedMask);
          const mask = new Set(board.mask.map(([x, y]) => x + ',' + y));
          assert.equal(mask.size, board.mask.length);
          const occupied = new Set(board.arrows.flatMap((item) => item.cells.map(([x, y]) => x + ',' + y)));
          assert.deepEqual(occupied, mask);
          assert.equal(board.arrows.reduce((sum, item) => sum + item.cells.length, 0), mask.size);
          assert.equal(shape === 'square', mask.size === size * size);
          // Check connectivity and 2x2 tile membership separately from the generator.
          const visited = new Set(), pending = [board.mask[0]];
          for (let i = 0; i < pending.length; i += 1) {
            const [x, y] = pending[i], key = x + ',' + y;
            if (visited.has(key)) continue;
            visited.add(key);
            for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
              if (mask.has(nx + ',' + ny) && !visited.has(nx + ',' + ny)) pending.push([nx, ny]);
            }
          }
          assert.equal(visited.size, mask.size);
          for (const [x, y] of board.mask) {
            const tx = x - x % 2, ty = y - y % 2;
            for (const [ox, oy] of [[0, 0], [0, 1], [1, 0], [1, 1]]) assert.ok(mask.has((tx + ox) + ',' + (ty + oy)));
          }
          if (shape === 'ring') {
            // Flood only void cells from the exterior, without using the generator's radius formula.
            const exterior = new Set(), voidQueue = [];
            for (let edge = 0; edge < size; edge += 1) {
              voidQueue.push([edge, 0], [edge, size - 1], [0, edge], [size - 1, edge]);
            }
            for (let i = 0; i < voidQueue.length; i += 1) {
              const [x, y] = voidQueue[i], key = x + ',' + y;
              if (x < 0 || y < 0 || x >= size || y >= size || mask.has(key) || exterior.has(key)) continue;
              exterior.add(key);
              voidQueue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
            }
            const hole = new Set();
            for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
              const key = x + ',' + y;
              if (!mask.has(key) && !exterior.has(key)) hole.add(key);
            }
            assert.equal(mask.size, { 20: 272, 24: 384, 28: 528, 32: 704, 36: 848, 40: 1056 }[size]);
            assert.equal(hole.size, { 20: 48, 24: 64, 28: 96, 32: 128, 36: 176, 40: 208 }[size]);
            const center = [size / 2, size / 2], reached = new Set(), holeQueue = [center];
            assert.ok(hole.has(center.join(',')));
            for (let i = 0; i < holeQueue.length; i += 1) {
              const [x, y] = holeQueue[i], key = x + ',' + y;
              if (!hole.has(key) || reached.has(key)) continue;
              reached.add(key);
              assert.equal(occupied.has(key), false);
              holeQueue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
            }
            assert.equal(reached.size, hole.size); // Exactly one enclosed, central void.
          }
          const { solvable, order, metrics } = solveBoard(board);
          assert.equal(solvable, true); assert.equal(metrics.dagSolvable, true); assert.equal(metrics.greedySolvable, true);
          assert.equal(metrics.playableCells, mask.size); assert.equal(metrics.occupiedCells, mask.size);
          assert.equal(metrics.density, 1); assert.equal(metrics.boundingBoxDensity, mask.size / (size * size));
          assert.equal(metrics.minLength, 2); assert.equal(metrics.maxLength, 30); assert.ok(metrics.totalBends >= 3);
          assert.ok(metrics.initialRemovable >= profile.minInitial && metrics.initialRemovable <= profile.maxInitial);
          assert.ok(metrics.dependencyDepth >= Math.ceil(profile.minDepthRatio * metrics.arrowCount));
          assert.ok(metrics.nonRectangularRatio >= profile.minNonRectangularRatio);
          assert.ok(metrics.boundingBoxInterpenetrationRatio >= profile.minInterpenetrationRatio);
        if (difficulty === 'expert') {
          assert.ok(metrics.greedyMaxUnlocks <= profile.maxGreedyUnlocks);
        }
          assert.ok(board.generationMetrics.boardAttempts >= 1 && board.generationMetrics.boardAttempts <= 32);
          assert.ok(board.generationMetrics.backbiteMoves <= 32 * mask.size * profile.mixPasses);
          assert.ok(board.generationMetrics.cutCandidates <= 32 * (mask.size / 2) * 2 * (size + size) * 29);
          const ids = board.arrows.map((item) => item.id);
          // Numeric ray tests across the bounding box are independent of engine mask/index/graph code.
          const blockers = new Map(ids.map((id) => [id, independentBlockers(board, ids, id)]));
          const remaining = new Set(ids);
          assert.equal(order.length, ids.length);
          for (const id of order) {
            assert.ok(remaining.has(id));
            assert.equal(blockers.get(id).some((other) => remaining.has(other)), false);
            remaining.delete(id);
          }
          assert.equal(remaining.size, 0);
          const alternative = new Set(ids), alternativeOrder = [];
          while (alternative.size) {
            const legal = [...alternative].filter((id) => !blockers.get(id).some((other) => alternative.has(other)));
            assert.ok(legal.length);
            const different = legal.filter((id) => id !== order[alternativeOrder.length]);
            const choices = different.length ? different : legal;
            const chosen = choices[(seed + alternative.size) % choices.length];
            alternative.delete(chosen); alternativeOrder.push(chosen);
          }
          if (metrics.initialRemovable > 1) assert.notDeepEqual(alternativeOrder, order);
          if (seed === 0 || board.generationMetrics.boardAttempts >= 4) {
            assert.deepEqual(board, generateBoard(difficulty, 'shaped-acceptance-' + seed, options));
          }
          for (const key of Object.keys(totals)) totals[key] += metrics[key];
        }
        const summary = { shape, size, difficulty, boards: 25, playableCells: expectedMask.length,
          maximumMs, maximumAttempts, averages: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / 25])) };
        summaries.push(summary);
        context.diagnostic(JSON.stringify(summary));
      }
      // Compare difficulty at the same shape and size, including the smallest silhouettes.
      for (let i = 1; i < summaries.length; i += 1) {
        const previous = summaries[i - 1].averages, current = summaries[i].averages;
        assert.ok(current.initialRemovable < previous.initialRemovable - 1.5);
        assert.ok(current.meanChoices < previous.meanChoices - 0.25);
        assert.ok(current.dependencyDepthRatio > previous.dependencyDepthRatio + 0.05);
      }
    }
  }
  assert.equal(fingerprints.size, 3600);
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
