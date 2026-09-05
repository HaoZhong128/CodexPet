// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { hudText, isTerminal, type StatusUpdate } from "./status";

const statusMocks = vi.hoisted(() => ({
  getStatus: vi.fn<() => Promise<StatusUpdate>>(),
  listenForStatus:
    vi.fn<
      (onUpdate: (update: StatusUpdate) => void) => Promise<() => void>
    >(),
}));

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string) => Promise<unknown>>(),
}));

const live2dMock = vi.hoisted(() => ({
  load: vi.fn<() => Promise<void>>(),
  setExpression: vi.fn(),
  startHitTesting: vi.fn(),
}));

vi.mock("./status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./status")>()),
  getStatus: statusMocks.getStatus,
  listenForStatus: statusMocks.listenForStatus,
}));

vi.mock("./live2d", () => ({
  Live2DView: {
    create: vi.fn(async () => live2dMock),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
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

let emitStatus: (update: StatusUpdate) => void;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="app"></div>';
  live2dMock.load.mockResolvedValue();
  statusMocks.listenForStatus.mockImplementation(async (onUpdate) => {
    emitStatus = onUpdate;
    return () => undefined;
  });
  tauriMocks.invoke.mockImplementation(async (command) =>
    command === "play_click_voice" ? "当断即断！" : null,
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("status contract", () => {
  it("shows waiting choice as active work and not as an interruption", () => {
    const waiting: StatusUpdate = {
      state: "waiting_choice",
      activeCount: 1,
      runningCount: 0,
      waitingCount: 1,
      activeSinceMs: 1_000,
      bubbleText: "主人，请选一个吧。",
    };

    expect(hudText(waiting, 4_000)).toBe(
      "进行中 1 · 等待你 1\n已运行 00:00:03",
    );
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

    root.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        clientX: 390,
        clientY: 500,
      }),
    );

    expect(menu.style.left).toBe("272px");
    expect(menu.style.top).toBe("320px");
  });

  it("shows click feedback for three seconds and restores the status bubble", async () => {
    statusMocks.getStatus.mockResolvedValue(
      update("running", "管理员，我还在工作。"),
    );
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);

    root.querySelector<HTMLElement>("#pet")!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await vi.waitFor(() => {
      expect(root.querySelector("#bubble")!.textContent).toBe("当断即断！");
    });

    await vi.advanceTimersByTimeAsync(3_000);

    expect(root.querySelector("#bubble")!.textContent).toBe(
      "管理员，我还在工作。",
    );
  });

  it("keeps a newer status when click feedback finishes loading later", async () => {
    const clickFeedback = deferred<string | null>();
    tauriMocks.invoke.mockImplementation(async (command) =>
      command === "play_click_voice" ? clickFeedback.promise : null,
    );
    statusMocks.getStatus.mockResolvedValue(update("running", "正在处理。"));
    const root = document.querySelector<HTMLElement>("#app")!;
    await new App().mount(root);

    root.querySelector<HTMLElement>("#pet")!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    emitStatus(update("waiting_choice", "管理员，请审核。"));
    clickFeedback.resolve("当断即断！");
    await clickFeedback.promise;
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(root.querySelector("#bubble")!.textContent).toBe(
      "管理员，请审核。",
    );
  });
});
