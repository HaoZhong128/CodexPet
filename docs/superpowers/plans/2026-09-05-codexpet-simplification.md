# CodexPet 极简重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前 CodexPet 直接重写为个人使用的单 EXE Windows 桌宠，只保留 Live2D 展示、服装/表情/基础动作、Codex 活跃状态与计时、状态气泡和外置预生成语音。

**Architecture:** `CodexPet.exe` 同时承担 GUI 和 `hook` 子命令；Codex 官方 Hooks 把生命周期事件通过固定命名管道发给正在运行的 GUI。GUI 只在内存中维护当前会话状态，前端渲染 Live2D 和 HUD，Rust 从 EXE 同目录的 `voice/<状态>/` 随机选择同名 `.txt + .wav` 并用 Windows `PlaySoundW` 播放。

**Tech Stack:** TypeScript 5.6、Vite 6、Vitest、Tauri 2、Rust 2021、serde/serde_json、Tokio Windows named pipe、windows-sys `PlaySoundW`。

**Spec:** `docs/superpowers/plans/2026-09-05-codexpet-simplification.md#已确认设计基线`（本计划为自包含设计与实施基线，已由用户在 2026-09-05 确认）。

## Global Constraints

- 仅支持 Windows 10/11 和当前用户的单实例、单机使用。
- 直接在当前 checkout 重写；不创建备份分支、工作树或旧代码基线提交，不保留旧实现或回滚路径。
- 不做安装器、发布包、自动更新、托盘、自启动、设置页、诊断页、任务详情页、状态持久化、提醒、免打扰、音量控制或语音调度器。
- 保留 `public/live2d/` 中运行所需的模型；Live2D 源工程和语音生成模型不属于运行项目。
- 基础动作只采用整个 Live2D 画布的 CSS 呼吸、摇摆、庆祝、错误晃动和点击反馈，不新增 motion3 动作系统。
- Codex 状态只来自官方 Hooks，不读取 `thread_history_1.sqlite`、会话 JSONL，也不连接 app-server。
- `request_user_input` 必须通过 `PreToolUse` 和 `PostToolUse` 识别；等待选择不是 `Interrupt`。
- `runningCount` 只统计真正运行中的会话；`waitingCount` 统计等待选择和等待权限；`activeCount = runningCount + waitingCount`。
- 最早活跃会话的计时在等待选择或等待权限期间继续累计，回答后不重置。
- 气泡内容与 WAV 必须来自同目录、同文件名的 UTF-8 `.txt` 和 PCM16 单声道 `.wav`；语音投放者负责格式正确，程序不解析 WAV 格式；不朗读实际 Codex 问题、选项、命令或输出。
- 语音目录仅在程序启动时扫描；新增语音后重启生效，允许随机重复。
- 程序启动时只更新 `~/.codex/hooks.json` 中 CodexPet 自己的 Hook，保留其他工具的 Hook；绝不修改 `~/.codex/config.toml` 的 `notify`。
- GUI 必须先运行，Hook 才能上报；程序重启后不恢复旧任务。
- 打包运行时允许联网加载 Cubism Core；不保留静态 PNG 降级渲染。

---

## 已确认设计基线

### 最终运行目录

```text
G:\Codex code\CodexPet-runtime\
├── CodexPet.exe
└── voice\
    ├── idle\
    ├── running\
    ├── question\
    ├── permission\
    ├── completed\
    └── interrupted\
```

每个状态目录可无限增加配对文件：

```text
question\01.txt
question\01.wav
question\02.txt
question\02.wav
```

只有同名 `.txt + .wav` 都存在时才进入随机候选列表。气泡显示 `.txt` 内容，同时播放对应 `.wav`。

### 状态模型

```rust
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PetState {
    Idle,
    Running,
    WaitingChoice,
    WaitingPermission,
    Completed,
    Interrupted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskPhase {
    Running,
    WaitingChoice,
    WaitingPermission,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusUpdate {
    pub state: PetState,
    pub active_count: usize,
    pub running_count: usize,
    pub waiting_count: usize,
    pub active_since_ms: Option<u64>,
    pub bubble_text: Option<String>,
}
```

事件映射固定为：

| Hook 输入 | 状态变化 | 计数/计时 |
|---|---|---|
| `SessionStart` | 没有其他活跃会话时发出 `idle` 表现，不创建运行任务 | 全部不变 |
| `UserPromptSubmit` | 当前会话进入 `running` | 首次出现时记录开始时间 |
| `PreToolUse` 且 `tool_name == "request_user_input"` | 进入 `waiting_choice` | 从 running 移到 waiting，计时继续 |
| `PostToolUse` 且 `tool_name == "request_user_input"` | 回到 `running` | 从 waiting 移回 running，计时不重置 |
| `PermissionRequest` | 进入 `waiting_permission` | 从 running 移到 waiting，计时继续 |
| 处于 `waiting_permission` 后收到 `PostToolUse` | 回到 `running` | 计时不重置 |
| `Stop` | 移除会话并短暂显示 `completed` | 活跃计数减一 |
| `Interrupt` | 移除会话并短暂显示 `interrupted` | 活跃计数减一 |
| `SessionEnd` | 静默移除残留会话，仅推送最新计数 | 活跃计数减一，不显示气泡、不播放语音 |

`Interrupt` 只表示真正取消/中断。Codex 让用户从选项中选择时，必须保持会话活跃并进入 `waiting_choice`。

### 最终源码结构

```text
src/
├── main.ts          # 前端入口
├── app.ts           # 桌宠 UI、气泡、HUD、右键菜单
├── live2d.ts        # Live2D 加载、服装/表情切换
├── status.ts        # StatusUpdate 类型与前端状态监听
├── status.test.ts   # 前端状态契约测试
└── styles.css       # 所有界面与基础动作样式

src-tauri/src/
├── main.rs          # GUI / hook 单 EXE 分流
├── lib.rs           # Tauri 启动与命令注册
├── bridge.rs        # Hook 解析、内存状态、命名管道
├── hooks.rs         # hooks.json 极简配置与 hook stdin 转发
└── voice.rs         # 外置语音扫描、随机选择、PlaySoundW

scripts/
└── build-local.ps1  # 测试、构建并复制单 EXE
```

运行代码不再拆分更多层；测试优先写在对应 Rust 模块内部，只保留一个前端状态契约测试文件。

---

### Task 1: 直接替换后端状态核心

