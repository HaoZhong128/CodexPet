# CodexPet Audio, Menu, Cleanup, and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个可控 WAV 播放器完成统一音量、防重叠和 Headpat 语音；实现紧凑右键菜单和四项持久设置；清理取消动作资源；部署新 EXE 并完成真实状态、视觉和交互验收。

**Architecture:** Rust `VoiceBank` 只负责 TXT/WAV 配对和随机选句，单个 `AudioPlayer` 负责默认声卡、当前 `Player`、停止和音量。前端一个 localStorage JSON 保存 `{size, volume, muted, status_panel_visible}`；`App` 的自定义菜单调用 Tauri 窗口 API和三个音频命令。资源清理在新映射和测试通过后进行，最终 runtime 必须使用本次 release EXE。

**Tech Stack:** Rust 2021, rodio 0.22.2 with minimal WAV/playback features, Tauri 2 window API, TypeScript, Vitest/jsdom, PowerShell

**Spec:** `docs/superpowers/specs/2026-09-06-codexpet-simplification-design.md`

## Global Constraints

- 必须先完成前两份计划并保持全套测试通过。
- 音频库固定 `=0.22.2`，`default-features = false`，只启用 `playback` 和 `wav`。
- 只有一个播放器；新语音先停止旧语音；不增加队列、重试器、备用播放器或设备管理 UI。
- 状态气泡和状态语音来自同一个 `VoiceClip`；缺 WAV 时只保留现有前端状态，不用其他类别冒充。
- 现有等待选择语音可复用；缺少的只有 `waiting_input` 和 `failed` 两类，向已有“语音包”任务发送一次精确清单，不创建重复任务。
- 右键菜单必须保留现有默认/女仆服装选择，并新增尺寸、音量、静音、状态卡、复位和退出。
- 状态卡、气泡和透明区不得打开菜单或扩大点击 region。
- 设置只使用一个 localStorage JSON，不增加配置服务、版本、迁移、哈希或签名。
- 资源删除前必须解析并核对绝对路径；只删除 `G:\Codex code\CodexPet\public\live2d\props` 和 `G:\Codex code\CodexPet-runtime\voice` 中明确取消的类别。
- 不删除 `HashMap`、`package-lock.json`/`Cargo.lock` 的标准完整性字段或依赖内部哈希实现。
- 不使用 CUA、Photoshop 或 Cubism Editor。
- 真实 `failed` 状态仍因 hook 缺失而 BLOCKED；不得用纯展示测试冒充真实验收。
- 用 `apply_patch` 编辑/删除源码文件；每个提交只暂存列出的文件并审阅缓存区。

## File and Interface Map

| File | Responsibility | Final public surface |
|---|---|---|
| `src-tauri/src/voice.rs` | state/headpat clips and one audio player | `VoiceBank::choose`, `choose_headpat`, `AudioPlayer::{play,stop,set_volume}` |
| `src-tauri/src/bridge.rs` | select state clip, expose headpat clip | `AppState::{apply_at,headpat_feedback}` |
| `src-tauri/src/lib.rs` | Tauri commands and shared player wiring | `play_headpat_voice`, `set_voice_volume`, `stop_voice` |
| `src-tauri/Cargo.toml` / `Cargo.lock` | minimal rodio dependency | locked 0.22.2 |
| `src/settings.ts` | one JSON and volume semantics | `AppSettings`, `loadSettings`, `saveSettings`, `setVolume`, `toggleMuted`, `effectiveVolume` |
| `src/window-position.ts` | fixed sizes and physical work-area placement | `PET_SIZES`, `resizePetWindow`, `resetPetPosition`, geometry helpers |
| `src/settings.test.ts` | persistence/mute/slider cases | Vitest |
| `src/window-position.test.ts` | size/anchor/clamp geometry | Vitest |
| `src/app.ts` | menu DOM, click/drag/headpat priority, settings | `App.mount/applyStatus` |
| `src/status.test.ts` | integrated menu/pointer/headpat tests | jsdom mocks |
| `src/live2d.ts` | region contains model plus open menu only | `startHitTesting([menu])` |
| `src/styles.css` | matching compact menu | state-card palette |
| `scripts/build-local.ps1` | build/deploy directory list | only retained voice categories |
| `PROGRESS.md` | final evidence and blocker | test/build/runtime/visual/size records |

---

### Task 1: Split the Voice Catalog and Define the Missing Asset Request

**Files:**
- Modify: `src-tauri/src/voice.rs`
- Modify: `src-tauri/src/bridge.rs`

- [ ] **Step 1: Add failing VoiceBank tests for final directories**

Replace the old `question` and arbitrary action-library cases with:

