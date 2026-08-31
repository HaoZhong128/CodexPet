# CodexPet Windows Hardening and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove failure safety and resource behavior, complete real Codex integration testing, and produce a clean Windows installer with recovery documentation.

**Architecture:** Keep all optional dependencies behind tested failure boundaries, add deterministic fault-injection and end-to-end fixtures, then package only the desktop executable, hook helper, UI/Live2D runtime assets, and documentation. GPT-SoVITS models remain user-managed external files.

**Tech Stack:** Tauri 2 bundler, Rust/TypeScript test suites, PowerShell smoke scripts, Windows 10/11, WebView2

**Spec:** `docs/superpowers/specs/2026-08-31-codex-desktop-pet-design.md`

## Global Constraints

- Complete Plans 01–03 first.
- Never bundle the 8+ GB GPT-SoVITS archive, extracted weights, reference voice, or user Codex configuration.
- Never log prompts, commands, tool input, assistant output, reference text, or generated speech text.
- Installer/uninstaller must preserve unrelated Codex configuration.
- TTS and Live2D failure must not terminate the desktop pet.
- State and bubble updates must arrive within one second of receiving a local event.
- Measure desktop-pet resource usage separately from GPT-SoVITS.

---

## File Map

```text
src-tauri/src/diagnostics.rs          redacted local diagnostics and health snapshot
src-tauri/tests/fault_injection.rs    optional-component failure matrix
src-tauri/tests/end_to_end.rs         multi-task event-to-UI/speech command flow
tests/e2e/event-sequences/*.jsonl     privacy-safe deterministic scenarios
scripts/smoke-windows.ps1             installed-build smoke test
scripts/measure-resources.ps1         separate pet/TTS measurements
scripts/verify-package.ps1            bundle-content and secret scan
docs/install.md                       nontechnical installation/setup guide
docs/troubleshooting.md               recovery and connection/TTS guidance
docs/release-checklist.md              signed manual acceptance record
src-tauri/tauri.conf.json             bundle metadata and resources
```

### Task 1: Add redacted diagnostics and a health report

**Files:**
- Create: `src-tauri/src/diagnostics.rs`
- Create: `src-tauri/tests/diagnostics_redaction.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/components/settings-window.ts`

**Interfaces:**
- Consumes: component status, error categories, versions, and timestamps.
- Produces: `get_diagnostics() -> DiagnosticsReport` and a user-triggered export file containing no content fields.

- [ ] **Step 1: Write a failing privacy test**

```rust
#[test]
fn diagnostics_never_contain_sensitive_payload_fields() {
    let report = report_after_error(raw_event_with_secrets());
    let json = serde_json::to_string(&report).unwrap();
    for forbidden in ["prompt", "tool_input", "input-messages", "last-assistant-message", "SECRET"] {
        assert!(!json.contains(forbidden));
    }
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test diagnostics_redaction
```

- [ ] **Step 3: Implement typed diagnostic codes**

```rust
pub enum DiagnosticCode {
    CodexHookNotTrusted,
    CodexPipeUnavailable,
    CodexConfigConflict,
    Live2dLoadFailed,
    VoiceConfigInvalid,
    VoiceStartFailed,
    VoiceRequestFailed,
    StorageRecoveredFromBackup,
}
```

Store code, component, timestamp, and a fixed safe message. Do not accept arbitrary error strings from raw events. Show the newest 50 entries and allow export only after explicit user action.

- [ ] **Step 4: Run tests and inspect one export**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test diagnostics_redaction
```

Expected: PASS and exported JSON contains no paths beyond the application directory and no task content.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/diagnostics.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tests/diagnostics_redaction.rs src/components/settings-window.ts
git commit -m "feat: add privacy-safe diagnostics"
```

### Task 2: Add deterministic fault-injection coverage

**Files:**
- Create: `src-tauri/tests/fault_injection.rs`
- Create: `tests/e2e/event-sequences/disconnect.jsonl`
- Create: `tests/e2e/event-sequences/duplicates.jsonl`
- Create: `tests/e2e/event-sequences/out-of-order.jsonl`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: injected `PipeTransport`, `PetAssetHealth`, `VoiceBackend`, `StorageBackend`, and test clocks.
- Produces: no new production feature; proves existing recovery contracts.

- [ ] **Step 1: Write the failure matrix as failing tests**

```rust
#[tokio::test]
async fn optional_failures_leave_core_responsive() {
    for fault in [Fault::PipeDisconnect, Fault::Live2dMissing, Fault::VoiceCrash, Fault::StorageCorrupt] {
        let app = TestApp::with_fault(fault).await;
        app.send(running_event()).await;
        assert!(app.snapshot().await.is_available());
        assert!(!app.has_exited());
    }
}
```

