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

## Blocked externally

- Real failed-task detection: Codex hook currently exposes no reliable failed event or result field. Display mapping remains implemented but production detection is not claimed.

## Remaining

- [x] Status aggregation and status card.
- [x] Simplified Live2D feedback and DPR rendering.
- [ ] Audio, menu/settings, cleanup, deployment, and real acceptance.

## Next step

Execute `docs/superpowers/plans/2026-09-06-codexpet-audio-menu-cleanup.md`.