```rust
#[test]
fn maps_waiting_input_and_choice_to_distinct_directories() {
    let temp = tempdir().unwrap();
    for directory in ["waiting_input", "waiting_choice"] {
        let folder = temp.path().join("voice").join(directory);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("01.txt"), directory).unwrap();
        fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
    }
    let bank = VoiceBank::load(temp.path()).unwrap();
    assert_eq!(bank.choose(PetState::WaitingInput).unwrap().text, "waiting_input");
    assert_eq!(bank.choose(PetState::WaitingChoice).unwrap().text, "waiting_choice");
}

#[test]
fn loads_only_headpat_interaction_pairs() {
    let temp = tempdir().unwrap();
    let folder = temp.path().join("voice/headpat");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("01.txt"), "嗯？").unwrap();
    fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
    let bank = VoiceBank::load(temp.path()).unwrap();
    assert_eq!(bank.choose_headpat().unwrap().text, "嗯？");
}
```

Keep pair filtering: only a `.txt` with a same-stem `.wav` is loaded.

- [ ] **Step 2: Run and confirm old directory mapping fails**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml voice::tests
```

Expected: FAIL because both waiting states still map to `question`, and headpat is under generic actions.

- [ ] **Step 3: Simplify VoiceBank to state clips plus one headpat list**

Use:

```rust
pub struct VoiceBank {
    clips: HashMap<PetState, Vec<VoiceClip>>,
    headpat: Vec<VoiceClip>,
}

fn category(state: PetState) -> &'static str {
    match state {
        PetState::Idle => "idle",
        PetState::Running => "running",
        PetState::WaitingInput => "waiting_input",
        PetState::WaitingChoice => "waiting_choice",
        PetState::WaitingPermission => "permission",
        PetState::Completed => "completed",
        PetState::Failed => "failed",
        PetState::Interrupted => "interrupted",
    }
}
```

Extract one private `load_pairs(folder: &Path) -> io::Result<Vec<VoiceClip>>`; call it for each state and once for `voice/headpat`. Replace `choose_action(category)` with parameterless `choose_headpat()`.

- [ ] **Step 4: Narrow AppState interaction API**

Replace:

```rust
pub fn action_feedback(&self, category: &str) -> Option<VoiceClip>
```

with:

```rust
pub fn headpat_feedback(&self) -> Option<VoiceClip> {
    self.voice.choose_headpat()
}
```

Update the bridge test to create `voice/headpat/01.txt` and `.wav` and assert status remains Running after retrieving it.

- [ ] **Step 5: Run Rust tests and commit the catalog**

Run:

```powershell
cargo test --manifest-path src-tauri\Cargo.toml voice::tests
cargo test --manifest-path src-tauri\Cargo.toml bridge::tests
git add -- src-tauri/src/voice.rs src-tauri/src/bridge.rs
git diff --cached --check
git diff --cached -- src-tauri/src/voice.rs src-tauri/src/bridge.rs
git commit -m "refactor: reduce voice catalog to states and headpat"
```

- [ ] **Step 6: Send the exact missing list to the existing voice task**

Use the existing task titled `语音包`, task id `01a06f17-85d9-71c3-b08e-96e99852ff59`. Send exactly:

```text
请只生成以下 4 组 TXT/WAV 配对，不修改 CodexPet 源码、配置或 Git；继续使用此前已验证的 GPT-SoVITS 模型、参考音频和参数，并保持 PCM16、单声道、32 kHz：

voice/waiting_input/01
管理员，这里需要你继续说明一下。

voice/waiting_input/02
管理员，我在等你的回复。

voice/failed/01
管理员，这次没有成功。

voice/failed/02
管理员，好像遇到问题了。

输出时报告每个 TXT/WAV 的路径、音频格式和校验结果。不要生成其他台词。
```

Do not block other source work while it runs. Use `wait_threads` only at later checkpoints; do not create another task.

---

### Task 2: Replace PlaySoundW with One Controllable WAV Player

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/voice.rs`

- [ ] **Step 1: Add pure player-state tests without touching a sound device**

Add:

```rust
#[test]
fn volume_changes_are_clamped_and_persist_for_future_playback() {
    let player = AudioPlayer::default();
    assert_eq!(player.volume_percent(), 100);
    player.set_volume(35);
    assert_eq!(player.volume_percent(), 35);
    player.set_volume(0);
    assert_eq!(player.volume_percent(), 0);
}

#[test]
fn stopping_without_an_open_device_is_safe() {
    AudioPlayer::default().stop();
}
```

Do not write a unit test that requires the developer machine's real audio device.

