# CodexPet Status and Status Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 hook-only 状态聚合、计数、去重和终态优先级，并把现有纯文本 HUD 改为紧凑、不可交互的状态卡。

**Architecture:** 继续使用 `Codex hook -> named pipe -> Rust StatusStore -> Tauri event -> App` 单链路。Rust 是状态真值和语音触发去重边界；前端只负责将 `StatusUpdate` 转为展示模型并渲染。没有失败 hook 时只保留 `failed` 映射，不新增猜测。

**Tech Stack:** Rust 2021, Tauri 2, TypeScript, Vitest, CSS

**Spec:** `docs/superpowers/specs/2026-09-06-codexpet-simplification-design.md`

## Global Constraints

- 生产状态来源只能是现有 Codex hook 和命名管道。
- 不使用问号、普通文本、超时、SQLite、rollout 或 CUA 推断状态。
- `running_count` 只统计 `TaskPhase::Running`；三个等待态只进入 `waiting_count`。
- 活跃等待/运行必须覆盖单个任务的 Completed/Interrupted 终态。
- `failed` 只做类型、颜色和纯展示测试，真实链路继续标为 BLOCKED。
- 当前工作树已有未提交修改。每个任务编辑前先读目标文件的现有 diff；不得 reset、checkout 或覆盖用户修改。
- 每次只暂存任务列出的文件，运行 `git diff --cached --check` 并审阅缓存区后再提交。
- 每完成一个任务就在本文勾选对应 checkbox，并同步 `PROGRESS.md`。

## File and Interface Map

| File | Responsibility | Planned public surface |
|---|---|---|
| `src-tauri/src/bridge.rs` | hook 解析、按 session 聚合、事件去重 | `PetState`, `StatusUpdate`, `StatusStore::apply_at/current` |
| `src/status.ts` | IPC 类型和纯展示映射 | `StatusPresentation`, `statusPresentation`, `isTerminal` |
| `src/status.test.ts` | 展示模型和 App 状态卡测试 | Vitest/jsdom cases |
| `src/app.ts` | 订阅、终态刷新、状态卡 DOM 更新 | `App.mount`, `App.applyStatus` |
| `src/styles.css` | 状态卡布局和六类色调 | `data-tone` selectors and CSS variables |
| `PROGRESS.md` | 长 Goal 的磁盘进度 | 完成、证据、剩余、下一步 |

The IPC contract stays:

```ts
export interface StatusUpdate {
  state: PetState;
  activeCount: number;
  runningCount: number;
  waitingCount: number;
  activeSinceMs: number | null;
  bubbleText: string | null;
}
```

---

### Task 1: Freeze the Current Baseline and Record the Status Source

**Files:**
- Create: `PROGRESS.md`
- Inspect: `src-tauri/src/bridge.rs`
- Inspect: `src/status.ts`
- Inspect: `src/app.ts`

- [ ] **Step 1: Record the dirty baseline without changing it**

Run:

```powershell
git branch --show-current
git status --short
git diff -- src-tauri/src/bridge.rs src/status.ts src/status.test.ts src/app.ts src/styles.css
git log -4 --oneline
```

Expected: branch `codex/live2d-motion-system`; existing source changes remain visible and untouched.

- [ ] **Step 2: Create the progress ledger**

Create `PROGRESS.md` with these fixed headings:

```md
# CodexPet Long Goal Progress

Updated: 2026-09-06

## Current architecture

Codex hook -> CodexPet.exe hook -> named pipe -> Rust StatusStore -> Tauri status event -> status card / Live2D / bubble / voice.

## Completed

- [x] Design approved.

## Verification evidence

- Baseline frontend tests: 6 files / 25 tests PASS before implementation.

## Blocked externally

- Real failed-task detection: Codex hook currently exposes no reliable failed event or result field. Display mapping remains implemented but production detection is not claimed.

## Remaining

- [ ] Status aggregation and status card.
- [ ] Simplified Live2D feedback and DPR rendering.
- [ ] Audio, menu/settings, cleanup, deployment, and real acceptance.

## Next step

Execute `docs/superpowers/plans/2026-09-06-codexpet-status-ui.md`.
```

- [ ] **Step 3: Verify and commit only the ledger**

Run:

```powershell
git diff --check -- PROGRESS.md
git add -- PROGRESS.md
git diff --cached --check
git diff --cached -- PROGRESS.md
git commit -m "docs: start CodexPet goal progress ledger"
```

Expected: one documentation-only commit; all pre-existing source changes remain unstaged.

---

### Task 2: Remove Text Guessing from Hook Parsing

**Files:**
- Modify: `src-tauri/src/bridge.rs`

