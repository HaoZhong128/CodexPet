pub mod bridge;
pub mod hooks;
pub mod voice;
pub mod window_region;

use tauri::Manager;

#[tauri::command]
fn get_status(state: tauri::State<'_, bridge::AppState>) -> bridge::StatusUpdate {
    state.current()
}

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
fn set_voice_volume(volume: u8, audio: tauri::State<'_, std::sync::Arc<voice::AudioPlayer>>) {
    audio.set_volume(volume);
}

#[tauri::command]
fn stop_voice(audio: tauri::State<'_, std::sync::Arc<voice::AudioPlayer>>) {
    audio.stop();
}

#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn set_window_region(
    window: tauri::WebviewWindow,
    width: u16,
    height: u16,
    runs: Vec<u16>,
) -> Result<(), String> {
    window_region::set_window_region(&window, width, height, &runs)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let exe = std::env::current_exe()?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("EXE directory is unavailable"))?;
    let state = bridge::AppState::load(exe_dir)?;
    let pipe_state = state.clone();
    let audio = std::sync::Arc::new(voice::AudioPlayer::default());
    let pipe_audio = audio.clone();

    tauri::Builder::default()
        .manage(state)
        .manage(audio)
        .invoke_handler(tauri::generate_handler![
            get_status,
            play_headpat_voice,
            set_voice_volume,
            stop_voice,
            start_dragging,
            set_window_region
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            window_region::position_bottom_right(&window).map_err(std::io::Error::other)?;
            hooks::ensure_codex_hooks(&hooks::codex_home(), &exe)?;
            bridge::start_pipe(app.handle().clone(), pipe_state.clone(), pipe_audio.clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}
