import "../style.css";
import {
  DIFFICULTIES,
  BOARD_SHAPES,
  validateBoard,
  canRemove,
  getRemovable,
  boardFingerprint,
} from "./engine.js";
import { BoardView } from "./board-view.js";
import {
  openStore,
  aggregateStats,
  updateSettings,
  ownerForUid,
  mergeSyncData,
  toCloudPayload,
} from "./storage.js";
import { initializeCloud } from "./cloud.js";
import { Soundscape } from "./audio.js";
import { ARROW_THEMES, APPEARANCE_MODES } from "./themes.js";
import { FIREBASE_CONFIG, PUBLIC_CONFIG_URL } from "./config.js";
import { bundledProfiles, loadPublicConfig } from "./public-config.js";

const app = document.querySelector("#app");
const icon = (name) => {
  const p =
    {
      arrow: "M4 12h16m-6-6 6 6-6 6",
      back: "m14 6-6 6 6 6",
      settings:
        "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-3-5h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z",
      hint: "M9 19h6m-5 3h4M8 15a6 6 0 1 1 8 0l-1 2H9Z",
      fit: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
      sound: "M11 4 6 8H3v8h3l5 4Zm4 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14",
      close: "m6 6 12 12M6 18 18 6",
      check: "m5 12 4 4 10-10",
      leaf: "M5 20C3 8 9 3 21 3c0 12-5 18-16 17Zm0 0L16 9",
      pause: "M9 5v14M15 5v14",
      minus: "M5 12h14",
      plus: "M5 12h14M12 5v14",
    }[name] || "";
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${p}"/></svg>`;
};
const logo = `<svg class="brand-mark" viewBox="0 0 44 44" fill="none" aria-hidden="true"><path d="M5 35c3-19 30-5 29-29m-6 6 6-6 6 6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
let store,
  profile,
  cloud,
  screen = "home",
  selected = "easy",
  selectedShape = "random",
  boardView,
  busy = false,
  owner = "guest",
  epoch = 0,
  stale = false,
  completion = null,
  toastTimer,
  syncTimer,
  syncing = false,
  saveViewTimer,
  viewState = null,
  updateWorker = null;
const audio = new Soundscape();
const pendingTaps = [];
let drainingTaps = false;
let publicProfiles = bundledProfiles();
const deviceId = (() => {
  try {
    const key = "arrow-journey-device";
    let v = localStorage.getItem(key);
    if (!v) {
      v = crypto.randomUUID();
      localStorage.setItem(key, v);
    }
    return v;
  } catch {
    return crypto.randomUUID();
  }
})();
const settings = () =>
  Object.fromEntries(
    Object.entries(profile?.settings || {}).map(([k, v]) => [k, v.value]),
  );
const systemColor = matchMedia("(prefers-color-scheme: dark)");
const darkMode = () =>
  settings().colorMode === "dark" ||
  (settings().colorMode === "system" && systemColor.matches);
const motion = () =>
  settings().reducedMotion ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;
function notify(text) {
  const el = document.querySelector("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
  document.querySelector("#announcer").textContent = text;
}
function failed(e) {
  console.error(e);
  if (e.code === "CONFLICT") {
    stale = true;
    notify("別のタブで進みました。「最新の状態を開く」で再開してね。");
    render();
  } else
    notify(e.message || "操作を完了できませんでした。再試行してください。");
}
function applySettings() {
  audio.configure(settings());
  audio.setBoard(profile?.activeGame?.playId);
  const showMistakes = Boolean(settings().showMistakes);
  app.querySelectorAll("[data-mistake-count]").forEach((element) => {
    element.hidden = !showMistakes;
  });
  const mistakeToggle = app.querySelector('[data-setting="showMistakes"]');
  if (mistakeToggle) mistakeToggle.checked = showMistakes;
  const theme = settings().arrowTheme || "forest";
  const dark = darkMode();
  document.documentElement.dataset.colorMode = dark ? "dark" : "light";
  boardView?.setTheme(theme, dark);
  app.querySelectorAll('[data-setting="arrowTheme"]').forEach((input) => {
    input.checked = input.value === theme;
  });
  const mode = app.querySelector('[data-setting="colorMode"]');
  if (mode) mode.value = settings().colorMode || "light";
  app.querySelectorAll("[data-swatch]").forEach((swatch) => {
    const color = ARROW_THEMES.find(
      (value) => value.id === swatch.dataset.swatch,
    );
    if (color) swatch.style.background = dark ? color.darkInk : color.ink;
  });
  document.documentElement.classList.toggle("reduce-motion", motion());
}
function header() {
  return screen === "home"
    ? `<header class="home-header"><h1 class="brand">${logo}<span>ARROW JOURNEY</span></h1></header>`
    : `<header class="screen-header"><button class="back-button" data-action="home">${icon("back")}ホーム</button><span class="screen-heading">Arrow Journey</span><button class="header-settings" data-action="settings" aria-label="設定">${icon("settings")}</button></header>`;
}
function footer() {
  return screen === "home"
    ? `<nav class="home-nav" aria-label="メニュー"><button data-action="settings">${icon("settings")}設定</button><button data-action="stats"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 20V9h4v11m2 0V4h4v16m2 0V12h4v8"/></svg>成績</button><button data-action="help">${icon("hint")}遊び方</button></nav>`
    : "";
}
function render() {
  if (!profile || profile.ownerKey !== owner) return;
  boardView?.destroy();
  boardView = null;
  app.innerHTML = `<div class="shell${screen === "play" ? " shell-play" : ""}">${header()}<aside id="app-notices" aria-label="通知"></aside><main id="main">${screen === "play" ? playMarkup() : homeMarkup()}</main>${footer()}</div><dialog id="dialog" class="dialog"></dialog>`;
  app.querySelectorAll("[data-action]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.preventDefault();
      action(el.dataset.action);
    }),
  );
  renderNotices();
  if (screen === "play" && profile.activeGame) {
    const g = profile.activeGame;
    audio.setBoard(g.playId);
    boardView = new BoardView(app.querySelector("#board"), {
      onTap: tap,
      onViewChange: (v) => {
        viewState = v;
        scheduleViewSave();
      },
    });
    boardView.setTheme(settings().arrowTheme || "forest", darkMode());
    boardView.setBoard(g.board, g.remainingIds, {
      hintId: g.hintId,
      reducedMotion: motion(),
    });
    boardView.setView(g.view);
    updatePlay();
  } else {
    app.querySelector("#new-shape")?.addEventListener("change", (event) => {
      selectedShape = event.target.value;
    });
    app.querySelectorAll("[data-difficulty]").forEach((el) =>
      el.addEventListener("click", () => {
        selected = el.dataset.difficulty;
        start();
      }),
    );
  }
}
function renderNotices() {
  const el = app.querySelector("#app-notices");
  if (!el) return;
  el.innerHTML =
    (stale
      ? '<div class="notice">別のタブで保存内容が変わりました。<button data-action="reload">最新の状態を開く →</button></div>'
      : "") +
    (updateWorker
      ? '<div class="notice update-notice" role="status"><span>更新があります</span><button data-action="update">更新</button></div>'
      : "");
  el.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = busy;
    button.onclick = () => action(button.dataset.action);
  });
}
function profileSizeLabel(p) {
  const sizes = p.sizes;
  return sizes?.length > 1
    ? `${sizes[0]} × ${sizes[0]} 〜 ${sizes.at(-1)} × ${sizes.at(-1)}`
    : `${p.width} × ${p.height}`;
}
function homeMarkup() {
  const resume = profile.activeGame;
  return `<section class="home-screen"><div class="home-content">${completion ? `<div class="completion" role="status">${icon("check")}<div><strong>クリア</strong><span>${DIFFICULTIES[completion.difficulty].name}<span data-mistake-count ${settings().showMistakes ? "" : "hidden"}> · ミス ${completion.misses}</span> · ヒント ${completion.hintsUsed} / 3</span></div></div>` : ""}${resume ? `<button class="resume-card" data-action="resume" ${busy || stale ? "disabled" : ""}><span class="resume-title">つづきから</span><span class="resume-meta"><strong>${DIFFICULTIES[resume.board.difficulty].name}</strong><span>残り ${resume.remainingIds.length} 本</span></span>${icon("arrow")}</button>` : ""}<section class="level-section" aria-labelledby="new-game-title"><div class="level-heading"><h2 class="section-title" id="new-game-title">新しい問題</h2><label class="shape-select" for="new-shape">形<select id="new-shape" ${busy || stale ? "disabled" : ""}><option value="random" ${selectedShape === "random" ? "selected" : ""}>ランダム</option>${BOARD_SHAPES.map(({ id, label }) => `<option value="${id}" ${selectedShape === id ? "selected" : ""}>${label}</option>`).join("")}</select></label></div><div class="level-list">${Object.entries(
    DIFFICULTIES,
  )
    .map(
      ([k, v], i) =>
        `<button class="level-row" data-difficulty="${k}" ${busy || stale ? "disabled" : ""}><span class="level-name">${v.name}<small>${profileSizeLabel(publicProfiles.find((p) => p.difficulty === k))}</small></span><span class="difficulty-dots" aria-hidden="true">${Array.from({ length: 4 }, (_, j) => `<i class="${j <= i ? "filled" : ""}"></i>`).join("")}</span>${icon("arrow")}</button>`,
    )
    .join(
      "",
    )}</div></section>${busy ? '<p class="busy-indicator" role="status">問題を準備しています…</p>' : ""}</div></section>`;
}
function playMarkup() {
  const g = profile.activeGame;
  if (!g) {
    screen = "home";
    return homeMarkup();
  }
  const shape = BOARD_SHAPES.find((value) => value.id === g.board.shape);
  return `<section class="play"><div class="play-meta"><span>${DIFFICULTIES[g.board.difficulty].name}<small>${g.board.width} × ${g.board.height}${shape ? " · " + shape.label : ""}</small></span><span class="miss-count" data-mistake-count ${settings().showMistakes ? "" : "hidden"}>ミス <strong id="misses">${g.misses}</strong></span><span class="saved-status">端末に保存</span></div><div class="board-toolbar" role="group" aria-label="盤面の操作"><div class="play-count"><span>残り</span><div><strong id="remaining">${g.remainingIds.length}</strong><small> / ${g.board.arrows.length}</small></div></div><div class="zoom-controls"><button class="icon-button" data-action="zoomOut" aria-label="縮小">${icon("minus")}</button><button data-action="fit" aria-label="盤面を全体表示">${icon("fit")}<span class="fit-label">全体表示</span></button><button class="icon-button" data-action="zoomIn" aria-label="拡大">${icon("plus")}</button></div><button class="hint-button" data-action="hint" aria-label="ヒント 残り ${3 - g.hintsUsed} 回">${icon("hint")}<span>ヒント</span><small id="hint-left" class="sr-only">残り ${3 - g.hintsUsed} 回</small><span id="hint-count" aria-hidden="true">${3 - g.hintsUsed}</span></button></div><div class="progress"><span id="progress-bar" style="width:${100 * (1 - g.remainingIds.length / g.board.arrows.length)}%"></span></div><div class="game-frame${g.board.shape && g.board.shape !== "square" ? " shaped-frame" : ""}"><div id="board" class="board-viewport" aria-label="矢印パズル盤面"></div></div><p class="play-message" id="play-message" role="status"></p></section>`;
}
function updatePlay() {
  renderNotices();
  app
    .querySelectorAll('[data-difficulty], [data-action="resume"], #new-shape')
    .forEach((button) => {
      button.disabled = busy || stale;
    });
  const g = profile?.activeGame;
  if (!g) return;
  const set = (id, v) => {
    const e = app.querySelector("#" + id);
    if (e) e.textContent = v;
  };
  set("remaining", g.remainingIds.length);
  set("misses", g.misses);
  set("hint-left", `残り ${3 - g.hintsUsed} 回`);
  set("hint-count", 3 - g.hintsUsed);
  const bar = app.querySelector("#progress-bar");
  if (bar)
    bar.style.width =
      100 * (1 - g.remainingIds.length / g.board.arrows.length) + "%";
  const hint = app.querySelector('[data-action="hint"]');
  if (hint) {
    hint.disabled = busy || stale || (g.hintsUsed >= 3 && !g.hintId);
    hint.setAttribute("aria-label", `ヒント 残り ${3 - g.hintsUsed} 回`);
  }
}
async function persist(next, target = owner, token = epoch) {
  if (
    next.activeGame &&
    next.activeGame.playId === profile?.activeGame?.playId &&
    viewState
  )
    next.activeGame.view = viewState;
  const saved = await store.write(target, next, next.revision);
  if (target === owner && token === epoch) {
    profile = saved;
    applySettings();
    broadcast?.postMessage({ owner: target, revision: saved.revision });
    scheduleSync();
  }
  return saved;
}
const broadcast =
  typeof BroadcastChannel === "function"
    ? new BroadcastChannel("arrow-journey-changes")
    : null;
