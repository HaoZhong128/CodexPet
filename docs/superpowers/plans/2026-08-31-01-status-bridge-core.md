# CodexPet Status Bridge and Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable Windows Tauri shell that receives privacy-minimized Codex lifecycle events, aggregates multiple tasks, tracks time, and exposes a static pet-state snapshot.

**Architecture:** A small `codexpet-hook.exe` accepts either hook JSON on stdin or `notify` JSON in its first argument and forwards a normalized event through a current-user Windows named pipe. The Tauri Rust core owns all task state, deduplication, timers, connection health, and persistence; the TypeScript page only displays snapshots.

**Tech Stack:** Tauri 2, Rust stable, Tokio, Serde, Chrono, `windows` crate, `toml_edit`, Vite, vanilla TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-08-31-codex-desktop-pet-design.md`

## Global Constraints

- Windows 10/11 only.
- Use Tauri 2 with a transparent WebView2 window; do not introduce Electron.
- Never read `transcript_path`, `prompt`, `input-messages`, `last-assistant-message`, or command bodies.
- Local transport is a current-user Windows named pipe; do not open a TCP port.
- Character task states remain idle, running, waiting confirmation, completed, and failed/cancelled.
- Waiting confirmation has higher display priority than every other task state.
- Visual state must update within one second of receiving a local event.
- Preserve unrelated Codex configuration and create a backup before installation changes.
- Run focused tests before each commit and the complete Rust/TypeScript test suites before finishing this plan.

---

## File Map

```text
package.json                         workspace scripts and frontend dependencies
vite.config.ts                      frontend build/test configuration
src/main.ts                         minimal static status view
src/smoke.test.ts                   initial frontend test-runner proof
src/styles.css                      temporary shell styling
src/state/contracts.ts              TypeScript mirror of Rust snapshot DTOs
src/state/backend.ts                typed Tauri command/event adapter
src-tauri/Cargo.toml                Rust dependencies and hook binary target
src-tauri/tauri.conf.json           Windows/Tauri application configuration
src-tauri/src/lib.rs                Tauri setup and shared application state
src-tauri/src/main.rs               desktop binary entry point
src-tauri/src/bin/codexpet-hook.rs  short-lived Codex hook/notify adapter
src-tauri/src/domain/event.rs       normalized input types and privacy-safe adapters
src-tauri/src/domain/task.rs        task and display state types
src-tauri/src/domain/aggregate.rs   multi-task reducer and snapshot creation
src-tauri/src/domain/reminder.rs    reminder/result timing decisions
src-tauri/src/domain/dedupe.rs      event ledger and duplicate suppression
src-tauri/src/ipc/pipe.rs           current-user named-pipe server/client
src-tauri/src/codex/install.rs      reversible hooks.json/config.toml integration
src-tauri/src/storage.rs            settings and active-task snapshot persistence
src-tauri/src/settings.rs           shared validated application settings
src-tauri/src/commands.rs           Tauri commands exposed to TypeScript
src-tauri/tests/fixtures/*.json     privacy-reviewed Codex event samples
src-tauri/tests/status_flow.rs      end-to-end normalized event flow
```

### Task 1: Initialize the repository and runnable Tauri shell

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.ts`
- Create: `src/styles.css`
- Create: `src/smoke.test.ts`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: no earlier task.
- Produces: `cargo test --manifest-path src-tauri/Cargo.toml` and `npm test` entry points; a Tauri app named `CodexPet`.

- [ ] **Step 1: Initialize Git and add generated/local exclusions**

```powershell
git init
```

Create `.gitignore` with exactly these project exclusions:

```gitignore
node_modules/
dist/
src-tauri/target/
.superpowers/
*.log
*.wav
voice-cache/
```

- [ ] **Step 2: Scaffold the smallest Tauri 2 + vanilla TypeScript application**

Generate the template in a temporary child directory so the existing design documents and user assets are never overwritten:

```powershell
$scaffold = Join-Path (Get-Location) '.tauri-scaffold'
if (Test-Path $scaffold) { throw "Temporary scaffold path already exists: $scaffold" }
npm create tauri-app@latest .tauri-scaffold -- --template vanilla-ts --manager npm --tauri-version 2
```

Copy the generated `src/`, `src-tauri/`, `index.html`, `package.json`, `vite.config.ts`, and TypeScript configuration files into the project root. Verify `Resolve-Path $scaffold` equals the expected child path before removing that temporary directory. Keep the existing `人物素材/` directory, model archive, `docs/`, and `.gitignore`. Do not enable updater, deep links, SQL, React, or telemetry.

- [ ] **Step 3: Add deterministic test scripts**

Set the relevant `package.json` scripts to:

```json
{
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "tauri": "tauri",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:rust": "cargo test --manifest-path src-tauri/Cargo.toml"
  }
}
```

Add Vitest as a development dependency and create this initial runner test:

```ts
import { describe, expect, it } from "vitest";

describe("CodexPet frontend", () => {
  it("runs the TypeScript test suite", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Verify the empty shell**

Run:

```powershell
npm install
npm test
npm run test:rust
npm run dev
```

Expected: tests pass and one `CodexPet` window opens without console errors. Close the dev window after the check.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore package.json package-lock.json index.html vite.config.ts src src-tauri
git commit -m "build: scaffold CodexPet Tauri shell"
```

### Task 2: Define normalized events without retaining private content

**Files:**
- Create: `src-tauri/src/domain/mod.rs`
- Create: `src-tauri/src/domain/event.rs`
- Create: `src-tauri/tests/fixtures/hook-user-prompt-submit.json`
- Create: `src-tauri/tests/fixtures/hook-permission-request.json`
- Create: `src-tauri/tests/fixtures/hook-stop.json`
- Create: `src-tauri/tests/fixtures/notify-agent-turn-complete.json`

**Interfaces:**
- Consumes: official hook stdin fields `session_id`, `cwd`, `hook_event_name`, and optional `turn_id`; official notify fields `type`, `thread-id`, `turn-id`, and `cwd`.
- Produces: `NormalizedEvent::from_hook(Value)` and `NormalizedEvent::from_notify(Value)` returning `Result<NormalizedEvent, EventError>`.

- [ ] **Step 1: Write privacy and mapping tests**

Add tests covering these exact expectations:

```rust
#[test]
fn user_prompt_becomes_running_without_prompt_text() {
    let raw = serde_json::json!({
        "session_id": "thr_1", "turn_id": "turn_1",
        "cwd": "C:\\work\\CodexPet", "hook_event_name": "UserPromptSubmit",
        "prompt": "SECRET"
    });
    let event = NormalizedEvent::from_hook(raw).unwrap();
    assert_eq!(event.kind, EventKind::Running);
    assert_eq!(event.display_label, "CodexPet");
    assert!(!serde_json::to_string(&event).unwrap().contains("SECRET"));
}

#[test]
fn permission_request_becomes_waiting() {
    let raw = fixture("hook-permission-request.json");
    assert_eq!(NormalizedEvent::from_hook(raw).unwrap().kind, EventKind::PermissionRequired);
}

#[test]
fn notify_completion_ignores_message_content() {
    let raw = fixture("notify-agent-turn-complete.json");
    let event = NormalizedEvent::from_notify(raw).unwrap();
    assert_eq!(event.kind, EventKind::Completed);
    assert_eq!(event.session_id, "thr_1");
    assert!(!serde_json::to_string(&event).unwrap().contains("private answer"));
}
```

- [ ] **Step 2: Run the new tests and confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::event -- --nocapture
```

Expected: FAIL because `NormalizedEvent` and `EventKind` do not exist.

- [ ] **Step 3: Implement the exact normalized contract**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum EventKind {
    SessionStarted,
    Running,
    PermissionRequired,
    Completed,
    Failed,
    Cancelled,
    SessionEnded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NormalizedEvent {
    pub event_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub kind: EventKind,
    pub occurred_at: DateTime<Utc>,
    pub display_label: String,
}
```

Map `UserPromptSubmit` to `Running`, `PermissionRequest` to `PermissionRequired`, `Stop` and `agent-turn-complete` to `Completed`, `SessionStart` to `SessionStarted`, and `SessionEnd` to `SessionEnded`. Create `display_label` only from the final component of `cwd`. Generate `event_id` from source, session, turn, event type, and timestamp; never include `prompt`, `tool_input`, `input-messages`, or assistant messages.

- [ ] **Step 4: Run event tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::event -- --nocapture
```

Expected: PASS for mapping, invalid JSON, missing session ID, and privacy assertions.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/domain src-tauri/tests/fixtures src-tauri/Cargo.toml
git commit -m "feat: normalize privacy-safe Codex events"
```

### Task 3: Implement the per-session reducer and multi-task display snapshot

**Files:**
- Create: `src-tauri/src/domain/task.rs`
- Create: `src-tauri/src/domain/aggregate.rs`
- Modify: `src-tauri/src/domain/mod.rs`

**Interfaces:**
- Consumes: `NormalizedEvent`, `EventKind` from Task 2.
- Produces: `TaskAggregate::apply(event) -> ApplyOutcome` and `TaskAggregate::snapshot(now) -> AppSnapshot`.

- [ ] **Step 1: Write failing state and priority tests**

```rust
#[test]
fn waiting_beats_failed_completed_and_running() {
    let mut aggregate = TaskAggregate::default();
    aggregate.apply(event("run", EventKind::Running, "a"));
    aggregate.apply(event("fail", EventKind::Failed, "b"));
    aggregate.apply(event("wait", EventKind::PermissionRequired, "c"));
    let snapshot = aggregate.snapshot(at(20));
    assert_eq!(snapshot.display_state, DisplayState::PermissionRequired);
    assert_eq!(snapshot.badge_count, 1);
}

#[test]
fn task_elapsed_time_uses_original_running_timestamp() {
    let mut aggregate = TaskAggregate::default();
    aggregate.apply(event_at("run", EventKind::Running, "a", 10));
    assert_eq!(aggregate.snapshot(at(75)).tasks[0].elapsed_seconds, 65);
}
```

- [ ] **Step 2: Confirm the tests fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::aggregate
```

Expected: FAIL because the aggregate types do not exist.

- [ ] **Step 3: Implement task and snapshot types**

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskState { Idle, Running, PermissionRequired, Completed, Failed, Cancelled }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayState { Idle, Running, PermissionRequired, Completed, Error }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionHealth { Connected, WaitingForUpdate, Disconnected }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub session_id: String,
    pub label: String,
    pub state: TaskState,
    pub elapsed_seconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub connection: ConnectionHealth,
    pub display_state: DisplayState,
    pub badge_count: u32,
    pub tasks: Vec<TaskView>,
}
```

Use the exact priority `PermissionRequired > Failed/Cancelled > Completed > Running > Idle`. Preserve the first `Running` timestamp until a terminal event. Reject an event older than the session's `last_event_at` with `ApplyOutcome::Stale`.

- [ ] **Step 4: Cover all transitions and run tests**

Add cases for session start, running, waiting, completion, failure, cancellation, duplicate timestamps, stale events, session end, and falling back to the next-highest task.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::aggregate
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/domain
git commit -m "feat: aggregate Codex task states"
```

### Task 4: Add deduplication, result display windows, and reminder decisions

**Files:**
- Create: `src-tauri/src/domain/dedupe.rs`
- Create: `src-tauri/src/domain/reminder.rs`
- Modify: `src-tauri/src/domain/aggregate.rs`

**Interfaces:**
- Consumes: normalized `event_id`, session/turn IDs, task states, and an injected clock.
- Produces: `EventLedger::accept(&NormalizedEvent) -> bool` and `ReminderEngine::tick(now, &AppSnapshot) -> Vec<ReminderIntent>`.

- [ ] **Step 1: Write failing deterministic-clock tests**

```rust
#[test]
fn duplicate_hook_and_notify_completion_produce_one_result() {
    let mut ledger = EventLedger::default();
    assert!(ledger.accept(&completion("thr_1", "turn_1", "hook")));
    assert!(!ledger.accept(&completion("thr_1", "turn_1", "notify")));
}

#[test]
fn permission_follow_up_fires_once_at_two_minutes() {
    let mut engine = ReminderEngine::new(ReminderPolicy::default());
    engine.on_permission_required("thr_1", at(0));
    assert!(engine.tick(at(119), &snapshot()).is_empty());
    assert_eq!(engine.tick(at(120), &snapshot()).len(), 1);
    assert!(engine.tick(at(240), &snapshot()).is_empty());
}
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::dedupe
cargo test --manifest-path src-tauri/Cargo.toml domain::reminder
```

Expected: FAIL because the engines are undefined.

- [ ] **Step 3: Implement policies with exact defaults**

```rust
pub struct ReminderPolicy {
    pub permission_follow_up: Duration, // 120 seconds
    pub result_display: Duration,       // 10 seconds
    pub completion_merge: Duration,     // 10 seconds
    pub line_cooldown: Duration,        // 5 minutes
}

pub enum ReminderIntentKind { PermissionImmediate, PermissionFollowUp, Completed, Failed, Cancelled }
pub struct ReminderIntent {
    pub key: String,
    pub session_ids: Vec<String>,
    pub kind: ReminderIntentKind,
    pub created_at: DateTime<Utc>,
}
```

Deduplicate completion by `(session_id, turn_id, terminal-kind)` so Hook `Stop` and notify `agent-turn-complete` collapse. Retain event keys for 24 hours, prune on insertion, and never let duplicate events reset timers.

- [ ] **Step 4: Run all domain tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain
```

Expected: PASS, including exact boundary tests at 119/120 seconds and 9/10 seconds.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/domain
git commit -m "feat: schedule deduplicated task reminders"
```

### Task 5: Build the current-user Windows named-pipe transport and hook executable

**Files:**
- Create: `src-tauri/src/ipc/mod.rs`
- Create: `src-tauri/src/ipc/pipe.rs`
- Create: `src-tauri/src/bin/codexpet-hook.rs`
- Create: `src-tauri/tests/pipe_round_trip.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: raw Hook JSON on stdin or notify JSON from `argv[1]`.
- Produces: newline-delimited `NormalizedEvent` JSON on `format!(r"\\.\pipe\codexpet-v1-{}", current_user_sid())`.

- [ ] **Step 1: Write failing input-source and round-trip tests**

```rust
#[test]
fn hook_reads_stdin_and_notify_reads_single_argument() {
    assert_eq!(read_payload(Source::Hook, &[], br#"{"session_id":"thr_1"}"#).unwrap().len(), 1);
    assert_eq!(read_payload(Source::Notify, &[json_arg()], &[]).unwrap().len(), 1);
}

#[tokio::test]
async fn current_user_pipe_round_trips_one_event() {
    let endpoint = test_endpoint();
    let server = PipeServer::bind(endpoint.clone()).await.unwrap();
    PipeClient::send(endpoint, &running_event()).await.unwrap();
    assert_eq!(server.next().await.unwrap(), running_event());
}
```

- [ ] **Step 2: Run and confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test pipe_round_trip
```

Expected: FAIL because pipe types and hook binary do not exist.

- [ ] **Step 3: Implement a bounded, non-blocking pipe client**

The hook process must connect and write within 250 ms, then exit `0`. If CodexPet is not running, it must still exit `0` without printing task content or slowing Codex. Limit accepted payloads to 64 KiB and one JSON event per connection.

```rust
pub async fn send(endpoint: &PipeEndpoint, event: &NormalizedEvent) -> Result<(), PipeError>;
pub async fn next(&mut self) -> Result<NormalizedEvent, PipeError>;
pub fn endpoint_for_current_user() -> Result<PipeEndpoint, PipeError>;
```

Use the Windows account SID in the pipe name and a security descriptor that grants access only to that SID and LocalSystem.

- [ ] **Step 4: Implement the hook binary source switch**

Accepted invocations:

```powershell
codexpet-hook.exe hook
codexpet-hook.exe notify '{"type":"agent-turn-complete","thread-id":"thr_1","turn-id":"turn_1","cwd":"G:\\Codex code\\CodexPet","input-messages":[],"last-assistant-message":""}'
```

For `hook`, read one JSON object from stdin. For `notify`, read exactly one JSON argument. Normalize, send, and exit without stdout; invalid input returns a nonzero exit code without echoing the payload.

- [ ] **Step 5: Run transport and privacy tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test pipe_round_trip
cargo test --manifest-path src-tauri/Cargo.toml domain::event
```

Expected: PASS; a missing server completes in under 500 ms.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/ipc src-tauri/src/bin src-tauri/tests src-tauri/Cargo.toml
git commit -m "feat: forward Codex events over user pipe"
```

### Task 6: Add reversible Codex integration installation

**Files:**
- Create: `src-tauri/src/codex/mod.rs`
- Create: `src-tauri/src/codex/install.rs`
- Create: `src-tauri/tests/codex_install.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: Codex home path, installed `codexpet-hook.exe` path, existing `hooks.json`, and existing `config.toml`.
- Produces: `inspect_installation`, `install_integration`, and `uninstall_integration` with backup paths and diagnostics.

- [ ] **Step 1: Write failing preservation tests using temporary directories**

```rust
#[test]
fn install_preserves_unrelated_hooks_and_config() {
    let home = fixture_codex_home_with_existing_entries();
    install_integration(&home, hook_exe()).unwrap();
    assert!(read_hooks(&home).contains("existing-tool"));
    assert!(read_config(&home).contains("model = \"gpt-existing\""));
    assert!(backup_exists(&home, "hooks.json"));
    assert!(backup_exists(&home, "config.toml"));
}

#[test]
fn uninstall_removes_only_codexpet_entries() {
    let home = installed_fixture();
    uninstall_integration(&home).unwrap();
    assert!(read_hooks(&home).contains("existing-tool"));
    assert!(!read_hooks(&home).contains("codexpet-hook.exe"));
}
```

- [ ] **Step 2: Confirm the tests fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test codex_install
```

Expected: FAIL because installation functions do not exist.

- [ ] **Step 3: Implement exact hook entries**

Merge current-user `hooks.json` entries for `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PermissionRequest`, and `Stop`. Each command handler uses an absolute quoted Windows path, `timeout: 1`, and no decision output. Use `commandWindows` so the hook executable receives `hook` and reads stdin.

Canonicalize the installed hook path and merge `notify = [canonical_hook_path, "notify"]` into `config.toml` with `toml_edit`. If an unrelated notify command already exists, report a visible conflict instead of overwriting it.

- [ ] **Step 4: Make writes atomic and reversible**

Write new content to a sibling temporary file, flush it, then replace the target. Before the first change in an installation attempt, create timestamped `.codexpet.bak` files. If either file update fails, restore both original files.

- [ ] **Step 5: Run installation tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test codex_install
```

Expected: PASS for empty files, existing unrelated entries, repeated install, uninstall, notify conflict, malformed JSON/TOML, and rollback.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/codex src-tauri/tests/codex_install.rs src-tauri/Cargo.toml
git commit -m "feat: install reversible Codex integration"
```

### Task 7: Persist settings and active-task snapshots

**Files:**
- Create: `src-tauri/src/storage.rs`
- Create: `src-tauri/src/settings.rs`
- Create: `src-tauri/tests/storage_round_trip.rs`
- Modify: `src-tauri/src/domain/aggregate.rs`

**Interfaces:**
- Consumes: Tauri app-data directory, `AppSettings`, and serializable active `TaskRecord` values.
- Produces: `Storage::load`, `save_settings`, `save_active_tasks`, and `clear_finished`.

- [ ] **Step 1: Write failing round-trip and privacy tests**

```rust
#[test]
fn snapshot_round_trip_keeps_start_time_without_content() {
    let storage = Storage::new(tempdir().unwrap().path());
    storage.save_active_tasks(&[active_task_at(10)]).unwrap();
    let loaded = storage.load().unwrap();
    assert_eq!(loaded.tasks[0].started_at, at(10));
    let raw = std::fs::read_to_string(storage.snapshot_path()).unwrap();
    assert!(!raw.contains("prompt"));
    assert!(!raw.contains("assistant"));
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test storage_round_trip
```

- [ ] **Step 3: Implement versioned JSON storage**

```rust
#[derive(Serialize, Deserialize)]
pub struct PersistedStateV1 {
    pub version: u32,
    pub settings: AppSettings,
    pub active_tasks: Vec<TaskRecord>,
    pub dedupe_keys: Vec<DedupeRecord>,
}
```

Define the first shared settings contract in `settings.rs`:

```rust
pub struct AppSettings {
    pub reminder_delay_seconds: u64,
    pub reminder_repeat_count: u8,
    pub result_display_seconds: u64,
    pub pet_scale: f64,
    pub always_on_top: bool,
}
```

Defaults are 120 seconds, one repeat, 10 seconds, scale 1.0, and always-on-top enabled. Later plans extend this same struct rather than defining a second settings store.

Use atomic replace and a `.bak` sibling. On parse failure, keep the damaged file, load safe defaults, and surface a diagnostic. Restored active tasks use `ConnectionHealth::WaitingForUpdate` until a new event arrives.

- [ ] **Step 4: Run storage and domain tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test storage_round_trip
cargo test --manifest-path src-tauri/Cargo.toml domain
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/storage.rs src-tauri/src/domain/aggregate.rs src-tauri/tests/storage_round_trip.rs
git commit -m "feat: persist CodexPet active state"
```

### Task 8: Wire the core into Tauri and expose a static status view

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src/state/contracts.ts`
- Create: `src/state/backend.ts`
- Modify: `src/main.ts`
- Modify: `src/styles.css`
- Create: `src/state/backend.test.ts`
- Create: `src-tauri/tests/status_flow.rs`

**Interfaces:**
- Consumes: `TaskAggregate`, named-pipe server, reminder engine, and storage.
- Produces: Tauri command `get_snapshot() -> AppSnapshot` and event `codexpet://snapshot` carrying the same DTO.

- [ ] **Step 1: Write failing Rust status-flow test**

```rust
#[tokio::test]
async fn pipe_event_updates_the_shared_snapshot() {
    let app = TestCore::start().await;
    app.send(running_event()).await;
    let snapshot = app.snapshot().await;
    assert_eq!(snapshot.display_state, DisplayState::Running);
    assert_eq!(snapshot.tasks.len(), 1);
}
```

- [ ] **Step 2: Write failing TypeScript contract test**

```ts
it("maps the backend snapshot without inventing state", () => {
  expect(parseSnapshot(fixture).displayState).toBe("running");
  expect(parseSnapshot(fixture).tasks[0].elapsedSeconds).toBe(42);
});
```

- [ ] **Step 3: Run both tests and confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test status_flow
npm test -- src/state/backend.test.ts
```

- [ ] **Step 4: Implement shared core setup and typed frontend adapter**

Start the pipe listener during Tauri setup, apply events under a short-lived async lock, persist after accepted changes, emit a new snapshot, and tick reminders at 250 ms. The frontend calls `get_snapshot` once, then listens to `codexpet://snapshot`.

```ts
export interface AppSnapshot {
  connection: "connected" | "waitingForUpdate" | "disconnected";
  displayState: "idle" | "running" | "permissionRequired" | "completed" | "error";
  badgeCount: number;
  tasks: TaskView[];
}
```

The temporary page displays only state, badge count, and task rows. It is intentionally not the final pet UI.

- [ ] **Step 5: Run all tests and a manual real-event smoke test**

```powershell
npm test
npm run test:rust
npm run dev
```

In a separate PowerShell window, pipe the fixture into the debug hook executable. Expected: the status view changes to `running` in under one second and never displays fixture prompt/message fields.

- [ ] **Step 6: Commit**

```powershell
git add src src-tauri
git commit -m "feat: expose live Codex status snapshots"
```

## Plan Completion Check

Run:

```powershell
npm test
npm run test:rust
npm run build -- --debug
git status --short
```

Expected: all tests pass, the debug bundle and `codexpet-hook.exe` build, and Git reports no uncommitted files. Then verify the user-installed Hook definitions in Codex via `/hooks`; Codex requires non-managed hooks to be explicitly reviewed and trusted before they run.
