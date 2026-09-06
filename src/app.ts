import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { Live2DView } from "./live2d";
import { MotionController } from "./motion";
import {
  effectiveVolume,
  loadSettings,
  saveSettings,
  setVolume,
  toggleMuted,
  type AppSettings,
  type PetSize,
} from "./settings";
import {
  getStatus,
  isTerminal,
  listenForStatus,
  statusPresentation,
  type StatusUpdate,
} from "./status";
import { resetPetPosition, resizePetWindow } from "./window-position";

type Outfit = "default" | "maid";

const MODELS: Record<Outfit, string> = {
  default: "/live2d/default/character-default.model3.json",
  maid: "/live2d/maid/character-maid.model3.json",
};

const OUTFITS: ReadonlyArray<readonly [Outfit, string]> = [
  ["default", "默认服装"],
  ["maid", "女仆服装"],
];

export class App {
  private root!: HTMLElement;
  private live2d!: Live2DView;
  private status: StatusUpdate | null = null;
  private outfit: Outfit = "default";
  private readonly motion = new MotionController();
  private outfitLoad: Promise<void> = Promise.resolve();
  private statusGeneration = 0;
  private headpatGeneration = 0;
  private terminalResetTimer: number | undefined;
  private settings: AppSettings = loadSettings();
  private unlistenStatus: (() => void) | undefined;

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    root.innerHTML =
      '<div id="pet"></div><div id="bubble"></div><section id="hud" aria-label="Codex 状态"><div class="status-heading"><span class="status-dot"></span><span class="status-title">CodexPet</span><span id="status-name"></span></div><div class="status-meta"><span id="status-running"></span><span id="status-waiting"></span><span id="status-elapsed"></span></div></section><div id="menu"></div>';

    const pet = root.querySelector<HTMLElement>("#pet")!;
    const bubble = root.querySelector<HTMLElement>("#bubble")!;
    const hud = root.querySelector<HTMLElement>("#hud")!;
    const menu = root.querySelector<HTMLElement>("#menu")!;
    this.settings = loadSettings();
    await resizePetWindow(this.settings.size);
    await invoke("set_voice_volume", {
      volume: effectiveVolume(this.settings),
    });
    this.live2d = await Live2DView.create(pet);

    bindMenu(root, pet, menu, {
      outfit: (value) => void this.setOutfit(value),
      size: (value) => void this.setSize(value),
      volume: (value) => this.setVoiceVolume(value),
      mute: () => this.toggleVoiceMuted(),
      panel: () => this.toggleStatusPanel(),
      reset: () => void resetPetPosition(),
      exit: () => void this.exit(),
    });
    this.renderSettings();
    await this.setOutfit("default");
    this.markMenuSelection();
    this.bindPointerActions(pet);
    this.startMotionLoop();
    this.live2d.startHitTesting([bubble, hud, menu]);

