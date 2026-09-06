$ErrorActionPreference = 'Stop'
$runtime = 'G:\Codex code\CodexPet-runtime'

npm ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo test --manifest-path src-tauri\Cargo.toml
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
cargo build --release --manifest-path src-tauri\Cargo.toml --features tauri/custom-protocol
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
Copy-Item -LiteralPath 'src-tauri\target\release\codexpet.exe' -Destination "$runtime\CodexPet.exe" -Force
New-Item -ItemType Directory -Force -Path "$runtime\voice" | Out-Null
foreach ($category in 'idle','running','waiting_input','waiting_choice','permission','completed','failed','interrupted','headpat') {
    New-Item -ItemType Directory -Force -Path "$runtime\voice\$category" | Out-Null
}
