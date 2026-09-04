use std::collections::HashMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

use crate::hooks::{create_pipe_server, PipeServer, MAX_PAYLOAD_BYTES};
use crate::voice::{play_wav, VoiceBank};

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

pub fn parse_hook(payload: Value) -> Result<HookEvent, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "hook payload must be a JSON object".to_owned())?;
    let event_name = object
        .get("hook_event_name")
        .and_then(Value::as_str)
        .ok_or_else(|| "hook payload is missing hook_event_name".to_owned())?;
    let session_id = object
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "hook payload is missing session_id".to_owned())?;
    let kind = match event_name {
        "SessionStart" => HookKind::SessionStart,
        "SessionEnd" => HookKind::SessionEnd,
        "UserPromptSubmit" => HookKind::UserPromptSubmit,
        "PreToolUse" => HookKind::PreToolUse,
        "PermissionRequest" => HookKind::PermissionRequest,
        "PostToolUse" => HookKind::PostToolUse,
        "Stop" => HookKind::Stop,
        "Interrupt" => HookKind::Interrupt,
        _ => return Err(format!("unknown hook event: {event_name}")),
    };

    Ok(HookEvent {
        kind,
        session_id: session_id.to_owned(),
        tool_name: object
            .get("tool_name")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PetState {
    Idle,
    Running,
    WaitingChoice,
    WaitingPermission,
    Completed,
    Interrupted,
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

#[derive(Default)]
pub struct StatusStore {
    tasks: HashMap<String, Task>,
}

struct Task {
    started_at_ms: u64,
    phase: TaskPhase,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TaskPhase {
    Running,
    WaitingChoice,
    WaitingPermission,
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
                    .or_insert(Task {
                        started_at_ms: now_ms,
                        phase: TaskPhase::Running,
                    });
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
                if !resumes {
                    return None;
                }
                task.phase = TaskPhase::Running;
                Some(PetState::Running)
            }
            HookKind::Stop => self
                .tasks
                .remove(&event.session_id)
                .map(|_| PetState::Completed),
            HookKind::Interrupt => self
                .tasks
                .remove(&event.session_id)
                .map(|_| PetState::Interrupted),
            HookKind::SessionEnd => self
                .tasks
                .remove(&event.session_id)
                .map(|_| self.aggregate_state()),
            HookKind::PreToolUse => None,
        };
        state.map(|state| self.snapshot(state))
    }

    fn aggregate_state(&self) -> PetState {
        if self
            .tasks
            .values()
            .any(|task| task.phase == TaskPhase::WaitingChoice)
        {
            PetState::WaitingChoice
        } else if self
            .tasks
            .values()
            .any(|task| task.phase == TaskPhase::WaitingPermission)
        {
            PetState::WaitingPermission
        } else if self.tasks.is_empty() {
            PetState::Idle
        } else {
            PetState::Running
        }
    }

    fn snapshot(&self, state: PetState) -> StatusUpdate {
        let running_count = self
            .tasks
            .values()
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

    fn apply_at(&self, event: HookEvent, now_ms: u64) -> Option<(StatusUpdate, Option<PathBuf>)> {
        let silent = event.kind == HookKind::SessionEnd;
        let mut update = self.store.lock().unwrap().apply_at(event, now_ms)?;
        if silent {
            return Some((update, None));
        }

        let clip = self.voice.choose(update.state);
        let wav_path = clip.as_ref().map(|clip| clip.wav_path.clone());
        update.bubble_text = clip.map(|clip| clip.text);
        Some((update, wav_path))
    }
}

pub fn start_pipe(app: tauri::AppHandle, state: AppState) -> io::Result<()> {
    let server = create_pipe_server(true)?;
    tauri::async_runtime::spawn_blocking(move || run_pipe_loop(server, app, state));
    Ok(())
}

fn run_pipe_loop(mut server: PipeServer, app: tauri::AppHandle, state: AppState) {
    loop {
        if server.connect().is_err() {
            return;
        }
        let next = match create_pipe_server(false) {
            Ok(next) => next,
            Err(_) => return,
        };

        let mut payload = Vec::new();
        let read = server
            .into_file()
            .take((MAX_PAYLOAD_BYTES + 1) as u64)
            .read_to_end(&mut payload);
        if read.is_ok() && payload.len() <= MAX_PAYLOAD_BYTES {
            if let Ok(value) = serde_json::from_slice(payload.as_slice()) {
                if let Ok(event) = parse_hook(value) {
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_or(0, |duration| duration.as_millis() as u64);
                    if let Some((update, wav_path)) = state.apply_at(event, now_ms) {
                        if let Some(path) = wav_path {
                            play_wav(&path);
                        }
                        let _ = app.emit("codexpet://status", update);
                    }
                }
            }
        }

        server = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn parses_official_pre_tool_use_payload_without_retaining_tool_input() {
        let payload = json!({
            "session_id": "session-1",
            "turn_id": "turn-1",
            "transcript_path": null,
            "cwd": r"C:\\work",
            "hook_event_name": "PreToolUse",
            "model": "gpt-5.6",
            "permission_mode": "default",
            "tool_name": "request_user_input",
            "tool_use_id": "call-1",
            "tool_input": {"questions": [{"id": "choice"}]}
        });

        let event = parse_hook(payload).unwrap();

        assert_eq!(event.kind, HookKind::PreToolUse);
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.tool_name.as_deref(), Some("request_user_input"));
    }

    #[test]
    fn parses_terminal_events_without_tool_fields() {
        for event_name in ["SessionEnd", "Stop", "Interrupt"] {
            let event = parse_hook(json!({
                "hook_event_name": event_name,
                "session_id": "session-1",
            }))
            .unwrap();

            assert_eq!(event.session_id, "session-1");
            assert_eq!(event.tool_name, None);
        }
    }

    #[test]
    fn rejects_unknown_or_incomplete_hook_payloads() {
        assert!(parse_hook(json!({
            "hook_event_name": "Unknown",
            "session_id": "session-1",
        }))
        .is_err());
        assert!(parse_hook(json!({"session_id": "session-1"})).is_err());
        assert!(parse_hook(json!({"hook_event_name": "Stop"})).is_err());
    }

    #[test]
    fn request_user_input_waits_without_resetting_the_timer() {
        let mut store = StatusStore::default();
        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);

        let waiting = store
            .apply_at(
                event(
                    HookKind::PreToolUse,
                    "session-1",
                    Some("request_user_input"),
                ),
                2_000,
            )
            .unwrap();
        assert_eq!(waiting.state, PetState::WaitingChoice);
        assert_eq!(waiting.active_count, 1);
        assert_eq!(waiting.running_count, 0);
        assert_eq!(waiting.waiting_count, 1);
        assert_eq!(waiting.active_since_ms, Some(1_000));

        let resumed = store
            .apply_at(
                event(
                    HookKind::PostToolUse,
                    "session-1",
                    Some("request_user_input"),
                ),
                5_000,
            )
            .unwrap();
        assert_eq!(resumed.state, PetState::Running);
        assert_eq!(resumed.active_since_ms, Some(1_000));

        let completed = store
            .apply_at(event(HookKind::Stop, "session-1", None), 6_000)
            .unwrap();
        assert_eq!(completed.state, PetState::Completed);
    }

    #[test]
    fn interrupt_is_not_a_waiting_choice() {
        let mut store = StatusStore::default();
        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);
        let update = store
            .apply_at(event(HookKind::Interrupt, "session-1", None), 2_000)
            .unwrap();
        assert_eq!(update.state, PetState::Interrupted);
        assert_eq!(update.active_count, 0);
        assert_eq!(update.waiting_count, 0);
    }

    #[test]
    fn unknown_or_repeated_terminal_events_do_not_emit_an_update() {
        let mut store = StatusStore::default();

        assert_eq!(
            store.apply_at(event(HookKind::Stop, "unknown", None), 1_000),
            None
        );
        assert_eq!(
            store.apply_at(event(HookKind::Interrupt, "unknown", None), 1_000),
            None
        );

        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 2_000);
        assert_eq!(
            store
                .apply_at(event(HookKind::Stop, "session-1", None), 3_000)
                .unwrap()
                .state,
            PetState::Completed
        );
        assert_eq!(
            store.apply_at(event(HookKind::Stop, "session-1", None), 4_000),
            None
        );

        store.apply_at(event(HookKind::UserPromptSubmit, "session-2", None), 5_000);
        assert_eq!(
            store
                .apply_at(event(HookKind::Interrupt, "session-2", None), 6_000)
                .unwrap()
                .state,
            PetState::Interrupted
        );
        assert_eq!(
            store.apply_at(event(HookKind::Interrupt, "session-2", None), 7_000),
            None
        );
    }

    #[test]
    fn ordinary_tool_events_do_not_emit_an_update() {
        let mut store = StatusStore::default();
        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);

        assert_eq!(
            store.apply_at(
                event(HookKind::PreToolUse, "session-1", Some("shell")),
                2_000
            ),
            None
        );
        assert_eq!(
            store.apply_at(
                event(HookKind::PostToolUse, "session-1", Some("shell")),
                3_000
            ),
            None
        );
    }

    #[test]
    fn status_update_uses_the_ipc_json_naming_contract() {
        let mut store = StatusStore::default();
        store.apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000);
        let waiting = store
            .apply_at(
                event(
                    HookKind::PreToolUse,
                    "session-1",
                    Some("request_user_input"),
                ),
                2_000,
            )
            .unwrap();

        assert_eq!(
            serde_json::to_value(waiting).unwrap(),
            serde_json::json!({
                "state": "waiting_choice",
                "activeCount": 1,
                "runningCount": 0,
                "waitingCount": 1,
                "activeSinceMs": 1_000,
                "bubbleText": null,
            })
        );
    }

    #[test]
    fn app_state_pairs_voice_with_the_full_active_task_flow() {
        let temp = tempdir().unwrap();
        write_voice_pair(temp.path(), "running", "running-voice", "开始工作。");
        write_voice_pair(
            temp.path(),
            "question",
            "question-voice",
            "主人，请选一个吧。",
        );
        write_voice_pair(temp.path(), "completed", "completed-voice", "任务完成。");
        let state = AppState::load(temp.path()).unwrap();

        let (running, running_wav) = state
            .apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000)
            .unwrap();
        assert_eq!(running.state, PetState::Running);
        assert_eq!(running.bubble_text.as_deref(), Some("开始工作。"));
        assert_same_stem(running_wav.as_deref().unwrap(), "running-voice");

        let (waiting, waiting_wav) = state
            .apply_at(
                event(
                    HookKind::PreToolUse,
                    "session-1",
                    Some("request_user_input"),
                ),
                2_000,
            )
            .unwrap();
        assert_eq!(waiting.state, PetState::WaitingChoice);
        assert_eq!(waiting.active_since_ms, Some(1_000));
        assert_eq!(waiting.bubble_text.as_deref(), Some("主人，请选一个吧。"));
        assert_same_stem(waiting_wav.as_deref().unwrap(), "question-voice");

        let (resumed, resumed_wav) = state
            .apply_at(
                event(
                    HookKind::PostToolUse,
                    "session-1",
                    Some("request_user_input"),
                ),
                3_000,
            )
            .unwrap();
        assert_eq!(resumed.state, PetState::Running);
        assert_eq!(resumed.active_since_ms, Some(1_000));
        assert_eq!(resumed.bubble_text.as_deref(), Some("开始工作。"));
        assert_same_stem(resumed_wav.as_deref().unwrap(), "running-voice");

        let (completed, completed_wav) = state
            .apply_at(event(HookKind::Stop, "session-1", None), 4_000)
            .unwrap();
        assert_eq!(completed.state, PetState::Completed);
        assert_eq!(completed.active_count, 0);
        assert_eq!(completed.bubble_text.as_deref(), Some("任务完成。"));
        assert_same_stem(completed_wav.as_deref().unwrap(), "completed-voice");
    }

    #[test]
    fn session_end_updates_counts_without_voice_or_bubble() {
        let temp = tempdir().unwrap();
        write_voice_pair(temp.path(), "idle", "idle-voice", "空闲。");
        let state = AppState::load(temp.path()).unwrap();
        state
            .apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 1_000)
            .unwrap();

        let (ended, wav) = state
            .apply_at(event(HookKind::SessionEnd, "session-1", None), 2_000)
            .unwrap();

        assert_eq!(ended.state, PetState::Idle);
        assert_eq!(ended.active_count, 0);
        assert_eq!(ended.active_since_ms, None);
        assert_eq!(ended.bubble_text, None);
        assert_eq!(wav, None);
    }

    #[test]
    fn app_state_aggregates_permission_waiting_across_three_sessions() {
        let temp = tempdir().unwrap();
        write_voice_pair(temp.path(), "permission", "permission-voice", "请授权。");
        let state = AppState::load(temp.path()).unwrap();
        state
            .apply_at(event(HookKind::UserPromptSubmit, "session-1", None), 3_000)
            .unwrap();
        state
            .apply_at(event(HookKind::UserPromptSubmit, "session-2", None), 1_000)
            .unwrap();
        state
            .apply_at(event(HookKind::UserPromptSubmit, "session-3", None), 2_000)
            .unwrap();

        let (waiting, wav) = state
            .apply_at(event(HookKind::PermissionRequest, "session-2", None), 4_000)
            .unwrap();
        assert_eq!(waiting.state, PetState::WaitingPermission);
        assert_eq!(waiting.active_count, 3);
        assert_eq!(waiting.running_count, 2);
        assert_eq!(waiting.waiting_count, 1);
        assert_eq!(waiting.active_since_ms, Some(1_000));
        assert_eq!(waiting.bubble_text.as_deref(), Some("请授权。"));
        assert_same_stem(wav.as_deref().unwrap(), "permission-voice");

        let (ended, wav) = state
            .apply_at(event(HookKind::SessionEnd, "session-2", None), 5_000)
            .unwrap();
        assert_eq!(ended.state, PetState::Running);
        assert_eq!(ended.active_count, 2);
        assert_eq!(ended.running_count, 2);
        assert_eq!(ended.waiting_count, 0);
        assert_eq!(ended.active_since_ms, Some(2_000));
        assert_eq!(ended.bubble_text, None);
        assert_eq!(wav, None);
    }

    fn write_voice_pair(root: &std::path::Path, category: &str, stem: &str, text: &str) {
        let directory = root.join("voice").join(category);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(format!("{stem}.txt")), text).unwrap();
        fs::write(directory.join(format!("{stem}.wav")), b"RIFF-test").unwrap();
    }

    fn assert_same_stem(path: &std::path::Path, stem: &str) {
        assert_eq!(path.file_stem().unwrap(), stem);
        assert_eq!(path.extension().unwrap(), "wav");
    }

    fn event(kind: HookKind, session_id: &str, tool_name: Option<&str>) -> HookEvent {
        HookEvent {
            kind,
            session_id: session_id.to_owned(),
            tool_name: tool_name.map(str::to_owned),
        }
    }
}
