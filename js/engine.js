/** Arrow Journey rules and deterministic generation. No browser or storage dependencies. */
export const RULES_VERSION = '1.0.0';
export const GENERATOR_VERSION = '3.0.0';
export const DIFFICULTY_PROFILE_VERSION = '3.0.0';

const MAX_DIMENSION = 64;
const MAX_LENGTH = 30;
const MAX_BOARD_ATTEMPTS = 16;
const BOARD_SIZES = Object.freeze([20, 24, 28, 32]);

// width/height are legacy metadata defaults; sizes defines every profile's actual range.
export const DIFFICULTIES = Object.freeze(Object.fromEntries([
  ['easy', { name: 'Easy', width: 20, height: 20, roots: 11, depthBias: -0.05, mixPasses: 8, minDepthRatio: 0.10, minInitial: 8, maxInitial: 14, minNonRectangularRatio: 0.55, minInterpenetrationRatio: 0.30, lengthBands: [[5, 10, 0.45], [11, 18, 0.45], [19, 30, 0.10]] }],
  ['normal', { name: 'Normal', width: 24, height: 24, roots: 7, depthBias: 0.4, mixPasses: 12, minDepthRatio: 0.20, minInitial: 5, maxInitial: 8, minNonRectangularRatio: 0.60, minInterpenetrationRatio: 0.45, lengthBands: [[6, 12, 0.22], [13, 22, 0.50], [23, 30, 0.28]] }],
  ['hard', { name: 'Hard', width: 28, height: 28, roots: 4, depthBias: 1.2, mixPasses: 16, minDepthRatio: 0.28, minInitial: 3, maxInitial: 5, minNonRectangularRatio: 0.60, minInterpenetrationRatio: 0.50, lengthBands: [[6, 12, 0.12], [13, 22, 0.38], [23, 30, 0.50]] }],
  ['expert', { name: 'Expert', width: 32, height: 32, roots: 2, depthBias: 3.2, mixPasses: 20, minDepthRatio: 0.40, minInitial: 1, maxInitial: 3, minNonRectangularRatio: 0.60, minInterpenetrationRatio: 0.50, lengthBands: [[6, 12, 0.08], [13, 22, 0.27], [23, 30, 0.65]] }],
].map(([key, value]) => [key, Object.freeze({ ...value, density: 1, minDensity: 1, minLength: 2, maxLength: MAX_LENGTH,
  sizes: BOARD_SIZES,
  lengthBands: Object.freeze(value.lengthBands.map(Object.freeze)) })])));

const inside = (x, y, width, height) => x >= 0 && x < width && y >= 0 && y < height;
const coordinateKey = (x, y) => `${x},${y}`;
const directionOf = (cells) => {
  const head = cells[cells.length - 1];
  const previous = cells[cells.length - 2];
  return [head[0] - previous[0], head[1] - previous[1]];
};

