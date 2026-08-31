# CodexPet GPT-SoVITS Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable local GPT-SoVITS v2Pro character speech with lazy startup, caching, priority, deduplication, and text-only fallback.

**Architecture:** Rust owns the GPT-SoVITS process, HTTP client, cache, and speech scheduler. The frontend receives only a ready local audio path plus bubble text, plays one item at a time, and reports completion; failures never block task state or visual reminders.

**Tech Stack:** Rust stable, Tokio, Reqwest, SHA-256, Tauri events/commands, Web Audio/HTMLAudioElement, GPT-SoVITS v2Pro `api_v2.py`

**Spec:** `docs/superpowers/specs/2026-08-31-codex-desktop-pet-design.md`

## Global Constraints

- Complete Plans 01 and 02 first.
- Use the user's existing GPT-SoVITS v2Pro model; do not train or bundle a model.
- Default to lazy start and stop the service after 10 minutes without pending or active speech.
- Show the text bubble immediately; never wait for TTS startup before showing a reminder.
- Same event speaks once, the same line cools down for five minutes, and completions merge within ten seconds.
- Waiting confirmation may interrupt idle or interaction speech.
- Do-not-disturb disables audio only; it must not disable bubbles or animations.
- Never send text, reference audio, or model data to a network host other than loopback.

---

## File Map

```text
src-tauri/src/voice/config.rs       validated GPT-SoVITS paths and voice parameters
src-tauri/src/voice/process.rs      api_v2.py lifecycle and health checks
src-tauri/src/voice/client.rs       loopback synthesis request client
src-tauri/src/voice/cache.rs        stable audio-key and bounded cache
src-tauri/src/voice/scheduler.rs    priority, merge, cooldown, and interruption
src-tauri/src/voice/mod.rs          VoiceService facade
src-tauri/tests/voice_*.rs          isolated process/client/cache/scheduler tests
src/audio/player.ts                 one-at-a-time frontend playback
src/audio/player.test.ts            playback completion/interruption tests
src/components/settings-window.ts   voice configuration and diagnostics
src/assets/lines.zh-CN.json         approved text pools from Plan 02
```

### Task 1: Define and validate the local voice configuration

**Files:**
- Create: `src-tauri/src/voice/mod.rs`
- Create: `src-tauri/src/voice/config.rs`
- Create: `src-tauri/tests/voice_config.rs`
- Modify: `src-tauri/src/settings.rs`

**Interfaces:**
- Consumes: user-selected GPT-SoVITS root, Python executable, model weights, reference WAV, reference text/language, output language, volume, and auto-stop setting.
- Produces: `VoiceConfig::validate() -> Result<ValidatedVoiceConfig, VoiceConfigError>`.

- [ ] **Step 1: Write failing validation tests**

```rust
#[test]
fn validation_rejects_missing_or_non_local_assets() {
    let config = VoiceConfig { api_base: "http://192.168.1.2:9880".into(), ..fixture_config() };
    assert_eq!(config.validate().unwrap_err(), VoiceConfigError::NonLoopbackEndpoint);
}

#[test]
fn defaults_use_lazy_start_and_ten_minute_shutdown() {
    let value = VoiceSettings::default();
    assert!(!value.prewarm_on_launch);
    assert_eq!(value.idle_shutdown_seconds, 600);
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_config
```

- [ ] **Step 3: Implement the exact config types**

```rust
pub struct VoiceConfig {
    pub python_exe: PathBuf,
    pub api_script: PathBuf,
    pub gpt_weights: PathBuf,
    pub sovits_weights: PathBuf,
    pub reference_audio: PathBuf,
    pub reference_text: String,
    pub reference_language: String,
    pub output_language: String,
    pub api_base: Url,
}
```

Canonicalize local paths, require files to exist, require an HTTP loopback host, and redact reference text and paths from user-visible error logs. Store paths in settings but never copy model files into the app data directory.

- [ ] **Step 4: Run tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_config
```

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/voice src-tauri/src/settings.rs src-tauri/tests/voice_config.rs
git commit -m "feat: validate local character voice settings"
```

### Task 2: Manage the GPT-SoVITS service lifecycle

