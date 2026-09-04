use std::fs;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_FILE_NOT_FOUND, ERROR_NO_DATA, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED,
    HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

pub const PIPE_NAME: &str = r"\\.\pipe\codexpet-status";
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("USERPROFILE").unwrap()).join(".codex"))
}

pub fn ensure_codex_hooks(
    codex_home: &Path,
    exe_path: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    fs::create_dir_all(codex_home)?;
    let hooks_path = codex_home.join("hooks.json");
    let existing = match fs::read(&hooks_path) {
        Ok(contents) => serde_json::from_slice(&contents)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    if !existing.is_object() {
        return Err(
            io::Error::new(io::ErrorKind::InvalidData, "hooks.json must be an object").into(),
        );
    }

    fs::write(
        hooks_path,
        serde_json::to_vec_pretty(&merge_codexpet_hooks(existing, exe_path)?)?,
    )?;
    Ok(())
}

pub fn merge_codexpet_hooks(mut config: Value, exe_path: &Path) -> io::Result<Value> {
    let config_object = config.as_object_mut().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidData, "hooks.json must be an object")
    })?;
    let hooks = config_object
        .entry("hooks")
        .or_insert_with(|| Value::Object(Default::default()))
        .as_object_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "hooks must be an object"))?;
    if hooks.values().any(|event| !event.is_array()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "every hook event must be an array",
        ));
    }

    for (event_name, matcher) in [
        ("SessionStart", None),
        ("SessionEnd", None),
        ("UserPromptSubmit", None),
        ("PreToolUse", Some("request_user_input")),
        ("PermissionRequest", None),
        ("PostToolUse", None),
        ("Stop", None),
        ("Interrupt", None),
    ] {
        let mut groups = hooks
            .remove(event_name)
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter_map(remove_codexpet_handlers)
            .collect::<Vec<_>>();
        groups.push(codexpet_group(matcher, exe_path));
        hooks.insert(event_name.to_owned(), Value::Array(groups));
    }

    Ok(config)
}

fn remove_codexpet_handlers(mut group: Value) -> Option<Value> {
    let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
        return Some(group);
    };
    handlers.retain(|handler| !is_legacy_codexpet_handler(handler));
    (!handlers.is_empty()).then_some(group)
}

fn is_legacy_codexpet_handler(handler: &Value) -> bool {
    ["command", "commandWindows"].iter().any(|field| {
        let Some(command) = handler.get(*field).and_then(Value::as_str) else {
            return false;
        };
        let Some((executable, arguments)) = command_parts(command) else {
            return false;
        };
        let Some(basename) = Path::new(executable)
            .file_name()
            .and_then(|name| name.to_str())
        else {
            return false;
        };

        basename.eq_ignore_ascii_case("codexpet-hook.exe")
            || (basename.eq_ignore_ascii_case("codexpet.exe")
                && arguments.split_whitespace().next().is_some_and(|argument| {
                    argument
                        .trim_matches(|character| character == '\"' || character == '\'')
                        .eq_ignore_ascii_case("hook")
                }))
    })
}

fn command_parts(command: &str) -> Option<(&str, &str)> {
    let command = command
        .trim_start()
        .strip_prefix('&')
        .unwrap_or(command)
        .trim_start();
    if let Some(command) = command.strip_prefix('\"') {
        let closing_quote = command.find('\"')?;
        Some((
            &command[..closing_quote],
            command[closing_quote + 1..].trim_start(),
        ))
    } else {
        let executable_end = command.find(char::is_whitespace).unwrap_or(command.len());
        (!command.is_empty()).then_some((
            &command[..executable_end],
            command[executable_end..].trim_start(),
        ))
    }
}

fn codexpet_group(matcher: Option<&str>, exe_path: &Path) -> Value {
    let command = format!("\"{}\" hook", exe_path.display());
    let handler = json!({
        "type": "command",
        "command": command,
        "commandWindows": format!("& {command}"),
        "timeout": 1,
    });
    match matcher {
        Some(matcher) => json!({"matcher": matcher, "hooks": [handler]}),
        None => json!({"hooks": [handler]}),
    }
}

