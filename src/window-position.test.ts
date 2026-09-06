import { describe, expect, it } from "vitest";

import {
  PET_SIZES,
  clampPosition,
  preserveBottomRight,
} from "./window-position";

const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

describe("pet window geometry", () => {
  it("uses the three fixed logical sizes", () => {
    expect(PET_SIZES).toEqual({
      small: { width: 300, height: 420 },
      standard: { width: 400, height: 560 },
      large: { width: 500, height: 700 },
    });
  });

  it("clamps a window inside the work area with a margin", () => {
    expect(
      clampPosition(
        { x: 1900, y: 1040 },
        { width: 500, height: 700 },
        workArea,
        12,
      ),
    ).toEqual({ x: 1408, y: 328 });
  });

  it("preserves a near bottom-right anchor while resizing", () => {
    expect(
      preserveBottomRight(
        { x: 1508, y: 468 },
        { width: 400, height: 560 },
        { width: 500, height: 700 },
        workArea,
        12,
      ),
    ).toEqual({ x: 1408, y: 328 });
  });

  it("keeps a middle-screen top-left position", () => {
    expect(
      preserveBottomRight(
        { x: 700, y: 200 },
        { width: 400, height: 560 },
        { width: 500, height: 700 },
        workArea,
        12,
      ),
    ).toEqual({ x: 700, y: 200 });
  });
});
