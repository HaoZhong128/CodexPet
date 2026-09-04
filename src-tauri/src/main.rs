#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("hook") {
        codexpet_lib::hooks::forward_stdin();
    } else {
        let _ = codexpet_lib::run();
    }
}
