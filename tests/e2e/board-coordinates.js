// Use the browser's rendered SVG transform, including a tall viewport and saved pan/zoom.
export async function boardCoordinates(page) {
  const matrix = await page.locator("#board svg > g").evaluate((scene) => {
    const { a, b, c, d, e, f } = scene.getScreenCTM();
    return { a, b, c, d, e, f };
  });
  return ([x, y], [dx, dy] = [0.5, 0.5]) => ({
    x: matrix.a * (x + dx) + matrix.c * (y + dy) + matrix.e,
    y: matrix.b * (x + dx) + matrix.d * (y + dy) + matrix.f,
  });
}
