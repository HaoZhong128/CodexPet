// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { alphaRuns } from "./live2d";

describe("alphaRuns", () => {
  it("keeps transparent gaps instead of collapsing visible pixels to a box", () => {
    const width = 5;
    const height = 3;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (const [x, y, alpha] of [
      [1, 0, 255],
      [2, 0, 1],
      [4, 0, 255],
      [0, 2, 255],
      [1, 2, 255],
      [2, 2, 255],
      [3, 2, 255],
      [4, 2, 255],
    ]) {
      pixels[(y * width + x) * 4 + 3] = alpha;
    }

    expect(alphaRuns(pixels, width, height)).toEqual([
      0, 1, 3,
      0, 4, 5,
      2, 0, 5,
    ]);
  });
});