**Files:**
- Create: `src-tauri/src/bridge.rs`
- Replace: `src-tauri/src/lib.rs`
- Replace: `src-tauri/src/main.rs`
- Replace: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Delete: `src-tauri/src/domain/`
- Delete: `src-tauri/src/codex/`
- Delete: `src-tauri/src/ipc/`
- Delete: `src-tauri/src/voice/`
- Delete: `src-tauri/src/bin/codexpet-hook.rs`
- Delete: `src-tauri/src/commands.rs`
- Delete: `src-tauri/src/diagnostics.rs`
- Delete: `src-tauri/src/portable.rs`
- Delete: `src-tauri/src/settings.rs`
- Delete: `src-tauri/src/storage.rs`
- Delete: `src-tauri/src/tray.rs`
- Delete: `src-tauri/src/window.rs`
- Delete: `src-tauri/tests/`

**Interfaces:**
- Consumes: Codex Hook JSON 中的 `hook_event_name`、`session_id` 和可选 `tool_name`；`turn_id` 只属于输入协议，不写入内存状态。
- Produces: `StatusStore::apply_at(event: HookEvent, now_ms: u64) -> Option<StatusUpdate>` 和序列化的 `StatusUpdate`；无状态变化的普通工具事件返回 `None`。

- [ ] **Step 1: 先写等待选择和真正中断的单元测试**

```rust
#[test]
fn request_user_input_waits_without_resetting_the_timer() {
    let mut store = StatusStore::default();
    store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);

    let waiting = store.apply_at(
        event(HookKind::PreToolUse, "session-1", Some("request_user_input")),
        2_000,
    ).unwrap();
    assert_eq!(waiting.state, PetState::WaitingChoice);
    assert_eq!(waiting.active_count, 1);
    assert_eq!(waiting.running_count, 0);
    assert_eq!(waiting.waiting_count, 1);
    assert_eq!(waiting.active_since_ms, Some(1_000));

    let resumed = store.apply_at(
        event(HookKind::PostToolUse, "session-1", Some("request_user_input")),
        5_000,
    ).unwrap();
    assert_eq!(resumed.state, PetState::Running);
    assert_eq!(resumed.active_since_ms, Some(1_000));
}

#[test]
fn interrupt_is_not_a_waiting_choice() {
    let mut store = StatusStore::default();
    store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);
    let update = store.apply_at(event(HookKind::Interrupt, "session-1", None), 2_000).unwrap();
    assert_eq!(update.state, PetState::Interrupted);
    assert_eq!(update.active_count, 0);
    assert_eq!(update.waiting_count, 0);
}

fn event(kind: HookKind, session_id: &str, tool_name: Option<&str>) -> HookEvent {
    HookEvent {
        kind,
        session_id: session_id.to_owned(),
        tool_name: tool_name.map(str::to_owned),
    }
}
```

- [ ] **Step 2: 运行测试并确认旧状态模型不能表达 `WaitingChoice`**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::tests -- --nocapture`

Expected: FAIL，因为 `StatusStore`、`PetState::WaitingChoice` 和新的计数字段尚不存在。

- [ ] **Step 3: 实现 Hook 类型和唯一的内存状态表**

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookKind {
    SessionStart,
    SessionEnd,
    UserPromptSubmit,
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    Stop,
    Interrupt,
}

pub struct HookEvent {
    pub kind: HookKind,
    pub session_id: String,
    pub tool_name: Option<String>,
}

#[derive(Default)]
pub struct StatusStore {
    tasks: HashMap<String, Task>,
}

struct Task {
    started_at_ms: u64,
    phase: TaskPhase,
}

impl StatusStore {
    pub fn apply_at(&mut self, event: HookEvent, now_ms: u64) -> Option<StatusUpdate> {
        let state = match event.kind {
            HookKind::SessionStart if self.tasks.is_empty() => Some(PetState::Idle),
            HookKind::SessionStart => None,
            HookKind::UserPromptSubmit => {
                self.tasks
                    .entry(event.session_id)
                    .and_modify(|task| task.phase = TaskPhase::Running)
                    .or_insert(Task { started_at_ms: now_ms, phase: TaskPhase::Running });
                Some(PetState::Running)
            }
            HookKind::PreToolUse if event.tool_name.as_deref() == Some("request_user_input") => {
                let task = self.tasks.get_mut(&event.session_id)?;
                task.phase = TaskPhase::WaitingChoice;
                Some(PetState::WaitingChoice)
            }
            HookKind::PermissionRequest => {
                let task = self.tasks.get_mut(&event.session_id)?;
                task.phase = TaskPhase::WaitingPermission;
                Some(PetState::WaitingPermission)
            }
            HookKind::PostToolUse => {
                let task = self.tasks.get_mut(&event.session_id)?;
                let resumes = match task.phase {
                    TaskPhase::WaitingChoice => {
                        event.tool_name.as_deref() == Some("request_user_input")
                    }
                    TaskPhase::WaitingPermission => true,
                    TaskPhase::Running => false,
                };
                if !resumes { return None; }
                task.phase = TaskPhase::Running;
                Some(PetState::Running)
            }
            HookKind::Stop => {
                self.tasks.remove(&event.session_id)
                    .map(|_| PetState::Completed)
            }
            HookKind::Interrupt => {
                self.tasks.remove(&event.session_id)
                    .map(|_| PetState::Interrupted)
            }
            HookKind::SessionEnd => {
                self.tasks.remove(&event.session_id)
                    .map(|_| self.aggregate_state())
            }
            HookKind::PreToolUse => None,
        };
        state.map(|state| self.snapshot(state))
    }

    fn aggregate_state(&self) -> PetState {
        if self.tasks.values().any(|task| task.phase == TaskPhase::WaitingChoice) {
            PetState::WaitingChoice
        } else if self.tasks.values().any(|task| task.phase == TaskPhase::WaitingPermission) {
            PetState::WaitingPermission
        } else if self.tasks.is_empty() {
            PetState::Idle
        } else {
            PetState::Running
        }
    }

    fn snapshot(&self, state: PetState) -> StatusUpdate {
        let running_count = self.tasks.values()
            .filter(|task| task.phase == TaskPhase::Running)
            .count();
        let active_count = self.tasks.len();
        StatusUpdate {
            state,
            active_count,
            running_count,
            waiting_count: active_count - running_count,
            active_since_ms: self.tasks.values().map(|task| task.started_at_ms).min(),
            bubble_text: None,
        }
    }

    pub fn current(&self) -> StatusUpdate {
        self.snapshot(self.aggregate_state())
    }
}
```

