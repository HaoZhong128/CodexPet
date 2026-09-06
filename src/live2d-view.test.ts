// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { Live2DView, pixiRenderOptions } from "./live2d";
import type { MotionFrame } from "./motion";

const modelSource = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("untitled-pixi-live2d-engine/cubism", () => ({
  Live2DModel: {
    from: vi.fn(async () => modelSource.queue.shift()),
  },
}));

function model() {
  return {
    textures: [],
    anchor: { set: vi.fn() },
    scale: { set: vi.fn() },
    position: { set: vi.fn() },
    expression: vi.fn(async () => undefined),
    destroy: vi.fn(),
    internalModel: {
      width: 100,
      height: 100,
      coreModel: {},
      on: vi.fn(),
    },
  };
}

function frame(): MotionFrame {
  return {
    action: "idle",
    expression: "happy",
    parameters: {},
  };
}

describe("Live2DView", () => {
  it("uses DPR for the Pixi backing resolution", () => {
    const canvas = document.createElement("canvas");

    expect(pixiRenderOptions(canvas, 1.5)).toMatchObject({
      canvas,
      resolution: 1.5,
      autoDensity: true,
      antialias: true,
      backgroundAlpha: 0,
      preference: "webgl",
    });
    expect(pixiRenderOptions(canvas, 0).resolution).toBe(1);
  });

  it("reapplies the current expression after an outfit model is replaced", async () => {
    const first = model();
    const second = model();
    modelSource.queue.push(first, second);
    const host = document.createElement("div");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 560,
    } as DOMRect);
    const app = {
      stage: { removeChildren: vi.fn(), addChild: vi.fn() },
      renderer: { resize: vi.fn() },
    };
    const View = Live2DView as unknown as new (
      host: HTMLElement,
      app: unknown,
      canvas: HTMLCanvasElement,
      rectangle: unknown,
    ) => Live2DView;
    const view = new View(host, app, document.createElement("canvas"), class {});

    await view.load("first.model3.json");
    view.setMotionFrame(frame());
    await view.load("second.model3.json");
    view.setMotionFrame(frame());

    expect(first.expression).toHaveBeenCalledWith("happy");
    expect(second.expression).toHaveBeenCalledWith("happy");
    expect(app.renderer.resize).toHaveBeenCalledWith(400, 560);
    expect(second.scale.set).toHaveBeenCalled();
    expect(second.position.set).toHaveBeenCalledWith(200, 280);
  });
});