pub fn forward_stdin() {
    forward_reader(io::stdin().lock());
}

fn forward_reader(reader: impl Read) {
    let Ok(payload) = read_hook_payload(reader) else {
        return;
    };
    let deadline = Instant::now() + Duration::from_millis(900);

    loop {
        if Instant::now() >= deadline {
            return;
        }
        match fs::OpenOptions::new().write(true).open(PIPE_NAME) {
            Ok(mut pipe) => {
                let _ = pipe.write_all(&payload);
                return;
            }
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(code)
                        if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PIPE_BUSY as i32
                ) && Instant::now() < deadline =>
            {
                let remaining = deadline.saturating_duration_since(Instant::now());
                thread::sleep(remaining.min(Duration::from_millis(10)));
            }
            Err(_) => return,
        }
    }
}

fn read_hook_payload(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut payload = Vec::new();
    reader
        .by_ref()
        .take((MAX_PAYLOAD_BYTES + 1) as u64)
        .read_to_end(&mut payload)?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "hook payload exceeds 64 KiB",
        ));
    }
    let value: Value = serde_json::from_slice(&payload)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if !value.is_object() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "hook payload must be an object",
        ));
    }
    Ok(payload)
}

pub struct PipeServer {
    handle: OwnedHandle,
}

pub fn create_pipe_server(first_pipe_instance: bool) -> io::Result<PipeServer> {
    let name = wide(PIPE_NAME);
    let open_mode = PIPE_ACCESS_INBOUND
        | if first_pipe_instance {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            0,
            MAX_PAYLOAD_BYTES as u32,
            0,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(PipeServer {
            handle: unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) },
        })
    }
}