function inspectStructure(board) {
  const errors = [];
  if (!board || typeof board !== 'object') return { errors: ['Board must be an object.'] };
  const { width, height, arrows } = board;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return { errors: [`Board dimensions must be integers from 2 to ${MAX_DIMENSION}.`] };
  }
  if (!Array.isArray(arrows) || arrows.length === 0 || arrows.length > Math.floor(width * height / 2)) {
    return { errors: ['Board must contain a bounded, nonempty array of arrows.'] };
  }
  const byId = new Map();
  const occupancy = new Map();
  for (let index = 0; index < arrows.length; index += 1) {
    const arrow = arrows[index];
    const label = typeof arrow?.id === 'string' ? arrow.id : `#${index}`;
    if (!arrow || typeof arrow.id !== 'string' || arrow.id.length === 0 || arrow.id.length > 128) {
      errors.push(`Arrow ${label} needs a nonempty ID of at most 128 characters.`);
    } else if (byId.has(arrow.id)) {
      errors.push(`Duplicate arrow ID: ${arrow.id}.`);
    } else byId.set(arrow.id, arrow);
    if (!Array.isArray(arrow?.cells) || arrow.cells.length < 2 || arrow.cells.length > MAX_LENGTH) {
      errors.push(`Arrow ${label} must contain 2 to ${MAX_LENGTH} cells.`);
      continue;
    }
    const seen = new Set();
    let geometryValid = true;
    for (let cellIndex = 0; cellIndex < arrow.cells.length; cellIndex += 1) {
      const point = arrow.cells[cellIndex];
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger) || !inside(point[0], point[1], width, height)) {
        errors.push(`Arrow ${label} has an invalid or out-of-bounds cell at index ${cellIndex}.`);
        geometryValid = false;
        continue;
      }
      const key = coordinateKey(...point);
      if (seen.has(key)) errors.push(`Arrow ${label} repeats cell (${key}).`);
      seen.add(key);
      if (occupancy.has(key)) errors.push(`Arrow ${label} overlaps arrow ${occupancy.get(key)} at (${key}).`);
      else occupancy.set(key, arrow.id);
      const previous = arrow.cells[cellIndex - 1];
      if (cellIndex > 0 && Array.isArray(previous) && previous.length === 2 && previous.every(Number.isInteger)
          && Math.abs(point[0] - previous[0]) + Math.abs(point[1] - previous[1]) !== 1) {
        errors.push(`Arrow ${label} has nonadjacent cells at index ${cellIndex}.`);
        geometryValid = false;
      }
    }
    if (!geometryValid) continue;
    const [dx, dy] = directionOf(arrow.cells);
    if (Object.hasOwn(arrow, 'direction')) {
      const saved = arrow.direction;
      if (!Array.isArray(saved) || saved.length !== 2 || saved[0] !== dx || saved[1] !== dy) {
        errors.push(`Arrow ${label} direction does not match its final segment.`);
      }
    }
    const [hx, hy] = arrow.cells[arrow.cells.length - 1];
    for (let x = hx + dx, y = hy + dy; inside(x, y, width, height); x += dx, y += dy) {
      if (seen.has(coordinateKey(x, y))) errors.push(`Arrow ${label} interferes with its own head ray at (${x},${y}).`);
    }
  }
  return { errors, byId, occupancy };
}

function dependencyGraph(board, occupancy) {
  const blockers = new Map();
  const dependents = new Map(board.arrows.map((arrow) => [arrow.id, []]));
  for (const arrow of board.arrows) {
    const result = new Set();
    const [dx, dy] = directionOf(arrow.cells);
    const [hx, hy] = arrow.cells[arrow.cells.length - 1];
    for (let x = hx + dx, y = hy + dy; inside(x, y, board.width, board.height); x += dx, y += dy) {
      const other = occupancy.get(coordinateKey(x, y));
      if (other !== undefined) result.add(other);
    }
    blockers.set(arrow.id, result);
    for (const id of result) dependents.get(id).push(arrow.id);
  }
  return { blockers, dependents };
}

function topologicalRemoval(board, graph) {
  const pending = new Map([...graph.blockers].map(([id, ids]) => [id, ids.size]));
  const ready = board.arrows.filter((arrow) => pending.get(arrow.id) === 0).map((arrow) => arrow.id);
  const order = [];
  const depths = new Map(board.arrows.map((arrow) => [arrow.id, 1]));
  const choices = [];
  let offset = 0;
  while (offset < ready.length) {
    choices.push(ready.length - offset);
    const id = ready[offset++];
    order.push(id);
    for (const dependent of graph.dependents.get(id)) {
      depths.set(dependent, Math.max(depths.get(dependent), depths.get(id) + 1));
      pending.set(dependent, pending.get(dependent) - 1);
      if (pending.get(dependent) === 0) ready.push(dependent);
    }
  }
  return { order, choices, depth: Math.max(...depths.values()), solvable: order.length === board.arrows.length };
}

/** Validates geometry and rejects dependency cycles as unplayable data. */
export function validateBoard(board) {
  const structure = inspectStructure(board);
  if (structure.errors.length) return { valid: false, errors: structure.errors };
  if (!topologicalRemoval(board, dependencyGraph(board, structure.occupancy)).solvable) {
    return { valid: false, errors: ['Board contains a dependency cycle and cannot be completely removed.'] };
  }
  return { valid: true, errors: [] };
}

function remainingSet(byId, remainingIds) {
  if (remainingIds === undefined) return new Set(byId.keys());
  if (!Array.isArray(remainingIds) && !(remainingIds instanceof Set)) return null;
  const set = new Set(remainingIds);
  return [...set].every((id) => byId.has(id)) ? set : null;
}

