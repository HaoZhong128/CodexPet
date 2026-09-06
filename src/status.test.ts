// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import {
  isTerminal,
  statusPresentation,
  type StatusUpdate,
} from "./status";
import { loadSettings } from "./settings";

const statusMocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<StatusUpdate>>(),
  listenForStatus:
    vi.fn<
      (onUpdate: (update: StatusUpdate) => void) => Promise<() => void>
    >(),
}));

const tauriMocks = vi.hoisted(() => ({
  invoke:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
}));

const windowMocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  resizePetWindow: vi.fn<() => Promise<void>>(),
  resetPetPosition: vi.fn<() => Promise<void>>(),
}));

const live2dMock = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  setExpression: vi.fn(),
  setMotionFrame: vi.fn(),
  startHitTesting: vi.fn(),
}));

vi.mock("./status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status")>()),
  getStatus: statusMocks.getStatus,
  listenForStatus: statusMocks.listenForStatus,
}));

vi.mock("./live2d", () => ({
  Live2DView: {
    create: vi.fn(async (host: HTMLElement) => {
      host.append(document.createElement("canvas"));
      return live2dMock;
    }),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: windowMocks.close }),
}));

vi.mock("./window-position", () => ({
  resizePetWindow: windowMocks.resizePetWindow,
  resetPetPosition: windowMocks.resetPetPosition,
}));

