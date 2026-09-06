use std::{
    collections::HashMap,
    ffi::OsStr,
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use rodio::{Decoder, DeviceSinkBuilder, MixerDeviceSink, Player};

use crate::bridge::PetState;

#[derive(Clone)]
pub struct VoiceClip {
    pub text: String,
    pub wav_path: PathBuf,
}

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

impl VoiceBank {
    pub fn load(exe_dir: &Path) -> std::io::Result<Self> {
        let mut clips = HashMap::new();
        for state in [
            PetState::Idle,
            PetState::Running,
            PetState::WaitingInput,
            PetState::WaitingChoice,
            PetState::WaitingPermission,
            PetState::Completed,
            PetState::Failed,
            PetState::Interrupted,
        ] {
            let folder = exe_dir.join("voice").join(category(state));
            clips.insert(state, load_pairs(&folder)?);
        }

        Ok(Self {
            clips,
            headpat: load_pairs(&exe_dir.join("voice/headpat"))?,
        })
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

    pub fn choose_headpat(&self) -> Option<VoiceClip> {
        if self.headpat.is_empty() {
            return None;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .subsec_nanos();
        self.headpat
            .get(nanos as usize % self.headpat.len())
            .cloned()
    }
}

fn load_pairs(folder: &Path) -> std::io::Result<Vec<VoiceClip>> {
    let mut clips = Vec::new();
    if !folder.is_dir() {
        return Ok(clips);
    }
    for entry in fs::read_dir(folder)? {
        let txt = entry?.path();
        let wav = txt.with_extension("wav");
        if txt.extension().and_then(OsStr::to_str) == Some("txt") && wav.is_file() {
            clips.push(VoiceClip {
                text: fs::read_to_string(&txt)?,
                wav_path: wav,
            });
        }
    }
    Ok(clips)
}

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
            inner.device = Some(PlaybackDevice {
                _sink: sink,
                player,
            });
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

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{AudioPlayer, VoiceBank};
    use crate::bridge::PetState;

    #[test]
    fn loads_only_same_stem_text_and_wav_pairs() {
        let temp = tempdir().unwrap();
        let folder = temp.path().join("voice/waiting_choice");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("01.txt"), "主人，请选一个吧。").unwrap();
        fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();
        fs::write(folder.join("ignored.txt"), "没有 wav").unwrap();
        fs::write(folder.join("orphan.wav"), b"RIFF-test").unwrap();

        let bank = VoiceBank::load(temp.path()).unwrap();
        let clips = bank.clips.get(&PetState::WaitingChoice).unwrap();
        assert_eq!(clips.len(), 1);
        assert_eq!(clips[0].text, "主人，请选一个吧。");
        assert!(clips[0].wav_path.ends_with("waiting_choice\\01.wav"));

        let clip = bank.choose(PetState::WaitingChoice).unwrap();

        assert_eq!(clip.text, "主人，请选一个吧。");
        assert!(clip.wav_path.ends_with("waiting_choice\\01.wav"));
    }

    #[test]
    fn maps_each_pet_state_to_its_fixed_voice_directory() {
        let temp = tempdir().unwrap();
        let cases = [
            (PetState::Idle, "idle"),
            (PetState::Running, "running"),
            (PetState::WaitingInput, "waiting_input"),
            (PetState::WaitingChoice, "waiting_choice"),
            (PetState::WaitingPermission, "permission"),
            (PetState::Completed, "completed"),
            (PetState::Failed, "failed"),
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
            PetState::WaitingInput,
            PetState::WaitingChoice,
            PetState::WaitingPermission,
            PetState::Completed,
            PetState::Failed,
            PetState::Interrupted,
        ] {
            assert!(bank.choose(state).is_none());
        }
    }

    #[test]
    fn loads_only_headpat_interaction_pairs() {
        let temp = tempdir().unwrap();
        let folder = temp.path().join("voice/headpat");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("01.txt"), "嗯？").unwrap();
        fs::write(folder.join("01.wav"), b"RIFF-test").unwrap();

        let bank = VoiceBank::load(temp.path()).unwrap();
        let clip = bank.choose_headpat().unwrap();

        assert_eq!(clip.text, "嗯？");
        assert!(clip.wav_path.ends_with("headpat\\01.wav"));
    }

    #[test]
    fn volume_changes_are_clamped_and_persist_for_future_playback() {
        let player = AudioPlayer::default();
        assert_eq!(player.volume_percent(), 100);
        player.set_volume(35);
        assert_eq!(player.volume_percent(), 35);
        player.set_volume(200);
        assert_eq!(player.volume_percent(), 100);
        player.set_volume(0);
        assert_eq!(player.volume_percent(), 0);
    }

    #[test]
    fn stopping_without_an_open_device_is_safe() {
        AudioPlayer::default().stop();
    }
}