    const generation = this.statusGeneration;
    this.unlistenStatus = await listenForStatus((update) =>
      this.applyStatus(update),
    );
    const snapshot = await getStatus();
    if (this.statusGeneration === generation) this.applyStatus(snapshot);
    window.setInterval(() => {
      if (this.status) this.renderHud(this.status);
    }, 1_000);
  }

  async setOutfit(outfit: Outfit): Promise<void> {
    this.outfit = outfit;
    this.markMenuSelection();
    const request = this.outfitLoad.then(async () => {
      if (this.outfit !== outfit) return;
      await this.live2d.load(MODELS[outfit]);
    });
    this.outfitLoad = request.catch(() => undefined);
    await this.outfitLoad;
  }

  applyStatus(update: StatusUpdate): void {
    this.statusGeneration += 1;
    this.headpatGeneration += 1;
    if (this.terminalResetTimer !== undefined) {
      window.clearTimeout(this.terminalResetTimer);
      this.terminalResetTimer = undefined;
    }
    this.status = update;
    this.motion.setStatus(update, performance.now());
    this.root.className = `pet-shell pet--${update.state}`;
    this.root.querySelector("#bubble")!.textContent = update.bubbleText ?? "";
    this.renderHud(update);
    if (isTerminal(update)) {
      this.terminalResetTimer = window.setTimeout(async () => {
        this.terminalResetTimer = undefined;
        const generation = this.statusGeneration;
        const snapshot = await getStatus();
        if (this.statusGeneration === generation) this.applyStatus(snapshot);
      }, 3_000);
    }
  }

  private renderHud(update: StatusUpdate): void {
    const view = statusPresentation(update, Date.now());
    const hud = this.root.querySelector<HTMLElement>("#hud")!;
    hud.dataset.tone = view.tone;
    this.root.querySelector("#status-name")!.textContent = view.label;
    this.root.querySelector("#status-running")!.textContent = view.running;
    const waiting = this.root.querySelector<HTMLElement>("#status-waiting")!;
    waiting.textContent = view.waiting ?? "";
    waiting.hidden = view.waiting === null;
    const elapsed = this.root.querySelector<HTMLElement>("#status-elapsed")!;
    elapsed.textContent = view.elapsed ?? "";
    elapsed.hidden = view.elapsed === null;
  }

  private markMenuSelection(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      '#menu button[data-kind="outfit"]',
    )) {
      button.classList.toggle(
        "is-selected",
        button.dataset.value === this.outfit,
      );
    }
  }

  private bindPointerActions(pet: HTMLElement): void {
    let pointerState:
      | { id: number; x: number; y: number; dragging: boolean }
      | undefined;
    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      pointerState = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
    });
    pet.addEventListener("pointermove", (event) => {
      if (
        !pointerState ||
        pointerState.id !== event.pointerId ||
        pointerState.dragging
      ) {
        return;
      }
      if (
        Math.hypot(
          event.clientX - pointerState.x,
          event.clientY - pointerState.y,
        ) > 4
      ) {
        pointerState.dragging = true;
        void invoke("start_dragging");
      }
    });
    pet.addEventListener("pointerup", (event) => {
      if (!pointerState || pointerState.id !== event.pointerId) return;
      const stationary =
        !pointerState.dragging &&
        Math.hypot(
          event.clientX - pointerState.x,
          event.clientY - pointerState.y,
        ) <= 4;
      pointerState = undefined;
      if (stationary) void this.startHeadpat();
    });
    pet.addEventListener("pointercancel", () => {
      pointerState = undefined;
    });
  }

  private async startHeadpat(): Promise<void> {
    this.motion.startHeadpat(performance.now());
    const statusGeneration = this.statusGeneration;
    const headpatGeneration = ++this.headpatGeneration;
    const text = await invoke<string | null>("play_headpat_voice");
    if (
      !text ||
      statusGeneration !== this.statusGeneration ||
      headpatGeneration !== this.headpatGeneration
    ) {
      return;
    }
    this.root.querySelector("#bubble")!.textContent = text;
    window.setTimeout(() => {
      if (
        statusGeneration === this.statusGeneration &&
        headpatGeneration === this.headpatGeneration
      ) {
        this.root.querySelector("#bubble")!.textContent =
          this.status?.bubbleText ?? "";
      }
    }, 3_200);
  }

  private async setSize(size: PetSize): Promise<void> {
    this.settings = { ...this.settings, size };
    saveSettings(this.settings);
    this.renderSettings();
    await resizePetWindow(size);
  }

  private setVoiceVolume(value: number): void {
    this.settings = setVolume(this.settings, value);
    saveSettings(this.settings);
    this.renderSettings();
    void invoke("set_voice_volume", {
      volume: effectiveVolume(this.settings),
    });
  }

  private toggleVoiceMuted(): void {
    this.settings = toggleMuted(this.settings);
    saveSettings(this.settings);
    this.renderSettings();
    void invoke("set_voice_volume", {
      volume: effectiveVolume(this.settings),
    });
  }

  private toggleStatusPanel(): void {
    this.settings = {
      ...this.settings,
      status_panel_visible: !this.settings.status_panel_visible,
    };
    saveSettings(this.settings);
    this.renderSettings();
  }

  private renderSettings(): void {
    this.root.querySelector<HTMLElement>("#hud")!.hidden =
      !this.settings.status_panel_visible;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      '#menu button[data-kind="size"]',
    )) {
      button.classList.toggle(
        "is-selected",
        button.dataset.value === this.settings.size,
      );
    }
    const slider = this.root.querySelector<HTMLInputElement>("#voice-volume")!;
    slider.value = String(effectiveVolume(this.settings));
    const mute = this.root.querySelector<HTMLButtonElement>(
      '#menu button[data-kind="mute"]',
    )!;
    mute.textContent = this.settings.muted ? "恢复声音" : "静音";
    mute.classList.toggle("is-selected", this.settings.muted);
    this.root.querySelector<HTMLButtonElement>(
      '#menu button[data-kind="panel"]',
    )!.textContent = this.settings.status_panel_visible
      ? "隐藏状态面板"
      : "显示状态面板";
  }

  private async exit(): Promise<void> {
    this.unlistenStatus?.();
    this.unlistenStatus = undefined;
    await invoke("stop_voice");
    await getCurrentWindow().close();
  }

  private startMotionLoop(): void {
    const update = (now: number) => {
      const frame = this.motion.sample(now);
      this.live2d.setMotionFrame(frame);
      this.root.dataset.motion = frame.action;
      window.requestAnimationFrame(update);
    };
    window.requestAnimationFrame(update);
  }
}

