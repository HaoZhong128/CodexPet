# CodexPet

个人使用的 Windows Codex Live2D 桌宠。

## 最终目录

- `G:\Codex code\CodexPet`：完整项目源码。
- `G:\Codex code\CodexPet-runtime`：可独立运行的软件，包含 `CodexPet.exe` 和运行时语音。

## 生成 EXE

在源码目录运行：

```powershell
.\scripts\build-local.ps1
```

脚本会安装依赖、运行前端和 Rust 测试、生成正式版本，并把最终 EXE 复制到独立运行目录。

## 使用

运行 `G:\Codex code\CodexPet-runtime\CodexPet.exe`。程序启动时会配置自己的 Codex Hooks，同时保留其他 Hook。

Live2D 模型和纹理位于源码目录的 `public\live2d`。运行时语音位于独立运行目录的 `voice`，按状态分为 `idle`、`running`、`waiting_input`、`waiting_choice`、`permission`、`completed`、`failed`、`interrupted` 和 `headpat`。

右键点击角色可调整大小和音量、静音、显示或隐藏状态面板、切换服装、重置位置或退出程序。