**Files:**
- Create: `src-tauri/src/voice/process.rs`
- Create: `src-tauri/tests/voice_process.rs`
- Create: `src-tauri/tests/fixtures/fake_tts_server.py`
- Modify: `src-tauri/src/voice/mod.rs`

**Interfaces:**
- Consumes: `ValidatedVoiceConfig`, injected process launcher, clock, and health probe.
- Produces: `VoiceProcess::ensure_running`, `stop`, `tick_idle`, and `status`.

- [ ] **Step 1: Write failing lifecycle tests against the fake server**

```rust
#[tokio::test]
async fn concurrent_start_requests_launch_one_process() {
    let voice = test_voice_process();
    tokio::join!(voice.ensure_running(), voice.ensure_running());
    assert_eq!(voice.launch_count(), 1);
}

#[tokio::test]
async fn idle_service_stops_after_six_hundred_seconds() {
    let voice = test_voice_process();
    voice.ensure_running().await.unwrap();
    voice.tick_idle(at(599)).await;
    assert!(voice.is_running());
    voice.tick_idle(at(600)).await;
    assert!(!voice.is_running());
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_process
```

- [ ] **Step 3: Implement one guarded child process**

Launch the configured Python executable from the extracted package root with the package's documented arguments:

```text
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

If port 9880 is already occupied by a process not started by CodexPet, return `VoiceProcessError::PortInUse` rather than connecting to it. After the service is reachable, call `/set_gpt_weights` and `/set_sovits_weights` with the configured model paths. Hide the Windows console window. Poll loopback readiness with a bounded 30-second startup deadline; preserve stderr in a size-limited local diagnostic file without task text.

```rust
pub enum VoiceProcessStatus { Stopped, Starting, Ready, Faulted }
pub async fn ensure_running(&self) -> Result<(), VoiceProcessError>;
pub async fn stop(&self) -> Result<(), VoiceProcessError>;
```

- [ ] **Step 4: Implement shutdown safety**

Reset the 10-minute idle deadline after successful synthesis and playback completion. Do not stop while requests are queued or audio is playing. On app exit, terminate only the child process started by CodexPet; never kill arbitrary Python processes.

- [ ] **Step 5: Run lifecycle tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_process
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/voice/process.rs src-tauri/src/voice/mod.rs src-tauri/tests/voice_process.rs src-tauri/tests/fixtures/fake_tts_server.py
git commit -m "feat: manage GPT-SoVITS lifecycle"
```

### Task 3: Add synthesis requests and a bounded local audio cache

**Files:**
- Create: `src-tauri/src/voice/client.rs`
- Create: `src-tauri/src/voice/cache.rs`
- Create: `src-tauri/tests/voice_client.rs`
- Create: `src-tauri/tests/voice_cache.rs`
- Modify: `src-tauri/src/voice/mod.rs`

**Interfaces:**
- Consumes: `SynthesisRequest { text, text_language, voice_fingerprint }`.
- Produces: `VoiceService::synthesize(request) -> Result<CachedAudio, VoiceError>`.

- [ ] **Step 1: Write failing client and cache tests**

```rust
#[tokio::test]
async fn repeated_fixed_line_uses_cached_audio() {
    let service = test_voice_service();
    let first = service.synthesize(request("任务完成了")).await.unwrap();
    let second = service.synthesize(request("任务完成了")).await.unwrap();
    assert_eq!(first.path, second.path);
    assert_eq!(service.http_request_count(), 1);
}

#[test]
fn cache_key_changes_when_voice_assets_change() {
    assert_ne!(cache_key(request_with_voice("a")), cache_key(request_with_voice("b")));
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_client
cargo test --manifest-path src-tauri/Cargo.toml --test voice_cache
```

- [ ] **Step 3: Implement the HTTP adapter for the installed `api_v2.py` contract**

POST to `/tts` with the v2Pro package's exact non-streaming WAV request fields:

