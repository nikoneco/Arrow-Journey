export const ARROW_THEMES = Object.freeze(
  [
    { id: "forest", label: "グリーン", ink: "#293f37", darkInk: "#a0cdb1" },
    { id: "ocean", label: "ブルー", ink: "#205879", darkInk: "#8fc2e2" },
    { id: "grape", label: "パープル", ink: "#66517a", darkInk: "#c5addf" },
    { id: "ember", label: "テラコッタ", ink: "#a04e35", darkInk: "#e6ac91" },
  ].map((theme) => Object.freeze(theme)),
);

export const APPEARANCE_MODES = Object.freeze(
  [
    { id: "light", label: "ライト" },
    { id: "dark", label: "ダーク" },
    { id: "system", label: "端末に合わせる" },
  ].map((mode) => Object.freeze(mode)),
);