function bindMenu(
  root: HTMLElement,
  pet: HTMLElement,
  menu: HTMLElement,
  actions: {
    outfit(value: Outfit): void;
    size(value: PetSize): void;
    volume(value: number): void;
    mute(): void;
    panel(): void;
    reset(): void;
    exit(): void;
  },
): void {
  menu.innerHTML = [
    '<div class="menu-label">服装</div><div class="menu-row">',
    ...OUTFITS.map(
      ([value, label]) =>
        `<button type="button" data-kind="outfit" data-value="${value}">${label}</button>`,
    ),
    '</div><div class="menu-label">大小</div><div class="menu-row">',
    '<button type="button" data-kind="size" data-value="small">75%</button>',
    '<button type="button" data-kind="size" data-value="standard">100%</button>',
    '<button type="button" data-kind="size" data-value="large">125%</button>',
    '</div><label class="volume-row"><span>音量</span><input id="voice-volume" type="range" min="0" max="100" step="1"></label>',
    '<button type="button" data-kind="mute">静音</button>',
    '<button type="button" data-kind="panel">隐藏状态面板</button>',
    '<button type="button" data-kind="reset">回到右下角</button>',
    '<button type="button" data-kind="exit">退出 CodexPet</button>',
  ].join("");

  pet.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    menu.classList.add("is-open");
    const rootBounds = root.getBoundingClientRect();
    const menuBounds = menu.getBoundingClientRect();
    const left = Math.min(
      Math.max(event.clientX - rootBounds.left, 0),
      Math.max(rootBounds.width - menuBounds.width, 0),
    );
    const top = Math.min(
      Math.max(event.clientY - rootBounds.top, 0),
      Math.max(rootBounds.height - menuBounds.height, 0),
    );
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  });
  window.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Node) || !menu.contains(event.target)) {
      menu.classList.remove("is-open");
    }
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") menu.classList.remove("is-open");
  });
  menu
    .querySelector<HTMLInputElement>("#voice-volume")!
    .addEventListener("input", (event) => {
      actions.volume(Number((event.target as HTMLInputElement).value));
    });
  menu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-kind]",
    );
    if (!button) return;
    const value = button.dataset.value;
    switch (button.dataset.kind) {
      case "outfit":
        actions.outfit(value as Outfit);
        break;
      case "size":
        actions.size(value as PetSize);
        break;
      case "mute":
        actions.mute();
        break;
      case "panel":
        actions.panel();
        break;
      case "reset":
        actions.reset();
        break;
      case "exit":
        actions.exit();
        break;
    }
    menu.classList.remove("is-open");
  });
}
