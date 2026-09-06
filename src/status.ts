import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type PetState =
  | "idle"
  | "running"
  | "waiting_input"
  | "waiting_choice"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "interrupted";

export interface StatusUpdate {
  state: PetState;
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  activeSinceMs: number | null;
  bubbleText: string | null;
}

export type StatusTone =
  | "idle"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export interface StatusPresentation {
  label: string;
  tone: StatusTone;
  running: string;
  waiting: string | null;
  elapsed: string | null;
}

const LABELS: Record<PetState, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_input: "等待输入",
  waiting_choice: "等待选择",
  waiting_permission: "等待授权",
  completed: "任务完成",
  failed: "任务失败",
  interrupted: "任务中断",
};

const TONES: Record<PetState, StatusTone> = {
  idle: "idle",
  running: "running",
  waiting_input: "waiting",
  waiting_choice: "waiting",
  waiting_permission: "waiting",
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
};

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
  return (
    update.state === "completed" ||
    update.state === "failed" ||
    update.state === "interrupted"
  );
}

export function statusPresentation(
  update: StatusUpdate,
  nowMs: number,
): StatusPresentation {
  return {
    label: LABELS[update.state],
    tone: TONES[update.state],
    running: `运行 ${update.runningCount}`,
    waiting:
      update.waitingCount > 0 ? `等待你 ${update.waitingCount}` : null,
    elapsed:
      update.activeSinceMs === null
        ? null
        : formatDuration(Math.max(0, nowMs - update.activeSinceMs)),
  };
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

function formatDuration(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const hh = String(Math.floor(seconds / 3_600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}
