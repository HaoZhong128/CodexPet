import { describe, expect, it } from "vitest";

import { MotionController } from "./motion";
import type { StatusUpdate } from "./status";

function status(
  state: StatusUpdate["state"],
  activeCount = state === "idle" ? 0 : 1,
): StatusUpdate {
  const waiting = state.startsWith("waiting_");
  return {
    state,
    activeCount,
    runningCount: state === "running" ? activeCount : 0,
    waitingCount: waiting ? activeCount : 0,
    activeSinceMs: activeCount > 0 ? 1_000 : null,
    bubbleText: null,
  };
}

describe("MotionController", () => {
  it("maps every Codex state to one simple main action", () => {
    const cases = [
      ["idle", "idle"],
      ["running", "running"],
      ["waiting_input", "waiting_input"],
      ["waiting_choice", "waiting_choice"],
      ["waiting_permission", "waiting_permission"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["interrupted", "interrupted"],
    ] as const;

    for (const [state, action] of cases) {
      const controller = new MotionController({ random: () => 0 });
      controller.setStatus(status(state), 0);
      expect(controller.sample(400).action).toBe(action);
    }
  });

  it("starts a replacement transition from the current parameter frame", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("running"), 0);
    const interruptedFrame = controller.sample(120);

    controller.setStatus(status("waiting_choice"), 120);
    const replacementStart = controller.sample(120);

    expect(replacementStart.parameters).toEqual(interruptedFrame.parameters);
    expect(controller.sample(500).action).toBe("waiting_choice");
    expect(controller.sample(500).parameters.ParamAngleZ).toBeGreaterThan(0);
  });

  it("layers breathing and synchronized blinking onto the main frame", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("idle", 0), 0);

    const calm = controller.sample(1_000);
    const blink = controller.sample(3_920);

    expect(blink.parameters.ParamEyeLOpen).toBeLessThan(0.2);
    expect(blink.parameters.ParamEyeROpen).toBe(blink.parameters.ParamEyeLOpen);
    expect(calm.parameters.ParamBreath).not.toBe(blink.parameters.ParamBreath);
    expect(calm).not.toHaveProperty("weapon");
    expect(calm).not.toHaveProperty("accessory");
    expect(calm).not.toHaveProperty("character");
  });

  it("waits 45 seconds before the first idle feedback", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("idle", 0), 0);

    expect(controller.sample(44_999).action).toBe("idle");
    expect(controller.sample(45_000).action).toBe("idle_tilt");
  });

  it("schedules later idle feedback in the 60 to 180 second range", () => {
    const minimum = new MotionController({ random: () => 0 });
    minimum.setStatus(status("idle", 0), 0);
    minimum.sample(45_000);
    expect(minimum.sample(109_999).action).toBe("idle");
    expect(minimum.sample(110_000).action).toBe("idle_glance");

    const maximum = new MotionController({ random: () => 0.999_999 });
    maximum.setStatus(status("idle", 0), 0);
    maximum.sample(45_000);
    expect(maximum.sample(229_999).action).toBe("idle");
    expect(maximum.sample(230_000).action).toBe("idle_tilt");
  });

  it("never repeats the same idle feedback consecutively", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("idle", 0), 0);

    expect(controller.sample(45_000).action).toBe("idle_tilt");
    expect(controller.sample(110_000).action).toBe("idle_glance");
  });

  it("cancels idle feedback immediately after leaving idle", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("idle", 0), 0);
    expect(controller.sample(45_000).action).toBe("idle_tilt");

    controller.setStatus(status("running"), 46_000);

    expect(controller.sample(46_400).action).toBe("running");
    expect(controller.sample(300_000).action).toBe("running");
  });

  it("restores the latest main state after headpat", () => {
    const controller = new MotionController({ random: () => 0 });
    controller.setStatus(status("running"), 0);
    controller.startHeadpat(500);

    controller.setStatus(status("waiting_choice"), 1_000);

    expect(controller.sample(1_200).action).toBe("headpat");
    expect(controller.sample(3_700).action).toBe("waiting_choice");
  });
});