/** Uses the whole head ray, including the last in-bounds cell. Invalid inputs fail closed. */
export function canRemove(board, remainingIds, id) {
  const structure = inspectStructure(board);
  if (structure.errors.length) return { allowed: false, blockers: [] };
  const remaining = remainingSet(structure.byId, remainingIds);
  if (!remaining?.has(id)) return { allowed: false, blockers: [] };
  const arrow = structure.byId.get(id);
  const blockers = new Set();
  const [dx, dy] = directionOf(arrow.cells);
  const [hx, hy] = arrow.cells[arrow.cells.length - 1];
  for (let x = hx + dx, y = hy + dy; inside(x, y, board.width, board.height); x += dx, y += dy) {
    const other = structure.occupancy.get(coordinateKey(x, y));
    if (remaining.has(other)) blockers.add(other);
  }
  return { allowed: blockers.size === 0, blockers: [...blockers] };
}

export function getRemovable(board, remainingIds) {
  const structure = inspectStructure(board);
  if (structure.errors.length) return [];
  const remaining = remainingSet(structure.byId, remainingIds);
  if (!remaining) return [];
  const graph = dependencyGraph(board, structure.occupancy);
  return board.arrows.filter((arrow) => remaining.has(arrow.id)
    && [...graph.blockers.get(arrow.id)].every((blocker) => !remaining.has(blocker))).map((arrow) => arrow.id);
}

function countBends(cells) {
  let bends = 0;
  for (let i = 2; i < cells.length; i += 1) {
    if (cells[i][0] - cells[i - 1][0] !== cells[i - 1][0] - cells[i - 2][0]
        || cells[i][1] - cells[i - 1][1] !== cells[i - 1][1] - cells[i - 2][1]) bends += 1;
  }
  return bends;
}

function geometryMetrics(board, occupancy) {
  const boxes = board.arrows.map((arrow) => {
    const xs = arrow.cells.map(([x]) => x), ys = arrow.cells.map(([, y]) => y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  });
  const contains = (box, [x, y]) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  let nonRectangularArrowCount = 0, boundingBoxOverlapPairs = 0, boundingBoxInterpenetrationPairs = 0;
  const interpenetrating = new Set();
  let totalNeighborDiversity = 0;
  for (let i = 0; i < board.arrows.length; i += 1) {
    const arrow = board.arrows[i], box = boxes[i];
    if ((box.maxX - box.minX + 1) * (box.maxY - box.minY + 1) > arrow.cells.length) nonRectangularArrowCount += 1;
    const neighbors = new Set();
    for (const [x, y] of arrow.cells) {
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        const owner = occupancy.get(coordinateKey(nx, ny));
        if (owner !== undefined && owner !== arrow.id) neighbors.add(owner);
      }
    }
    totalNeighborDiversity += neighbors.size;
    for (let j = i + 1; j < board.arrows.length; j += 1) {
      const other = boxes[j];
      if (box.maxX < other.minX || other.maxX < box.minX || box.maxY < other.minY || other.maxY < box.minY) continue;
      boundingBoxOverlapPairs += 1;
      if (arrow.cells.some((point) => contains(other, point)) && board.arrows[j].cells.some((point) => contains(box, point))) {
        boundingBoxInterpenetrationPairs += 1;
        interpenetrating.add(i); interpenetrating.add(j);
      }
    }
  }
  return {
    nonRectangularArrowCount, nonRectangularRatio: nonRectangularArrowCount / board.arrows.length,
    boundingBoxOverlapPairs, boundingBoxInterpenetrationPairs,
    boundingBoxInterpenetrationRatio: interpenetrating.size / board.arrows.length,
    averageNeighborDiversity: totalNeighborDiversity / board.arrows.length,
  };
}

/** A second solver scans cell paths directly, without the occupancy map or dependency graph. */
function directGreedyRemoval(board) {
  const remaining = board.arrows.slice();
  const order = [];
  while (remaining.length) {
    const index = remaining.findIndex((arrow) => {
      const [hx, hy] = arrow.cells[arrow.cells.length - 1];
      const [dx, dy] = directionOf(arrow.cells);
      return !remaining.some((other) => other.cells.some(([x, y]) => {
        if (dx !== 0) return y === hy && (x - hx) * dx > 0;
        return x === hx && (y - hy) * dy > 0;
      }));
    });
    if (index === -1) return { solvable: false, order };
    order.push(remaining[index].id);
    remaining.splice(index, 1);
  }
  return { solvable: true, order };
}

