import type { StatusUpdate } from "./status";

export type MotionAction =
  | "idle"
  | "idle_tilt"
  | "idle_glance"
  | "running"
  | "waiting_input"
  | "waiting_choice"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "interrupted"
  | "headpat";

export type MotionExpression = "auto_neutral" | "happy" | "angry" | "error";

export interface MotionFrame {
  action: MotionAction;
  expression: MotionExpression;
  parameters: Record<string, number>;
}

interface MotionControllerOptions {
  random?: () => number;
}

interface TimedOverlay {
  action: "idle_tilt" | "idle_glance" | "headpat";
  startedAt: number;
  endsAt: number;
}

const TRANSITION_MS = 320;
const FIRST_IDLE_DELAY_MS = 45_000;
const MIN_IDLE_INTERVAL_MS = 60_000;
const MAX_IDLE_INTERVAL_MS = 180_000;
const IDLE_FEEDBACK_MS = 5_000;
const HEADPAT_MS = 3_200;

const DEFAULT_PARAMETERS: Record<string, number> = {
  ParamAngleX: 0,
  ParamAngleY: 0,
  ParamAngleZ: 0,
  ParamBodyAngleX: 0,
  ParamBodyAngleY: 0,
  ParamBodyAngleZ: 0,
  ParamBreath: 0,
  ParamBrowLAngle: 0,
  ParamBrowLForm: 0,
  ParamBrowLY: 0,
  ParamBrowRAngle: 0,
  ParamBrowRForm: 0,
  ParamBrowRY: 0,
  ParamEyeBallX: 0,
  ParamEyeBallY: 0,
  ParamEyeLOpen: 1,
  ParamEyeROpen: 1,
  ParamHairBack: 0,
  ParamHairFront: 0,
  ParamHairSide: 0,
  ParamMouthOpenY: 0,
};

export class MotionController {
  private readonly random: () => number;
  private state: StatusUpdate["state"] | null = null;
  private stateStartedAt = 0;
  private transitionFrom: MotionFrame | null = null;
  private transitionStartedAt = 0;
  private overlay: TimedOverlay | null = null;
  private lastIdleAction: "idle_tilt" | "idle_glance" | null = null;
  private nextIdleAt = Number.POSITIVE_INFINITY;

  constructor(options: MotionControllerOptions = {}) {
    this.random = options.random ?? Math.random;
  }

  setStatus(status: StatusUpdate, now: number): void {
    if (status.state === this.state) return;
    if (this.state !== null) this.transitionFrom = this.sample(now);
    this.transitionStartedAt = now;
    this.stateStartedAt = now;
    this.state = status.state;

    if (status.state === "idle") {
      if (this.overlay?.action !== "headpat") this.overlay = null;
      this.nextIdleAt = now + FIRST_IDLE_DELAY_MS;
    } else {
      if (this.overlay?.action !== "headpat") this.overlay = null;
      this.nextIdleAt = Number.POSITIVE_INFINITY;
    }
  }

  startHeadpat(now: number): void {
    this.transitionFrom = this.sample(now);
    this.transitionStartedAt = now;
    this.overlay = {
      action: "headpat",
      startedAt: now,
      endsAt: now + HEADPAT_MS,
    };
  }

  sample(now: number): MotionFrame {
    this.finishOverlay(now);
    this.maybeStartIdleFeedback(now);

    const action = this.overlay?.action ?? mainAction(this.state);
    const startedAt = this.overlay?.startedAt ?? this.stateStartedAt;
    let frame = frameFor(action, Math.max(0, now - startedAt));
    const progress = (now - this.transitionStartedAt) / TRANSITION_MS;
    if (this.transitionFrom && progress < 1) {
      frame = blendFrame(this.transitionFrom, frame, smoothStep(progress));
    } else if (this.transitionFrom) {
      this.transitionFrom = null;
    }

    const blink = blinkValue(now);
    frame.parameters.ParamEyeLOpen = Math.min(
      frame.parameters.ParamEyeLOpen,
      blink,
    );
    frame.parameters.ParamEyeROpen = Math.min(
      frame.parameters.ParamEyeROpen,
      blink,
    );
    frame.parameters.ParamBreath =
      0.5 + Math.sin((now / 3_200) * Math.PI * 2) * 0.5;
    return frame;
  }