- [ ] **Step 2: Confirm at least one scenario fails before hardening**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test fault_injection -- --nocapture
```

- [ ] **Step 3: Add only the recovery boundaries required by failing tests**

Expected behaviors:

- Pipe disconnect: keep tasks as waiting-for-update and retry listener creation.
- Live2D missing: frontend selects static renderer.
- Voice crash: bubble remains, process status becomes faulted, next request may restart it.
- Corrupt storage: retain damaged file, load backup/defaults, and emit one diagnostic.
- Duplicate/out-of-order events: no repeat speech and no state regression.

- [ ] **Step 4: Run the full failure matrix**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test fault_injection
npm test
```

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src src-tauri/tests/fault_injection.rs tests/e2e/event-sequences
git commit -m "test: harden optional component failures"
```

### Task 3: Build an end-to-end multi-task acceptance harness

**Files:**
- Create: `src-tauri/tests/end_to_end.rs`
- Create: `tests/e2e/event-sequences/multi-task.jsonl`
- Create: `tests/e2e/event-sequences/permission-reminder.jsonl`
- Create: `tests/e2e/event-sequences/completion-merge.jsonl`
- Create: `scripts/smoke-windows.ps1`

**Interfaces:**
- Consumes: JSONL normalized event sequences and an injected clock.
- Produces: assertions over snapshots, renderer commands, bubbles, and speech commands.

- [ ] **Step 1: Write a failing end-to-end sequence test**

```rust
#[tokio::test]
async fn multi_task_sequence_matches_approved_priority_and_timing() {
    let result = run_sequence("tests/e2e/event-sequences/multi-task.jsonl").await;
    assert_eq!(result.at("00:05").display_state, DisplayState::PermissionRequired);
    assert_eq!(result.at("00:05").badge_count, 1);
    assert_eq!(result.at("00:15").display_state, DisplayState::Running);
    assert_eq!(result.spoken_completion_count(), 1);
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test end_to_end
```

- [ ] **Step 3: Implement the JSONL harness and exact sequences**

Each line contains only `advance_ms` and a complete `NormalizedEvent`. Cover two running tasks, one permission request, one failed task, three completions inside ten seconds, duplicate Hook/notify completion, and a stale event.

- [ ] **Step 4: Add installed-build smoke checks**

`scripts/smoke-windows.ps1` must:

1. Launch the built CodexPet executable.
2. Wait for the current-user pipe.
3. Invoke `codexpet-hook.exe hook` with privacy-safe fixtures.
4. Query the diagnostic snapshot command through the test-only interface.
5. Confirm process responsiveness and exit cleanly.

- [ ] **Step 5: Run acceptance tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test end_to_end
powershell -ExecutionPolicy Bypass -File scripts/smoke-windows.ps1 -BuildDir src-tauri\target\debug
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/tests/end_to_end.rs tests/e2e/event-sequences scripts/smoke-windows.ps1
git commit -m "test: add CodexPet end-to-end acceptance"
```

### Task 4: Verify real Codex Desktop, CLI, and IDE events

**Files:**
- Create: `docs/codex-integration-validation.md`
- Modify: `src-tauri/tests/fixtures/*.json`
- Modify: `src-tauri/src/domain/event.rs`

**Interfaces:**
- Consumes: current official Codex Hook stdin and notify argument formats.
- Produces: privacy-scrubbed fixtures and a validation record for Desktop, CLI, and IDE.

- [ ] **Step 1: Install the debug integration through CodexPet**

Use the settings command, then open `/hooks` in Codex and explicitly review/trust the new user-level definitions. Verify the definitions use the debug `codexpet-hook.exe` absolute path and one-second timeout.

- [ ] **Step 2: Capture only allowed fields from each source**

For Desktop, CLI, and IDE, trigger session start, prompt submit, permission request, stop, completion notify, and session end where supported. Store only field names, types, source name, and redacted IDs; remove prompts, tool input, assistant messages, and transcript paths before saving fixtures.

- [ ] **Step 3: Turn every observed shape difference into an adapter test**

```rust
#[test]
fn every_validated_fixture_normalizes_without_content() {
    for fixture in validated_fixtures() {
        let event = normalize(fixture.raw).unwrap();
        assert!(event.display_label.len() <= 80);
        assert!(event_is_privacy_safe(&event));
    }
}
```

- [ ] **Step 4: Run adapter and end-to-end suites**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml domain::event
cargo test --manifest-path src-tauri/Cargo.toml --test end_to_end
```

- [ ] **Step 5: Document current-version results**

Record the Codex version, source app, events observed, any unsupported event, and the chosen safe fallback. Do not claim failure/cancellation detection for a source unless a real validated event supports it.

- [ ] **Step 6: Commit**

```powershell
git add docs/codex-integration-validation.md src-tauri/tests/fixtures src-tauri/src/domain/event.rs
git commit -m "test: validate current Codex lifecycle events"
```

### Task 5: Measure pet and TTS resources separately

**Files:**
- Create: `scripts/measure-resources.ps1`
- Create: `docs/performance.md`

**Interfaces:**
- Consumes: built desktop process and optional child GPT-SoVITS process ID.
- Produces: timestamped CSV samples and a summarized measurement table.

- [ ] **Step 1: Implement a fixed measurement script**

Sample working set, private memory, CPU time delta, handle count, and GPU dedicated bytes when available, once per second for 60 seconds. Identify the pet process and its child TTS process separately by PID; do not group all Python processes.

- [ ] **Step 2: Measure the four required scenarios**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/measure-resources.ps1 -Scenario PetIdle
powershell -ExecutionPolicy Bypass -File scripts/measure-resources.ps1 -Scenario PetLive2DRunning
powershell -ExecutionPolicy Bypass -File scripts/measure-resources.ps1 -Scenario TtsWarm
powershell -ExecutionPolicy Bypass -File scripts/measure-resources.ps1 -Scenario TtsStopped
```

- [ ] **Step 3: Verify the lightweight contract**

Confirm the pet process never loads model weights and dedicated model GPU memory returns after the 10-minute idle shutdown/manual stop. Record measured values rather than introducing an unverified hard memory target.

- [ ] **Step 4: Commit**

```powershell
git add scripts/measure-resources.ps1 docs/performance.md
git commit -m "perf: measure desktop pet and voice separately"
```

### Task 6: Configure the Windows bundle and exclude user-owned data

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.toml`
- Create: `scripts/verify-package.ps1`
- Create: `docs/install.md`

**Interfaces:**
- Consumes: release desktop binary, hook helper, fallback image, Live2D runtime files, and application metadata.
- Produces: Windows installer and package verification report.

- [ ] **Step 1: Configure explicit bundle resources**

Include only:

- `codexpet-hook.exe`
- frontend bundle
- fallback character PNG
- permitted Live2D runtime/model assets
- default line JSON

Exclude `人物素材/`, `assets/live2d-source/`, `.superpowers/`, GPT-SoVITS archives/weights, reference WAV files, diagnostics, caches, and Codex configuration.

- [ ] **Step 2: Add package-content verification**

`scripts/verify-package.ps1` expands the installer to a temporary directory, lists files, fails on extensions `.7z`, `.ckpt`, `.pth`, `.wav`, `.cmo3`, `.psd`, or paths containing `人物素材`, and scans text files for `prompt`, `last-assistant-message`, and development absolute paths.

- [ ] **Step 3: Build and verify the release installer**

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File scripts/verify-package.ps1 -BundleDir src-tauri\target\release\bundle
```

Expected: bundle verification passes and installer size excludes all TTS/model source data.

- [ ] **Step 4: Write the nontechnical installation guide**

Cover install, first launch, Codex integration/trust review, GPT-SoVITS directory selection, voice test, tray behavior, uninstall, and where settings/cache live. State clearly that the model remains external.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml scripts/verify-package.ps1 docs/install.md
git commit -m "build: package CodexPet for Windows"
```

### Task 7: Run the complete release checklist

**Files:**
- Create: `docs/release-checklist.md`
- Create: `docs/troubleshooting.md`

**Interfaces:**
- Consumes: release installer and all automated/manual checks.
- Produces: signed-off release checklist and recovery guide.

- [ ] **Step 1: Run all automated checks from a clean checkout**

```powershell
npm ci
npm test
npm run test:rust
npm run build
powershell -ExecutionPolicy Bypass -File scripts/verify-package.ps1 -BundleDir src-tauri\target\release\bundle
```

- [ ] **Step 2: Install on a clean Windows user profile**

Verify first launch, Codex integration installation, `/hooks` trust review, Desktop/CLI/IDE events, two concurrent tasks, waiting reminder, completion merge, both outfits, all expressions, pet/poke, DND, settings persistence, tray, auto-start, hide/show, and uninstall.

- [ ] **Step 3: Run the failure checklist**

Repeat with GPT-SoVITS path missing, TTS process killed mid-request, Live2D model directory missing, Codex hooks untrusted, app snapshot corrupted, and Codex not running. Confirm static/bubble fallbacks and no application exit.

- [ ] **Step 4: Write troubleshooting actions**

For each diagnostic code, document the exact user action: trust hooks, reinstall connection, restore config backup, select model path, restart voice, clear cache, reset window position, or collect redacted diagnostics.

- [ ] **Step 5: Record the release evidence and commit**

```powershell
git add docs/release-checklist.md docs/troubleshooting.md
git commit -m "docs: complete CodexPet release verification"
```

## Plan Completion Check

The release is complete only when all tests pass from a clean checkout, the verified installer works on a clean Windows profile, all manual checklist rows contain date/result/evidence, the bundle contains no user-owned model or source assets, and `git status --short` is empty.