- [ ] **Step 2: Add the minimal locked dependency**

Change `Cargo.toml`:

```toml
rodio = { version = "=0.22.2", default-features = false, features = ["playback", "wav"] }
```

Remove only `Win32_Media_Audio` from `windows-sys`; preserve the other Windows APIs. Run:

```powershell
cargo update --manifest-path src-tauri\Cargo.toml -p rodio --precise 0.22.2
```

Expected: Cargo.lock resolves rodio 0.22.2 and its playback/WAV dependencies.

- [ ] **Step 3: Implement a lazily opened single player**

Replace `PlaySoundW`/`stop_wav` with:

```rust
use std::{fs::File, io::BufReader, sync::Mutex};
use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};

struct PlaybackDevice {
    _sink: MixerDeviceSink,
    player: Player,
}

struct AudioInner {
    volume_percent: u8,
    device: Option<PlaybackDevice>,
}

pub struct AudioPlayer {
    inner: Mutex<AudioInner>,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self {
            inner: Mutex::new(AudioInner {
                volume_percent: 100,
                device: None,
            }),
        }
    }
}

impl AudioPlayer {
    pub fn play(&self, path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let source = Decoder::try_from(BufReader::new(File::open(path)?))?;
        let mut inner = self.inner.lock().unwrap();
        if inner.device.is_none() {
            let sink = DeviceSinkBuilder::open_default_sink()?;
            let player = Player::connect_new(sink.mixer());
            inner.device = Some(PlaybackDevice { _sink: sink, player });
        }
        let volume = f32::from(inner.volume_percent) / 100.0;
        let device = inner.device.as_mut().unwrap();
        device.player.stop();
        device.player.set_volume(volume);
        device.player.append(source);
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(device) = self.inner.lock().unwrap().device.as_ref() {
            device.player.stop();
        }
    }

    pub fn set_volume(&self, volume_percent: u8) {
        let mut inner = self.inner.lock().unwrap();
        inner.volume_percent = volume_percent.min(100);
        let gain = f32::from(inner.volume_percent) / 100.0;
        if let Some(device) = inner.device.as_ref() {
            device.player.set_volume(gain);
        }
    }

    #[cfg(test)]
    fn volume_percent(&self) -> u8 {
        self.inner.lock().unwrap().volume_percent
    }
}
```

The output device is opened on first actual playback, so Rust unit tests and machines without a sound device still start the status path. A playback error is returned once to the caller and logged; no retry queue is added.

- [ ] **Step 4: Run formatting and tests**

Run:

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
cargo test --manifest-path src-tauri\Cargo.toml voice::tests
cargo test --manifest-path src-tauri\Cargo.toml
```

If fmt reports differences, run `cargo fmt --manifest-path src-tauri\Cargo.toml`, inspect the target files, then rerun the commands. Expected: PASS without opening the real device.

- [ ] **Step 5: Commit the player**

Run:

```powershell
git add -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/voice.rs
git diff --cached --check
git diff --cached --stat
git diff --cached -- src-tauri/Cargo.toml src-tauri/src/voice.rs
git commit -m "feat: add controllable WAV playback"
```

---

### Task 3: Wire State and Headpat Playback Through the Shared Player

**Files:**
- Modify: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/voice.rs`

- [ ] **Step 1: Add command-level unit seams**

Keep `AppState::apply_at` returning `(StatusUpdate, Option<PathBuf>)` so its tests never play real audio. Add a pure `AudioPlayer::set_volume` test from Task 2 and update bridge tests so:

- duplicate status transitions return `None` and therefore have no clip;
- a real transition returns one clip whose text becomes `bubble_text`;
- `SessionEnd` returns an update with no clip/bubble;
- `headpat_feedback()` returns only a `voice/headpat` clip and does not change status.

- [ ] **Step 2: Manage one AudioPlayer and expose three narrow commands**

In `run()`:

```rust
let audio = std::sync::Arc::new(voice::AudioPlayer::default());
let pipe_audio = audio.clone();

tauri::Builder::default()
    .manage(state)
    .manage(audio)
```

Commands:

```rust
#[tauri::command]
fn play_headpat_voice(
    state: tauri::State<'_, bridge::AppState>,
    audio: tauri::State<'_, std::sync::Arc<voice::AudioPlayer>>,
) -> Option<String> {
    let clip = state.headpat_feedback()?;
    if let Err(error) = audio.play(&clip.wav_path) {
        eprintln!("CodexPet voice playback failed: {error}");
    }
    Some(clip.text)
}

#[tauri::command]
fn set_voice_volume(
    volume: u8,
    audio: tauri::State<'_, std::sync::Arc<voice::AudioPlayer>>,
) {
    audio.set_volume(volume);
}

#[tauri::command]
fn stop_voice(audio: tauri::State<'_, std::sync::Arc<voice::AudioPlayer>>) {
    audio.stop();
}
```