```json
{
  "text": "任务完成了",
  "text_lang": "zh",
  "ref_audio_path": "C:\\voice\\reference.wav",
  "aux_ref_audio_paths": [],
  "prompt_text": "参考音频对应文本",
  "prompt_lang": "zh",
  "top_k": 15,
  "top_p": 1.0,
  "temperature": 1.0,
  "text_split_method": "cut5",
  "batch_size": 1,
  "batch_threshold": 0.75,
  "split_bucket": true,
  "speed_factor": 1.0,
  "fragment_interval": 0.3,
  "seed": -1,
  "media_type": "wav",
  "streaming_mode": false,
  "parallel_infer": true,
  "repetition_penalty": 1.35,
  "sample_steps": 32,
  "super_sampling": false,
  "overlap_length": 2,
  "min_chunk_length": 16
}
```

Replace only text, languages, and configured reference values at runtime. Set connect and request timeouts, reject redirects or non-loopback endpoints, require HTTP 200 with an audio content type, and save the returned WAV bytes.

```rust
pub struct SynthesisRequest {
    pub text: String,
    pub text_language: String,
    pub voice_fingerprint: String,
}
```

- [ ] **Step 4: Implement cache hashing and eviction**

Hash normalized text, output language, model weight file metadata, reference audio metadata, and synthesis parameters. Write audio atomically to the app-data `voice-cache/` directory. Limit the cache to 512 MiB by deleting least-recently-used completed files; never delete an active playback file.

- [ ] **Step 5: Run tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_client
cargo test --manifest-path src-tauri/Cargo.toml --test voice_cache
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/voice/client.rs src-tauri/src/voice/cache.rs src-tauri/src/voice/mod.rs src-tauri/tests/voice_client.rs src-tauri/tests/voice_cache.rs
git commit -m "feat: synthesize and cache character speech"
```

### Task 4: Implement priority, cooldown, completion merging, and interruption

**Files:**
- Create: `src-tauri/src/voice/scheduler.rs`
- Create: `src-tauri/tests/voice_scheduler.rs`
- Modify: `src-tauri/src/domain/reminder.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Rust `ReminderIntent` from Plan 01 and frontend `LineIntent` from Plan 02 through a Tauri command `enqueue_line_intent`.
- Produces: `SpeechCommand::ShowBubble`, `SpeechCommand::Play`, and `SpeechCommand::StopCurrent`.

- [ ] **Step 1: Write failing scheduler tests**

```rust
#[test]
fn permission_interrupts_idle_speech() {
    let mut scheduler = scheduler_playing(Priority::Idle);
    let commands = scheduler.enqueue(permission_intent());
    assert_eq!(commands[0], SpeechCommand::StopCurrent);
}

#[test]
fn three_completions_within_ten_seconds_merge() {
    let mut scheduler = SpeechScheduler::default();
    scheduler.enqueue_at(completed("a"), at(0));
    scheduler.enqueue_at(completed("b"), at(4));
    scheduler.enqueue_at(completed("c"), at(9));
    assert_eq!(scheduler.flush_at(at(10)).text(), "有三个任务完成了");
}

#[test]
fn do_not_disturb_keeps_bubble_and_drops_audio() {
    let commands = dnd_scheduler().enqueue(permission_intent());
    assert!(commands.iter().any(|x| matches!(x, SpeechCommand::ShowBubble(_))));
    assert!(!commands.iter().any(|x| matches!(x, SpeechCommand::Play(_))));
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_scheduler
```

- [ ] **Step 3: Implement explicit priorities**

```rust
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Priority { Idle, Interaction, Running, Result, Error, Permission }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineIntentDto {
    pub category: String,
    pub text: String,
    pub source_key: String,
    pub priority: Priority,
}
```

Expose `enqueue_line_intent(intent: LineIntentDto)` as a Tauri command. Queue at most two pending audio items. Drop stale idle/interaction entries before synthesis. Use the domain event key for event deduplication and a separate normalized-text ledger for the five-minute same-line cooldown.

- [ ] **Step 4: Connect reminder and line intents**

Emit the bubble command immediately. Defer completion audio until the ten-second merge window closes. Permission audio bypasses the merge window and may stop current low-priority playback.

