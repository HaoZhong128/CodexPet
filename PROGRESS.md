# CodexPet Long Goal Progress

Updated: 2026-09-06

## Current architecture

Codex hook -> CodexPet.exe hook -> named pipe -> Rust StatusStore -> Tauri status event -> status card / Live2D / bubble / voice.

## Completed

- [x] Design approved.
- [x] Three implementation plans approved.
- [x] Baseline verified in the current checkout.
- [x] Phase 1: structured waiting detection, concurrent aggregation, duplicate suppression, and compact status card.

## Verification evidence

- Baseline frontend tests: 6 files / 25 tests PASS.
- Baseline Rust tests after exiting the runtime that owned the named pipe: 33 library tests + 3 integration tests PASS.
- Phase 1 frontend tests: 6 files / 29 tests PASS.
- Phase 1 Rust tests: 37 library tests + 3 integration tests PASS.
- Phase 1 production frontend build: PASS; the existing Vite large-chunk warning remains non-blocking and is unrelated to this scope.
- Status source remains the Codex hook and named pipe. Waiting priority is Choice > Permission > Input > Running; terminal feedback cannot mask other active work.

## Blocked externally

- Real failed-task detection: Codex hook currently exposes no reliable failed event or result field. Display mapping remains implemented but production detection is not claimed.

## Remaining

- [x] Status aggregation and status card.
- [ ] Simplified Live2D feedback and DPR rendering.
- [ ] Audio, menu/settings, cleanup, deployment, and real acceptance.

## Next step

Execute `docs/superpowers/plans/2026-09-06-codexpet-live2d-rendering.md`.