  private finishOverlay(now: number): void {
    if (!this.overlay || now < this.overlay.endsAt) return;
    const finished = this.overlay;
    this.transitionFrom = frameFor(
      finished.action,
      finished.endsAt - finished.startedAt,
    );
    this.transitionStartedAt = finished.endsAt;
    this.overlay = null;
    if (this.state === "idle") {
      this.nextIdleAt =
        finished.endsAt +
        MIN_IDLE_INTERVAL_MS +
        this.random() * (MAX_IDLE_INTERVAL_MS - MIN_IDLE_INTERVAL_MS);
    } else {
      this.nextIdleAt = Number.POSITIVE_INFINITY;
    }
  }

  private maybeStartIdleFeedback(now: number): void {
    if (this.overlay || this.state !== "idle" || now < this.nextIdleAt) return;
    const selected = this.random() < 0.5 ? "idle_tilt" : "idle_glance";
    const action =
      selected === this.lastIdleAction
        ? selected === "idle_tilt"
          ? "idle_glance"
          : "idle_tilt"
        : selected;
    this.lastIdleAction = action;
    this.transitionFrom = frameFor("idle", now - this.stateStartedAt);
    this.transitionStartedAt = now;
    this.overlay = {
      action,
      startedAt: now,
      endsAt: now + IDLE_FEEDBACK_MS,
    };
  }
}

function mainAction(state: StatusUpdate["state"] | null): MotionAction {
  return state ?? "idle";
}

function frameFor(action: MotionAction, elapsedMs: number): MotionFrame {
  const seconds = elapsedMs / 1_000;
  const parameters = { ...DEFAULT_PARAMETERS };
  let expression: MotionExpression = "auto_neutral";

  switch (action) {
    case "idle":
      parameters.ParamAngleX = Math.sin(seconds * 0.8) * 1.6;
      parameters.ParamBodyAngleZ = Math.sin(seconds * 0.65) * 1.1;
      parameters.ParamHairSide = Math.sin(seconds * 0.65) * 0.12;
      break;
    case "idle_tilt":
      parameters.ParamAngleZ = 4;
      parameters.ParamEyeBallX = 0.18;
      break;
    case "idle_glance":
      parameters.ParamAngleX = -4;
      parameters.ParamEyeBallX = -0.3;
      break;
    case "running":
      parameters.ParamAngleX = 3;
      parameters.ParamBodyAngleX = 1.5;
      break;
    case "waiting_input":
      parameters.ParamAngleY = 5;
      parameters.ParamEyeBallY = 0.25;
      break;
    case "waiting_choice":
      parameters.ParamAngleZ = 5;
      parameters.ParamEyeBallY = 0.25;
      break;
    case "waiting_permission":
      parameters.ParamAngleX = 4;
      parameters.ParamAngleZ = -4;
      break;
    case "completed":
      expression = "happy";
      parameters.ParamAngleZ = 4;
      break;
    case "failed":
      expression = "error";
      parameters.ParamAngleY = -6;
      break;
    case "interrupted":
      expression = "angry";
      parameters.ParamAngleX = 4;
      parameters.ParamAngleZ = 4;
      break;
    case "headpat":
      expression = "happy";
      parameters.ParamAngleY = -4;
      parameters.ParamAngleZ = Math.sin(seconds * Math.PI * 1.4) * 2;
      parameters.ParamEyeLOpen = 0.72;
      parameters.ParamEyeROpen = 0.72;
      break;
  }

  return { action, expression, parameters };
}

function blendFrame(from: MotionFrame, to: MotionFrame, amount: number): MotionFrame {
  const parameters: Record<string, number> = {};
  for (const id of Object.keys(DEFAULT_PARAMETERS)) {
    parameters[id] = lerp(from.parameters[id], to.parameters[id], amount);
  }
  return {
    action: to.action,
    expression: to.expression,
    parameters,
  };
}

function smoothStep(value: number): number {
  const clamped = Math.min(Math.max(value, 0), 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function blinkValue(now: number): number {
  const phase = ((now % 4_000) + 4_000) % 4_000;
  if (phase < 3_860) return 1;
  if (phase < 3_920) return 1 - (phase - 3_860) / 60;
  if (phase < 3_980) return (phase - 3_920) / 60;
  return 1;
}