function update(
  state: StatusUpdate["state"],
  bubbleText: string | null = null,
): StatusUpdate {
  const active = state === "running" || state.startsWith("waiting_");
  const waiting = state.startsWith("waiting_");
  return {
    state,
    activeCount: active ? 1 : 0,
    runningCount: active && !waiting ? 1 : 0,
    waitingCount: waiting ? 1 : 0,
    activeSinceMs: active ? 1_000 : null,
    bubbleText,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pointer(
  type: string,
  x: number,
  y: number,
  button = 0,
  pointerId = 1,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as PointerEvent;
}

let emitStatus: (update: StatusUpdate) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  live2dMock.load.mockResolvedValue();
  windowMocks.close.mockResolvedValue();
  windowMocks.resizePetWindow.mockResolvedValue();
  windowMocks.resetPetPosition.mockResolvedValue();
  statusMocks.listenForStatus.mockImplementation(async (onUpdate) => {
    emitStatus = onUpdate;
    return () => undefined;
  });
  tauriMocks.invoke.mockImplementation(async (command) =>
    command === "play_headpat_voice" ? "嗯？" : null,
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("status contract", () => {
  it("presents running and waiting counts separately", () => {
    const view = statusPresentation(
      {
        state: "waiting_choice",
        activeCount: 3,
        runningCount: 2,
        waitingCount: 1,
        activeSinceMs: 1_000,
        bubbleText: null,
      },
      4_000,
    );

    expect(view).toEqual({
      label: "等待选择",
      tone: "waiting",
      running: "运行 2",
      waiting: "等待你 1",
      elapsed: "00:00:03",
    });
  });

  it("formats elapsed time through the first hour", () => {
    const running = update("running");
    expect(statusPresentation(running, 1_000).elapsed).toBe("00:00:00");
    expect(statusPresentation(running, 3_600_999).elapsed).toBe("00:59:59");
    expect(statusPresentation(running, 3_601_000).elapsed).toBe("01:00:00");
  });

  it("keeps failed as a display-only mapping", () => {
    expect(statusPresentation(update("failed"), 10_000)).toMatchObject({
      label: "任务失败",
      tone: "failed",
    });
  });

  it("renders the structured status card with true task counts", async () => {
    vi.setSystemTime(4_000);
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);

    app.applyStatus({
      state: "waiting_permission",
      activeCount: 3,
      runningCount: 2,
      waitingCount: 1,
      activeSinceMs: 1_000,
      bubbleText: "需要授权。",
    });

    expect(root.querySelector("#hud")!.getAttribute("data-tone")).toBe(
      "waiting",
    );
    expect(root.querySelector("#status-name")!.textContent).toBe("等待授权");
    expect(root.querySelector("#status-running")!.textContent).toBe("运行 2");
    expect(root.querySelector("#status-waiting")!.textContent).toBe("等待你 1");
    expect(root.querySelector("#status-elapsed")!.textContent).toBe("00:00:03");

    app.applyStatus(update("running"));
    expect(
      root.querySelector<HTMLElement>("#status-waiting")!.hidden,
    ).toBe(true);
  });

  it("drives one parameter motion from the latest status", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    let motionTick!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      motionTick = callback;
      return 1;
    });
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);

    app.applyStatus(update("running"));
    motionTick(400);

    expect(live2dMock.setMotionFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "running" }),
    );
  });

  it("keeps the app DOM free of canceled action props", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    let motionTick!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      motionTick = callback;
      return 1;
    });
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);

    app.applyStatus(update("running"));
    motionTick(400);

    expect(root.querySelector("#props")).toBeNull();
    expect(root.querySelector("#weapon")).toBeNull();
    expect(root.querySelector("#accessory")).toBeNull();
    expect(root.querySelector<HTMLCanvasElement>("canvas")!.style.transform).toBe(
      "",
    );
  });

  it("keeps outfit choices alongside the compact settings menu", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;

    await new App().mount(root);

    expect(
      [...root.querySelectorAll<HTMLButtonElement>("#menu button")].map(
        (button) => [button.dataset.kind, button.textContent],
      ),
    ).toEqual([
      ["outfit", "默认服装"],
      ["outfit", "女仆服装"],
      ["size", "75%"],
      ["size", "100%"],
      ["size", "125%"],
      ["mute", "静音"],
      ["panel", "隐藏状态面板"],
      ["reset", "回到右下角"],
      ["exit", "退出 CodexPet"],
    ]);
    expect(root.querySelector<HTMLInputElement>("#voice-volume")).not.toBeNull();
  });

  it("opens the menu only from a pet right click", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    tauriMocks.invoke.mockClear();
    const pet = root.querySelector<HTMLElement>("#pet")!;
    const hud = root.querySelector<HTMLElement>("#hud")!;
    const menu = root.querySelector<HTMLElement>("#menu")!;

    pet.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
    );
    expect(menu.classList.contains("is-open")).toBe(true);
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("start_dragging");
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("play_headpat_voice");

    menu.classList.remove("is-open");
    hud.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
    );
    expect(menu.classList.contains("is-open")).toBe(false);
  });

  it("uses movement threshold to choose drag instead of headpat", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    tauriMocks.invoke.mockClear();
    const pet = root.querySelector<HTMLElement>("#pet")!;

    pet.dispatchEvent(pointer("pointerdown", 10, 10));
    pet.dispatchEvent(pointer("pointermove", 16, 10));
    pet.dispatchEvent(pointer("pointermove", 20, 10));

    expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
    expect(tauriMocks.invoke).toHaveBeenCalledWith("start_dragging");
    expect(tauriMocks.invoke).not.toHaveBeenCalledWith("play_headpat_voice");
  });

  it("uses a short stationary left click for headpat", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    tauriMocks.invoke.mockClear();
    const pet = root.querySelector<HTMLElement>("#pet")!;

    pet.dispatchEvent(pointer("pointerdown", 10, 10));
    pet.dispatchEvent(pointer("pointerup", 12, 11));
    await Promise.resolve();

    expect(tauriMocks.invoke).toHaveBeenCalledWith("play_headpat_voice");
    expect(root.querySelector("#bubble")!.textContent).toBe("嗯？");
  });

  it("does not let delayed headpat text replace a newer status bubble", async () => {
    const headpat = deferred<unknown>();
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === "play_headpat_voice") return headpat.promise;
      return null;
    });
    statusMocks.getStatus.mockResolvedValue(update("idle", "空闲。"));
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);
    const pet = root.querySelector<HTMLElement>("#pet")!;

    pet.dispatchEvent(pointer("pointerdown", 10, 10));
    pet.dispatchEvent(pointer("pointerup", 10, 10));
    app.applyStatus(update("running", "正在工作。"));
    headpat.resolve("嗯？");
    await Promise.resolve();

    expect(root.querySelector("#bubble")!.textContent).toBe("正在工作。");
  });

  it("restores the current status bubble after headpat", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle", "空闲。"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    const pet = root.querySelector<HTMLElement>("#pet")!;

    pet.dispatchEvent(pointer("pointerdown", 10, 10));
    pet.dispatchEvent(pointer("pointerup", 10, 10));
    await Promise.resolve();
    expect(root.querySelector("#bubble")!.textContent).toBe("嗯？");

    await vi.advanceTimersByTimeAsync(3_200);
    expect(root.querySelector("#bubble")!.textContent).toBe("空闲。");
  });

  it("resizes through fixed choices and saves the selection", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    windowMocks.resizePetWindow.mockClear();

    root
      .querySelector<HTMLButtonElement>('[data-kind="size"][data-value="large"]')!
      .click();
    await Promise.resolve();

    expect(windowMocks.resizePetWindow).toHaveBeenCalledWith("large");
    expect(loadSettings()).toMatchObject({ size: "large" });
  });

  it("updates volume immediately without closing the menu", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    tauriMocks.invoke.mockClear();
    const menu = root.querySelector<HTMLElement>("#menu")!;
    menu.classList.add("is-open");
    const slider = root.querySelector<HTMLInputElement>("#voice-volume")!;

    slider.value = "42";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(tauriMocks.invoke).toHaveBeenCalledWith("set_voice_volume", {
      volume: 42,
    });
    expect(loadSettings()).toMatchObject({ volume: 42, muted: false });
    expect(menu.classList.contains("is-open")).toBe(true);
  });

  it("mutes and restores the prior volume", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    tauriMocks.invoke.mockClear();
    const mute = root.querySelector<HTMLButtonElement>('[data-kind="mute"]')!;

    mute.click();
    await Promise.resolve();
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("set_voice_volume", {
      volume: 0,
    });
    expect(mute.textContent).toBe("恢复声音");
    expect(mute.classList.contains("is-selected")).toBe(true);

    mute.click();
    await Promise.resolve();
    expect(tauriMocks.invoke).toHaveBeenLastCalledWith("set_voice_volume", {
      volume: 70,
    });
    expect(loadSettings()).toMatchObject({ volume: 70, muted: false });
  });

  it("toggles the status panel without stopping status updates", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    const panel = root.querySelector<HTMLButtonElement>('[data-kind="panel"]')!;

    panel.click();

    expect(root.querySelector<HTMLElement>("#hud")!.hidden).toBe(true);
    expect(panel.textContent).toBe("显示状态面板");
    expect(statusMocks.listenForStatus).toHaveBeenCalledOnce();
    emitStatus(update("running"));
    expect(root.className).toBe("pet-shell pet--running");
  });

  it("resets position and exits in a safe order", async () => {
    const order: string[] = [];
    const unlisten = vi.fn(() => order.push("unlisten"));
    statusMocks.listenForStatus.mockImplementation(async (onUpdate) => {
      emitStatus = onUpdate;
      return unlisten;
    });
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    windowMocks.resetPetPosition.mockImplementation(async () => {
      order.push("reset");
    });
    tauriMocks.invoke.mockImplementation(async (command) => {
      if (command === "stop_voice") order.push("stop");
      return null;
    });
    windowMocks.close.mockImplementation(async () => {
      order.push("close");
    });
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);

    root.querySelector<HTMLButtonElement>('[data-kind="reset"]')!.click();
    await Promise.resolve();
    root.querySelector<HTMLButtonElement>('[data-kind="exit"]')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["reset", "unlisten", "stop", "close"]);
  });

  it("restricts native hit testing to the open menu", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);
    const menu = root.querySelector<HTMLElement>("#menu")!;

    expect(live2dMock.startHitTesting).toHaveBeenCalledWith([menu]);
  });

  it("shows waiting choice as active work and not as an interruption", () => {
    const waiting: StatusUpdate = {
      state: "waiting_choice",
      activeCount: 1,
      runningCount: 0,
      waitingCount: 1,
      activeSinceMs: 1_000,
      bubbleText: "主人，请选一个吧。",
    };

    expect(statusPresentation(waiting, 4_000)).toMatchObject({
      running: "运行 0",
      waiting: "等待你 1",
      elapsed: "00:00:03",
    });
    expect(isTerminal(waiting)).toBe(false);

    const interrupted: StatusUpdate = {
      state: "interrupted",
      activeCount: 0,
      runningCount: 0,
      waitingCount: 0,
      activeSinceMs: null,
      bubbleText: "任务中断了。",
    };
    expect(isTerminal(interrupted)).toBe(true);
    expect(isTerminal(update("failed"))).toBe(true);
  });

  it("subscribes before loading the snapshot and keeps a newer live status", async () => {
    const snapshot = deferred<StatusUpdate>();
    statusMocks.getStatus.mockReturnValueOnce(snapshot.promise);
    const root = document.querySelector<HTMLElement>("#app")!;
    const mounting = new App().mount(root);

    await vi.waitFor(() => {
      expect(statusMocks.listenForStatus).toHaveBeenCalledOnce();
      expect(statusMocks.getStatus).toHaveBeenCalledOnce();
    });
    emitStatus(update("waiting_choice", "请选择。"));
    snapshot.resolve(update("running", "旧快照。"));
    await mounting;

    expect(root.className).toBe("pet-shell pet--waiting_choice");
    expect(root.querySelector("#bubble")!.textContent).toBe("请选择。");
  });

  it("keeps a live status received while listener registration is pending", async () => {
    const listening = deferred<() => void>();
    statusMocks.listenForStatus.mockImplementation((onUpdate) => {
      emitStatus = onUpdate;
      return listening.promise;
    });
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    const mounting = new App().mount(root);

    await vi.waitFor(() => {
      expect(statusMocks.listenForStatus).toHaveBeenCalledOnce();
    });
    emitStatus(update("completed", "刚刚完成。"));
    listening.resolve(() => undefined);
    await mounting;

    expect(root.className).toBe("pet-shell pet--completed");
    expect(root.querySelector("#bubble")!.textContent).toBe("刚刚完成。");
  });

  it("cancels a terminal reset when a newer live status arrives", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);

    app.applyStatus(update("completed", "完成。"));
    emitStatus(update("waiting_choice", "还在等选择。"));
    await vi.advanceTimersByTimeAsync(3_000);

    expect(root.className).toBe("pet-shell pet--waiting_choice");
    expect(root.querySelector("#bubble")!.textContent).toBe("还在等选择。");
  });

  it("does not apply a terminal refresh after a newer live status", async () => {
    const refresh = deferred<StatusUpdate>();
    statusMocks.getStatus
      .mockResolvedValueOnce(update("idle"))
      .mockReturnValueOnce(refresh.promise);
    const root = document.querySelector<HTMLElement>("#app")!;
    const app = new App();
    await app.mount(root);

    app.applyStatus(update("completed", "完成。"));
    await vi.advanceTimersByTimeAsync(3_000);
    emitStatus(update("waiting_choice", "新的选择。"));
    refresh.resolve(update("running", "旧刷新。"));
    await Promise.resolve();

    expect(root.className).toBe("pet-shell pet--waiting_choice");
    expect(root.querySelector("#bubble")!.textContent).toBe("新的选择。");
  });

  it("keeps an opened menu inside the root bounds", async () => {
    statusMocks.getStatus.mockResolvedValue(update("idle"));
    const root = document.querySelector<HTMLElement>("#app")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 560,
      width: 400,
      height: 560,
      toJSON: () => undefined,
    });
    await new App().mount(root);
    const menu = root.querySelector<HTMLElement>("#menu")!;
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue({
      x: 390,
      y: 500,
      left: 390,
      top: 500,
      right: 518,
      bottom: 740,
      width: 128,
      height: 240,
      toJSON: () => undefined,
    });

    root.querySelector<HTMLElement>("#pet")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 390,
        clientY: 500,
      }),
    );

    expect(menu.style.left).toBe("272px");
    expect(menu.style.top).toBe("320px");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.classList.contains("is-open")).toBe(false);

    root
      .querySelector<HTMLElement>("#pet")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("pointerdown"));
    expect(menu.classList.contains("is-open")).toBe(false);
  });

});