export function solveBoard(board) {
  const structure = inspectStructure(board);
  if (structure.errors.length) return { solvable: false, order: [], metrics: { errors: structure.errors } };
  const graph = dependencyGraph(board, structure.occupancy);
  const result = topologicalRemoval(board, graph);
  const independent = directGreedyRemoval(board);
  const lengths = board.arrows.map((arrow) => arrow.cells.length);
  const occupiedCells = lengths.reduce((sum, value) => sum + value, 0);
  const totalBends = board.arrows.reduce((sum, arrow) => sum + countBends(arrow.cells), 0);
  const initialRemovable = [...graph.blockers.values()].filter((ids) => ids.size === 0).length;
  return {
    solvable: result.solvable && independent.solvable,
    order: result.order,
    metrics: {
      arrowCount: board.arrows.length, occupiedCells, density: occupiedCells / (board.width * board.height),
      minLength: Math.min(...lengths), maxLength: Math.max(...lengths), averageLength: occupiedCells / lengths.length,
      totalBends, averageBends: totalBends / lengths.length,
      initialRemovable, initialRemovableRatio: initialRemovable / lengths.length,
      dependencyEdges: [...graph.blockers.values()].reduce((sum, ids) => sum + ids.size, 0),
      dependencyDepth: result.depth, dependencyDepthRatio: result.depth / lengths.length, choicesOverTime: result.choices,
      meanChoices: result.choices.reduce((sum, value) => sum + value, 0) / Math.max(1, result.choices.length),
      dagSolvable: result.solvable, greedySolvable: independent.solvable,
      ...geometryMetrics(board, structure.occupancy),
    },
  };
}

function hash128(text) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
    .map((value) => value.toString(16).padStart(8, '0')).join('');
}

/** IDs, arrow enumeration, seed, difficulty and metadata do not affect geometry identity. */
export function boardFingerprint(board) {
  const structure = inspectStructure(board);
  if (structure.errors.length) throw new TypeError(structure.errors.join(' '));
  const paths = board.arrows.map((arrow) => arrow.cells.map(([x, y]) => `${x},${y}`).join(';')).sort();
  return `aj1-${hash128(JSON.stringify([board.width, board.height, paths]))}`;
}

