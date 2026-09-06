// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { Live2DView, pixiRenderOptions } from "./live2d";
import type { MotionFrame } from "./motion";

const modelSource = vi.hoisted(() => ({ queue: [] as unknown[] }));
const tauriMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("untitled-pixi-live2d-engine/cubism", () => ({
  Live2DModel: {
    from: vi.fn(async () => modelSource.queue.shift()),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMocks.invoke }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
      preserveDrawingBuffer: true,
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
    ) => Live2DView;
    const view = new View(host, app, document.createElement("canvas"));

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

  it("samples the visible canvas without rendering the model offscreen", async () => {
    const context = {
      putImageData: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) })),
      fillStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as never,
    );
    tauriMocks.invoke.mockResolvedValue(null);
    const extract = vi.fn(() => ({
      width: 2,
      height: 2,
      pixels: new Uint8ClampedArray(16),
    }));
    const host = document.createElement("div");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 2,
      height: 2,
    } as DOMRect);
    const app = {
      stage: {},
      renderer: { extract: { pixels: extract } },
    };
    const View = Live2DView as unknown as new (
      host: HTMLElement,
      app: unknown,
      canvas: HTMLCanvasElement,
    ) => Live2DView;
    const visibleCanvas = document.createElement("canvas");
    const view = new View(host, app, visibleCanvas);

    await (
      view as unknown as {
        updateWindowRegion(elements: HTMLElement[]): Promise<void>;
      }
    ).updateWindowRegion([]);

    expect(extract).not.toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalledWith(visibleCanvas, 0, 0, 2, 2);
  });
});