- [ ] **Step 1: Replace the heuristic test with a structured-boundary test**

Delete the test that expects a `Stop` message ending in `?` or `？` to become `WaitingInput`. Add:

```rust
#[test]
fn stop_text_never_guesses_that_the_task_is_waiting() {
    let mut store = StatusStore::default();
    store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);

    let stopped = store
        .apply_at(
            parse_hook(json!({
                "hook_event_name": "Stop",
                "session_id": "session-1",
                "last_assistant_message": "请继续说明一下？"
            }))
            .unwrap(),
            2_000,
        )
        .unwrap();

    assert_eq!(stopped.state, PetState::Completed);
    assert_eq!(stopped.active_count, 0);
}
```

- [ ] **Step 2: Run the focused Rust test and confirm it fails**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml bridge::tests::stop_text_never_guesses_that_the_task_is_waiting -- --exact
```

Expected: FAIL because `awaiting_input` still turns the stop into `WaitingInput`.

- [ ] **Step 3: Delete the heuristic field and parser branch**

Make `HookEvent` exactly:

```rust
pub struct HookEvent {
    pub kind: HookKind,
    pub session_id: String,
    pub resumable_session: bool,
    pub source: Option<String>,
    pub tool_name: Option<String>,
    pub user_input: Option<UserInputKind>,
}
```

Delete calculation of `awaiting_input`, delete the guarded `HookKind::Stop if event.awaiting_input` arm, and remove the field from the test helper. Preserve the existing structured `request_user_input` parsing.

- [ ] **Step 4: Run the bridge suite**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml bridge::tests
```

Expected: PASS, including separate `UserInputKind::Input` and `Choice` cases.

- [ ] **Step 5: Commit the parser change**

Run:

```powershell
git add -- src-tauri/src/bridge.rs
git diff --cached --check
git diff --cached -- src-tauri/src/bridge.rs
git commit -m "fix: trust only structured waiting hooks"
```

---

### Task 3: Make Aggregation Authoritative and Suppress Duplicate Transitions

**Files:**
- Modify: `src-tauri/src/bridge.rs`

- [ ] **Step 1: Add failing aggregation tests**

Add cases equivalent to:

```rust
#[test]
fn terminal_event_does_not_override_other_active_work() {
    let mut store = StatusStore::default();
    store.apply_at(event(HookKind::UserPromptSubmit, "running", None), 1_000);
    store.apply_at(event(HookKind::UserPromptSubmit, "waiting", None), 2_000);
    store.apply_at(event(
        HookKind::PreToolUse,
        "waiting",
        Some("request_user_input"),
    ), 3_000);

    let after_stop = store
        .apply_at(event(HookKind::Stop, "running", None), 4_000)
        .unwrap();
    assert_eq!(after_stop.state, PetState::WaitingChoice);
    assert_eq!(after_stop.running_count, 0);
    assert_eq!(after_stop.waiting_count, 1);
}

#[test]
fn duplicate_phase_event_does_not_emit_or_reannounce() {
    let mut store = StatusStore::default();
    assert!(store
        .apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000)
        .is_some());
    assert_eq!(
        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 2_000),
        None
    );
}
```

Also add a 0/1/2-running table test and a precedence test covering:

```text
WaitingChoice > WaitingPermission > WaitingInput > Running > Idle
```

