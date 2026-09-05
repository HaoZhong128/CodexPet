# CodexPet

这是我个人使用的 Windows Codex 桌宠。

运行 `G:\Codex code\CodexPet-runtime\CodexPet.exe`，并在使用 Codex 前先启动这个 GUI。程序启动时会自动配置自己的 Codex Hooks，同时保留其他 Hook。

状态语音放在 EXE 同目录的 `voice\idle`、`running`、`question`、`permission`、`completed` 或 `interrupted` 中，点击角色时播放的反馈语音放在 `voice\click` 中。每条语音必须使用同一文件名的 UTF-8 `.txt` 与 PCM16 单声道 `.wav`，例如 `question\01.txt` 和 `question\01.wav`。新增或替换语音后重启程序才会加载。

在桌宠上点击右键，可以切换默认/女仆服装和五种表情。