Register these and remove `play_action_voice`.

- [ ] **Step 3: Pass the same player to the pipe loop**

Change `start_pipe` and `run_pipe_loop` to accept `Arc<AudioPlayer>`. On each emitted state transition:

```rust
audio.stop();
if let Some(path) = wav_path {
    if let Err(error) = audio.play(&path) {
        eprintln!("CodexPet voice playback failed: {error}");
    }
}
let _ = app.emit("codexpet://status", update);
```

This stops an old clip even when the new state has no WAV, guarantees no overlap, and leaves duplicate events silent because `StatusStore::apply_at` returned `None`.

- [ ] **Step 4: Run Rust tests and release compile**

Run:

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
cargo test --manifest-path src-tauri\Cargo.toml
cargo build --release --manifest-path src-tauri\Cargo.toml --features tauri/custom-protocol
```

Expected: PASS; release links rodio with only playback/WAV enabled.

- [ ] **Step 5: Commit the wiring**

Run:

```powershell
git add -- src-tauri/src/bridge.rs src-tauri/src/lib.rs src-tauri/src/voice.rs
git diff --cached --check
git diff --cached -- src-tauri/src/bridge.rs src-tauri/src/lib.rs src-tauri/src/voice.rs
git commit -m "feat: route pet voices through one player"
```

---

### Task 4: Add One Persisted Settings Object

**Files:**
- Create: `src/settings.ts`
- Create: `src/settings.test.ts`

- [ ] **Step 1: Write failing persistence and mute tests**

```ts
describe("CodexPet settings", () => {
  it("uses one stable default object", () => {
    expect(loadSettings(new MemoryStorage())).toEqual({
      size: "standard",
      volume: 70,
      muted: false,
      status_panel_visible: true,
    });
  });

  it("round-trips one JSON value", () => {
    const storage = new MemoryStorage();
    const settings: AppSettings = {
      size: "large",
      volume: 35,
      muted: true,
      status_panel_visible: false,
    };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
    expect(storage.length).toBe(1);
  });

  it("keeps the last nonzero volume while muted", () => {
    const initial = { ...DEFAULT_SETTINGS, volume: 35 };
    expect(effectiveVolume(toggleMuted(initial))).toBe(0);
    expect(toggleMuted(toggleMuted(initial))).toMatchObject({ volume: 35, muted: false });
    expect(setVolume(initial, 0)).toMatchObject({ volume: 35, muted: true });
    expect(setVolume(setVolume(initial, 0), 42)).toMatchObject({ volume: 42, muted: false });
  });
});
```

Use this test-local storage; do not add a production storage wrapper:

```ts
class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}
```

- [ ] **Step 2: Run and confirm module is missing**

Run:

```powershell
npm test -- src/settings.test.ts
```

Expected: FAIL because `src/settings.ts` does not exist.

- [ ] **Step 3: Implement only four settings**

```ts
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
```

`loadSettings` performs one JSON parse and accepts only the three size strings, numeric volume clamped to 1–100, and booleans; on parse failure it returns a copy of defaults. This is not a migration system. `saveSettings` writes exactly one key.

Volume rules:

```ts
export function effectiveVolume(settings: AppSettings): number {
  return settings.muted ? 0 : settings.volume;
}

export function setVolume(settings: AppSettings, value: number): AppSettings {
  const volume = Math.round(Math.min(Math.max(value, 0), 100));
  return volume === 0
    ? { ...settings, muted: true }
    : { ...settings, volume, muted: false };
}

export function toggleMuted(settings: AppSettings): AppSettings {
  return { ...settings, muted: !settings.muted };
}
```

- [ ] **Step 4: Run and commit**

Run:

```powershell
npm test -- src/settings.test.ts
git add -- src/settings.ts src/settings.test.ts
git diff --cached --check
git diff --cached -- src/settings.ts src/settings.test.ts
git commit -m "feat: persist simple pet settings"
```

---

### Task 5: Implement Fixed Window Sizes and Bottom-Right Placement

**Files:**
- Create: `src/window-position.ts`
- Create: `src/window-position.test.ts`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Add failing pure geometry tests**

```ts
expect(PET_SIZES).toEqual({
  small: { width: 300, height: 420 },
  standard: { width: 400, height: 560 },
  large: { width: 500, height: 700 },
});

expect(clampPosition(
  { x: 1900, y: 1040 },
  { width: 500, height: 700 },
  { x: 0, y: 0, width: 1920, height: 1040 },
  12,
)).toEqual({ x: 1408, y: 328 });