broadcast?.addEventListener("message", (e) => {
  if (e.data.owner === owner && e.data.revision > profile?.revision) {
    stale = true;
    render();
  }
});
function scheduleViewSave() {
  clearTimeout(saveViewTimer);
  saveViewTimer = setTimeout(async () => {
    if (busy || stale || !profile?.activeGame || !viewState) return;
    const token = epoch;
    busy = true;
    try {
      const next = structuredClone(profile);
      next.activeGame.view = viewState;
      await persist(next);
    } catch (e) {
      if (token === epoch) failed(e);
    } finally {
      if (token === epoch) {
        busy = false;
        updatePlay();
      }
    }
  }, 500);
}
async function generate(difficulty) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./generator-worker.js", import.meta.url),
      { type: "module" },
    );
    const timer = setTimeout(() => {
      worker.terminate();
      reject(
        new Error("盤面の準備が間に合いませんでした。再試行してください。"),
      );
    }, 12000);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.board);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(
        new Error("盤面を準備できませんでした。途中盤面は保持しています。"),
      );
    };
    worker.postMessage({
      requestId: crypto.randomUUID(),
      difficulty,
      seed: crypto.randomUUID(),
      shape: selectedShape === "random" ? undefined : selectedShape,
    });
  });
}
async function start() {
  if (busy || stale) return;
  busy = true;
  completion = null;
  render();
  const target = owner,
    token = epoch;
  try {
    await audio.unlock();
    let board;
    for (let i = 0; i < 3; i++) {
      board = await generate(selected);
      if (token !== epoch) return;
      if (!profile.clears[board.fingerprint]) break;
      board = null;
    }
    if (!board)
      throw new Error("新しい盤面を準備できませんでした。再試行してください。");
    if (token !== epoch) return;
    const next = structuredClone(profile),
      playId = crypto.randomUUID();
    next.activeGame = {
      playId,
      board,
      boardFingerprint: board.fingerprint,
      remainingIds: board.arrows.map((a) => a.id),
      misses: 0,
      hintsUsed: 0,
      hintId: null,
      hintRevision: null,
      boardRevision: 0,
      startedAt: Date.now(),
    };
    next.summaries[playId] = {
      playId,
      difficulty: board.difficulty,
      misses: 0,
      hintsUsed: 0,
    };
    viewState = null;
    await persist(next, target, token);
    if (token === epoch) {
      screen = "play";
      viewState = null;
    }
  } catch (e) {
    if (token === epoch) failed(e);
  } finally {
    if (token === epoch) {
      busy = false;
      render();
    }
  }
}
function tap(id) {
  const game = profile?.activeGame;
  if (stale || screen !== "play" || !game || !game.remainingIds.includes(id))
    return;
  pendingTaps.push({ id, owner, epoch, playId: game.playId });
  void drainTaps();
}
async function drainTaps() {
  if (drainingTaps) return;
  drainingTaps = true;
  try {
    while (pendingTaps.length) {
      const request = pendingTaps[0],
        game = profile?.activeGame;
      if (
        request.owner !== owner ||
        request.epoch !== epoch ||
        request.playId !== game?.playId ||
        screen !== "play" ||
        stale
      ) {
        pendingTaps.shift();
        continue;
      }
      if (busy) {
        await new Promise((resolve) => setTimeout(resolve, 16));
        continue;
      }
      pendingTaps.shift();
      if (game.remainingIds.includes(request.id)) await performTap(request.id);
    }
  } finally {
    drainingTaps = false;
  }
}
async function performTap(id) {
  if (busy || stale || screen !== "play" || !profile.activeGame) return;
  busy = true;
  const token = epoch,
    target = owner,
    g = profile.activeGame;
  if (!g.remainingIds.includes(id)) {
    busy = false;
    return;
  }
  updatePlay();
  try {
    await audio.unlock();
    if (token !== epoch) return;
    const next = structuredClone(profile),
      ng = next.activeGame,
      result = canRemove(g.board, g.remainingIds, id);
    if (!result.allowed) {
      ng.misses++;
      next.summaries[g.playId].misses = ng.misses;
      await persist(next, target, token);
      if (token !== epoch) return;
      if (screen === "play") {
        boardView?.markBlocked(id);
        audio.effect("blocked");
        document.querySelector("#play-message").textContent =
          "別の矢印に遮られています。";
      }
      updatePlay();
      return;
    }
    ng.remainingIds = ng.remainingIds.filter((v) => v !== id);
    ng.boardRevision++;
    ng.hintId = null;
    ng.hintRevision = null;
    const finished = ng.remainingIds.length === 0;
    if (finished) {
      next.clears[g.board.fingerprint] ??= {
        boardFingerprint: g.board.fingerprint,
        playId: g.playId,
        difficulty: g.board.difficulty,
        misses: g.misses,
        hintsUsed: g.hintsUsed,
        completedAt: Date.now(),
      };
      next.activeGame = null;
    }
    await persist(next, target, token);
    if (token !== epoch) return;
    boardView?.setHint(null);
    audio.effect("remove");
    // Logical removal is already saved. Other arrows can be tapped while it moves.
    boardView?.removeArrow(id);
    if (finished) {
      await boardView?.whenIdle();
      if (token !== epoch) return;
      completion = {
        difficulty: g.board.difficulty,
        misses: g.misses,
        hintsUsed: g.hintsUsed,
      };
      screen = "home";
      audio.effect("complete");
      render();
    } else if (screen === "play") {
      boardView?.setBoard(
        profile.activeGame.board,
        profile.activeGame.remainingIds,
        { reducedMotion: motion() },
      );
      updatePlay();
      document.querySelector("#play-message").textContent = "";
    }
  } catch (e) {
    if (token === epoch) failed(e);
  } finally {
    if (token === epoch) {
      busy = false;
      if (screen === "home") render();
      else updatePlay();
    }
  }
}
async function hint() {
  if (busy || stale || !profile.activeGame) return;
  const g = profile.activeGame,
    token = epoch,
    target = owner;
  if (g.hintId && g.hintRevision === g.boardRevision) {
    boardView?.setHint(g.hintId);
    notify("消せる矢印を表示しています。");
    return;
  }
  if (g.hintsUsed >= 3) {
    notify("この盤面のヒントは、3回使いました。");
    return;
  }
  const ids = getRemovable(g.board, g.remainingIds);
  if (!ids.length) {
    notify("盤面の状態を確認できません。保存内容は保持しています。");
    return;
  }
  busy = true;
  try {
    const next = structuredClone(profile),
      ng = next.activeGame;
    ng.hintId = ids[0];
    ng.hintRevision = ng.boardRevision;
    ng.hintsUsed++;
    next.summaries[g.playId].hintsUsed = ng.hintsUsed;
    await persist(next, target, token);
    if (token !== epoch) return;
    boardView?.setHint(ng.hintId);
    audio.effect("hint");
    notify("消せる矢印を表示しました。");
  } catch (e) {
    if (token === epoch) failed(e);
  } finally {
    if (token === epoch) {
      busy = false;
      updatePlay();
    }
  }
}
async function changeSettings(patch) {
  if (busy || stale) return;
  const token = epoch,
    target = owner,
    snapshot = profile;
  busy = true;
  try {
    await audio.unlock();
    await persist(updateSettings(snapshot, patch, deviceId), target, token);
  } catch (e) {
    if (token === epoch) failed(e);
  } finally {
    if (token === epoch) {
      busy = false;
      updatePlay();
    }
  }
}
async function action(name) {
  if (name === "home" && profile?.ownerKey === owner) {
    pendingTaps.length = 0;
    screen = "home";
    render();
    return;
  }
  if (name === "update") return applyUpdate();
  if (name === "help") return openHelp();
  if (name === "stats") return openStats();
  if (name === "settings") return openSettings();
  if (name === "zoomIn") return boardView?.zoom(1.3);
  if (name === "zoomOut") return boardView?.zoom(1 / 1.3);
  if (name === "fit") return boardView?.reset();
  if (name === "hint") return hint();
  if (name === "start") return start();
  if (name === "sound") {
    await changeSettings({ bgmEnabled: !settings().bgmEnabled });
    render();
    return;
  }
  if (name === "reload") {
    if (busy) return;
    const token = epoch,
      target = owner;
    busy = true;
    renderNotices();
    try {
      const loaded = await store.read(target);
      if (token !== epoch || target !== owner) return;
      profile = loaded;
      stale = false;
      screen = "home";
      busy = false;
      render();
    } catch (e) {
      if (token === epoch) failed(e);
    } finally {
      if (token === epoch) {
        busy = false;
        updatePlay();
      }
    }
    return;
  }
  if (busy) return;
  if (name === "resume" && profile.activeGame) {
    screen = "play";
    render();
    audio.unlock();
  }
}
async function applyUpdate() {
  if (busy || !updateWorker) return;
  const token = epoch,
    worker = updateWorker;
  busy = true;
  renderNotices();
  clearTimeout(saveViewTimer);
  try {
    if (!stale && profile.activeGame && viewState) {
      const next = structuredClone(profile);
      next.activeGame.view = viewState;
      await persist(next);
    }
    if (token !== epoch) return;
    // Another tab may have activated this worker while we were saving.
    if (
      worker.state === "activated" ||
      navigator.serviceWorker.controller === worker
    ) {
      location.reload();
      return;
    }
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => location.reload(),
      { once: true },
    );
    worker.postMessage("SKIP_WAITING");
  } catch (e) {
    if (token === epoch) {
      busy = false;
      failed(e);
      updatePlay();
    }
  }
}
function modal(title, body) {
  const dialog = document.querySelector("#dialog");
  dialog.innerHTML = `<div class="dialog-heading"><h2>${title}</h2><button class="icon-button" aria-label="閉じる">${icon("close")}</button></div>${body}`;
  dialog.querySelector(".dialog-heading button").onclick = () => dialog.close();
  dialog.addEventListener(
    "click",
    (e) => {
      if (e.target === dialog) dialog.close();
    },
    { once: false },
  );
  dialog.showModal();
  return dialog;
}
function openHelp() {
  modal(
    "遊び方",
    `<div class="help-diagram"><svg viewBox="0 0 240 90" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M25 65V25H145m-10-10 10 10-10 10"/><path stroke-dasharray="3 7" opacity=".35" d="M160 25h55"/><path d="m204 18 8 7-8 7" opacity=".35"/></svg></div><ol class="help-steps"><li><strong>先端の向きを見る</strong><p>先端から盤面の外まで、まっすぐな道に別の矢印がなければ抜けます。形の外の空白を挟んでいても、同じ直線上に矢印があれば抜けません。</p></li><li><strong>矢印があるマスをタップ</strong><p>胴体が元の経路をたどって外へ移動します。すべて抜けたらクリアです。</p></li><li><strong>ヒントと保存</strong><p>ヒントは1盤面3回。抜けなくてもゲームオーバーはありません。</p></li></ol><p class="dialog-note">矢印を長押しすると直線ガイドを表示します。指を離しても矢印は抜けません。<br>ドラッグで盤面を移動。ピンチ・ホイール・＋で拡大できます。<br>途中盤面はこの端末だけに保存します。トップからいつでも再開できます。</p>`,
  );
}
function openStats() {
  const s = aggregateStats(profile);
  modal(
    "成績",
    `<div class="stats-total"><strong>${s.totalClears}</strong><span>クリア回数</span></div><dl class="stats-list">${Object.entries(
      DIFFICULTIES,
    )
      .map(
        ([k, d]) =>
          `<div><dt>${d.name}</dt><dd>${s.byDifficulty[k]}<small> 回</small></dd></div>`,
      )
      .join(
        "",
      )}</dl><p class="dialog-note">${owner === "guest" ? "ゲストの成績 · この端末に保存" : "ログイン中のアカウントの成績"}</p>`,
  );
}
function openSettings() {
  const s = settings();
  const d = modal(
    "設定",
    `<div class="appearance-row"><label for="color-mode">表示</label><select id="color-mode" data-setting="colorMode">${APPEARANCE_MODES.map((mode) => `<option value="${mode.id}" ${(s.colorMode || "light") === mode.id ? "selected" : ""}>${mode.label}</option>`).join("")}</select></div><fieldset class="theme-picker"><legend>矢印の色</legend><div class="theme-options">${ARROW_THEMES.map((theme) => `<label class="theme-option"><input type="radio" name="arrow-theme" value="${theme.id}" data-setting="arrowTheme" ${(s.arrowTheme || "forest") === theme.id ? "checked" : ""}><span class="theme-swatch" data-swatch="${theme.id}" style="background:${darkMode() ? theme.darkInk : theme.ink}" aria-hidden="true"></span><span>${theme.label}</span></label>`).join("")}</div></fieldset><div class="settings-fields">${[
      ["bgm", "BGM", ""],
      ["sfx", "効果音", ""],
    ]
      .map(
        ([k, label, sub]) =>
          `<div class="setting-row"><label for="${k}-enabled"><strong>${label}</strong><small>${sub}</small></label><input class="switch" type="checkbox" id="${k}-enabled" data-setting="${k}Enabled" ${s[k + "Enabled"] ? "checked" : ""}></div><div class="volume-row"><label for="${k}-volume">音量</label><input type="range" id="${k}-volume" min="0" max="1" step="0.01" value="${s[k + "Volume"]}" data-setting="${k}Volume"><output>${Math.round(s[k + "Volume"] * 100)}%</output></div>`,
      )
      .join(
        "",
      )}<div class="setting-row"><label for="show-mistakes"><strong>ミス数を表示</strong><small>プレイ中とクリア時</small></label><input class="switch" type="checkbox" id="show-mistakes" data-setting="showMistakes" ${s.showMistakes ? "checked" : ""}></div><div class="setting-row motion-row"><label for="reduced-motion"><strong>動きを減らす</strong><small>矢印の演出を短くします</small></label><input class="switch" type="checkbox" id="reduced-motion" data-setting="reducedMotion" ${s.reducedMotion ? "checked" : ""}></div></div><section class="account"><h3>成績と設定の同期</h3><p>${cloud?.configured ? (owner === "guest" ? "Googleアカウントで、成績と設定をほかの端末にも。" : "ログイン中 · 途中盤面はこの端末だけに保存します。") : "Google連携は準備中です。<br>成績・設定・途中盤面は、この端末に保存されています。"}</p><button class="secondary" id="login" ${!cloud?.configured ? "disabled" : ""}>${owner === "guest" ? "Googleでログイン" : "ログアウト"}</button>${cloud?.configured && owner !== "guest" ? '<button class="text-button" id="sync">今すぐ同期</button>' : ""}<p class="sync-status" id="sync-status"></p></section><p class="dialog-note">Arrow Journey 0.6.1<br></p>`,
  );
  d.querySelectorAll("[data-setting]").forEach((input) =>
    input.addEventListener("change", async () => {
      const value =
        input.type === "checkbox"
          ? input.checked
          : input.type === "range"
            ? Number(input.value)
            : input.value;
      if (input.type === "range")
        input.nextElementSibling.value = Math.round(value * 100) + "%";
      await changeSettings({ [input.dataset.setting]: value });
      if (screen === "play" && profile.activeGame)
        boardView?.setBoard(
          profile.activeGame.board,
          profile.activeGame.remainingIds,
          { hintId: profile.activeGame.hintId, reducedMotion: motion() },
        );
    }),
  );
  d.querySelector("#login").onclick = async () => {
    try {
      if (owner === "guest") await cloud.login();
      else await cloud.logout();
      d.close();
    } catch (e) {
      failed(e);
    }
  };
  d.querySelector("#sync")?.addEventListener("click", () => syncNow());
}
function scheduleSync() {
  clearTimeout(syncTimer);
  if (cloud?.configured && owner !== "guest" && navigator.onLine)
    syncTimer = setTimeout(syncNow, 1200);
}
async function syncNow() {
  if (
    syncing ||
    busy ||
    stale ||
    !cloud?.configured ||
    owner === "guest" ||
    !navigator.onLine
  )
    return;
  syncing = true;
  const token = epoch,
    target = owner,
    snapshot = structuredClone(profile);
  let retry = false,
    commitLocked = false;
  try {
    const merged = await cloud.sync(target, snapshot);
    if (token !== epoch || target !== owner) return;
    if (busy) {
      retry = true;
      return;
    }
    retry = profile.revision !== snapshot.revision;
    busy = true;
    commitLocked = true;
    const latest = profile;
    const next = mergeSyncData(latest, toCloudPayload(merged));
    const saved = await store.write(target, next, latest.revision);
    if (token !== epoch) return;
    profile = saved;
    applySettings();
    broadcast?.postMessage({ owner: target, revision: saved.revision });
    const status = document.querySelector("#sync-status");
    if (status) status.textContent = "成績と設定を同期しました。";
  } catch (e) {
    retry = true;
    if (token === epoch) {
      const status = document.querySelector("#sync-status");
      if (status) status.textContent = "同期待ち · 接続後に再試行します。";
      if (e.code === "CONFLICT") {
        stale = true;
        render();
      }
    }
  } finally {
    syncing = false;
    if (commitLocked && token === epoch) {
      busy = false;
      updatePlay();
    }
    if (retry && token === epoch && !stale && navigator.onLine) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncNow, 10000);
    }
    if (token !== epoch) scheduleSync();
  }
}
async function switchUser(user) {
  const nextOwner = user ? ownerForUid(user.uid) : "guest";
  if (nextOwner === owner) return;
  const token = ++epoch;
  pendingTaps.length = 0;
  owner = nextOwner;
  screen = "home";
  completion = null;
  busy = true;
  profile = null;
  viewState = null;
  boardView?.destroy();
  boardView = null;
  clearTimeout(saveViewTimer);
  clearTimeout(syncTimer);
  app.innerHTML = `<div class="shell">${header()}<main class="session-loading" aria-busy="true">読み込み中…</main></div>`;
  try {
    const loaded = await store.read(owner);
    if (token !== epoch) return;
    profile = loaded;
    stale = false;
    busy = false;
    applySettings();
    render();
    scheduleSync();
  } catch (e) {
    if (token === epoch) fatal(e);
  } finally {
    if (token === epoch) busy = false;
  }
}
function validateSavedGame(g) {
  try {
    if (
      !validateBoard(g.board).valid ||
      boardFingerprint(g.board) !== g.board.fingerprint ||
      g.boardFingerprint !== g.board.fingerprint ||
      !DIFFICULTIES[g.board.difficulty]
    )
      return false;
    const ids = new Set(g.board.arrows.map((a) => a.id));
    if (g.remainingIds.some((id) => !ids.has(id))) return false;
    if (
      g.hintId !== null &&
      (!g.remainingIds.includes(g.hintId) ||
        !canRemove(g.board, g.remainingIds, g.hintId).allowed ||
        g.hintRevision !== g.boardRevision)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
function fatal(e) {
  app.innerHTML = `<div class="shell">${header()}<main class="recovery"><h1>保存データを開けません</h1><p id="recovery-error"></p><p>元のデータは残しています。保存領域の空きや、ほかのタブを確認してから再読み込みしてください。</p><button class="primary" id="retry">再読み込み</button><button class="secondary" id="export">元データを保存</button></main></div>`;
  app.querySelector("#recovery-error").textContent = e.message;
  app.querySelector("#retry").onclick = () => location.reload();
  app.querySelector("#export").onclick = async () => {
    try {
      const raw = await store.exportRaw(owner),
        url = URL.createObjectURL(
          new Blob([JSON.stringify(raw, null, 2)], {
            type: "application/json",
          }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = "arrow-journey-recovery.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      notify("データを取り出せませんでした。保存内容は変更していません。");
    }
  };
}
async function boot() {
  try {
    store = await openStore({ validateGame: validateSavedGame });
    profile = await store.read(owner);
    applySettings();
    render();
    systemColor.addEventListener("change", applySettings);
    // Public metadata is optional; packaged profiles keep play available offline.
    loadPublicConfig(PUBLIC_CONFIG_URL).then((result) => {
      publicProfiles = result.profiles;
      for (const p of publicProfiles) {
        const size = app.querySelector(
          `[data-difficulty="${p.difficulty}"] small`,
        );
        if (size) size.textContent = profileSizeLabel(p);
      }
    });
    cloud = await initializeCloud(FIREBASE_CONFIG, { onUser: switchUser });
    window.addEventListener("online", scheduleSync);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleSync();
    });
    if ("serviceWorker" in navigator && import.meta.env.PROD) {
      try {
        const reg = await navigator.serviceWorker.register("./sw.js");
        const reportClient = () =>
          navigator.serviceWorker.controller?.postMessage({
            type: "CLIENT_READY",
            script: import.meta.url,
          });
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          reportClient();
          updateWorker = null;
          renderNotices();
        });
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) {
            reportClient();
            reg.update().catch(() => {});
          }
        });
        navigator.serviceWorker.ready.then(reportClient);
        const offer = () => {
          if (reg.waiting && navigator.serviceWorker.controller) {
            updateWorker = reg.waiting;
            renderNotices();
          }
        };
        if (reg.waiting) offer();
        reg.addEventListener("updatefound", () =>
          reg.installing?.addEventListener("statechange", () => {
            if (reg.waiting) offer();
          }),
        );
      } catch {
        notify("オフラインの準備ができませんでした。オンラインで遊べます。");
      }
    }
  } catch (e) {
    fatal(e);
  }
}
boot();
