import { invoke } from "@tauri-apps/api/core";
import type { Application } from "pixi.js";
import type { Live2DModel } from "untitled-pixi-live2d-engine/cubism";

import type { MotionFrame } from "./motion";

const HOSTED_CORE =
  "https://cubism.live2d.com/sdk-web/core/live2dcubismcore.min.js";
const CORE_URL = ["127.0.0.1", "localhost"].includes(window.location.hostname)
  ? "/cubism-core/sdk-web/core/live2dcubismcore.min.js"
  : HOSTED_CORE;

let coreLoading: Promise<void> | null = null;
let pixiConfigured = false;

export function pixiRenderOptions(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
) {
  return {
    canvas,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    preference: "webgl" as const,
    preserveDrawingBuffer: true,
    resolution: devicePixelRatio > 0 ? devicePixelRatio : 1,
  };
}

export class Live2DView {
  private model: Live2DModel | null = null;
  private motionFrame: MotionFrame | null = null;
  private expression: MotionFrame["expression"] | null = null;
  private hitTestInFlight = false;
  private lastHitTestAt = 0;
  private readonly sourceCanvas = document.createElement("canvas");
  private readonly maskCanvas = document.createElement("canvas");

  private constructor(
    private readonly host: HTMLElement,
    private readonly app: Application,
    private readonly canvas: HTMLCanvasElement,
  ) {}

  static async create(host: HTMLElement): Promise<Live2DView> {
    ensureWebGL1Compatibility();
    await loadCubismCore();
    const [pixi, cubism] = await Promise.all([
      import("pixi.js"),
      import("untitled-pixi-live2d-engine/cubism"),
    ]);
    if (!pixiConfigured) {
      pixi.extensions.add(cubism.Live2DPlugin);
      cubism.configureCubismSDK({ memorySizeMB: 32 });
      pixiConfigured = true;
    }

    const canvas = document.createElement("canvas");
    host.append(canvas);
    const app = new pixi.Application();
    await app.init(pixiRenderOptions(canvas, window.devicePixelRatio));
    const view = new Live2DView(host, app, canvas);
    new ResizeObserver(() => view.resize()).observe(host);
    view.resize();
    return view;
  }

  async load(modelUrl: string): Promise<void> {
    this.app.stage.removeChildren();
    if (this.model) destroyModel(this.model);
    this.model = null;
    this.expression = null;

    const { Live2DModel } = await import(
      "untitled-pixi-live2d-engine/cubism"
    );
    const model = await Live2DModel.from(modelUrl, {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: true,
      eyeBlink: false,
    });
    ensurePixiTextureSourceCompatibility(model);
    adaptCubism6RenderOrders(model);
    model.anchor.set(0.5, 0.5);
    this.app.stage.addChild(model);
    this.model = model;
    const internalModel = model.internalModel as unknown as MotionInternalModel;
    internalModel.on("beforeModelUpdate", () => {
      if (this.motionFrame) {
        applyParameterFrame(internalModel.coreModel, this.motionFrame.parameters);
      }
    });
    this.resize();
  }

  setMotionFrame(frame: MotionFrame): void {
    this.motionFrame = frame;
    if (this.model && this.expression !== frame.expression) {
      this.expression = frame.expression;
      void this.model.expression(frame.expression);
    }
  }

  startHitTesting(uiElements: HTMLElement[]): void {
    const update = (now: number) => {
      if (!this.hitTestInFlight && now - this.lastHitTestAt >= 50) {
        this.lastHitTestAt = now;
        this.hitTestInFlight = true;
        this.updateWindowRegion(uiElements).finally(() => {
          this.hitTestInFlight = false;
        });
      }
      window.requestAnimationFrame(update);
    };
    window.requestAnimationFrame(update);
  }