expect(preserveBottomRight(
  { x: 1508, y: 468 },
  { width: 400, height: 560 },
  { width: 500, height: 700 },
  { x: 0, y: 0, width: 1920, height: 1040 },
  12,
)).toEqual({ x: 1408, y: 328 });
```

The example preserves a 12-pixel right/bottom gap. Add a second case proving a middle-screen pet keeps its top-left position except for edge clamping.

- [ ] **Step 2: Run and confirm module is missing**

Run:

```powershell
npm test -- src/window-position.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement pure geometry plus Tauri calls**

Export:

```ts
export const PET_SIZES: Record<PetSize, LogicalRect> = {
  small: { width: 300, height: 420 },
  standard: { width: 400, height: 560 },
  large: { width: 500, height: 700 },
};
```

Define the local shape directly above it:

```ts
export interface LogicalRect {
  width: number;
  height: number;
}
```

`clampPosition` clamps against `workArea` with a 12-pixel margin. `preserveBottomRight` treats right/bottom gaps up to 48 physical pixels as anchored; otherwise it preserves the old x/y and clamps.

`resizePetWindow(size)` must:

1. read current `outerPosition`, `outerSize`, `currentMonitor` and scale factor;
2. compute old right/bottom gaps in physical pixels;
3. call `setSize(new LogicalSize(width, height))`;
4. read the new physical `outerSize`;
5. set a clamped `PhysicalPosition` that preserves a near bottom-right anchor.

`resetPetPosition()` reads `primaryMonitor().workArea`, current `outerSize`, and sets the 12-pixel bottom-right position.

- [ ] **Step 4: Grant only required mutating permissions**

Change capabilities to:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-size",
    "core:window:allow-set-position",
    "core:window:allow-close"
  ]
}
```

Read-only size/position/monitor calls are already part of `core:window:default`; do not add unrelated permissions.

- [ ] **Step 5: Run and commit**

Run:

```powershell
npm test -- src/window-position.test.ts
npm run build
git add -- src/window-position.ts src/window-position.test.ts src-tauri/capabilities/default.json
git diff --cached --check
git diff --cached -- src/window-position.ts src/window-position.test.ts src-tauri/capabilities/default.json
git commit -m "feat: add fixed pet window sizes"
```

---

### Task 6: Build the Menu and Enforce Pointer Priority

**Files:**
- Modify: `src/app.ts`
- Modify: `src/status.test.ts`
- Modify: `src/live2d.ts`
- Modify: `src/styles.css`

- [ ] **Step 1: Extend mocks and write failing interaction tests**

Mock `@tauri-apps/api/window`, settings, and window-position calls. Cover:

```ts
it("opens the menu only from a pet right click", async () => {
  pet.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
  expect(menu.classList.contains("is-open")).toBe(true);
  expect(tauriMocks.invoke).not.toHaveBeenCalledWith("start_dragging");
  expect(tauriMocks.invoke).not.toHaveBeenCalledWith("play_headpat_voice");

  menu.classList.remove("is-open");
  hud.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
  expect(menu.classList.contains("is-open")).toBe(false);
});

it("uses movement threshold to choose drag instead of headpat", async () => {
  pet.dispatchEvent(pointer("pointerdown", 10, 10));
  pet.dispatchEvent(pointer("pointermove", 16, 10));
  expect(tauriMocks.invoke).toHaveBeenCalledWith("start_dragging");
  expect(tauriMocks.invoke).not.toHaveBeenCalledWith("play_headpat_voice");
});

it("uses a short stationary left click for headpat", async () => {
  pet.dispatchEvent(pointer("pointerdown", 10, 10));
  pet.dispatchEvent(pointer("pointerup", 12, 11));
  expect(tauriMocks.invoke).toHaveBeenCalledWith("play_headpat_voice");
});
```

Add tests for:

- outfit buttons remain present;
- 75/100/125 selection calls `resizePetWindow` and saves;
- slider remains open and invokes `set_voice_volume` immediately;
- mute text/selected state and restoring prior volume;
- status panel visibility without stopping status subscription;
- reset position;
- exit order: unlisten status, `stop_voice`, then window `close`;
- Escape/outside click close and edge clamping;
- `startHitTesting` receives only the menu, never HUD/bubble.

- [ ] **Step 2: Run and confirm old menu/pointer logic fails**

Run:

```powershell
npm test -- src/status.test.ts
```

Expected: FAIL because current root-level right click and immediate drag conflict with Headpat and menu lacks settings.

- [ ] **Step 3: Apply settings during mount**

At startup:

```ts
this.settings = loadSettings();
await resizePetWindow(this.settings.size);
await invoke("set_voice_volume", { volume: effectiveVolume(this.settings) });
this.renderStatusPanelVisibility();
```

Store the status unlisten function returned by `listenForStatus` for exit. Continue subscribing before reading the initial snapshot.

- [ ] **Step 4: Build one compact menu that preserves outfits**

Menu groups, in order:

```text
服装: 默认 / 女仆
大小: 75% / 100% / 125%
音量: range 0..100
静音 / 恢复声音
隐藏状态面板 / 显示状态面板
回到右下角
退出 CodexPet
```

Attach `contextmenu` only to `#pet`, call `preventDefault()` and `stopPropagation()`, then clamp menu coordinates to root bounds. The range input uses `input`, calls `setVolume`, saves, updates UI, and invokes `set_voice_volume` without closing the menu. Normal buttons close after action.

