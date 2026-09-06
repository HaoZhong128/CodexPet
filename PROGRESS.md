# CodexPet Long Goal Progress

Updated: 2026-09-06

## Current architecture

Codex hook -> CodexPet.exe hook -> named pipe -> Rust StatusStore -> Tauri status event -> status card / Live2D / bubble / voice.

## Completed

- [x] Design approved.
- [x] Three implementation plans approved.
- [x] Baseline verified in the current checkout.

## Verification evidence

- Baseline frontend tests: 6 files / 25 tests PASS.
- Baseline Rust tests after exiting the runtime that owned the named pipe: 33 library tests + 3 integration tests PASS.

## Blocked externally

- Real failed-task detection: Codex hook currently exposes no reliable failed event or result field. Display mapping remains implemented but production detection is not claimed.

## Remaining

- [ ] Status aggregation and status card.
- [ ] Simplified Live2D feedback and DPR rendering.
- [ ] Audio, menu/settings, cleanup, deployment, and real acceptance.

## Next step

Execute `docs/superpowers/plans/2026-09-06-codexpet-status-ui.md`.