  private async updateWindowRegion(uiElements: HTMLElement[]): Promise<void> {
    const hostBounds = this.host.getBoundingClientRect();
    const width = Math.max(Math.round(hostBounds.width), 1);
    const height = Math.max(Math.round(hostBounds.height), 1);
    this.sourceCanvas.width = width;
    this.sourceCanvas.height = height;
    const sourceContext = this.sourceCanvas.getContext("2d")!;
    sourceContext.clearRect(0, 0, width, height);
    sourceContext.drawImage(this.canvas, 0, 0, width, height);

    this.maskCanvas.width = window.innerWidth;
    this.maskCanvas.height = window.innerHeight;
    const context = this.maskCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;
    context.drawImage(
      this.sourceCanvas,
      hostBounds.left,
      hostBounds.top,
      hostBounds.width,
      hostBounds.height,
    );

    context.fillStyle = "#fff";
    for (const element of uiElements) {
      const elementStyle = window.getComputedStyle(element);
      if (
        elementStyle.display === "none" ||
        elementStyle.visibility === "hidden" ||
        Number.parseFloat(elementStyle.opacity) === 0
      ) {
        continue;
      }
      const bounds = element.getBoundingClientRect();
      context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
    }

    const pixels = context.getImageData(
      0,
      0,
      this.maskCanvas.width,
      this.maskCanvas.height,
    ).data;
    await invoke("set_window_region", {
      width: this.maskCanvas.width,
      height: this.maskCanvas.height,
      runs: alphaRuns(pixels, this.maskCanvas.width, this.maskCanvas.height),
    });
  }

  private resize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    const safeWidth = Math.max(width, 1);
    const safeHeight = Math.max(height, 1);
    this.app.renderer.resize(safeWidth, safeHeight);
    if (!this.model) return;
    const scale =
      Math.min(
        safeWidth / this.model.internalModel.width,
        safeHeight / this.model.internalModel.height,
      ) * 0.98;
    this.model.scale.set(scale);
    this.model.position.set(safeWidth / 2, safeHeight / 2);
  }
}

interface ParameterId {
  getString(): { s: string };
}

export interface ParameterCoreModel {
  getParameterCount(): number;
  getParameterId(index: number): ParameterId;
  getParameterMinimumValue(index: number): number;
  getParameterMaximumValue(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
}

interface MotionInternalModel {
  coreModel: ParameterCoreModel;
  on(event: "beforeModelUpdate", listener: () => void): void;
}

export function applyParameterFrame(
  coreModel: ParameterCoreModel,
  parameters: Record<string, number>,
): void {
  for (let index = 0; index < coreModel.getParameterCount(); index += 1) {
    const id = coreModel.getParameterId(index).getString().s;
    const value = parameters[id];
    if (value === undefined) continue;
    coreModel.setParameterValueByIndex(
      index,
      Math.min(
        Math.max(value, coreModel.getParameterMinimumValue(index)),
        coreModel.getParameterMaximumValue(index),
      ),
    );
  }
}

function destroyModel(model: Live2DModel): void {
  const textures = [...model.textures];
  model.destroy({ children: true, texture: false });
  for (const texture of textures) texture.destroy(true);
}

function loadCubismCore(): Promise<void> {
  if ("Live2DCubismCore" in window) return Promise.resolve();
  if (coreLoading) return coreLoading;
  coreLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CORE_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Cubism Core could not be loaded"));
    document.head.append(script);
  });
  return coreLoading;
}

function ensureWebGL1Compatibility(): void {
  const globals = window as unknown as {
    WebGLRenderingContext?: unknown;
    WebGL2RenderingContext?: unknown;
  };
  globals.WebGLRenderingContext ??=
    globals.WebGL2RenderingContext ?? { UNPACK_FLIP_Y_WEBGL: 0x9240 };
}

function ensurePixiTextureSourceCompatibility(model: Live2DModel): void {
  for (const texture of model.textures) {
    const source = texture.source as { _gpuData?: Record<number, unknown> };
    source._gpuData ??= {};
  }
}

function adaptCubism6RenderOrders(model: Live2DModel): void {
  const core = model.internalModel.coreModel as unknown as {
    getDrawableRenderOrders(): Int32Array;
    _model?: { getRenderOrders?: () => Int32Array };
  };
  const getRenderOrders = core._model?.getRenderOrders;
  if (getRenderOrders) {
    core.getDrawableRenderOrders = () => getRenderOrders.call(core._model);
  }
}

export function alphaRuns(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): number[] {
  const runs: number[] = [];
  for (let y = 0; y < height; y += 1) {
    let x = 0;
    while (x < width) {
      while (x < width && pixels[(y * width + x) * 4 + 3] === 0) x += 1;
      const start = x;
      while (x < width && pixels[(y * width + x) * 4 + 3] !== 0) x += 1;
      if (start < x) runs.push(y, start, x);
    }
  }
  return runs;
}
