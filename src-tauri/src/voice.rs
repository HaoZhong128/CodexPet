use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

use crate::bridge::PetState;

#[derive(Clone)]
pub struct VoiceClip {
    pub text: String,
    pub wav_path: PathBuf,
}

pub struct VoiceBank {
    clips: HashMap<PetState, Vec<VoiceClip>>,
    click_clips: Vec<VoiceClip>,
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

        let folder = exe_dir.join("voice").join("click");
        let mut click_clips = Vec::new();
        if folder.is_dir() {
            for entry in fs::read_dir(folder)? {
                let txt = entry?.path();
                let wav = txt.with_extension("wav");
                if txt.extension().and_then(OsStr::to_str) == Some("txt") && wav.is_file() {
                    click_clips.push(VoiceClip {
                        text: fs::read_to_string(&txt)?,
                        wav_path: wav,
                    });
                }
            }
        }

        Ok(Self { clips, click_clips })
    }

    pub fn choose(&self, state: PetState) -> Option<VoiceClip> {
        let clips = self.clips.get(&state)?;
        if clips.is_empty() {
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .subsec_nanos();
        clips.get(nanos as usize % clips.len()).cloned()
    }

    pub fn choose_click(&self) -> Option<VoiceClip> {
        if self.click_clips.is_empty() {
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .subsec_nanos();
        self.click_clips
            .get(nanos as usize % self.click_clips.len())
            .cloned()
    }
}

pub fn play_wav(path: &Path) {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    unsafe {
        PlaySoundW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            SND_ASYNC | SND_FILENAME | SND_NODEFAULT,
        );
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::VoiceBank;
    use crate::bridge::PetState;

    #[test]
    fn loads_only_same_stem_text_and_wav_pairs() {
        let temp = tempdir().unwrap();
        let folder = temp.path().join("voice/question");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("01.txt"), "主人，请选一个吧。").unwrap();
        fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
        fs::write(folder.join("ignored.txt"), "没有 wav").unwrap();
        fs::write(folder.join("orphan.wav"), b"RIFF-test").unwrap();

        let bank = VoiceBank::load(temp.path()).unwrap();
        let clips = bank.clips.get(&PetState::WaitingChoice).unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].text, "主人，请选一个吧。");
        assert!(clips[0].wav_path.ends_with("question\\01.wav"));

        let clip = bank.choose(PetState::WaitingChoice).unwrap();

        assert_eq!(clip.text, "主人，请选一个吧。");
        assert!(clip.wav_path.ends_with("question\\01.wav"));
    }

    #[test]
    fn loads_click_feedback_from_its_own_directory() {
        let temp = tempdir().unwrap();
        let folder = temp.path().join("voice/click");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("01.txt"), "当断即断！").unwrap();
        fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
        fs::write(folder.join("ignored.txt"), "没有 wav").unwrap();

        let bank = VoiceBank::load(temp.path()).unwrap();
        let clip = bank.choose_click().unwrap();

        assert_eq!(clip.text, "当断即断！");
        assert!(clip.wav_path.ends_with("click\\01.wav"));
    }

    #[test]
    fn maps_each_pet_state_to_its_fixed_voice_directory() {
        let temp = tempdir().unwrap();
        let cases = [
            (PetState::Idle, "idle"),
            (PetState::Running, "running"),
            (PetState::WaitingChoice, "question"),
            (PetState::WaitingPermission, "permission"),
            (PetState::Completed, "completed"),
            (PetState::Interrupted, "interrupted"),
        ];

        for (_, directory) in cases {
            let folder = temp.path().join("voice").join(directory);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("clip.txt"), directory).unwrap();
            fs::write(folder.join("clip.wav"), b"RIFF-test").unwrap();
        }

        let bank = VoiceBank::load(temp.path()).unwrap();

        for (state, directory) in cases {
            let clip = bank.choose(state).unwrap();
            assert_eq!(clip.text, directory);
            assert!(clip.wav_path.ends_with(format!("{directory}\\clip.wav")));
        }
    }

    #[test]
    fn returns_none_when_voice_directories_are_empty_or_missing() {
        let temp = tempdir().unwrap();
        fs::create_dir_all(temp.path().join("voice/idle")).unwrap();

        let bank = VoiceBank::load(temp.path()).unwrap();

        for state in [
            PetState::Idle,
            PetState::Running,
            PetState::WaitingChoice,
            PetState::WaitingPermission,
            PetState::Completed,
            PetState::Interrupted,
        ] {
            assert!(bank.choose(state).is_none());
        }
    }
}