普通 `PostToolUse` 返回 `None`，不会在每次工具完成时重复播放 running 台词。等待选择或等待权限恢复时才产生新的 running 状态。实现不增加仓储、事件总线、去重器、恢复逻辑或状态机框架。

- [ ] **Step 4: 建立可编译的极简后端骨架并删除旧后端**

`src-tauri/src/lib.rs` 在本 Task 暂时只暴露状态核心；GUI 启动在 Task 4 接入：

```rust
pub mod bridge;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}
```

`src-tauri/src/main.rs` 暂时只调用 `run()`：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let _ = codexpet_lib::run();
}
```

从 `Cargo.toml` 删除 `codexpet-hook` 独立 bin、autostart、chrono、sha2、thiserror、toml_edit 和 tray feature；保留后续 Task 明确需要的 Tauri、serde、serde_json、Tokio、windows-sys 和测试用 tempfile。然后删除本 Task Files 中列出的全部旧模块与旧集成测试。

- [ ] **Step 5: 运行后端状态测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml bridge::tests -- --nocapture`

Expected: PASS，且测试明确得到 `running → waiting_choice → running → completed`。

- [ ] **Step 6: 检查极简后端文件结构**

```powershell
rg --files src-tauri/src
```

Expected: 只剩 `main.rs`、`lib.rs`、`bridge.rs`；后续 Task 会新增 `hooks.rs` 和 `voice.rs`。此处不创建旧代码基线或中间提交。

### Task 2: 单 EXE Hook 转发与极简配置

**Files:**
- Replace: `src-tauri/src/main.rs`
- Create: `src-tauri/src/hooks.rs`
- Modify: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `CodexPet.exe hook` 的 stdin 和 `~/.codex/hooks.json`。
- Produces: `hooks::codex_home()`、`hooks::forward_stdin()`、`hooks::ensure_codex_hooks(codex_home, exe_path)`，以及固定管道 `\\.\pipe\codexpet-status`。

- [ ] **Step 1: 锁定当前 Codex Hook 输入形状**

Run: `codex --version`

Expected: 当前开发机为 `codex-cli 0.153.2`。对照该版本的官方 `pre-tool-use.command.input.schema.json` 和 `post-tool-use.command.input.schema.json`，确认两者都包含 `hook_event_name/session_id/turn_id/tool_name/tool_use_id/tool_input`，Post 另外包含 `tool_response`：

- `https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json`
- `https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/hooks/schema/generated/post-tool-use.command.input.schema.json`

在 `bridge.rs` 的测试中直接解析以下官方形状，不保存 `questions` 内容：

```rust
let payload = json!({
    "session_id": "session-1",
    "turn_id": "turn-1",
    "transcript_path": null,
    "cwd": r"C:\work",
    "hook_event_name": "PreToolUse",
    "model": "gpt-5.6",
    "permission_mode": "default",
    "tool_name": "request_user_input",
    "tool_use_id": "call-1",
    "tool_input": {"questions": [{"id": "choice"}]}
});
let event = parse_hook(payload).unwrap();
assert_eq!(event.kind, HookKind::PreToolUse);
assert_eq!(event.tool_name.as_deref(), Some("request_user_input"));
```

- [ ] **Step 2: 为 Hook 配置写最小测试**

```rust
#[test]
fn installs_question_hooks_without_touching_unrelated_hooks() {
    let existing = json!({
        "hooks": {
            "Stop": [{
                "matcher": "keep-me",
                "hooks": [{"type": "command", "command": "other-tool"}]
            }]
        }
    });
    let updated = merge_codexpet_hooks(existing, Path::new(r"C:\Pet\CodexPet.exe"));

    assert_eq!(updated["hooks"]["Stop"][0]["matcher"], "keep-me");
    assert!(updated["hooks"]["PreToolUse"].as_array().unwrap().iter().any(|group| {
        group["matcher"] == "request_user_input"
    }));
}
```

- [ ] **Step 3: 运行测试并确认缺少 `PreToolUse` 配置**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: FAIL，因为极简 Hook 合并函数尚不存在。

- [ ] **Step 4: 实现单 EXE 入口**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("hook") {
        codexpet_lib::hooks::forward_stdin();
    } else {
        codexpet_lib::run();
    }
}
```

`forward_stdin()` 读取一个不超过 64 KiB 的 JSON 对象，以客户端关闭连接作为单条消息边界，写入固定命名管道后退出。遇到管道尚未创建或忙碌时，在 900 ms 内每 10 ms 重试；GUI 未运行时仍在时限内直接退出，不能长期阻塞 Codex。

GUI 启动时用 named pipe 的 first-instance 标记抢占 `\\.\pipe\codexpet-status`，失败即退出，从而不增加单实例依赖。服务端在读取已连接客户端前先创建下一实例，避免并发 Hook 因 `ERROR_PIPE_BUSY` 丢失；管道拒绝远程客户端。

同时在 `lib.rs` 增加 `pub mod hooks;`，使 `main.rs` 能调用该模块。

`codex_home()` 只支持当前 Windows 用户和可选覆盖变量：

```rust
pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("USERPROFILE").unwrap()).join(".codex"))
}
```

- [ ] **Step 5: 只注册需要的官方事件**

程序启动时移除命令中包含 `codexpet-hook.exe`，或同时包含 `CodexPet.exe` 与参数 `hook` 的旧 CodexPet handler，然后加入当前 EXE：

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "request_user_input",
      "hooks": [{
        "type": "command",
        "command": "\"C:\\Pet\\CodexPet.exe\" hook",
        "commandWindows": "& \"C:\\Pet\\CodexPet.exe\" hook",
        "timeout": 1
      }]
    }]
  }
}
```

同一个 handler 还注册到 `SessionStart`、`SessionEnd`、`UserPromptSubmit`、`PermissionRequest`、`PostToolUse`、`Stop` 和 `Interrupt`。`PostToolUse` 不设 matcher，以便既恢复 `waiting_choice`，也恢复 `waiting_permission`。不读取或写入 `config.toml`。