- [ ] **Step 5: Implement click-versus-drag once**

Track one left pointer with `{id, x, y, dragging}`. Ignore non-left buttons and targets inside the menu. On movement greater than 4 logical pixels, mark dragging, clear the pending Headpat, and invoke `start_dragging` once. On pointerup below threshold, call `motion.startHeadpat(performance.now())` then `play_headpat_voice`. If a newer status arrives before the command resolves, keep the status bubble; otherwise show Headpat text for 3.2 seconds and restore the current status bubble.

Right button never enters this state machine.

- [ ] **Step 6: Restrict the native region to model plus open menu**

Call:

```ts
this.live2d.startHitTesting([menu]);
```

Do not pass HUD or bubble. `Live2DView` already skips `display:none`, so the menu rectangle joins the region only while `.is-open` changes it to grid.

- [ ] **Step 7: Style the menu using the status-card palette**

Use one 190–210px panel, 10–12px radius, dark translucent background, thin cyan/gray border, small section labels and selected state. Give Exit a low-saturation red foreground. Add no icons, framework, modal or settings page.

- [ ] **Step 8: Run frontend tests/build and commit**

Run:

```powershell
npm test
npm run build
git add -- src/app.ts src/status.test.ts src/live2d.ts src/styles.css
git diff --cached --check
git diff --cached -- src/app.ts src/status.test.ts src/live2d.ts src/styles.css
git commit -m "feat: add compact pet settings menu"
```

---

### Task 7: Stage Final Voice Files and Remove Canceled Resources

**Files:**
- Modify: `scripts/build-local.ps1`
- Delete: `public/live2d/props/` contents
- Modify externally: `G:\Codex code\CodexPet-runtime\voice\...`
- Read externally: output from existing `语音包` task

- [ ] **Step 1: Wait for and audit the voice task output**

Use `wait_threads` for task `01a06f17-85d9-71c3-b08e-96e99852ff59`. Verify all four requested TXT/WAV pairs exist, text matches exactly, and WAV is PCM16 mono 32 kHz. If the task reports a problem, send a focused correction to the same task; do not create another.

- [ ] **Step 2: Build the final runtime voice layout without deleting originals yet**

Create/copy:

```text
voice/waiting_choice/01.* <- existing voice/question/01.*
voice/waiting_choice/02.* <- existing voice/question/02.*
voice/headpat/01.*        <- existing action/headpat_start/01.*
voice/headpat/02.*        <- existing action/headpat_start/02.*
voice/headpat/03.*        <- existing action/headpat_start/03.*
voice/headpat/04.*        <- existing action/headpat_relaxed/01.*
voice/headpat/05.*        <- existing action/headpat_relaxed/02.*
voice/headpat/06.*        <- existing action/headpat_relaxed/03.*
voice/headpat/07.*        <- existing action/headpat_relaxed/04.*
```

Copy generated `waiting_input/01..02` and `failed/01..02` pairs from the voice task output. Preserve the source task/staging copies.

- [ ] **Step 3: Verify every retained pair before cleanup**

Use PowerShell to enumerate exactly these runtime directories:

```text
idle, running, waiting_input, waiting_choice, permission,
completed, failed, interrupted, headpat
```

For every TXT file, require same-stem WAV; for every WAV, require same-stem TXT. Read all texts and verify category meaning. Inspect WAV format with the existing validated audio-audit command/tool.

- [ ] **Step 4: Update build-local directory creation**

Replace the category array with:

```powershell
foreach ($category in 'idle','running','waiting_input','waiting_choice','permission','completed','failed','interrupted','headpat') {
    New-Item -ItemType Directory -Force -Path "$runtime\voice\$category" | Out-Null
}
```

