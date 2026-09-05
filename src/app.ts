import { invoke } from "@tauri-apps/api/core";

import { Live2DView } from "./live2d";
import {
  getStatus,
  hudText,
  isTerminal,
  listenForStatus,
  type StatusUpdate,
} from "./status";

type Outfit = "default" | "maid";
type Expression = "auto_neutral" | "happy" | "angry" | "sleepy" | "error";

const MODELS: Record<Outfit, string> = {
  default: "/live2d/default/character-default.model3.json",
  maid: "/live2d/maid/character-maid.model3.json",
};

const OUTFITS: ReadonlyArray<readonly [Outfit, string]> = [
  ["default", "默认服装"],
  ["maid", "女仆服装"],
];

const EXPRESSIONS: ReadonlyArray<readonly [Expression, string]> = [
  ["auto_neutral", "默认"],
  ["happy", "开心"],
  ["angry", "生气"],
  ["sleepy", "困倦"],
  ["error", "沮丧"],
];

export class App {
  private root!: HTMLElement;
  private live2d!: Live2DView;
  private status: StatusUpdate | null = null;
  private outfit: Outfit = "default";
  private expression: Expression = "auto_neutral";
  private outfitLoad: Promise<void> = Promise.resolve();
  private statusGeneration = 0;
  private clickGeneration = 0;
  private terminalResetTimer: number | undefined;
  private clickBubbleTimer: number | undefined;

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    root.innerHTML =
      '<div id="pet"></div><div id="bubble"></div><div id="hud"></div><div id="menu"></div>';

    const pet = root.querySelector<HTMLElement>("#pet")!;
    const menu = root.querySelector<HTMLElement>("#menu")!;
    this.live2d = await Live2DView.create(pet);
    await this.setOutfit("default");

    bindMenu(root, menu, {
      outfit: (value) => void this.setOutfit(value),
      expression: (value) => this.setExpression(value),
    });
    this.markMenuSelection();
    this.bindPointerActions(pet);
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
      if (this.outfit === outfit) {
        this.live2d.setExpression(this.expression);
      }
    });
    this.outfitLoad = request.catch(() => undefined);
    await this.outfitLoad;
  }

  setExpression(name: Expression): void {
    this.expression = name;
    this.live2d.setExpression(name);
    this.markMenuSelection();
  }

  applyStatus(update: StatusUpdate): void {
    this.statusGeneration += 1;
    if (this.clickBubbleTimer !== undefined) {
      window.clearTimeout(this.clickBubbleTimer);
      this.clickBubbleTimer = undefined;
    }
    if (this.terminalResetTimer !== undefined) {
      window.clearTimeout(this.terminalResetTimer);
      this.terminalResetTimer = undefined;
    }
    this.status = update;
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
    this.root.querySelector("#hud")!.textContent = hudText(update, Date.now());
  }

  private async playClickVoice(): Promise<void> {
    const clickGeneration = ++this.clickGeneration;
    const statusGeneration = this.statusGeneration;
    const text = await invoke<string | null>("play_click_voice");
    if (
      !text ||
      clickGeneration !== this.clickGeneration ||
      statusGeneration !== this.statusGeneration
    ) {
      return;
    }
    this.root.querySelector("#bubble")!.textContent = text;
    if (this.clickBubbleTimer !== undefined) {
      window.clearTimeout(this.clickBubbleTimer);
    }
    this.clickBubbleTimer = window.setTimeout(() => {
      this.clickBubbleTimer = undefined;
      this.root.querySelector("#bubble")!.textContent =
        this.status?.bubbleText ?? "";
    }, 3_000);
  }

  private markMenuSelection(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      "#menu button",
    )) {
      button.classList.toggle(
        "is-selected",
        button.dataset.value === this.outfit ||
          button.dataset.value === this.expression,
      );
    }
  }

  private bindPointerActions(pet: HTMLElement): void {
    pet.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this.root.classList.remove("pet--poked");
      void this.root.offsetWidth;
      this.root.classList.add("pet--poked");
      void this.playClickVoice();
    });
    pet.addEventListener("animationend", (event) => {
      if ((event as AnimationEvent).animationName === "poke") {
        this.root.classList.remove("pet--poked");
      }
    });
    this.root.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && !(event.target as Element).closest("#menu")) {
        void invoke("start_dragging");
      }
    });
  }
}

function bindMenu(
  root: HTMLElement,
  menu: HTMLElement,
  actions: {
    outfit(value: Outfit): void;
    expression(value: Expression): void;
  },
): void {
  menu.innerHTML = [
    ...OUTFITS.map(
      ([value, label]) =>
        `<button type="button" data-kind="outfit" data-value="${value}">${label}</button>`,
    ),
    ...EXPRESSIONS.map(
      ([value, label]) =>
        `<button type="button" data-kind="expression" data-value="${value}">${label}</button>`,
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
    if (button.dataset.kind === "outfit") actions.outfit(value as Outfit);
    else actions.expression(value as Expression);
    menu.classList.remove("is-open");
  });
}