- [ ] **Step 6: 运行 Hook 单元测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml hooks::tests -- --nocapture`

Expected: PASS；生成配置包含 `PreToolUse(request_user_input)`，旧 CodexPet handler 消失，其他 handler 保持原值。

- [ ] **Step 7: 检查单 EXE Hook 路径可以编译**

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS；Cargo 只生成 `codexpet.exe`，不再声明 `codexpet-hook.exe`。

### Task 3: 外置状态语音与气泡配对

**Files:**
- Create: `src-tauri/src/voice.rs`
- Modify: `src-tauri/src/bridge.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `exe_dir/voice/{idle,running,question,permission,completed,interrupted}/*.txt` 和同名 `.wav`。
- Produces: `VoiceBank::load(exe_dir) -> VoiceBank`、`VoiceBank::choose(state) -> Option<VoiceClip>`、`play_wav(path)`。

- [ ] **Step 1: 写配对和状态目录测试**

```rust
#[test]
fn loads_only_same_stem_text_and_wav_pairs() {
    let temp = tempfile::tempdir().unwrap();
    let folder = temp.path().join("voice/question");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("01.txt"), "主人，请选一个吧。").unwrap();
    fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
    fs::write(folder.join("ignored.txt"), "没有 wav").unwrap();

    let bank = VoiceBank::load(temp.path()).unwrap();
    let clip = bank.choose(PetState::WaitingChoice).unwrap();
    assert_eq!(clip.text, "主人，请选一个吧。");
    assert!(clip.wav_path.ends_with("question\\01.wav"));
}
```

- [ ] **Step 2: 运行测试并确认旧 manifest 架构不满足外置目录要求**

Run: `cargo test --manifest-path src-tauri/Cargo.toml voice::tests -- --nocapture`

Expected: FAIL，因为 `VoiceBank` 尚不存在。

- [ ] **Step 3: 实现固定目录映射和随机选择**

```rust
#[derive(Clone)]
pub struct VoiceClip {
    pub text: String,
    pub wav_path: PathBuf,
}

pub struct VoiceBank {
    clips: HashMap<PetState, Vec<VoiceClip>>,
}

fn category(state: PetState) -> &'static str {
    match state {
        PetState::Idle => "idle",
        PetState::Running => "running",
        PetState::WaitingChoice => "question",
        PetState::WaitingPermission => "permission",
        PetState::Completed => "completed",
        PetState::Interrupted => "interrupted",
    }
}

impl VoiceBank {
    pub fn load(exe_dir: &Path) -> std::io::Result<Self> {
        let mut clips = HashMap::new();
        for state in [
            PetState::Idle,
            PetState::Running,
            PetState::WaitingChoice,
            PetState::WaitingPermission,
            PetState::Completed,
            PetState::Interrupted,
        ] {
            let folder = exe_dir.join("voice").join(category(state));
            let mut state_clips = Vec::new();
            if folder.is_dir() {
                for entry in fs::read_dir(folder)? {
                    let txt = entry?.path();
                    let wav = txt.with_extension("wav");
                    if txt.extension().and_then(OsStr::to_str) == Some("txt") && wav.is_file() {
                        state_clips.push(VoiceClip {
                            text: fs::read_to_string(&txt)?,
                            wav_path: wav,
                        });
                    }
                }
            }
            clips.insert(state, state_clips);
        }
        Ok(Self { clips })
    }

    pub fn choose(&self, state: PetState) -> Option<VoiceClip> {
        let clips = self.clips.get(&state)?;
        if clips.is_empty() {
            return None;
        }
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.subsec_nanos();
        clips.get(nanos as usize % clips.len()).cloned()
    }
}
```

使用 `SystemTime` 的纳秒值对候选数量取模，不增加 `rand` 依赖。每次状态更新只选一个 pair；允许连续选到同一条。

- [ ] **Step 4: 用 Windows `PlaySoundW` 播放最新 WAV**

```rust
use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
use std::os::windows::ffi::OsStrExt;

pub fn play_wav(path: &Path) {
    let wide = path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    unsafe { PlaySoundW(wide.as_ptr(), std::ptr::null_mut(), SND_ASYNC | SND_FILENAME | SND_NODEFAULT); }
}
```

新语音直接替换当前播放内容；不实现队列、优先级、冷却、完成回调或音量控制。

- [ ] **Step 5: 保持语音模块边界简单**

本 Task 只实现并测试 `VoiceBank` 与 `play_wav`。状态到语音的唯一接线点放在 Task 4 的 `run_pipe_loop`：将 `.txt` 放入 `bubble_text`，同时调用 `play_wav`。`PreToolUse(request_user_input)` 使用 `question/`；对应 `PostToolUse` 使用 `running/`。

在 `lib.rs` 增加 `pub mod voice;`。旧前端的 `src/audio/` 和内置 manifest 暂时不参与 Rust 构建，在 Task 5 重写整个前端时一起删除。

- [ ] **Step 6: 运行语音与状态测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS；只有同 stem 的 pair 被加载，六个状态映射到固定目录，空目录返回 `None`。

- [ ] **Step 7: 检查外置语音实现可以编译**

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS。

### Task 4: 极简 Tauri 壳与前端状态契约

**Files:**
- Replace: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/bridge.rs`
- Replace: `src/status.ts`
- Create: `src/status.test.ts`

**Interfaces:**
- Consumes: Rust `StatusUpdate` 和 `codexpet://status`。
- Produces: `bridge::AppState`、`bridge::start_pipe`、Tauri 命令 `get_status`、`start_dragging`，以及前端 `getStatus()`、`listenForStatus(onUpdate)`。

- [ ] **Step 1: 写前端状态显示测试**

```ts
it("shows waiting choice as active work and not as an interruption", () => {
  const waiting: StatusUpdate = {
    state: "waiting_choice",
    activeCount: 1,
    runningCount: 0,
    waitingCount: 1,
    activeSinceMs: 1_000,
    bubbleText: "主人，请选一个吧。",
  };
  expect(hudText(waiting, 4_000)).toBe("进行中 1 · 等待你 1\n已运行 00:00:03");
  expect(isTerminal(waiting)).toBe(false);

  const interrupted: StatusUpdate = {
    state: "interrupted",
    activeCount: 0,
    runningCount: 0,
    waitingCount: 0,
    activeSinceMs: null,
    bubbleText: "任务中断了。",
  };
  expect(isTerminal(interrupted)).toBe(true);
});
```

- [ ] **Step 2: 运行测试并确认旧前端契约不支持新状态显示**

Run: `npm test -- src/status.test.ts`

Expected: FAIL，因为新的 `StatusUpdate`、`hudText` 和 `isTerminal` 尚不存在。

- [ ] **Step 3: 实现唯一前端状态类型**

