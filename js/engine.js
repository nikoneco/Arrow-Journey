/** Arrow Journey rules and deterministic generation. No browser or storage dependencies. */
export const RULES_VERSION = '1.0.0';
export const GENERATOR_VERSION = '1.0.0';
export const DIFFICULTY_PROFILE_VERSION = '1.0.0';

const MAX_DIMENSION = 64;
const MAX_LENGTH = 30;
const MAX_BOARD_ATTEMPTS = 4;

export const DIFFICULTIES = Object.freeze(Object.fromEntries([
  ['easy', { name: 'Easy', width: 20, height: 20, density: 1, minDensity: 1, bandHeights: [2, 3], lengthBands: [[4, 7, 0.42], [8, 12, 0.46], [13, 18, 0.12]] }],
  ['normal', { name: 'Normal', width: 24, height: 24, density: 1, minDensity: 1, bandHeights: [3, 4], lengthBands: [[6, 10, 0.20], [11, 18, 0.54], [19, 27, 0.26]] }],
  ['hard', { name: 'Hard', width: 28, height: 28, density: 1, minDensity: 1, bandHeights: [4, 5], lengthBands: [[8, 12, 0.14], [13, 21, 0.36], [22, 30, 0.50]] }],
  ['expert', { name: 'Expert', width: 32, height: 32, density: 1, minDensity: 1, bandHeights: [5, 6], lengthBands: [[10, 15, 0.10], [16, 23, 0.28], [24, 30, 0.62]] }],
].map(([key, value]) => [key, Object.freeze({ ...value, bandHeights: Object.freeze(value.bandHeights), lengthBands: Object.freeze(value.lengthBands.map(Object.freeze)) })])));

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
      dependencyDepth: result.depth, choicesOverTime: result.choices,
      meanChoices: result.choices.reduce((sum, value) => sum + value, 0) / Math.max(1, result.choices.length),
      dagSolvable: result.solvable, greedySolvable: independent.solvable,
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

/** Makes a full rectangular Hamiltonian path whose final step points outward. */
function tilePath(tile, direction, random) {
  const { x, y, width, height } = tile;
  const cells = [];
  const reverseLanes = random() < 0.5;
  if (direction === 'left' || direction === 'right') {
    for (let lane = 0; lane < height; lane += 1) {
      const py = y + (reverseLanes ? height - 1 - lane : lane);
      const forwards = ((height - 1 - lane) % 2 === 0) === (direction === 'right');
      for (let i = 0; i < width; i += 1) cells.push([x + (forwards ? i : width - 1 - i), py]);
    }
  } else {
    for (let lane = 0; lane < width; lane += 1) {
      const px = x + (reverseLanes ? width - 1 - lane : lane);
      const forwards = ((width - 1 - lane) % 2 === 0) === (direction === 'down');
      for (let i = 0; i < height; i += 1) cells.push([px, y + (forwards ? i : height - 1 - i)]);
    }
  }
  return cells;
}

function chooseOutwardDirection(tile, width, height, random) {
  const sides = [
    ['left', tile.x, tile.width >= 2], ['right', width - tile.x - tile.width, tile.width >= 2],
    ['up', tile.y, tile.height >= 2], ['down', height - tile.y - tile.height, tile.height >= 2],
  ];
  const nearest = Math.min(...sides.map(([, distance]) => distance));
  const choices = sides.filter(([, distance, allowed]) => distance === nearest && allowed);
  if (!choices.length) throw new Error('Tile has no valid outward head direction.');
  return choices[Math.floor(random() * choices.length)][0];
}

