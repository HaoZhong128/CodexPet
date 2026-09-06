export type PetSize = "small" | "standard" | "large";

export interface AppSettings {
  size: PetSize;
  volume: number;
  muted: boolean;
  status_panel_visible: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  size: "standard",
  volume: 70,
  muted: false,
  status_panel_visible: true,
};

const STORAGE_KEY = "codexpet.settings";

export function loadSettings(storage: Storage = window.localStorage): AppSettings {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<AppSettings> | null;
    if (
      !saved ||
      !["small", "standard", "large"].includes(saved.size ?? "") ||
      typeof saved.volume !== "number" ||
      typeof saved.muted !== "boolean" ||
      typeof saved.status_panel_visible !== "boolean"
    ) {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      size: saved.size as PetSize,
      volume: Math.round(Math.min(Math.max(saved.volume, 1), 100)),
      muted: saved.muted,
      status_panel_visible: saved.status_panel_visible,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(
  settings: AppSettings,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export function effectiveVolume(settings: AppSettings): number {
  return settings.muted ? 0 : settings.volume;
}

export function setVolume(
  settings: AppSettings,
  value: number,
): AppSettings {
  const volume = Math.round(Math.min(Math.max(value, 0), 100));
  return volume === 0
    ? { ...settings, muted: true }
    : { ...settings, volume, muted: false };
}

export function toggleMuted(settings: AppSettings): AppSettings {
  return { ...settings, muted: !settings.muted };
}