```ts
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
  return listen<StatusUpdate>("codexpet://status", ({ payload }) => onUpdate(payload));
}

export function isTerminal(update: StatusUpdate): boolean {
  return update.state === "completed" || update.state === "interrupted";
}

export function hudText(update: StatusUpdate, nowMs: number): string {
  const waiting = update.waitingCount > 0 ? ` · 等待你 ${update.waitingCount}` : "";
  const first = `进行中 ${update.activeCount}${waiting}`;
  if (update.activeSinceMs === null) return first;
  const seconds = Math.max(0, Math.floor((nowMs - update.activeSinceMs) / 1_000));
  const hh = String(Math.floor(seconds / 3_600)).padStart(2, "0");
  const mm = String(Math.floor((seconds % 3_600) / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${first}\n已运行 ${hh}:${mm}:${ss}`;
}
```

`hudText(update, nowMs)` 只负责格式化 `activeCount/waitingCount` 和 `nowMs - activeSinceMs`。后端是可信输入，前端直接使用泛型事件 payload，不增加运行时 schema 校验。

- [ ] **Step 4: 将 Tauri 只缩到两个命令和一个事件**

在 `bridge.rs` 中让 GUI 与管道线程共享同一个状态核心和启动时加载的 `VoiceBank`：

```rust
#[derive(Clone)]
pub struct AppState {
    store: Arc<Mutex<StatusStore>>,
    voice: Arc<VoiceBank>,
}

impl AppState {
    pub fn load(exe_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            store: Arc::new(Mutex::new(StatusStore::default())),
            voice: Arc::new(VoiceBank::load(exe_dir)?),
        })
    }

    pub fn current(&self) -> StatusUpdate {
        self.store.lock().unwrap().current()
    }
}

pub fn start_pipe(app: tauri::AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        run_pipe_loop(r"\\.\pipe\codexpet-status", app, state).await;
    });
}
```

`run_pipe_loop` 每次读取一个 Hook JSON，转换成 `HookEvent`，调用 `apply_at`；只有返回 `Some(update)` 时才选择语音、填入 `bubble_text`、播放 WAV，并发出 `codexpet://status`。`SessionEnd` 更新计数但跳过语音。首个 pipe server 使用 first-instance 标记保证只运行一个 GUI；每次连接后先创建下一 server instance 再读取当前消息。

`lib.rs` 使用同一份 `AppState`，完整入口固定为：

```rust
#[tauri::command]
fn get_status(state: tauri::State<'_, bridge::AppState>) -> bridge::StatusUpdate {
    state.current()
}

#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    let exe_dir = exe.parent()
        .ok_or_else(|| std::io::Error::other("EXE directory is unavailable"))?;
    let state = bridge::AppState::load(exe_dir)?;
    let pipe_state = state.clone();

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_status, start_dragging])
        .setup(move |app| {
            hooks::ensure_codex_hooks(&hooks::codex_home(), &exe)?;
            bridge::start_pipe(app.handle().clone(), pipe_state.clone());
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}
```

`get_status` 锁住 `AppState.store` 并返回当前 snapshot；`start_dragging` 只调用当前 WebviewWindow 的 `start_dragging()`。不增加设置、诊断、安装/卸载、语音完成、窗口定位、便携数据或任务详情命令。

- [ ] **Step 5: 运行前后端契约测试**

Run: `npm test -- src/status.test.ts`

Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: PASS。

- [ ] **Step 6: 检查极简应用壳文件集合**

```powershell
rg --files src-tauri/src
```

Expected: 恰好列出 `main.rs`、`lib.rs`、`bridge.rs`、`hooks.rs`、`voice.rs`。

### Task 5: Live2D、HUD、气泡和基础动作

**Files:**
- Replace: `src/main.ts`
- Replace: `src/app.ts`
- Create: `src/live2d.ts`
- Replace: `src/styles.css`
- Delete: `src/audio/`
- Delete: `src/assets/`
- Delete: `src/components/`
- Delete: `src/pet/`
- Delete: `src/state/`
- Delete: `src/styles/`
- Delete: `src/smoke.test.ts`
- Delete: `src/vite-config.test.ts`

**Interfaces:**
- Consumes: `StatusUpdate`、两个 model3 文件、五个 exp3 表情文件。
- Produces: Live2D 角色、服装/表情菜单、状态 HUD、气泡和 CSS 基础动作。

- [ ] **Step 1: 用一个 `App` 类替换现有组件树**

```ts
export class App {
  private root!: HTMLElement;
  private live2d!: Live2DView;
  private status: StatusUpdate | null = null;
  private outfit: "default" | "maid" = "default";
  private expression = "auto_neutral";

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    root.innerHTML = '<div id="pet"></div><div id="bubble"></div><div id="hud"></div><div id="menu"></div>';
    this.live2d = await Live2DView.create(root.querySelector("#pet")!);
    await this.setOutfit("default");
    bindMenu(root.querySelector("#menu")!, {
      outfit: (value) => void this.setOutfit(value),
      expression: (value) => this.setExpression(value),
    });
    this.applyStatus(await getStatus());
    await listenForStatus((update) => this.applyStatus(update));
    window.setInterval(() => {
      if (this.status) this.renderHud(this.status);
    }, 1_000);
  }

  async setOutfit(outfit: "default" | "maid"): Promise<void> {
    this.outfit = outfit;
    await this.live2d.load(MODELS[outfit]);
    this.setExpression(this.expression);
  }

  setExpression(name: string): void {
    this.expression = name;
    this.live2d.setExpression(name);
  }

  applyStatus(update: StatusUpdate): void {
    this.status = update;
    this.root.className = `pet-shell pet--${update.state}`;
    this.root.querySelector("#bubble")!.textContent = update.bubbleText ?? "";
    this.renderHud(update);
    if (isTerminal(update)) {
      window.setTimeout(async () => this.applyStatus(await getStatus()), 3_000);
    }
  }

  private renderHud(update: StatusUpdate): void {
    this.root.querySelector("#hud")!.textContent = hudText(update, Date.now());
  }
}
```

`MODELS` 只包含 `/live2d/default/character-default.model3.json` 和 `/live2d/maid/character-maid.model3.json`。`bindMenu` 只生成两套服装和 `auto_neutral/happy/angry/sleepy/error` 五个表情；不恢复设置窗口或任务列表。

- [ ] **Step 2: 将已验证的 Cubism 加载链收拢到 `live2d.ts`**

`Live2DView` 每次只保留当前服装模型，切换时销毁旧模型并加载另一个 model3：