- [ ] **Step 5: Run domain and scheduler tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_scheduler
cargo test --manifest-path src-tauri/Cargo.toml domain
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/voice/scheduler.rs src-tauri/src/domain/reminder.rs src-tauri/src/lib.rs src-tauri/tests/voice_scheduler.rs
git commit -m "feat: schedule prioritized character speech"
```

### Task 5: Play audio in the pet UI and report completion safely

**Files:**
- Create: `src/audio/player.ts`
- Create: `src/audio/player.test.ts`
- Modify: `src/state/backend.ts`
- Modify: `src/components/status-hud.ts`
- Modify: `src/app.ts`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: Tauri event `codexpet://speech-command`.
- Produces: command `speech_finished(speech_id, outcome)` with `completed`, `interrupted`, or `failed`.

- [ ] **Step 1: Write failing player tests with a fake audio element**

```ts
it("plays only one item and reports completion", async () => {
  const backend = fakeBackend();
  const player = new SpeechPlayer(fakeAudioFactory(), backend);
  await player.handle(playCommand("s1", "asset://one.wav"));
  fakeAudio.finish();
  expect(backend.finished).toEqual([{ id: "s1", outcome: "completed" }]);
});

it("stop command reports interruption", async () => {
  await player.handle(playCommand("s1", "asset://one.wav"));
  await player.handle(stopCommand("s1"));
  expect(backend.finished[0].outcome).toBe("interrupted");
});
```

- [ ] **Step 2: Confirm failure**

```powershell
npm test -- src/audio/player.test.ts
```

- [ ] **Step 3: Implement local-only playback**

Convert only backend-approved cache paths to Tauri asset URLs. Reject HTTP/HTTPS audio URLs. Display bubble text before attempting playback; playback errors report failure and leave the bubble visible for its normal duration.

- [ ] **Step 4: Run tests and manual audio check**

```powershell
npm test -- src/audio/player.test.ts
npm run dev
```

Expected: one line plays, waiting confirmation interrupts idle speech, and missing audio output does not freeze the queue.

- [ ] **Step 5: Commit**

```powershell
git add src/audio src/state/backend.ts src/components/status-hud.ts src/app.ts src-tauri/src/commands.rs src-tauri/capabilities/default.json
git commit -m "feat: play queued local character speech"
```

### Task 6: Add voice settings, diagnostics, and real v2Pro verification

**Files:**
- Modify: `src/components/settings-window.ts`
- Modify: `src/components/settings-window.test.ts`
- Modify: `src-tauri/src/commands.rs`
- Create: `src-tauri/tests/voice_commands.rs`
- Create: `docs/voice-setup.md`

**Interfaces:**
- Consumes: voice settings and `VoiceService` status.
- Produces: commands `inspect_voice`, `test_voice`, `prewarm_voice`, `stop_voice`, and `clear_voice_cache`.

- [ ] **Step 1: Write failing command-state tests**

```rust
#[tokio::test]
async fn test_voice_returns_text_fallback_when_process_fails() {
    let result = test_commands(failing_process()).test_voice("测试语音").await;
    assert_eq!(result.unwrap_err().fallback_text(), "测试语音");
}
```

- [ ] **Step 2: Confirm failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --test voice_commands
```

- [ ] **Step 3: Implement the approved voice settings UI**

Include model root, Python path, GPT weight, SoVITS weight, reference WAV, reference text/language, output language, volume, prewarm, stop, test, and cache clear. Display status as stopped, starting, ready, or faulted without exposing private text in logs.

- [ ] **Step 4: Verify against the user's package and RTX 5060 8GB**

Start from `GPT-SoVITS-v2pro-20250604-nvidia50.7z` extracted to a user-selected directory. Test cold start, warm synthesis, two sequential lines, interruption, 10-minute shutdown using a temporarily shortened test value, and manual stop. Record measured startup time, first-audio latency, GPU memory, and process memory in `docs/voice-setup.md` without claiming a universal benchmark.

- [ ] **Step 5: Run all tests**

```powershell
npm test
npm run test:rust
```

- [ ] **Step 6: Commit**

```powershell
git add src/components/settings-window* src-tauri/src/commands.rs src-tauri/tests/voice_commands.rs docs/voice-setup.md
git commit -m "feat: add GPT-SoVITS setup and diagnostics"
```

## Plan Completion Check

Run:

```powershell
npm test
npm run test:rust
npm run build
git status --short
```

Expected: all tests pass; real voice works locally; DND, failure, cold start, cache, interruption, and idle shutdown behave as specified; the model archive and extracted model files are not staged in Git or bundled in the app.
