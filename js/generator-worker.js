import { generateBoard } from "./engine.js";

self.addEventListener("message", ({ data }) => {
  const requestId = data?.requestId;
  try {
    const board = generateBoard(data?.difficulty, data?.seed, {
      shape: data?.shape,
    });
    self.postMessage({ requestId, board });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