```ts
import type { Application } from "pixi.js";
import type { Live2DModel } from "untitled-pixi-live2d-engine/cubism";

export class Live2DView {
  private model: Live2DModel | null = null;

  private constructor(
    private readonly host: HTMLElement,
    private readonly app: Application,
  ) {}

  static async create(host: HTMLElement): Promise<Live2DView> {
    ensureWebGL1Compatibility();
    await loadCubismCore();
    const [pixi, cubism] = await Promise.all([
      import("pixi.js"),
      import("untitled-pixi-live2d-engine/cubism"),
    ]);
    if (!pixiConfigured) {
      pixi.extensions.add(cubism.Live2DPlugin);
      cubism.configureCubismSDK({ memorySizeMB: 32 });
      pixiConfigured = true;
    }
    const canvas = document.createElement("canvas");
    host.append(canvas);
    const app = new pixi.Application();
    await app.init({ canvas, backgroundAlpha: 0, antialias: true, preference: "webgl" });
    const view = new Live2DView(host, app);
    new ResizeObserver(() => view.resize()).observe(host);
    view.resize();
    return view;
  }

  async load(modelUrl: string): Promise<void> {
    this.app.stage.removeChildren();
    this.model?.destroy({ children: true, texture: true, textureSource: true });
    const { Live2DModel } = await import("untitled-pixi-live2d-engine/cubism");
    const model = await Live2DModel.from(modelUrl, {
      autoHitTest: false,
      autoFocus: false,
      autoUpdate: true,
      eyeBlink: false,
    });
    ensurePixiTextureSourceCompatibility(model);
    adaptCubism6RenderOrders(model);
    model.anchor.set(0.5, 0.5);
    this.app.stage.removeChildren();
    this.app.stage.addChild(model);
    this.model = model;
    this.resize();
  }

  setExpression(name: string): void {
    if (this.model) void this.model.expression(name);
  }

  private resize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    this.app.renderer.resize(Math.max(width, 1), Math.max(height, 1));
    if (!this.model) return;
    const scale = Math.min(
      width / this.model.internalModel.width,
      height / this.model.internalModel.height,
    ) * 0.98;
    this.model.scale.set(scale);
    this.model.position.set(width / 2, height / 2);
  }
}
```

同文件用以下固定代码加载 Core 并保留三个已验证的兼容处理：

```ts
const HOSTED_CORE = "https://cubism.live2d.com/sdk-web/core/live2dcubismcore.min.js";
const CORE_URL = ["127.0.0.1", "localhost"].includes(window.location.hostname)
  ? "/cubism-core/sdk-web/core/live2dcubismcore.min.js"
  : HOSTED_CORE;
let coreLoading: Promise<void> | null = null;
let pixiConfigured = false;

function loadCubismCore(): Promise<void> {
  if ("Live2DCubismCore" in window) return Promise.resolve();
  if (coreLoading) return coreLoading;
  coreLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CORE_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Cubism Core could not be loaded"));
    document.head.append(script);
  });
  return coreLoading;
}

function ensureWebGL1Compatibility(): void {
  const globals = window as unknown as {
    WebGLRenderingContext?: unknown;
    WebGL2RenderingContext?: unknown;
  };
  globals.WebGLRenderingContext ??=
    globals.WebGL2RenderingContext ?? { UNPACK_FLIP_Y_WEBGL: 0x9240 };
}

function ensurePixiTextureSourceCompatibility(model: Live2DModel): void {
  for (const texture of model.textures) {
    const source = texture.source as { _gpuData?: Record<number, unknown> };
    source._gpuData ??= {};
  }
}

function adaptCubism6RenderOrders(model: Live2DModel): void {
  const core = model.internalModel.coreModel as unknown as {
    getDrawableRenderOrders(): Int32Array;
    _model?: { getRenderOrders?: () => Int32Array };
  };
  const getRenderOrders = core._model?.getRenderOrders;
  if (getRenderOrders) {
    core.getDrawableRenderOrders = () => getRenderOrders.call(core._model);
  }
}
```

按 host 尺寸缩放居中。加载失败直接保持空白，不增加静态 fallback。

表情名称 `auto_neutral` 表示普通中性表情，不是“自动模式”；状态变化只改 CSS 动作，不覆盖用户手动选择的表情。

- [ ] **Step 3: 保留整体彩动，不实现 Live2D motion3**

```css
.pet--idle canvas { animation: breathe 3s ease-in-out infinite; }
.pet--running canvas { animation: work-sway 1.8s ease-in-out infinite; }
.pet--waiting_choice canvas,
.pet--waiting_permission canvas { animation: attention 0.9s ease-in-out infinite; }
.pet--completed canvas { animation: celebrate 0.6s ease-out 2; }
.pet--interrupted canvas { animation: error-shake 0.35s linear 2; }
```

点击角色只触发一次短暂 `pet--poked` class。拖动空白区域调用 `start_dragging`。

- [ ] **Step 4: 明确 HUD 和计时显示**

```text
进行中 3 · 等待你 1
已运行 00:12:34
```

`进行中` 使用 `activeCount`，等待提示使用 `waitingCount`；计时基于 `Date.now() - activeSinceMs` 每秒刷新。等待选择期间数字继续增长。

- [ ] **Step 5: 运行前端测试和构建**

Run: `npm test`

Expected: PASS。

Run: `npm run build`

Expected: PASS；不再输出 fallback PNG 文件。

- [ ] **Step 6: 手工验证角色交互**

Run: `npm run desktop:dev`

Expected: 默认服装可见；可以切换女仆服装和五个表情；六个状态 class 产生对应整体彩动；窗口可拖动；气泡不遮挡 HUD。

- [ ] **Step 7: 检查极简前端文件集合**

```powershell
rg --files src
```

Expected: 恰好列出 `main.ts`、`app.ts`、`live2d.ts`、`status.ts`、`status.test.ts`、`styles.css`。

### Task 6: 压缩 Live2D 运行素材

**Files:**
- Modify: `public/live2d/default/character-default.model3.json`
- Modify: `public/live2d/maid/character-maid.model3.json`
- Delete: `public/live2d/default/character-default.4096/`
- Delete: `public/live2d/maid/character-maid.4096/`
- Keep: both `.moc3`, both `.2048/texture_00.png`, and `public/live2d/default/expressions/*.exp3.json`

**Interfaces:**
- Consumes: 2048 纹理。
- Produces: 与当前两套外观和五个表情相同的运行模型。

- [ ] **Step 1: 将两个 model3 的纹理路径改为 2048 目录**

