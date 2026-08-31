# CodexPet Implementation Roadmap

> **For agentic workers:** Execute the four linked plans in order. Each plan requires superpowers:subagent-driven-development (recommended) or superpowers:executing-plans and contains its own test/commit gates.

**Goal:** Deliver the approved Windows Codex desktop pet without coupling status integration, character rendering, voice inference, and release hardening into one untestable change.

**Architecture:** Plan 01 establishes the privacy-safe state core and a static status UI. Plan 02 builds the real pet and Live2D layer, Plan 03 adds optional GPT-SoVITS speech, and Plan 04 verifies failure behavior and packages the Windows release.

**Tech Stack:** Tauri 2, Rust, vanilla TypeScript, WebView2, Live2D Cubism SDK for Web, GPT-SoVITS v2Pro

**Spec:** `docs/superpowers/specs/2026-08-31-codex-desktop-pet-design.md`

## Execution Order

1. [`2026-08-31-01-status-bridge-core.md`](./2026-08-31-01-status-bridge-core.md)
   - Deliverable: Codex Hooks/notify → named pipe → Rust aggregate → static Tauri status view.
   - Gate: real privacy-safe event changes the view within one second; duplicate completion speaks zero times because voice is not yet present and updates state only once.
2. [`2026-08-31-02-pet-ui-live2d.md`](./2026-08-31-02-pet-ui-live2d.md)
   - Deliverable: transparent pet window, task UI, settings, interactions, fallback image, and one two-outfit Live2D model.
   - Gate: every state works with Live2D and with the model deliberately unavailable.
3. [`2026-08-31-03-gpt-sovits-voice.md`](./2026-08-31-03-gpt-sovits-voice.md)
   - Deliverable: local v2Pro speech with lazy lifecycle, cache, priority, merge, cooldown, DND, and bubble fallback.
   - Gate: a cold model failure never blocks the bubble; warm speech, interruption, and 10-minute shutdown pass.
4. [`2026-08-31-04-windows-hardening-release.md`](./2026-08-31-04-windows-hardening-release.md)
   - Deliverable: real Desktop/CLI/IDE validation, fault matrix, performance evidence, verified Windows installer, and recovery guide.
   - Gate: clean-profile checklist passes and the installer contains no user model, voice, source-art, or Codex data.

## Requirement Coverage

| Design requirement | Owning plan |
| --- | --- |
| Codex Desktop/CLI/IDE state, privacy, multi-task priority, timing | 01, verified in 04 |
| Waiting confirmation, result windows, event deduplication | 01 |
| Transparent desktop pet, right-click menu, task details, settings, tray | 02 |
| Petting, poking, random lines, action/line cooldown | 02 |
| Default/maid outfit, expressions, Live2D motions, static fallback | 02 |
| GPT-SoVITS v2Pro, lazy start, cache, DND, voice deduplication | 03 |
| Completion merging and permission interruption | 03 |
| Fault recovery, current Codex validation, resource measurement, installer | 04 |

## Scope Boundaries

- Do not start Plan 02 until Plan 01 has a passing real-event smoke test.
- Do not block Plan 02 on final voice quality; voice begins only in Plan 03.
- Do not bundle the GPT-SoVITS archive, extracted weights, reference audio, editable PSD, Cubism source project, or restricted SDK files. Keep editable PSD/`.cmo3` sources in Git LFS; never put them in the installer.
- If current Codex event payloads cannot reliably distinguish failure/cancellation, keep the safe fallback documented in the design rather than inferring from transcript content.
