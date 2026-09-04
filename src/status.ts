import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PetState =
  | "idle"
  | "running"
  | "waiting_choice"
  | "waiting_permission"
  | "completed"
  | "interrupted";

export interface StatusUpdate {
  state: PetState;
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  activeSinceMs: number | null;
  bubbleText: string | null;
}

export async function getStatus(): Promise<StatusUpdate> {
  return invoke<StatusUpdate>("get_status");
}

export async function listenForStatus(
  onUpdate: (update: StatusUpdate) => void,
): Promise<UnlistenFn> {
  return listen<StatusUpdate>("codexpet://status", ({ payload }) =>
    onUpdate(payload),
  );
}

export function isTerminal(update: StatusUpdate): boolean {
  return update.state === "completed" || update.state === "interrupted";
}

export function hudText(update: StatusUpdate, nowMs: number): string {
  const waiting =
    update.waitingCount > 0 ? ` · 等待你 ${update.waitingCount}` : "";
  const first = `进行中 ${update.activeCount}${waiting}`;
  if (update.activeSinceMs === null) return first;
  const seconds = Math.max(
    0,
    Math.floor((nowMs - update.activeSinceMs) / 1_000),
  );
  const hh = String(Math.floor(seconds / 3_600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${first}\n已运行 ${hh}:${mm}:${ss}`;
}
