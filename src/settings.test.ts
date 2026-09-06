import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  effectiveVolume,
  loadSettings,
  saveSettings,
  setVolume,
  toggleMuted,
  type AppSettings,
} from "./settings";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("CodexPet settings", () => {
  it("uses one stable default object", () => {
    expect(loadSettings(new MemoryStorage())).toEqual({
      size: "standard",
      volume: 70,
      muted: false,
      status_panel_visible: true,
    });
  });

  it("round-trips one JSON value", () => {
    const storage = new MemoryStorage();
    const settings: AppSettings = {
      size: "large",
      volume: 35,
      muted: true,
      status_panel_visible: false,
    };

    saveSettings(settings, storage);

    expect(loadSettings(storage)).toEqual(settings);
    expect(storage.length).toBe(1);
  });

  it("keeps the last nonzero volume while muted", () => {
    const initial = { ...DEFAULT_SETTINGS, volume: 35 };

    expect(effectiveVolume(toggleMuted(initial))).toBe(0);
    expect(toggleMuted(toggleMuted(initial))).toMatchObject({
      volume: 35,
      muted: false,
    });
    expect(setVolume(initial, 0)).toMatchObject({ volume: 35, muted: true });
    expect(setVolume(setVolume(initial, 0), 42)).toMatchObject({
      volume: 42,
      muted: false,
    });
  });
});