function randomFromSeed(seed) {
  let state = Number.parseInt(hash128(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseLength(profile, random) {
  let value = random();
  for (const [minimum, maximum, weight] of profile.lengthBands) {
    value -= weight;
    if (value <= 0) return minimum + Math.floor(random() * (maximum - minimum + 1));
  }
  return MAX_LENGTH;
}

/** Backbite moves preserve a single orthogonal Hamiltonian path and every cell. */
function mixedHamiltonianPath(width, height, passes, random, work) {
  const area = width * height;
  const path = new Uint16Array(area);
  const positions = new Uint16Array(area);
  for (let i = 0; i < area; i += 1) {
    const y = Math.floor(i / width), offset = i % width;
    const cell = y * width + (y % 2 ? width - 1 - offset : offset);
    path[i] = cell; positions[cell] = i;
  }
  const neighbors = [];
  for (let move = 0; move < area * passes; move += 1) {
    const atStart = random() < 0.5;
    const endIndex = atStart ? 0 : area - 1;
    const cell = path[endIndex], x = cell % width, y = Math.floor(cell / width);
    neighbors.length = 0;
    if (x > 0) neighbors.push(cell - 1);
    if (x + 1 < width) neighbors.push(cell + 1);
    if (y > 0) neighbors.push(cell - width);
    if (y + 1 < height) neighbors.push(cell + width);
    const other = positions[neighbors[Math.floor(random() * neighbors.length)]];
    if (Math.abs(other - endIndex) === 1) continue;
    const low = atStart ? 0 : other + 1;
    const high = atStart ? other - 1 : area - 1;
    for (let a = low, b = high; a < b; a += 1, b -= 1) [path[a], path[b]] = [path[b], path[a]];
    for (let i = low; i <= high; i += 1) positions[path[i]] = i;
    work.backbiteMoves += 1;
  }
  return { path, positions };
}

/**
 * Cuts pieces from a mixed full-grid route in actual legal removal order.
 * Each cut has 2..30 cells and leaves remaining route components of size >= 2.
 * A clear ray may contain only pieces already cut, so dependencies are acyclic.
 */
function generateCandidate(profile, random, work) {
  const { width, height } = profile;
  const area = width * height;
  const { path, positions } = mixedHamiltonianPath(width, height, profile.mixPasses, random, work);
  const alive = new Uint8Array(area).fill(1);
  const owners = new Int16Array(area).fill(-1);
  const starts = new Uint16Array(area), ends = new Uint16Array(area);
  const depths = [], arrows = [];
  let remaining = area, roots = 0;
  while (remaining > 0 && arrows.length < area / 2) {
    // Recompute the still-contiguous intervals of the original mixed route.
    for (let index = 0; index < area;) {
      if (!alive[path[index]]) { index += 1; continue; }
      const start = index;
      while (index < area && alive[path[index]]) index += 1;
      for (let i = start; i < index; i += 1) { starts[i] = start; ends[i] = index - 1; }
    }
    const targetLength = arrows.length === 0 ? MAX_LENGTH : arrows.length === 1 ? 2 : chooseLength(profile, random);
    let best = null, bestScore = -Infinity;
    const inspectHead = (head, dx, dy, dependencyDepth) => {
      const hx = head % width, hy = Math.floor(head / width);
      const px = hx - dx, py = hy - dy;
      if (!inside(px, py, width, height)) return;
      const previousCell = py * width + px;
      if (!alive[previousCell]) return;
      const index = positions[head], previousIndex = positions[previousCell];
      const step = index - previousIndex;
      if (Math.abs(step) !== 1) return;
      // The untouched component beyond the chosen head cannot become a singleton.
      if ((step === 1 ? ends[index] - index : index - starts[index]) === 1) return;
      const available = step === 1 ? index - starts[index] + 1 : ends[index] - index + 1;
      const maximum = Math.min(MAX_LENGTH, available);
      for (let length = 2; length <= maximum; length += 1) {
        work.cutCandidates += 1;
        if (available - length === 1) continue;
        if (arrows.length < 2 && length !== targetLength) continue;
        const isRoot = dependencyDepth === 0;
        const rootPreference = roots < profile.roots ? (isRoot ? 100000 : 0) : (isRoot ? -100000 : 0);
        const score = rootPreference - Math.abs(length - targetLength) + dependencyDepth * profile.depthBias + random() * 0.4;
        if (score > bestScore) { best = { index, step, length, dependencyDepth, isRoot }; bestScore = score; }
      }
    };
    // Only the first remaining cell seen from each edge has a clear outward ray.
    // The depth of removed owners on that ray is accumulated independently.
    const scan = (start, increment, count, dx, dy) => {
      let depth = 0;
      for (let i = 0, cell = start; i < count; i += 1, cell += increment) {
        if (alive[cell]) { inspectHead(cell, dx, dy, depth); return; }
        depth = Math.max(depth, depths[owners[cell]] || 0);
      }
    };
    for (let y = 0; y < height; y += 1) {
      scan(y * width, 1, width, -1, 0);
      scan(y * width + width - 1, -1, width, 1, 0);
    }
    for (let x = 0; x < width; x += 1) {
      scan(x, width, height, 0, -1);
      scan((height - 1) * width + x, -width, height, 0, 1);
    }
    if (!best) return null;
    const cells = [];
    for (let offset = best.length - 1; offset >= 0; offset -= 1) {
      const cell = path[best.index - offset * best.step];
      cells.push([cell % width, Math.floor(cell / width)]);
      alive[cell] = 0; owners[cell] = arrows.length;
    }
    depths.push(best.dependencyDepth + 1);
    if (best.isRoot) roots += 1;
    arrows.push({ id: 'a' + arrows.length.toString(36), cells });
    remaining -= best.length;
  }
  if (remaining !== 0) return null;
  // Enumeration and IDs must not disclose the construction's removal order.
  for (let i = arrows.length - 1; i > 0; i -= 1) {
    const other = Math.floor(random() * (i + 1));
    [arrows[i], arrows[other]] = [arrows[other], arrows[i]];
  }
  arrows.forEach((arrow, index) => { arrow.id = `a${index.toString(36)}`; });
  return { width, height, arrows };
}

/** Size uses a separate, difficulty-independent seed stream; an override supports previews/tests. */
export function generateBoard(difficulty = 'easy', seed = 'arrow-journey', options = {}) {
  if (!Object.hasOwn(DIFFICULTIES, difficulty)) throw new RangeError(`Unknown difficulty: ${String(difficulty)}`);
  if ((typeof seed !== 'string' && typeof seed !== 'number') || (typeof seed === 'number' && !Number.isFinite(seed))) {
    throw new TypeError('Seed must be a string or finite number.');
  }
  seed = String(seed);
  if (seed.length > 1024) throw new RangeError('Seed must be at most 1024 characters.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Generation options must be an object.');
  const size = options.size === undefined
    ? BOARD_SIZES[Math.floor(randomFromSeed(`${GENERATOR_VERSION}|size|${seed}`)() * BOARD_SIZES.length)] : options.size;
  if (!BOARD_SIZES.includes(size)) throw new RangeError('Board size must be 20, 24, 28 or 32.');
  const profile = { ...DIFFICULTIES[difficulty], width: size, height: size };
  const random = randomFromSeed(`${RULES_VERSION}|${GENERATOR_VERSION}|${DIFFICULTY_PROFILE_VERSION}|${difficulty}|${size}|${seed}`);
  const work = { boardAttempts: 0, backbiteMoves: 0, cutCandidates: 0 };
  for (let attempt = 0; attempt < MAX_BOARD_ATTEMPTS; attempt += 1) {
    work.boardAttempts += 1;
    const board = generateCandidate(profile, random, work);
    if (!board) continue;
    const validation = validateBoard(board);
    if (!validation.valid) continue;
    const solution = solveBoard(board);
    if (!solution.solvable || solution.metrics.density < profile.minDensity || solution.metrics.maxLength !== MAX_LENGTH
        || solution.metrics.totalBends < 3 || solution.metrics.minLength !== 2
        || solution.metrics.dependencyDepth < Math.ceil(profile.minDepthRatio * solution.metrics.arrowCount)
        || solution.metrics.initialRemovable < profile.minInitial || solution.metrics.initialRemovable > profile.maxInitial
        || solution.metrics.nonRectangularRatio < profile.minNonRectangularRatio
        || solution.metrics.boundingBoxInterpenetrationRatio < profile.minInterpenetrationRatio) continue;
    return {
      ...board, difficulty, seed, generatorVersion: GENERATOR_VERSION, rulesVersion: RULES_VERSION,
      difficultyProfileVersion: DIFFICULTY_PROFILE_VERSION, fingerprint: boardFingerprint(board),
      generationMetrics: { ...work },
    };
  }
  throw new Error(`A valid ${difficulty} board could not be generated within ${MAX_BOARD_ATTEMPTS} bounded attempts.`);
}

/** Samples Q([s,L+s]); distances and path coordinates are in cell units. */
export function sampleArrow(arrow, distance = 0) {
  const cells = arrow?.cells;
  if (!Array.isArray(cells) || cells.length < 2 || cells.length > MAX_LENGTH
      || cells.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isInteger))
      || cells.some((point, index) => index > 0 && Math.abs(point[0] - cells[index - 1][0]) + Math.abs(point[1] - cells[index - 1][1]) !== 1)
      || new Set(cells.map(([x, y]) => coordinateKey(x, y))).size !== cells.length) {
    throw new TypeError('Arrow must be a nonrepeating, orthogonally adjacent cell path.');
  }
  if (!Number.isFinite(distance) || distance < 0) throw new RangeError('Distance must be finite and nonnegative.');
  const length = cells.length - 1;
  const head = cells[length];
  const [dx, dy] = directionOf(cells);
  const pointAt = (position) => {
    if (position >= length) return [head[0] + (position - length) * dx, head[1] + (position - length) * dy];
    const index = Math.floor(position), fraction = position - index;
    return [cells[index][0] + (cells[index + 1][0] - cells[index][0]) * fraction,
      cells[index][1] + (cells[index + 1][1] - cells[index][1]) * fraction];
  };
  const points = [pointAt(distance)];
  for (let index = Math.floor(distance) + 1; index <= length && index < length + distance; index += 1) points.push(cells[index].slice());
  points.push(pointAt(length + distance));
  return points;
}
