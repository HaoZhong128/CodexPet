# CodexPet Live2D and Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Live2D 反馈收敛成主状态、两种低频 Idle 反馈和一个 Headpat 覆盖，同时修复 DPR 渲染清晰度并删除前端复杂动作耦合。

**Architecture:** `MotionController` 是唯一动作决策点，只输出表情与 Live2D 参数；`Live2DView` 负责平滑帧应用、DPR backing store、模型自适应和透明像素区域。`App` 只编排状态、交互和逐帧采样，不再同步 Canvas CSS transform、武器、道具或动作语音调度器。

**Tech Stack:** TypeScript, Vitest/jsdom, PixiJS 8, untitled-pixi-live2d-engine, Tauri window-region command

**Spec:** `docs/superpowers/specs/2026-09-06-codexpet-simplification-design.md`

## Global Constraints

- 必须先完成并验证 `2026-09-06-codexpet-status-ui.md`。
- 不修改 `.moc3`、模型 JSON、表情 JSON、Live2D SDK 或 2048×2048 原始纹理。
- 不恢复剑、包子、睡眠、擦剑、复杂中断栈或动作恢复点。
- 表情和参数继续用现有模型已支持的 ID；缺失参数由现有 `applyParameterFrame` 忽略。
- Canvas 的 CSS 大小是逻辑像素；Pixi `resolution` 是 DPR；点击遮罩仍以逻辑分辨率抽取。
- `#hud`、`#bubble` 继续 `pointer-events: none`，也不进入原生窗口 region。
- 保留默认服装和女仆服装切换；此阶段不改变右键菜单设置功能。
- 用 `apply_patch` 做删除和编辑，不用 checkout/reset 清理当前工作树。
- 每次提交前只暂存列出的文件并审阅缓存区。

## File and Interface Map

| File | Responsibility | Final interface |
|---|---|---|
| `src/motion.ts` | 状态动作、Idle 定时、Headpat 覆盖、平滑插值 | `MotionAction`, `MotionFrame`, `MotionController` |
| `src/motion.test.ts` | 状态映射、时序、非重复、恢复、平滑 | deterministic random/time tests |
| `src/live2d.ts` | Pixi 初始化、模型加载、参数应用、region、resize | `Live2DView`, `pixiRenderOptions`, `alphaRuns`, `applyParameterFrame` |
| `src/live2d-view.test.ts` | model replacement and resize behavior | mocked Pixi/model tests |
| `src/parameter-frame.test.ts` | parameter bounds | unchanged contract |
| `src/app.ts` | motion loop and simple DOM | no props/weapon/action scheduler |
| `src/status.test.ts` | App integration | state -> simple frame |
| `src/styles.css` | pet canvas without action transforms/props | logical layout only |
| `src/action-voice.ts` | canceled action scheduler | delete |
| `src/action-voice.test.ts` | canceled scheduler tests | delete |

Final motion surface:

```ts
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
```

---

### Task 1: Replace Complex Motion Expectations with the Approved Contract

**Files:**
- Modify: `src/motion.test.ts`

- [ ] **Step 1: Remove tests that require canceled behavior**

Delete assertions for:

- `idle_bun`, `idle_doze`, `idle_clean_sword`;
- `running_sword`, `running_multi`, `completed_sheath`;
- weapon opacity/rotation, accessory kind, character CSS transforms;
- sword/headpat interrupt staging.

Do not delete tests for rapid state changes, blinking, breathing, Headpat restore, or Idle scheduling; rewrite those for the new contract.

- [ ] **Step 2: Add the exact state mapping table**

```ts
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
```

- [ ] **Step 3: Add deterministic Idle and Headpat tests**

Add:

```ts
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
  expect(minimum.sample(110_000).action).not.toBe("idle");

  const maximum = new MotionController({ random: () => 0.999_999 });
  maximum.setStatus(status("idle", 0), 0);
  maximum.sample(45_000);
  expect(maximum.sample(229_999).action).toBe("idle");
  expect(maximum.sample(230_000).action).not.toBe("idle");
});

it("never repeats the same idle feedback consecutively", () => {
  const controller = new MotionController({ random: () => 0 });
  controller.setStatus(status("idle", 0), 0);
  expect(controller.sample(45_000).action).toBe("idle_tilt");
  expect(controller.sample(110_000).action).toBe("idle_glance");
});

it("restores the latest main state after headpat", () => {
  const controller = new MotionController({ random: () => 0 });
  controller.setStatus(status("running"), 0);
  controller.startHeadpat(500);
  controller.setStatus(status("waiting_choice"), 1_000);
  expect(controller.sample(1_200).action).toBe("headpat");
  expect(controller.sample(3_700).action).toBe("waiting_choice");
});
```