- [ ] **Step 2: Run the new tests and confirm the current forced state fails**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml bridge::tests
```

Expected: FAIL because a stopped session currently forces `Completed`, and duplicate prompt events emit again.

- [ ] **Step 3: Implement one aggregate-after-mutation path**

Use this shape inside `StatusStore::apply_at`:

```rust
pub fn apply_at(&mut self, event: HookEvent, now_ms: u64) -> Option<StatusUpdate> {
    let before = self.current();
    let terminal = match event.kind {
        HookKind::SessionStart => return None,
        HookKind::UserPromptSubmit => {
            if !event.resumable_session {
                return None;
            }
            self.tasks
                .entry(event.session_id)
                .and_modify(|task| task.phase = TaskPhase::Running)
                .or_insert(Task {
                    started_at_ms: now_ms,
                    phase: TaskPhase::Running,
                });
            None
        }
        HookKind::PreToolUse if event.tool_name.as_deref() == Some("request_user_input") => {
            let task = self.tasks.get_mut(&event.session_id)?;
            task.phase = match event.user_input {
                Some(UserInputKind::Choice) => TaskPhase::WaitingChoice,
                _ => TaskPhase::WaitingInput,
            };
            None
        }
        HookKind::PermissionRequest => {
            self.tasks.get_mut(&event.session_id)?.phase = TaskPhase::WaitingPermission;
            None
        }
        HookKind::PostToolUse => {
            let task = self.tasks.get_mut(&event.session_id)?;
            let resumes = match task.phase {
                TaskPhase::WaitingInput | TaskPhase::WaitingChoice => {
                    event.tool_name.as_deref() == Some("request_user_input")
                }
                TaskPhase::WaitingPermission => true,
                TaskPhase::Running => false,
            };
            if !resumes {
                return None;
            }
            task.phase = TaskPhase::Running;
            None
        }
        HookKind::Stop => self.tasks.remove(&event.session_id).map(|_| PetState::Completed),
        HookKind::Interrupt => self
            .tasks
            .remove(&event.session_id)
            .map(|_| PetState::Interrupted),
        HookKind::SessionEnd => {
            self.tasks.remove(&event.session_id)?;
            None
        }
        HookKind::PreToolUse => return None,
    };

    let aggregate = self.aggregate_state();
    let visible = if aggregate == PetState::Idle {
        terminal.unwrap_or(PetState::Idle)
    } else {
        aggregate
    };
    let update = self.snapshot(visible);
    (update != before).then_some(update)
}
```

Important: if `SessionEnd` changes counts, it emits the new aggregate but remains silent in `AppState::apply_at`. Unknown Stop/Interrupt returns `None`. A terminal transition only appears when the removal leaves no active tasks.

- [ ] **Step 4: Update existing tests to compare aggregate results**

Change old expectations that assumed `SessionStart` always emits Idle or any Stop always emits Completed. Do not weaken count/timer assertions.

- [ ] **Step 5: Run the Rust suite**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml
```

Expected: all Rust tests PASS. If the running runtime owns the fixed named pipe and a pipe test reports `PermissionDenied`, exit that exact `CodexPet.exe` normally, rerun once, and record the reason in `PROGRESS.md`; do not rewrite the pipe tests.

- [ ] **Step 6: Commit the aggregation fix**

Run:

```powershell
git add -- src-tauri/src/bridge.rs
git diff --cached --check
git diff --cached -- src-tauri/src/bridge.rs
git commit -m "fix: aggregate concurrent Codex task states"
```

---

### Task 4: Introduce a Typed Frontend Presentation Model

**Files:**
- Modify: `src/status.ts`
- Modify: `src/status.test.ts`

- [ ] **Step 1: Add failing presentation tests**

Add tests for exact labels, tone, true running/waiting counts, and elapsed time:

```ts
it("presents running and waiting counts separately", () => {
  const view = statusPresentation(
    {
      state: "waiting_choice",
      activeCount: 3,
      runningCount: 2,
      waitingCount: 1,
      activeSinceMs: 1_000,
      bubbleText: null,
    },
    4_000,
  );

  expect(view).toEqual({
    label: "等待选择",
    tone: "waiting",
    running: "运行 2",
    waiting: "等待你 1",
    elapsed: "00:00:03",
  });
});

it("keeps failed as a display-only mapping", () => {
  expect(statusPresentation(update("failed"), 10_000)).toMatchObject({
    label: "任务失败",
    tone: "failed",
  });
});
```

Include duration cases `00:00:00`, `00:59:59`, and `01:00:00`.

- [ ] **Step 2: Run and confirm the missing API fails**

Run:

```powershell
npm test -- src/status.test.ts
```

Expected: FAIL because `statusPresentation` does not exist and `hudText` labels `activeCount` as running.

- [ ] **Step 3: Implement the small pure mapping**

Add:

```ts
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

export function statusPresentation(
  update: StatusUpdate,
  nowMs: number,
): StatusPresentation {
  return {
    label: LABELS[update.state],
    tone: TONES[update.state],
    running: `运行 ${update.runningCount}`,
    waiting: update.waitingCount > 0 ? `等待你 ${update.waitingCount}` : null,
    elapsed:
      update.activeSinceMs === null
        ? null
        : formatDuration(Math.max(0, nowMs - update.activeSinceMs)),
  };
}
```

Keep one private `formatDuration` function; delete `hudText` after `app.ts` no longer imports it.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npm test -- src/status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the presentation model**

Run:

```powershell
git add -- src/status.ts src/status.test.ts
git diff --cached --check
git diff --cached -- src/status.ts src/status.test.ts
git commit -m "test: define Codex status presentation contract"
```

---

### Task 5: Render the Compact Non-Interactive Status Card