```json
"Textures": ["character-default.2048/texture_00.png"]
```

女仆 model3 对应使用：

```json
"Textures": ["character-maid.2048/texture_00.png"]
```

- [ ] **Step 2: 删除未引用的 4096 纹理**

只删除本 Task 的 Files 列表中明确标为 Delete 的两个目标，不触碰 `.moc3` 和表情 JSON。静态 fallback 已随 Task 5 的 `src/assets/` 删除。

- [ ] **Step 3: 构建并手工检查两套模型**

Run: `npm run build`

Expected: PASS；两个 model3 均只引用存在的 2048 纹理。

Run: `npm run desktop:dev`

Expected: 默认与女仆服装轮廓、透明度和五个表情均正常，无静态 PNG 降级。

- [ ] **Step 4: 确认 model3 不再引用 4096 纹理**

```powershell
rg -n "4096" public/live2d
```

Expected: 无匹配。

### Task 7: 精简依赖、配置和本机构建

**Files:**
- Replace: `.gitignore`
- Delete: `.gitattributes`
- Replace: `index.html`
- Replace: `package.json`
- Modify: `package-lock.json`
- Replace: `tsconfig.json`
- Replace: `vite.config.ts`
- Replace: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Replace: `src-tauri/tauri.conf.json`
- Keep: `src-tauri/build.rs`
- Replace: `src-tauri/capabilities/default.json`
- Delete: `src-tauri/.gitignore`
- Keep: `src-tauri/icons/icon.ico`
- Delete: `src-tauri/icons/32x32.png`
- Delete: `src-tauri/icons/128x128.png`
- Delete: `src-tauri/icons/128x128@2x.png`
- Delete: `src-tauri/icons/icon.icns`
- Delete: `src-tauri/icons/icon.png`
- Delete: `src-tauri/icons/Square30x30Logo.png`
- Delete: `src-tauri/icons/Square44x44Logo.png`
- Delete: `src-tauri/icons/Square71x71Logo.png`
- Delete: `src-tauri/icons/Square89x89Logo.png`
- Delete: `src-tauri/icons/Square107x107Logo.png`
- Delete: `src-tauri/icons/Square142x142Logo.png`
- Delete: `src-tauri/icons/Square150x150Logo.png`
- Delete: `src-tauri/icons/Square284x284Logo.png`
- Delete: `src-tauri/icons/Square310x310Logo.png`
- Delete: `src-tauri/icons/StoreLogo.png`
- Create: `scripts/build-local.ps1`
- Delete: `scripts/build-portable.ps1`
- Delete: `scripts/measure-resources.ps1`
- Delete: `scripts/smoke-windows.ps1`
- Delete: `scripts/test-portable-release.ps1`
- Delete: `scripts/test-portable-runtime.ps1`
- Delete: `scripts/test-portable-status-flow.ps1`
- Delete: `scripts/test-verify-portable.ps1`
- Delete: `scripts/verify-portable.ps1`
- Replace: `README.md`
- Delete: `docs/codex-integration-validation.md`
- Delete: `docs/performance.md`
- Delete: `docs/portable-app-design.md`
- Delete: `docs/portable-app-implementation-plan.md`
- Delete: `docs/portable-usage.txt`
- Delete: `docs/troubleshooting.md`
- Delete: `docs/voice-setup.md`
- Delete: `docs/superpowers/plans/2026-09-04-static-voice-pack.md`
- Delete: `docs/superpowers/specs/2026-09-04-static-voice-pack-design.md`
- Delete: `tests/`
- Delete: `vendor/`

**Interfaces:**
- Consumes: 前端构建和 Rust release build。
- Produces: `G:\Codex code\CodexPet-runtime\CodexPet.exe`，且不覆盖现有 `voice/`。

- [ ] **Step 1: 将依赖缩到运行需要的集合**

前端保留：

```json
{
  "dependencies": {
    "@tauri-apps/api": "^2",
    "pixi.js": "^8.13.1",
    "untitled-pixi-live2d-engine": "^1.3.5"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "typescript": "~5.6.2",
    "vite": "^6.0.3",
    "vitest": "^3.2.4",
    "jsdom": "^24.1.3"
  }
}
```

Rust 保留 Tauri、serde、serde_json、Tokio 的 `io-util/net/rt-multi-thread/sync/time` 和 windows-sys 的命名管道及 `Win32_Media_Audio` 功能。删除 autostart、chrono、sha2、thiserror、toml_edit、tray 和独立 `codexpet-hook` bin。

根 `.gitignore` 只保留 `node_modules/`、`dist/`、`src-tauri/target/`、`tmp/`、`portable/`、`.superpowers/`、`GPT-SoVITS-v2pro-20250604-nvidia50/`、`人物语音参数/`、`人物素材/` 和 `assets/live2d-source/`，防止物理清理前误暂存大目录。删除仅服务已移出 `.cmo3` 源文件的 `.gitattributes`，并删除旧 e2e fixture 与 vendor 说明。

- [ ] **Step 2: 固定前端入口、TypeScript 和 Cubism 开发代理**

`index.html` 只保留 `#app`、`/src/styles.css` 和 `/src/main.ts`。`tsconfig.json` 只包含 ES2020、DOM、bundler module resolution、strict、noEmit，并只扫描 `src`。

`vite.config.ts` 保留 Live2D 开发所需的唯一代理：

```ts
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  optimizeDeps: {
    entries: ["index.html"],
    esbuildOptions: {
      define: { "WebGLRenderingContext.UNPACK_FLIP_Y_WEBGL": "37440" },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "/cubism-core": {
        target: "https://cubism.live2d.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cubism-core/, ""),
      },
    },
  },
});
```

- [ ] **Step 3: 将 Tauri 配置固定为单窗口、无 bundle**

窗口保持透明、无边框、置顶、跳过任务栏和不可缩放；`bundle.active` 保持 `false`。能力文件只保留 `core:default`；图标只保留 `icons/icon.ico`。不声明托盘、插件、安装器或额外 sidecar。

- [ ] **Step 4: 编写唯一构建脚本**

```powershell
$ErrorActionPreference = 'Stop'
$runtime = 'G:\Codex code\CodexPet-runtime'
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri\Cargo.toml
cargo build --release --manifest-path src-tauri\Cargo.toml
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -LiteralPath 'src-tauri\target\release\codexpet.exe' -Destination "$runtime\CodexPet.exe" -Force
New-Item -ItemType Directory -Force -Path "$runtime\voice" | Out-Null
foreach ($category in 'idle','running','question','permission','completed','interrupted') {
    New-Item -ItemType Directory -Force -Path "$runtime\voice\$category" | Out-Null
}
```