Use an Idle feedback duration of 5 seconds and Headpat duration of 3.2 seconds so the expected due times above are exact: `45s + 5s + 60s = 110s`, and `45s + 5s + 180s = 230s`.

- [ ] **Step 4: Run and confirm the old implementation fails**

Run:

```powershell
npm test -- src/motion.test.ts
```

Expected: FAIL on new action names and new timing.

---

### Task 2: Rewrite MotionController as Main State Plus One Overlay

**Files:**
- Modify: `src/motion.ts`
- Modify: `src/motion.test.ts`

- [ ] **Step 1: Replace action/frame types and constants**

Use:

```ts
const TRANSITION_MS = 320;
const FIRST_IDLE_DELAY_MS = 45_000;
const MIN_IDLE_INTERVAL_MS = 60_000;
const MAX_IDLE_INTERVAL_MS = 180_000;
const IDLE_FEEDBACK_MS = 5_000;
const HEADPAT_MS = 3_200;

type TimedOverlay = {
  action: "idle_tilt" | "idle_glance" | "headpat";
  startedAt: number;
  endsAt: number;
};
```

Remove `WeaponFrame`, `AccessoryFrame`, `CharacterFrame`, their fields in `MotionFrame`, and all prop-related parameter IDs.

- [ ] **Step 2: Implement status, overlay and non-repeat timing with one controller**

Keep these fields only:

```ts
private state: StatusUpdate["state"] | null = null;
private stateStartedAt = 0;
private overlay: TimedOverlay | null = null;
private lastIdleAction: "idle_tilt" | "idle_glance" | null = null;
private nextIdleAt = Number.POSITIVE_INFINITY;
private transitionFrom: MotionFrame | null = null;
private transitionStartedAt = 0;
```

Core scheduling rules:

```ts
setStatus(status: StatusUpdate, now: number): void {
  if (status.state === this.state) return;
  this.transitionFrom = this.sample(now);
  this.transitionStartedAt = now;
  this.stateStartedAt = now;
  this.state = status.state;
  if (status.state === "idle") {
    this.overlay = null;
    this.nextIdleAt = now + FIRST_IDLE_DELAY_MS;
  } else if (this.overlay?.action !== "headpat") {
    this.overlay = null;
    this.nextIdleAt = Number.POSITIVE_INFINITY;
  }
}

startHeadpat(now: number): void {
  this.transitionFrom = this.sample(now);
  this.transitionStartedAt = now;
  this.overlay = { action: "headpat", startedAt: now, endsAt: now + HEADPAT_MS };
}
```

When an Idle overlay finishes, save its `endsAt`, clear it, then compute from that scheduled end rather than the time of a late `sample()` call:

```ts
this.nextIdleAt = endedAt
  + MIN_IDLE_INTERVAL_MS
  + this.random() * (MAX_IDLE_INTERVAL_MS - MIN_IDLE_INTERVAL_MS);
```

Choose between two actions; if the roll selects `lastIdleAction`, flip to the other action. Leaving Idle cancels Idle overlays immediately. A status update during Headpat updates the main state but lets the short Headpat overlay finish, then restores that latest state.

- [ ] **Step 3: Implement restrained parameter frames**

Keep baseline breathing/blinking in `sample`. Use only small values:

```ts
case "idle":
  parameters.ParamAngleX = Math.sin(seconds * 0.8) * 1.6;
  parameters.ParamBodyAngleZ = Math.sin(seconds * 0.65) * 1.1;
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
```

Retain the existing 320 ms smooth-step blend and `Math.min(actionEye, blink)` rule so blinking never reopens eyes an action closes.

- [ ] **Step 4: Run motion tests**

Run:

```powershell
npm test -- src/motion.test.ts
```

Expected: PASS for mapping, smooth replacement, 45-second first delay, 60/180-second bounds, non-repeat, non-idle cancellation, breathing/blinking, and Headpat restore.

- [ ] **Step 5: Commit the controller**

Run:

```powershell
git add -- src/motion.ts src/motion.test.ts
git diff --cached --check
git diff --cached -- src/motion.ts src/motion.test.ts
git commit -m "refactor: simplify Live2D motion feedback"
```

---

### Task 3: Remove Props and Action Voice Scheduling from the App

**Files:**
- Modify: `src/app.ts`
- Modify: `src/status.test.ts`
- Modify: `src/styles.css`
- Delete: `src/action-voice.ts`
- Delete: `src/action-voice.test.ts`

- [ ] **Step 1: Rewrite App integration tests before production code**

Replace sword/props/action scheduler tests with:

```ts
it("drives the simple motion from the latest status", async () => {
  statusMocks.getStatus.mockResolvedValue(update("idle"));
  let tick!: FrameRequestCallback;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    tick = callback;
    return 1;
  });
  const root = document.querySelector<HTMLElement>("#app")!;
  const app = new App();
  await app.mount(root);

  app.applyStatus(update("running"));
  tick(400);

  expect(live2dMock.setMotionFrame).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: "running" }),
  );
  expect(root.querySelector("#props")).toBeNull();
  expect(root.querySelector("#weapon")).toBeNull();
  expect(root.querySelector("#accessory")).toBeNull();
});
```

Remove mocks/expectations for `play_action_voice` from action entry. Headpat voice will be reintroduced directly as an interaction in Phase 3.

- [ ] **Step 2: Run and confirm the old App fails the simple DOM contract**

Run:

```powershell
npm test -- src/status.test.ts src/action-voice.test.ts
```

Expected: FAIL because props and complex actions still exist.

- [ ] **Step 3: Simplify App imports, DOM and animation loop**

Delete `ActionVoiceScheduler`, `ActionVoiceCategory`, `AccessoryFrame`, `MotionFrame`, `ACCESSORIES`, `playActionVoice`, `renderCharacter`, `renderWeapon`, and `renderAccessory`.

The pet portion of the DOM becomes:

```html
<div id="pet"></div>
<div id="bubble"></div>
```

The motion loop becomes:

```ts
private startMotionLoop(): void {
  const update = (now: number) => {
    const frame = this.motion.sample(now);
    this.live2d.setMotionFrame(frame);
    this.root.dataset.motion = frame.action;
    window.requestAnimationFrame(update);
  };
  window.requestAnimationFrame(update);
}
```

Keep outfit switching and status behavior unchanged.

- [ ] **Step 4: Delete canceled scheduler files with apply_patch**

Delete the entire contents/files `src/action-voice.ts` and `src/action-voice.test.ts`. They have no production consumer after Step 3.

- [ ] **Step 5: Delete only canceled prop styles**

Remove selectors for `#props`, `#weapon`, `#accessory`, and its bun/cloth/sleep variants. Remove Canvas `transform-origin`; retain the drop shadow and logical width/height.

- [ ] **Step 6: Run frontend tests**

Run:

```powershell
npm test
```

Expected: PASS; test count may decrease only by the deleted action-scheduler cases and must gain the replacement App/motion cases.

- [ ] **Step 7: Commit the app simplification**

Run:

```powershell
git add -- src/app.ts src/status.test.ts src/styles.css
git diff --cached --check
git diff --cached -- src/app.ts src/status.test.ts src/styles.css src/action-voice.ts src/action-voice.test.ts
git commit -m "refactor: remove complex pet actions and props"
```

---

### Task 4: Render at Device Pixel Ratio Without Enlarging Hit Testing

**Files:**
- Modify: `src/live2d.ts`
- Modify: `src/live2d-view.test.ts`
- Modify: `src/parameter-frame.test.ts`

- [ ] **Step 1: Add a pure options test**

Export a small options builder and test it:

```ts
it("uses DPR for Pixi backing resolution", () => {
  const canvas = document.createElement("canvas");
  expect(pixiRenderOptions(canvas, 1.5)).toMatchObject({
    canvas,
    resolution: 1.5,
    autoDensity: true,
    antialias: true,
    backgroundAlpha: 0,
    preference: "webgl",
  });
});
```

Also assert a non-positive DPR becomes `1`.

- [ ] **Step 2: Run and confirm the missing options API fails**

Run:

```powershell
npm test -- src/live2d-view.test.ts src/parameter-frame.test.ts
```

Expected: FAIL because `pixiRenderOptions` does not exist.

- [ ] **Step 3: Add the options helper and use it in Pixi init**

