pub mod bridge;
pub mod hooks;
pub mod voice;

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
    let exe_dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("EXE directory is unavailable"))?;
    let state = bridge::AppState::load(exe_dir)?;
    let pipe_state = state.clone();

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![get_status, start_dragging])
        .setup(move |app| {
            hooks::ensure_codex_hooks(&hooks::codex_home(), &exe)?;
            bridge::start_pipe(app.handle().clone(), pipe_state.clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}