脚本不删除也不覆盖 `$runtime\voice`。

- [ ] **Step 5: 将 README 缩到个人使用说明**

README 只说明：运行 `CodexPet.exe`、GUI 必须先开、语音目录格式、重启刷新语音、右键切换服装/表情，以及 Hooks 会在启动时自动配置。

- [ ] **Step 6: 运行唯一构建脚本**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-local.ps1`

Expected: 所有测试与构建通过；runtime 目录只有一个 EXE 和未被覆盖的 `voice/`。

- [ ] **Step 7: 检查待提交范围**

```powershell
git status --short
```

Expected: 只剩本计划明确列出的源码、配置、素材、文档删除和可再生目录；不出现计划外的用户文件。

### Task 8: 状态链路验收与物理清理

**Files:**
- Verify: `G:\Codex code\CodexPet-runtime\CodexPet.exe`
- Move outside project: `GPT-SoVITS-v2pro-20250604-nvidia50/`, `人物语音参数/`, `人物素材/`, `assets/live2d-source/`
- Delete as regenerable/obsolete: `src-tauri/target/`, `tmp/`, `node_modules/`, `dist/`, `portable/`, `.superpowers/`, `src-tauri/gen/`, `src-tauri/binaries/`

**Interfaces:**
- Consumes: 构建后的单 EXE 和测试 voice pack。
- Produces: 验收通过的最小项目与 `G:\Codex code\CodexPet-assets\` 外部素材目录。

Steps 1–4 是功能验收；只有四步全部通过后才执行跨目录移动和删除。物理清理不是判断软件功能成功的前置条件。

- [ ] **Step 1: 验证完整等待选择序列**

验收前在 runtime 六个状态目录中临时放入同 stem 的测试 `.txt + .wav`；WAV 是最短可播放的 PCM16 单声道测试音频，只验证配对与播放链路，不作为角色语音交付。验收完成后删除这些临时 pair，正式语音仍由独立模型和参数生成后自行投放。

向 hook 子命令依次发送：

```text
UserPromptSubmit
PreToolUse(tool_name=request_user_input)
PostToolUse(tool_name=request_user_input)
Stop
```

Expected:

```text
running → waiting_choice → running → completed
```

整个序列中 `active_since_ms` 不变；等待时 `activeCount=1`、`runningCount=0`、`waitingCount=1`；回答后变为 `activeCount=1`、`runningCount=1`、`waitingCount=0`。四次状态变化分别显示并播放对应目录的配对台词。

- [ ] **Step 2: 单独验证真正中断**

发送 `UserPromptSubmit → Interrupt`。

Expected: `running → interrupted`，随后活跃计数为 0；过程中绝不出现 `waiting_choice`。

- [ ] **Step 3: 验证并发数量与最早计时**

启动三个 session，让一个 running、一个 waiting_choice、一个 waiting_permission。

Expected: `activeCount=3`、`runningCount=1`、`waitingCount=2`；HUD 的运行时间以三个 session 中最早的开始时间为准并持续增长。

- [ ] **Step 4: 验证外置语音重启生效**

在 `voice/question/` 新增一组同名 `.txt + .wav`，程序运行期间不要求出现；重启后重复等待选择事件。

Expected: 新 pair 进入随机候选；气泡文本和播放 WAV 始终来自同一 stem。

- [ ] **Step 5: 将生成与源素材移出应用项目**

先解析并确认以下四个源路径都位于 `G:\Codex code\CodexPet\`，目标都位于 `G:\Codex code\CodexPet-assets\`，再逐项移动：

```text
GPT-SoVITS-v2pro-20250604-nvidia50
人物语音参数
人物素材
assets/live2d-source
```

这些约 14.6 GiB 的内容用于独立生成/编辑，不随 CodexPet 构建。

- [ ] **Step 6: 删除明确列出的生成物和旧便携目录**

逐项确认绝对路径后删除本 Task 的 Delete 列表。预计释放约 21.4 GiB；`src-tauri/target`、`node_modules` 和 `dist` 均可由构建脚本重建。不得使用不带明确目标的 `git clean` 或仓库根目录递归删除。本计划的 `.superpowers/sdd/2026-09-05-codexpet-simplification/` 要保留到最终审查和最终提交完成后再删除。

- [ ] **Step 7: 最终运行验收**

直接双击 `G:\Codex code\CodexPet-runtime\CodexPet.exe`，再开启 Codex 对话。

Expected:

- Live2D 默认服装正常显示，可切换女仆服装和五个表情。
- idle/running/waiting_choice/waiting_permission/completed/interrupted 均有对应整体彩动。
- 多会话数量和最早运行时间正确。
- `request_user_input` 出现时显示“等待你的选择”语义的预生成气泡并播放 `voice/question/` WAV。
- 用户回答后恢复 running，计时不重置。
- 权限询问使用 `voice/permission/`，真正中断使用 `voice/interrupted/`。
- `hooks.json` 指向 `CodexPet.exe hook`，不再引用 `codexpet-hook.exe`；现有 `config.toml notify` 未改变。
- 关闭 GUI 后 Hook 不影响 Codex 正常工作。

- [ ] **Step 8: 只提交最终极简项目**

```powershell
git add -A -- .gitignore README.md docs index.html package.json package-lock.json public scripts src src-tauri tsconfig.json vite.config.ts
git commit -m "refactor: rebuild codexpet as a minimal desktop pet"
```

Expected: 这是唯一的新实现提交；Git 历史中没有旧未跟踪源码的基线提交，也没有模型、权重、编译缓存或 runtime 语音文件。

---

## 完成标准

- 最终运行目录只有一个 `CodexPet.exe` 和可编辑的 `voice/`。
- 运行源码收敛到 5 个 TypeScript 文件和 5 个 Rust 文件，不保留旧模块兼容层。
- 自动测试覆盖 `running → waiting_choice → running → completed`、`running → interrupted`、权限等待、并发计数和最早计时。
- 全部前端测试、Rust 测试、前端 build 和 Rust release build 通过。
- 手工验收覆盖两套服装、五个表情、六类状态动作、气泡与 WAV 配对播放。
- 项目目录不再包含 GPT-SoVITS、模型权重、Live2D 源工程、临时 spike、编译缓存、旧便携副本或发布工程。
