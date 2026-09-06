# CodexPet Long Goal Progress

Updated: 2026-09-06

## Current architecture

Codex hook -> CodexPet.exe hook -> named pipe -> Rust StatusStore -> Tauri status event -> status card / Live2D / bubble / voice.

## Completed

- [x] Design approved.
- [x] Three implementation plans approved.
- [x] Baseline verified in the current checkout.
- [x] Phase 1: structured waiting detection, concurrent aggregation, duplicate suppression, and compact status card.
- [x] Phase 2: simplified Live2D motion feedback, removed prop rendering, and enabled device-pixel-ratio rendering.
- [x] Phase 3: one Rust voice player, state/headpat voice catalog, persistent settings, fixed window sizes, and compact right-click menu.
- [x] Canceled action code, prop rendering, runtime prop assets, and obsolete runtime voice categories removed from production paths.
- [x] Release built with `tauri/custom-protocol` and deployed to `G:\Codex code\CodexPet-runtime`.

## Verification evidence

- Baseline frontend tests: 6 files / 25 tests PASS.
- Baseline Rust tests after exiting the runtime that owned the named pipe: 33 library tests + 3 integration tests PASS.
- Phase 1 frontend tests: 6 files / 29 tests PASS.
- Phase 1 Rust tests: 37 library tests + 3 integration tests PASS.
- Phase 1 production frontend build: PASS; the existing Vite large-chunk warning remains non-blocking and is unrelated to this scope.
- Status source remains the Codex hook and named pipe. Waiting priority is Choice > Permission > Input > Running; terminal feedback cannot mask other active work.
- Phase 2 frontend tests: 5 files / 25 tests PASS.
- Phase 2 Rust regression tests: 37 library tests + 3 integration tests PASS.
- Phase 2 production frontend build: PASS; only the existing Vite large-chunk warning remains.
- Both production model textures remain 2048 x 2048 (2,251,156 and 2,289,736 bytes). No texture was enlarged or resampled.
- Pixi now renders at the current device pixel ratio while Live2D layout and hit-test masks continue to use logical CSS dimensions.
- Production frontend code no longer renders weapons, accessories, or status-specific props; remaining mentions are negative regression assertions only.
- Final frontend tests: 7 files / 44 tests PASS.
- Final Rust tests: 39 library tests + 3 integration tests PASS.
- Final production frontend and Rust release builds: PASS; only the existing Vite large-chunk warning remains.
- Release and deployed EXE are byte-identical; SHA-256 is `49EAAE869C0E34F969B8BC85A5FBA682160830E3E3240A3C83A6461228A1C045`.
- Final deployed EXE is 14,214,656 bytes. The complete runtime is 18,541,927 bytes, down 3,441,103 bytes (15.65%) from the measured baseline.
- Runtime voice assets are 4,327,271 bytes, down 3,713,487 bytes (46.18%) from the measured baseline.
- The runtime voice catalog contains exactly 9 directories and 26 bidirectionally paired TXT/WAV entries. All 26 WAV files are PCM16 mono 32 kHz.
- Settings persistence was verified across a real process restart for size, volume, mute, and status-panel visibility, then restored to standard / 70 / unmuted / visible.
- Small, standard, and large windows render a complete model. Default and maid outfits load, and headpat feedback restores the current status bubble after 3.2 seconds.
- A Windows desktop capture reproduced the old native-region failure, then verified the fix across 40 consecutive frames over 20 seconds: model, bubble, and status card remained visible. The compact menu was also captured in the final desktop composition.
- Controlled runtime Hook events verified idle, running, waiting input, waiting choice, waiting permission, completed, interrupted, concurrent counts, terminal reset, SessionEnd cleanup, and continued named-pipe reception.
- The existing independent task `CodexPet 状态识别验收` (`01a06fcc-2463-77a2-a4ce-2b4641a2610b`, `gpt-5.6-sol`, low) previously reported 12/12 PASS on an earlier deployed build. A fresh final-candidate run executed through GUI shutdown, but that turn and a follow-up report request both returned empty task messages, so neither is counted as current independent acceptance evidence.

## Blocked externally

- Real failed-task detection: Codex hook currently exposes no reliable failed event or result field. Display mapping remains implemented but production detection is not claimed.
- The final candidate still needs a readable independent 12/12 report; the reused acceptance task currently completes with an empty result channel.
- Visual appearance and actual audio quality/volume require user acceptance. Automated checks cannot substitute for seeing and hearing the running pet.

## Remaining

- [x] Status aggregation and status card.
- [x] Simplified Live2D feedback and DPR rendering.
- [x] Audio, menu/settings, cleanup, and deployment.
- [ ] User visual/audio acceptance.
- [ ] Readable independent 12/12 status acceptance on the final deployed hash.

## Next step

Ask the user to inspect the final desktop screenshots and listen to the running pet. Reuse the existing independent acceptance task when its result channel is healthy; do not create a duplicate task.
