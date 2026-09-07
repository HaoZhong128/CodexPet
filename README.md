# CodexPet

CodexPet 是一个面向 Windows 的 Codex Live2D 桌宠。它通过 Codex Hooks 接收任务状态，用角色动作、表情、气泡和可选语音提供反馈。

## 功能

- 显示空闲、运行、等待输入、等待选择、权限确认、完成、失败和中断等 Codex 状态。
- 根据状态驱动 Live2D 头部、眼睛、身体、头发、眨眼和呼吸反馈。
- 支持默认服装与女仆服装切换。
- 支持按状态播放本地 WAV 台词，也支持摸头反馈。
- 右键菜单可调整角色大小、音量、静音、状态面板、服装和窗口位置。

## 编译环境

本项目目前只构建 Windows x64 桌面程序。请先安装：

1. [Node.js LTS](https://nodejs.org/)（包含 npm）。
2. [Rust](https://www.rust-lang.org/tools/install)，使用默认的 MSVC 工具链。
3. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，安装时选择“使用 C++ 的桌面开发”。
4. [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。Windows 11 和多数较新的 Windows 10 通常已经安装。
5. Git（只有克隆仓库时需要）。

详细的 Windows 依赖说明可参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)。

## 克隆和生成 EXE

在 PowerShell 中运行：

```powershell
git clone https://github.com/HaoZhong128/CodexPet.git
cd CodexPet
powershell -ExecutionPolicy Bypass -File .\scripts\build-local.ps1
```

脚本会依次执行：

1. `npm ci` 安装锁定版本的前端依赖。
2. `npm test` 运行前端测试。
3. `npm run build` 生成前端资源。
4. `cargo test` 运行 Rust 测试。
5. 以 `tauri/custom-protocol` 特性编译 Release EXE。
6. 把最终文件复制到源码目录同级的 `CodexPet-runtime`。

默认产物是：

```text
父目录/
├─ CodexPet/                  # 源码
└─ CodexPet-runtime/
   ├─ CodexPet.exe
   └─ voice/                  # 自动创建各状态语音目录
```

也可以指定其他输出位置：

```powershell
.\scripts\build-local.ps1 -RuntimePath "D:\Apps\CodexPet-runtime"
```

## 运行

双击 `CodexPet-runtime\CodexPet.exe`。首次启动时，程序会把自己的 Hook 合并写入 `%USERPROFILE%\.codex\hooks.json`；已有的其他 Hook 会保留。程序移动到其他目录后，再启动一次即可刷新 Hook 中的 EXE 路径。

Live2D Cubism Core 由 Live2D 官方地址加载，因此显示角色时需要能够访问该地址。目标电脑还需要 WebView2 Runtime；缺少时可从上面的微软链接安装。

## 添加语音（可选）

源码仓库不包含运行时台词。构建脚本会在 `CodexPet-runtime\voice` 下创建这些目录：

```text
idle  running  waiting_input  waiting_choice  permission
completed  failed  interrupted  headpat
```

把同名的 `.wav` 和 UTF-8 `.txt` 文件成对放入对应目录，例如：

```text
voice\completed\01.wav
voice\completed\01.txt
```

TXT 内容会作为该语音对应的气泡台词。推荐使用 PCM 16-bit、单声道、32 kHz WAV。

## 更换 Live2D 虚拟形象

项目中的两套形象入口固定在 [src/app.ts](src/app.ts) 的 `MODELS`：

```text
默认形象：public/live2d/default/character-default.model3.json
女仆形象：public/live2d/maid/character-maid.model3.json
```

最简单、改动最少的方式是保留上述目录和入口文件名，只替换目录里的模型文件：

1. 从 Live2D Cubism 导出 Web 模型，准备 `.model3.json`、`.moc3`、纹理 PNG，以及模型需要的其他文件。
2. 把默认形象放进 `public/live2d/default`，或把第二套形象放进 `public/live2d/maid`。
3. 保留入口名 `character-default.model3.json` 或 `character-maid.model3.json`。如果 `.moc3`、纹理或其他文件改了名字，在 `.model3.json` 的 `FileReferences` 中写对相对路径。
4. 重新运行 `scripts\build-local.ps1`，模型会被打包进新的 EXE。

如果希望使用不同的入口文件名或增加更多服装，需要同时修改 [src/app.ts](src/app.ts) 中的 `Outfit`、`MODELS` 和 `OUTFITS`。

### 动作参数兼容

CodexPet 会尝试驱动以下常见参数：

```text
ParamAngleX/Y/Z       ParamBodyAngleX/Y/Z
ParamEyeBallX/Y       ParamEyeLOpen/ParamEyeROpen
ParamBrowL*/ParamBrowR*
ParamHairBack/Front/Side
ParamMouthOpenY       ParamBreath
```

新模型缺少某个参数时，该项动作会被跳过，模型仍可显示；参数越完整，状态动作越丰富。整体轻微缩放式呼吸不依赖模型内部的 `ParamBreath`。

### 表情兼容

状态系统使用这些表情名：

```text
auto_neutral  happy  angry  error
```

若要保留全部状态表情，请在新模型的 `.model3.json` 中用这些 `Name` 注册相应的 `.exp3.json`。现有模型还保留了 `sleepy` 表情，可继续沿用。没有对应表情时，角色仍可依靠参数动作反馈状态，但不会出现那套表情变化。

发布或分享替换后的模型前，请确认你拥有模型、纹理、表情和相关素材的使用及再分发权限。

## 源码结构

```text
src/                       # TypeScript 前端、状态展示与 Live2D 动画
src-tauri/                 # Rust 后端、Hooks、命名管道、音频和窗口控制
public/live2d/             # 当前 Live2D 模型与纹理
scripts/build-local.ps1    # 测试、Release 构建和运行目录整理
```

## 常见问题

- `npm` 找不到：安装 Node.js LTS 后重新打开 PowerShell。
- `cargo` 或 `rustc` 找不到：安装 Rust 后重新打开 PowerShell。
- Rust 链接失败或提示缺少 MSVC：在 Visual Studio Installer 中补装“使用 C++ 的桌面开发”。
- EXE 能启动但没有角色：检查网络是否能访问 Live2D Cubism Core，并确认 `.model3.json` 中的文件相对路径正确。
- 角色能显示但动作很少：检查新模型是否包含上面列出的标准参数 ID。
