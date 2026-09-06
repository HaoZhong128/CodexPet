import { invoke } from "@tauri-apps/api/core";

import {
  ActionVoiceScheduler,
  type ActionVoiceCategory,
} from "./action-voice";
import { Live2DView } from "./live2d";
import {
  MotionController,
  type AccessoryFrame,
  type MotionFrame,
} from "./motion";
import {
  getStatus,
  isTerminal,
  listenForStatus,
  statusPresentation,
  type StatusUpdate,
} from "./status";

type Outfit = "default" | "maid";

const MODELS: Record<Outfit, string> = {
  default: "/live2d/default/character-default.model3.json",
  maid: "/live2d/maid/character-maid.model3.json",
};

const OUTFITS: ReadonlyArray<readonly [Outfit, string]> = [
  ["default", "默认服装"],
  ["maid", "女仆服装"],
];

const ACCESSORIES: Record<Exclude<AccessoryFrame["kind"], null>, string> = {
  bun: "/live2d/props/bun.png",
  cloth: "/live2d/props/cloth.png",
  sleep: "/live2d/props/sleep-bubble.png",
};

export class App {
  private root!: HTMLElement;
  private live2d!: Live2DView;
  private status: StatusUpdate | null = null;
  private outfit: Outfit = "default";
  private readonly motion = new MotionController();
  private readonly actionVoice = new ActionVoiceScheduler();
  private outfitLoad: Promise<void> = Promise.resolve();
  private statusGeneration = 0;
  private actionVoiceGeneration = 0;
  private terminalResetTimer: number | undefined;
  private actionBubbleTimer: number | undefined;

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    root.innerHTML =
      '<div id="pet"><div id="props"><img id="weapon" src="/live2d/props/character-default-sword-v2.png" alt=""><img id="accessory" alt=""></div></div><div id="bubble"></div><section id="hud" aria-label="Codex 状态"><div class="status-heading"><span class="status-dot"></span><span class="status-title">CodexPet</span><span id="status-name"></span></div><div class="status-meta"><span id="status-running"></span><span id="status-waiting"></span><span id="status-elapsed"></span></div></section><div id="menu"></div>';

    const pet = root.querySelector<HTMLElement>("#pet")!;
    const menu = root.querySelector<HTMLElement>("#menu")!;
    this.live2d = await Live2DView.create(pet);
    await this.setOutfit("default");

    bindMenu(root, menu, {
      outfit: (value) => void this.setOutfit(value),
    });
    this.markMenuSelection();
    this.bindPointerActions(pet);
    this.startMotionLoop();
    this.live2d.startHitTesting([
      root.querySelector<HTMLElement>("#bubble")!,
      root.querySelector<HTMLElement>("#hud")!,
      menu,
    ]);

    const generation = this.statusGeneration;
    await listenForStatus((update) => this.applyStatus(update));
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
    this.actionVoiceGeneration += 1;
    if (this.actionBubbleTimer !== undefined) {
      window.clearTimeout(this.actionBubbleTimer);
      this.actionBubbleTimer = undefined;
    }
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

  private async playActionVoice(category: ActionVoiceCategory): Promise<void> {
    const voiceGeneration = ++this.actionVoiceGeneration;
    const statusGeneration = this.statusGeneration;
    const text = await invoke<string | null>("play_action_voice", { category });
    if (statusGeneration !== this.statusGeneration) {
      if (text) await invoke("stop_voice");
      return;
    }
    if (
      !text ||
      voiceGeneration !== this.actionVoiceGeneration
    ) {
      return;
    }
    this.root.querySelector("#bubble")!.textContent = text;
    if (this.actionBubbleTimer !== undefined) {
      window.clearTimeout(this.actionBubbleTimer);
    }
    this.actionBubbleTimer = window.setTimeout(() => {
      this.actionBubbleTimer = undefined;
      this.root.querySelector("#bubble")!.textContent =
        this.status?.bubbleText ?? "";
    }, 3_200);
  }

  private markMenuSelection(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "#menu button",
    )) {
      button.classList.toggle(
        "is-selected",
        button.dataset.value === this.outfit,
      );
    }
  }

  private bindPointerActions(pet: HTMLElement): void {
    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.motion.startHeadpat(performance.now());
    });
    this.root.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest("#menu")) {
        void invoke("start_dragging");
      }
    });
  }

  private startMotionLoop(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>("#pet canvas")!;
    const props = this.root.querySelector<HTMLElement>("#props")!;
    const weapon = this.root.querySelector<HTMLElement>("#weapon")!;
    const accessory = this.root.querySelector<HTMLImageElement>("#accessory")!;
    const update = (now: number) => {
      const frame = this.motion.sample(now);
      this.live2d.setMotionFrame(frame);
      this.renderCharacter(canvas, props, frame);
      this.renderWeapon(weapon, frame);
      this.renderAccessory(accessory, frame.accessory);
      this.root.dataset.motion = frame.action;
      const cue = this.actionVoice.takeCue(frame.action, now);
      if (cue) void this.playActionVoice(cue);
      window.requestAnimationFrame(update);
    };
    window.requestAnimationFrame(update);
  }

  private renderCharacter(
    canvas: HTMLCanvasElement,
    props: HTMLElement,
    frame: MotionFrame,
  ): void {
    const { x, y, rotation, scale } = frame.character;
    const transform = `translate(${x}px, ${y}px) rotate(${rotation}deg) scale(${scale})`;
    canvas.style.transform = transform;
    props.style.transform = transform;
  }

  private renderWeapon(weapon: HTMLElement, frame: MotionFrame): void {
    weapon.style.opacity = String(frame.weapon.opacity);
    weapon.style.transform = `rotate(${frame.weapon.rotation}deg)`;
  }

  private renderAccessory(
    accessory: HTMLImageElement,
    frame: AccessoryFrame,
  ): void {
    if (frame.kind && accessory.dataset.kind !== frame.kind) {
      accessory.dataset.kind = frame.kind;
      accessory.src = ACCESSORIES[frame.kind];
    } else if (!frame.kind) {
      delete accessory.dataset.kind;
    }
    accessory.style.opacity = String(frame.opacity);
    accessory.style.transform = `rotate(${frame.rotation}deg)`;
  }
}

function bindMenu(
  root: HTMLElement,
  menu: HTMLElement,
  actions: {
    outfit(value: Outfit): void;
  },
): void {
  menu.innerHTML = [
    ...OUTFITS.map(
      ([value, label]) =>
        `<button type="button" data-kind="outfit" data-value="${value}">${label}</button>`,
    ),
  ].join("");

  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
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
    if (!menu.contains(event.target as Node)) menu.classList.remove("is-open");
  });
  menu.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      "button[data-kind]",
    );
    if (!button) return;
    const value = button.dataset.value!;
    actions.outfit(value as Outfit);
    menu.classList.remove("is-open");
  });
}