**Files:**
- Modify: `src/app.ts`
- Modify: `src/status.test.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Add a failing DOM test for card structure and visibility**

Assert the rendered card fields instead of one text blob:

```ts
app.applyStatus({
  state: "waiting_permission",
  activeCount: 3,
  runningCount: 2,
  waitingCount: 1,
  activeSinceMs: 1_000,
  bubbleText: "需要授权。",
});

expect(root.querySelector("#hud")!.getAttribute("data-tone")).toBe("waiting");
expect(root.querySelector("#status-name")!.textContent).toBe("等待授权");
expect(root.querySelector("#status-running")!.textContent).toBe("运行 2");
expect(root.querySelector("#status-waiting")!.textContent).toBe("等待你 1");
expect(root.querySelector("#status-elapsed")!.textContent).toBe("00:00:03");
```

Use `vi.setSystemTime(4_000)` so elapsed output is deterministic. Also assert `#status-waiting.hidden === true` for Idle/Running with zero waiting.

- [ ] **Step 2: Run and confirm the old HUD fails**

Run:

```powershell
npm test -- src/status.test.ts
```

Expected: FAIL because the structured elements do not exist.

- [ ] **Step 3: Replace only the HUD markup and renderer**

Keep the existing pet, outfit menu, motion and voice behavior for now. Change only the HUD portion of `root.innerHTML` to:

```html
<section id="hud" aria-label="Codex 状态">
  <div class="status-heading">
    <span class="status-dot"></span>
    <span class="status-title">CodexPet</span>
    <span id="status-name"></span>
  </div>
  <div class="status-meta">
    <span id="status-running"></span>
    <span id="status-waiting"></span>
    <span id="status-elapsed"></span>
  </div>
</section>
```

Render from `statusPresentation(update, Date.now())`:

```ts
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
```

- [ ] **Step 4: Style six restrained tones without changing hit regions**

Use `pointer-events: none` on `#hud` and retain it outside the native hit-test element list. Define:

```css
#hud {
  --status-color: #718096;
  color: #f7fbff;
  border: 1px solid color-mix(in srgb, var(--status-color) 58%, transparent);
  background: rgb(20 25 34 / 76%);
  box-shadow: 0 8px 24px rgb(7 12 20 / 20%);
  backdrop-filter: blur(8px);
  pointer-events: none;
  transition: border-color 180ms ease, background-color 180ms ease;
}

#hud[data-tone="running"] { --status-color: #43c6e8; }
#hud[data-tone="waiting"] { --status-color: #e7ad4c; }
#hud[data-tone="completed"] { --status-color: #65c68a; }
#hud[data-tone="failed"] { --status-color: #d66a72; }
#hud[data-tone="interrupted"] { --status-color: #9a7bd1; }
```

Use the variable for the dot and subtle accent only. Do not add a UI dependency.

- [ ] **Step 5: Run frontend tests and build**

Run:

```powershell
npm test
npm run build
```

Expected: all frontend tests PASS and Vite build succeeds. Old tests that inspect HUD text must be updated to the structured contract, not deleted.

- [ ] **Step 6: Commit the card**

Run:

```powershell
git add -- src/app.ts src/status.test.ts src/styles.css
git diff --cached --check
git diff --cached -- src/app.ts src/status.test.ts src/styles.css
git commit -m "feat: render compact Codex status card"
```

---

### Task 6: Close Phase 1 with Full Verification

**Files:**
- Modify: `PROGRESS.md`

- [ ] **Step 1: Run all non-runtime verification**

Run:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
git diff --check
git status --short
```

Expected: all tests/build PASS; no whitespace errors; unrelated pre-existing files remain preserved.

- [ ] **Step 2: Update the progress ledger with exact evidence**

Record:

- test file/test counts reported by Vitest;
- Rust test count;
- build result;
- status source and priority now implemented;
- real `failed` detection still BLOCKED;
- next plan: `docs/superpowers/plans/2026-09-06-codexpet-live2d-rendering.md`.

- [ ] **Step 3: Commit the phase record**

Run:

```powershell
git add -- PROGRESS.md
git diff --cached --check
git diff --cached -- PROGRESS.md
git commit -m "docs: record status UI verification"
```

## Phase 1 Exit Criteria

- Structured `request_user_input` distinguishes input from choices.
- Text ending in a question mark never creates a waiting state.
- 0/1/2 running counts and all three waiting counts are correct.
- Active waiting/running work masks terminal feedback from another session.
- Duplicate phase events do not emit duplicate bubble/voice transitions.
- The status card renders state, true running count, waiting count, and elapsed time.
- The card and bubble remain non-interactive and do not widen the native click region.
- Frontend tests, Rust tests, and frontend production build pass.
- `PROGRESS.md` truthfully retains the real-failure blocker.