impl PipeServer {
    pub fn connect(&self) -> io::Result<()> {
        if unsafe { ConnectNamedPipe(self.handle.as_raw_handle() as HANDLE, std::ptr::null_mut()) }
            != 0
        {
            return Ok(());
        }
        let error = unsafe { GetLastError() };
        if error == ERROR_PIPE_CONNECTED || error == ERROR_NO_DATA {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(error as i32))
        }
    }

    pub fn into_file(self) -> fs::File {
        self.handle.into()
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::Mutex;
    use std::thread;
    use std::time::{Duration, Instant};

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    static PIPE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn installs_question_hooks_without_touching_unrelated_hooks() {
        let existing = json!({
            "version": 1,
            "hooks": {
                "Stop": [{
                    "matcher": "keep-me",
                    "hooks": [{"type": "command", "command": "other-tool"}]
                }]
            }
        });

        let updated = merge_codexpet_hooks(existing, Path::new(r"C:\Pet\CodexPet.exe")).unwrap();

        assert_eq!(updated["version"], 1);
        assert_eq!(updated["hooks"]["Stop"][0]["matcher"], "keep-me");
        assert_eq!(
            updated["hooks"]["Stop"][0]["hooks"][0]["command"],
            "other-tool"
        );
        assert!(updated["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group["matcher"] == "request_user_input"));
    }

    #[test]
    fn replaces_all_legacy_codexpet_handlers_and_keeps_other_handlers() {
        let existing = json!({
            "otherTopLevelSetting": {"keep": true},
            "hooks": {
                "SessionStart": [{"hooks": [{"type": "command", "command": "other-tool", "commandWindows": "& \"C:\\Pet\\CodexPet.exe\" hook"}]}],
                "SessionEnd": [{"hooks": [{"type": "command", "command": "C:\\old\\codexpet-hook.exe --status"}]}],
                "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "& \"C:\\Pet\\CodexPet.exe\" hook"}]}],
                "PermissionRequest": [{"hooks": [{"type": "command", "command": "\"C:\\Pet\\CodexPet.exe\" hook"}]}],
                "PostToolUse": [{"hooks": [{"type": "command", "command": "C:\\old\\codexpet-hook.exe"}]}],
                "Stop": [
                    {"matcher": "keep-me", "hooks": [{"type": "command", "command": "other-tool"}]},
                    {"hooks": [{"type": "command", "command": "C:\\old\\codexpet-hook.exe"}]}
                ],
                "Interrupt": [{"hooks": [{"type": "command", "command": "\"C:\\Pet\\CodexPet.exe\" hook"}]}]
            }
        });

        let updated = merge_codexpet_hooks(existing, Path::new(r"C:\Pet\CodexPet.exe")).unwrap();
        let hooks = updated["hooks"].as_object().unwrap();

        assert_eq!(updated["otherTopLevelSetting"], json!({"keep": true}));
        for event_name in [
            "SessionStart",
            "SessionEnd",
            "UserPromptSubmit",
            "PreToolUse",
            "PermissionRequest",
            "PostToolUse",
            "Stop",
            "Interrupt",
        ] {
            let groups = hooks[event_name].as_array().unwrap();
            assert!(groups.iter().all(|group| {
                group["hooks"].as_array().unwrap().iter().all(|handler| {
                    !handler["command"]
                        .as_str()
                        .is_some_and(|command| command.contains("codexpet-hook.exe"))
                        && (!handler["commandWindows"].as_str().is_some_and(|command| {
                            command.contains("CodexPet.exe")
                                && command.split_whitespace().any(|argument| {
                                    argument.trim_matches('\"').eq_ignore_ascii_case("hook")
                                })
                        }) || (handler["command"] == "\"C:\\Pet\\CodexPet.exe\" hook"
                            && handler["commandWindows"] == "& \"C:\\Pet\\CodexPet.exe\" hook"
                            && handler["timeout"] == 1))
                })
            }));
            assert_eq!(
                groups
                    .iter()
                    .flat_map(|group| {
                        group["hooks"].as_array().unwrap().iter().filter(|handler| {
                            handler["command"] == "\"C:\\Pet\\CodexPet.exe\" hook"
                                && handler["commandWindows"] == "& \"C:\\Pet\\CodexPet.exe\" hook"
                                && handler["timeout"] == 1
                        })
                    })
                    .count(),
                1
            );
        }
        assert_eq!(hooks["Stop"][0]["matcher"], "keep-me");
        assert_eq!(hooks["Stop"][0]["hooks"][0]["command"], "other-tool");
        assert!(hooks["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| { group["matcher"] == "request_user_input" }));
        assert!(hooks["PostToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .any(|group| group.get("matcher").is_none()));
    }

    #[test]
    fn preserves_commands_that_only_mention_legacy_handler_names() {
        let existing = json!({
            "hooks": {
                "Stop": [
                    {"hooks": [{"type": "command", "command": "echo codexpet-hook.exe"}]},
                    {"hooks": [{"type": "command", "command": "\"C:\\Pet\\MyCodexPet.exe\" hook"}]},
                    {"hooks": [{"type": "command", "commandWindows": "echo CodexPet.exe hook"}]}
                ]
            }
        });

        let updated = merge_codexpet_hooks(existing, Path::new(r"C:\Pet\CodexPet.exe")).unwrap();
        let commands = updated["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|group| group["hooks"].as_array().unwrap().iter())
            .collect::<Vec<_>>();

        assert!(commands
            .iter()
            .any(|handler| handler["command"] == "echo codexpet-hook.exe"));
        assert!(commands
            .iter()
            .any(|handler| { handler["command"] == "\"C:\\Pet\\MyCodexPet.exe\" hook" }));
        assert!(commands
            .iter()
            .any(|handler| { handler["commandWindows"] == "echo CodexPet.exe hook" }));
    }

    #[test]
    fn rejects_invalid_or_unwritable_hooks_json() {
        let directory = tempdir().unwrap();
        let codex_home = directory.path().join(".codex");
        std::fs::create_dir(&codex_home).unwrap();
        let hooks_path = codex_home.join("hooks.json");

        std::fs::write(&hooks_path, "not json").unwrap();
        assert!(ensure_codex_hooks(&codex_home, Path::new(r"C:\Pet\CodexPet.exe")).is_err());

        std::fs::remove_file(&hooks_path).unwrap();
        std::fs::create_dir(&hooks_path).unwrap();
        assert!(ensure_codex_hooks(&codex_home, Path::new(r"C:\Pet\CodexPet.exe")).is_err());
    }

    #[test]
    fn rejects_unrecognized_hook_structures_without_rewriting_the_file() {
        let directory = tempdir().unwrap();
        let codex_home = directory.path().join(".codex");
        std::fs::create_dir(&codex_home).unwrap();
        let hooks_path = codex_home.join("hooks.json");
        let original = br#"{"hooks":{"Stop":{"unexpected":true}}}"#;
        std::fs::write(&hooks_path, original).unwrap();

        assert!(ensure_codex_hooks(&codex_home, Path::new(r"C:\Pet\CodexPet.exe")).is_err());

        assert_eq!(std::fs::read(&hooks_path).unwrap(), original);

        let root_invalid = br#"{"hooks":"unexpected"}"#;
        std::fs::write(&hooks_path, root_invalid).unwrap();

        assert!(ensure_codex_hooks(&codex_home, Path::new(r"C:\Pet\CodexPet.exe")).is_err());

        assert_eq!(std::fs::read(&hooks_path).unwrap(), root_invalid);
    }

    #[test]
    fn preserves_groups_without_a_hooks_array() {
        let existing = json!({
            "hooks": {
                "Stop": [{"matcher": "future-hook-group", "future": true}]
            }
        });

        let updated = merge_codexpet_hooks(existing, Path::new(r"C:\Pet\CodexPet.exe")).unwrap();

        assert_eq!(
            updated["hooks"]["Stop"][0],
            json!({
                "matcher": "future-hook-group",
                "future": true,
            })
        );
    }

    #[test]
    fn rejects_payloads_larger_than_64_kib() {
        let payload = vec![b' '; 64 * 1024 + 1];

        assert!(read_hook_payload(Cursor::new(payload)).is_err());
    }

    #[test]
    fn reads_one_json_object_until_client_eof() {
        let payload = read_hook_payload(Cursor::new(
            br#"{"hook_event_name":"Stop","session_id":"s-1"}"#,
        ))
        .unwrap();

        assert_eq!(payload, br#"{"hook_event_name":"Stop","session_id":"s-1"}"#);
    }

    #[test]
    fn first_pipe_instance_reserves_the_name_while_later_instances_are_allowed() {
        let _lock = PIPE_TEST_LOCK.lock().unwrap();
        let first = create_pipe_server(true).unwrap();

        assert!(create_pipe_server(true).is_err());
        let next = create_pipe_server(false).unwrap();

        drop(next);
        drop(first);
    }

    #[test]
    fn forwards_a_complete_json_frame_to_the_named_pipe_server() {
        let _lock = PIPE_TEST_LOCK.lock().unwrap();
        let server = create_pipe_server(true).unwrap();
        let payload = br#"{"hook_event_name":"Stop","session_id":"s-1"}"#.to_vec();
        let sender_payload = payload.clone();
        let sender = thread::spawn(move || forward_reader(Cursor::new(sender_payload)));

        server.connect().unwrap();
        let mut received = Vec::new();
        server.into_file().read_to_end(&mut received).unwrap();
        sender.join().unwrap();

        assert_eq!(received, payload);
    }

    #[test]
    fn reads_a_complete_frame_when_the_client_closes_before_connect() {
        let _lock = PIPE_TEST_LOCK.lock().unwrap();
        let server = create_pipe_server(true).unwrap();
        let payload = br#"{"hook_event_name":"Stop","session_id":"s-1"}"#.to_vec();
        let sender_payload = payload.clone();
        let sender = thread::spawn(move || forward_reader(Cursor::new(sender_payload)));

        sender.join().unwrap();
        server.connect().unwrap();
        let mut received = Vec::new();
        server.into_file().read_to_end(&mut received).unwrap();

        assert_eq!(received, payload);
    }

    #[test]
    fn forwarding_without_a_server_returns_after_the_retry_window() {
        let _lock = PIPE_TEST_LOCK.lock().unwrap();
        let started_at = Instant::now();

        forward_reader(Cursor::new(
            br#"{"hook_event_name":"Stop","session_id":"s-1"}"#,
        ));

        let elapsed = started_at.elapsed();
        assert!(elapsed >= Duration::from_millis(800));
        assert!(elapsed < Duration::from_millis(1_500));
    }
}