Do not add voice copying, manifests, hashes or checksum comparisons to the build script.

- [ ] **Step 5: Delete only verified canceled runtime categories**

Resolve and verify exact paths in the same PowerShell process before removal:

```powershell
$runtimeVoice = [System.IO.Path]::GetFullPath('G:\Codex code\CodexPet-runtime\voice')
if ($runtimeVoice -ne 'G:\Codex code\CodexPet-runtime\voice') { throw 'Unexpected runtime voice root' }
$removeTargets = @(
  'G:\Codex code\CodexPet-runtime\voice\action',
  'G:\Codex code\CodexPet-runtime\voice\click',
  'G:\Codex code\CodexPet-runtime\voice\question'
)
foreach ($target in $removeTargets) {
  $resolved = [System.IO.Path]::GetFullPath($target)
  if (-not $resolved.StartsWith($runtimeVoice + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing out-of-scope removal: $resolved"
  }
}
foreach ($target in $removeTargets) {
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
```

These runtime deletions are not recoverable from the runtime folder; the original/source voice task and staging assets remain available.

- [ ] **Step 6: Delete only repository props used by canceled actions**

Verify `Resolve-Path public/live2d/props` is exactly under `G:\Codex code\CodexPet\public\live2d\props`, then delete its files/directory with `apply_patch`. Do not touch default/maid model textures.

- [ ] **Step 7: Audit hash and canceled-action references**

Run:

```powershell
rg -n -i "hash|checksum|digest|sha1|sha256|integrity" . -g '!node_modules/**' -g '!src-tauri/target/**' -g '!src-tauri/gen/**' -g '!package-lock.json' -g '!src-tauri/Cargo.lock' -g '!docs/superpowers/**'
rg -n "running_sword|completed_sheath|idle_bun|idle_doze|idle_clean_sword|sword_effort|action/headpat|voice/click|voice/question|live2d/props" src src-tauri scripts public
```

Expected: no custom integrity/release hash logic and no production references to canceled actions/resources. Do not edit standard lockfile integrity data or dependency-internal hashes.

- [ ] **Step 8: Run tests and commit repository cleanup**

Run:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
git add -- scripts/build-local.ps1
git diff --cached --check
git diff --cached -- scripts/build-local.ps1 public/live2d/props
git commit -m "chore: remove canceled pet action resources"
```

---

### Task 8: Build, Deploy, and Prove the Runtime Matches the Source

**Files:**
- Modify: `PROGRESS.md`
- Runtime: `G:\Codex code\CodexPet-runtime\CodexPet.exe`

- [ ] **Step 1: Record before sizes**

Run:

```powershell
Get-Item -LiteralPath 'G:\Codex code\CodexPet-runtime\CodexPet.exe' | Select-Object FullName,Length,LastWriteTime
Get-ChildItem -LiteralPath 'G:\Codex code\CodexPet-runtime' -Recurse -File | Measure-Object Length -Sum
Get-ChildItem -LiteralPath 'G:\Codex code\CodexPet-runtime\voice' -Recurse -File | Measure-Object Length -Sum
```

Record exact byte counts in `PROGRESS.md` before replacement.

- [ ] **Step 2: Exit only the running CodexPet instance**

Resolve process path before stopping:

```powershell
Get-CimInstance Win32_Process -Filter "Name='CodexPet.exe'" | Select-Object ProcessId,ExecutablePath
```

If the path is exactly `G:\Codex code\CodexPet-runtime\CodexPet.exe`, use the app's own Exit menu after it is available. If menu verification has not yet been possible, stop only that resolved PID. Do not stop similarly named processes from other paths.

- [ ] **Step 3: Execute the full build/deploy script**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local.ps1
```

Expected order: `npm ci`, frontend tests, Vite build, Rust tests, release custom-protocol build, copy to runtime. Any failure stops the script.

- [ ] **Step 4: Verify deployed identity without adding hash code**

Compare exact file length and last-write timestamp for:

```text
src-tauri/target/release/codexpet.exe
G:/Codex code/CodexPet-runtime/CodexPet.exe
```

Then use `Compare-Object` on raw byte arrays or `fc.exe /b` as a one-time verification command. Do not add a hash, expected digest, script output, test or metadata file to the project.

- [ ] **Step 5: Start the new runtime and test audio controls manually**

Launch the runtime EXE. Verify:

- one status transition plays one clip;
- a new state stops the previous clip;
- volume changes affect current and later clips;
- mute is immediate;
- unmute restores the previous nonzero volume;
- Headpat plays one headpat clip and restores the current status bubble;
- no sword/food/sleep/cloth lines play.

- [ ] **Step 6: Record after sizes and net change**