function generateCandidate(profile, random, work) {
  const { width, height } = profile;
  const tiles = [];
  // A two-row edge band explicitly includes both 2-cell and 30-cell arrows.
  const edgeWidths = [1, 15];
  let edgeRemaining = width - 16;
  while (edgeRemaining > 0) {
    const amount = Math.min(15, edgeRemaining);
    edgeWidths.push(amount);
    edgeRemaining -= amount;
  }
  for (let i = edgeWidths.length - 1; i > 0; i -= 1) {
    const other = Math.floor(random() * (i + 1));
    [edgeWidths[i], edgeWidths[other]] = [edgeWidths[other], edgeWidths[i]];
  }
  let edgeX = 0;
  for (const amount of edgeWidths) {
    tiles.push({ x: edgeX, y: 0, width: amount, height: 2 });
    edgeX += amount;
  }
  let y = 2;
  while (y < height) {
    const remainingHeight = height - y;
    const choices = profile.bandHeights.filter((amount) => amount <= remainingHeight && remainingHeight - amount !== 1);
    const bandHeight = choices.length ? choices[Math.floor(random() * choices.length)] : remainingHeight;
    let x = 0;
    while (x < width) {
      const remainingWidth = width - x;
      const maximum = Math.min(Math.floor(MAX_LENGTH / bandHeight), remainingWidth);
      const widths = [];
      for (let amount = 2; amount <= maximum; amount += 1) {
        if (remainingWidth - amount !== 1) widths.push(amount);
      }
      const desiredWidth = Math.round(chooseLength(profile, random) / bandHeight);
      const closeness = Math.min(...widths.map((amount) => Math.abs(amount - desiredWidth)));
      const closest = widths.filter((amount) => Math.abs(amount - desiredWidth) === closeness);
      const tileWidth = closest[Math.floor(random() * closest.length)];
      if (!tileWidth) throw new Error('No bounded full-grid tile partition is available.');
      tiles.push({ x, y, width: tileWidth, height: bandHeight });
      x += tileWidth;
    }
    y += bandHeight;
  }
  const rotation = Math.floor(random() * 4);
  const mirror = random() < 0.5;
  const transform = ([px, py]) => {
    let tx = mirror ? width - 1 - px : px;
    let ty = py;
    for (let turn = 0; turn < rotation; turn += 1) [tx, ty] = [height - 1 - ty, tx];
    return [tx, ty];
  };
  const arrows = tiles.map((tile, index) => ({
    id: 'a' + index.toString(36),
    cells: tilePath(tile, chooseOutwardDirection(tile, width, height, random), random).map(transform),
  }));
  work.tiles += tiles.length;
  return { width, height, arrows };
}

/**
 * Fully tiles the grid with 2..30-cell paths. A head points through the closest
 * outer side of its rectangle. Any blocker belongs to a tile with a strictly
 * smaller distance to the board edge, so dependency cycles cannot occur.
 * Structural, graph and independent direct-greedy checks still run before return.
 */
export function generateBoard(difficulty = 'easy', seed = 'arrow-journey') {
  if (!Object.hasOwn(DIFFICULTIES, difficulty)) throw new RangeError(`Unknown difficulty: ${String(difficulty)}`);
  if ((typeof seed !== 'string' && typeof seed !== 'number') || (typeof seed === 'number' && !Number.isFinite(seed))) {
    throw new TypeError('Seed must be a string or finite number.');
  }
  seed = String(seed);
  if (seed.length > 1024) throw new RangeError('Seed must be at most 1024 characters.');
  const profile = DIFFICULTIES[difficulty];
  const random = randomFromSeed(`${RULES_VERSION}|${GENERATOR_VERSION}|${DIFFICULTY_PROFILE_VERSION}|${difficulty}|${seed}`);
  const work = { boardAttempts: 0, tiles: 0 };
  for (let attempt = 0; attempt < MAX_BOARD_ATTEMPTS; attempt += 1) {
    work.boardAttempts += 1;
    const board = generateCandidate(profile, random, work);
    const validation = validateBoard(board);
    if (!validation.valid) continue;
    const solution = solveBoard(board);
    if (!solution.solvable || solution.metrics.density < profile.minDensity || solution.metrics.maxLength < 24
        || solution.metrics.totalBends < 3 || solution.metrics.minLength !== 2) continue;
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