```ts
export function pixiRenderOptions(
  canvas: HTMLCanvasElement,
  devicePixelRatio: number,
) {
  return {
    canvas,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    preference: "webgl" as const,
    resolution: devicePixelRatio > 0 ? devicePixelRatio : 1,
  };
}
```

Initialize with:

```ts
await app.init(pixiRenderOptions(canvas, window.devicePixelRatio));
```

Keep `ResizeObserver(() => view.resize())`; `resize()` continues to use the host's logical width/height, which lets Pixi allocate a DPR-scaled backing store under `autoDensity`.

- [ ] **Step 4: Keep the native hit mask logical**

Retain:

```ts
resolution: 1
```

in renderer extraction and `window.innerWidth/innerHeight` for the mask. Delete use of Canvas CSS transform/DOMMatrix because Task 3 no longer transforms the canvas. Draw extracted pixels directly at `hostBounds.left/top`:

```ts
context.drawImage(
  this.sourceCanvas,
  hostBounds.left,
  hostBounds.top,
  hostBounds.width,
  hostBounds.height,
);
```

This intentionally decouples visual DPR from the low-cost logical region mask.

- [ ] **Step 5: Test resize/model replacement and parameter clamping**

Add to the mocked `Live2DView` test:

```ts
expect(app.renderer.resize).toHaveBeenCalledWith(400, 560);
expect(second.scale.set).toHaveBeenCalled();
expect(second.position.set).toHaveBeenCalledWith(200, 280);
```

Keep the existing expression-reapply test and parameter clamp test.

- [ ] **Step 6: Run the focused and complete frontend suites**

Run:

```powershell
npm test -- src/live2d-view.test.ts src/parameter-frame.test.ts
npm test
npm run build
```

Expected: all PASS; Vite production build succeeds.

- [ ] **Step 7: Commit the rendering fix**

Run:

```powershell
git add -- src/live2d.ts src/live2d-view.test.ts src/parameter-frame.test.ts
git diff --cached --check
git diff --cached -- src/live2d.ts src/live2d-view.test.ts src/parameter-frame.test.ts
git commit -m "fix: render Live2D at device pixel ratio"
```

---

### Task 5: Verify the Asset Boundary and Close Phase 2

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: Audit model texture dimensions read-only**

Run:

```powershell
Add-Type -AssemblyName System.Drawing
Get-ChildItem -LiteralPath public\live2d -Recurse -File -Include *.png | Where-Object { $_.FullName -notmatch '\\props\\' } | ForEach-Object {
  $image = [System.Drawing.Image]::FromFile($_.FullName)
  try { [pscustomobject]@{ Path = $_.FullName; Width = $image.Width; Height = $image.Height } }
  finally { $image.Dispose() }
}
```

Expected: principal model textures remain 2048×2048. Do not edit or upscale them.

- [ ] **Step 2: Prove canceled behavior is absent from source references**

Run:

```powershell
rg -n "running_sword|completed_sheath|idle_bun|idle_doze|idle_clean_sword|touch_running_interrupt|sword_effort|headpat_relaxed|headpat_start|#props|#weapon|#accessory" src
```

Expected: no matches. Runtime voice/resource directories are cleaned in Phase 3, not here.

- [ ] **Step 3: Run phase verification**

Run:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
git diff --check
git status --short
```

Expected: all automated checks PASS.

- [ ] **Step 4: Update and commit progress**

Record test counts, texture dimensions, DPR strategy, removal of canceled frontend behaviors, and next plan `docs/superpowers/plans/2026-09-06-codexpet-audio-menu-cleanup.md`.

Run:

```powershell
git add -- PROGRESS.md
git diff --cached --check
git diff --cached -- PROGRESS.md
git commit -m "docs: record Live2D simplification verification"
```

## Phase 2 Exit Criteria

- Only state motions, two quiet Idle gestures, and Headpat remain.
- First Idle gesture waits at least 45 seconds; later intervals are 60–180 seconds; consecutive duplicates are prevented.
- Headpat restores the latest real state through 320 ms interpolation.
- No props, weapon, canceled scheduler, action CSS transforms, or action voice cues remain in frontend source.
- Pixi resolution follows devicePixelRatio and resize remains logical-size driven.
- Native transparent hit mask remains at logical resolution and excludes card/bubble.
- Existing textures/models/SDK remain byte-for-byte untouched.
- Frontend tests, Rust tests, and frontend build pass.