Repeat Step 1 and record EXE delta, voice directory delta, total runtime delta, and whether total runtime shrank. Do not predict the measured result.

---

### Task 9: Run Real Status, Visual, and Interaction Acceptance

**Files:**
- Modify: `PROGRESS.md`
- Read runtime only: deployed app and screenshots

- [ ] **Step 1: Reuse the existing status acceptance task**

Use task titled `CodexPet 状态识别验收`, id `01a06fc7-91aa-7382-8b33-a975cabb443c`. Send one cohesive prompt using `gpt-5.6-sol`, low reasoning:

```text
请复测已部署的 CodexPet，只产生和观察状态，不修改源码、配置、资源或 Git。依次覆盖：0 个任务、1 个运行任务、2 个同时运行任务、等待文字输入、等待多个选项、权限等待与恢复、正常完成、中断、回到 Idle。逐项报告主状态、运行数、等待数、计时、气泡是否只在状态变化时出现、Live2D 表情是否平滑恢复。真实 failed 若仍无可靠 Codex hook 信号，记录 BLOCKED，不得用模拟测试代替。
```

Wait for attention/completion with `wait_threads`; do not create a duplicate task.

- [ ] **Step 2: Verify menu and pointer behavior on the deployed runtime**

Check every requested interaction:

```text
transparent area -> pass-through
model right click -> menu only
right click -> no Headpat/drag/bubble/voice
short left click -> Headpat
left drag >4px -> window movement only
menu outside/Escape -> close
outfit default/maid -> both still load
75/100/125 -> full model, window and region resize together
volume slider -> menu stays open
status panel toggle -> state subscription continues
reset -> primary work-area bottom-right, not under taskbar
exit -> no CodexPet.exe remains
restart -> four saved settings restored
```

- [ ] **Step 3: Capture read-only rendered evidence without CUA**

Start the new runtime with the previously proven WebView2 CDP read-only setup, inspect `/json` and require the page URL to start with `https://tauri.localhost`. Capture PNG screenshots for small, standard and large at the machine's current DPR, plus one open-menu image and representative Running/Waiting states.

Save screenshots outside the repository or under the session visualization directory, not under source control. Compare face, eyes, mouth, outline and status text at 100% pixel view. Record paths and observations. Do not use CUA, Photoshop or Cubism Editor.

- [ ] **Step 4: Ask the user for final visual acceptance**

Present the representative images and measured findings. Build success is not visual acceptance. Do not mark the visual item complete until the user confirms the result.

- [ ] **Step 5: Run final repository checks**

Run:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
cargo build --release --manifest-path src-tauri\Cargo.toml --features tauri/custom-protocol
git diff --check
git status --short
git log -12 --oneline
```

Expected: all checks PASS; status lists only known unrelated/pre-existing changes, if any.

- [ ] **Step 6: Write the final truthful progress record**

`PROGRESS.md` must include:

- completed requirements and commit IDs;
- exact automated test/build outputs;
- deployed source/runtime file comparison evidence;
- real status acceptance table;
- voice TXT/WAV audit and playback findings;
- screenshot paths and user visual decision;
- before/after EXE, voice and total runtime sizes;
- hash audit conclusion;
- any remaining unrelated dirty files;
- real `failed` detection as BLOCKED by missing Codex hook signal;
- next action: wait for an official failed hook/result field, then add a real event mapping and acceptance case.

- [ ] **Step 7: Commit only the progress record**

Run:

```powershell
git add -- PROGRESS.md
git diff --cached --check
git diff --cached -- PROGRESS.md
git commit -m "docs: record CodexPet runtime acceptance"
```

## Phase 3 Exit Criteria

- State/Headpat voice catalogs are distinct and all retained TXT/WAV pairs are valid.
- A single rodio player provides no-overlap, current/future volume, mute and stop behavior.
- The menu preserves outfit switching and implements 75/100/125 size, volume, mute, status card, reset and exit.
- Click, drag, right-click and menu priority are mutually exclusive.
- Only model pixels plus an open menu belong to the native click region.
- Four settings persist in one localStorage JSON.
- Canceled action source, props and runtime voice categories are gone; original source voice assets remain recoverable.
- No custom resource/release/deploy hash logic remains; standard maps/lock integrity data are untouched.
- The runtime EXE is rebuilt from this source, deployed, and compared byte-for-byte without adding hash machinery.
- Automated, real-status, audio, menu and visual checks are recorded with exact evidence.
- User has accepted the rendered result.
- Real failed-task detection remains explicitly BLOCKED until Codex exposes a reliable signal; therefore the long Goal is not falsely marked fully complete.
