# CodexPet 三个任务完成记录

> 本文件记录语音、Live2D 微调、实时状态修复与最终冻结结果。三个任务均已完成；新对话可先读本文件快速了解本轮改动。

## 当前进度（2026-09-05）

| 工作项 | 状态 | 当前证据 |
|---|---|---|
| 任务 1：正式语音包 | **已完成** | 六个状态各 2 组、点击反馈 11 组，共 23 组 `.txt + .wav` |
| 任务 2：Live2D 观感微调 | **已完成** | 两套模型、纹理、五种表情和布局已更新；沮丧表情已加入双眼泪珠 |
| 补充任务：实时状态修复 | **已完成** | 独立验收 `12/12 PASS`；runtime EXE 可独立加载并接收 Hook |
| 任务 3：最终构建并冻结 | **已完成** | 前端 `8/8`、Rust `28/28`，已部署 EXE 并清理全部生成目录 |

本轮源码、Live2D 素材、点击语音接口、实时状态修复和本记录由最终提交统一入库。正式语音、模型权重、GPT-SoVITS、runtime 和构建缓存均位于 Git 仓库之外或已被清理。

最终构建的 `CodexPet.exe` 可以独立加载内嵌前端。构建时 release 与 runtime EXE 的 SHA-256 均为：

```text
43EC4DCE631B451BBBE03823632845A9234F3A74E494EE661DB28A03A345DD16
```

**目标：** 在不扩展软件架构的前提下，补齐正式语音、按实际观感微调 Live2D，最后重新构建并冻结这个个人使用版本。此目标已完成。

**完成后的能力：** 程序具备 Live2D 两套服装、五种表情、基础 CSS 动作、Codex Hooks 状态、活跃任务数量、运行时间、气泡、外置 WAV 播放和点击语音接口。

**技术结构：** 前端使用 TypeScript、Vite、PixiJS 和 Live2D；桌面程序使用 Tauri/Rust。语音由应用项目之外的 GPT-SoVITS 生成，运行时只读取 EXE 同目录的配对 `.txt + .wav`。

## 全局约束

- 这是个人自用软件，不开发安装器、发布包、自动更新、设置页、托盘、数据库、诊断页或日志平台。
- 不重写状态系统，不改变 Codex Hook 协议。
- `request_user_input` 已映射为 `waiting_choice`，不属于 `interrupted`。
- 不增加 Live2D `motion3` 系统；基础动作继续使用整个画布的 CSS 动画。
- 不添加静态 PNG 降级显示。
- 不修改 `C:\Users\A\.codex\config.toml`。
- 不删除现有自动测试，但本计划不增加单独的状态验收阶段或长期稳定性测试阶段。
- 任务 1 和任务 2 执行期间都不要提交 Git；统一由任务 3 处理最终提交。

## 关键路径

```text
应用源码：G:\Codex code\CodexPet
运行目录：G:\Codex code\CodexPet-runtime
外部素材：G:\Codex code\CodexPet-assets
语音生成器：G:\Codex code\CodexPet-assets\GPT-SoVITS-v2pro-20250604-nvidia50
语音权重：G:\Codex code\CodexPet-assets\人物语音参数
Live2D 源工程：G:\Codex code\CodexPet-assets\live2d-source
```

## 并行关系

```text
窗口 A：任务 1 正式语音 ─┐
                         ├─→ 任务 3 构建与冻结
窗口 B：任务 2 Live2D ───┘
```

- 任务 1 只操作外部素材目录和 runtime 的 `voice`，不改 Git 仓库。
- 任务 2 只修改 Git 仓库中的 Live2D 前端观感文件，不改语音目录。
- `scripts\build-local.ps1` 复制 EXE 时不会删除或覆盖 `runtime\voice`，因此任务 2 的构建不会破坏任务 1 的结果。
- 两个窗口不要同时编辑本文件。

---

## 任务 1：制作正式语音包

**负责窗口：** 窗口 A

**当前状态：已完成。** 已使用指定 GPT-SoVITS 模型和确认后的参考音频生成正式语音。六个 Codex 状态各 2 组，点击反馈 11 组，共 23 组同 stem 的 `.txt + .wav`，已部署到 runtime。

**目标：** 使用独立 GPT-SoVITS 模型生成首批 12 条正式语音，每个状态 2 条；气泡文本与音频保持同名配对。

**允许操作：**

- `G:\Codex code\CodexPet-assets\GPT-SoVITS-v2pro-20250604-nvidia50\`
- `G:\Codex code\CodexPet-assets\人物语音参数\`
- `G:\Codex code\CodexPet-assets\voice-pack-work\`，作为生成暂存目录
- `G:\Codex code\CodexPet-runtime\voice\`

**禁止操作：** 不修改 `G:\Codex code\CodexPet\src`、`src-tauri`、`public` 或构建配置。

**现有模型文件：**

```text
chenqianyu-v2p_e10_s150.pth
chenqianyu-v2p-e20.ckpt
```

生成过程和参考素材保存在 `G:\Codex code\CodexPet-assets\voice-pack-work\`，不进入 Git 仓库。

### 状态目录与首批台词

| 目录 | 程序状态 | `01.txt` | `02.txt` |
|---|---|---|---|
| `idle` | 空闲 | 我在这里，随时可以开始。 | 准备好了，今天也一起加油吧。 |
| `running` | 正在工作 | 正在处理，请稍等一下。 | 我还在工作，很快就好。 |
| `question` | 等待用户选择 | 这里需要你做一个选择。 | 请看看选项，告诉我你的决定。 |
| `permission` | 等待权限确认 | 这一步需要你的授权。 | 请确认是否允许继续。 |
| `completed` | 正常完成 | 任务完成了。 | 处理完毕，可以查看结果了。 |
| `interrupted` | 真正中断 | 任务已经中断。 | 这次操作没有继续执行。 |

如果用户在窗口 A 中要求调整语气，以用户确认后的台词替换本表；目录映射不变。

### 执行步骤

- [x] 确认 GPT-SoVITS 实际程序根目录、启动方式、两份权重分别对应的 SoVITS/GPT 槽位和所需参考音频。
- [x] 在 `G:\Codex code\CodexPet-assets\voice-pack-work\` 下创建生成暂存目录。
- [x] 使用同一套已确认的角色模型与推理参数生成六个状态共 12 条语音。
- [x] 额外生成 11 条点击反馈语音并放入独立的 `click` 目录。
- [x] 将输出统一为 PCM16、32 kHz、单声道、16-bit WAV。
- [x] 将气泡台词以 UTF-8 保存为同目录同名 `.txt`。
- [x] 确认 23 组文件全部成对，不存在孤立 `.txt` 或 `.wav`。
- [x] 将完成的目录部署到 `G:\Codex code\CodexPet-runtime\voice\`。
- [x] 关闭并重新启动 `G:\Codex code\CodexPet-runtime\CodexPet.exe`，确认新语音目录可被加载。

### 完成标准

- runtime 六个状态目录各有 `01.txt + 01.wav`、`02.txt + 02.wav`，`click` 目录有 11 组配对。
- `.txt` 是对应气泡文字，`.wav` 是对应台词，stem 完全相同。
- 所有 23 个 WAV 均为 PCM16、32 kHz、单声道、16-bit。
- 语音使用指定角色权重生成，不使用测试音频或临时静音文件。
- Git 仓库保持不变。

### 给窗口 A 的开场提示

```text
请先完整阅读 G:\Codex code\CodexPet\NEXT_TASKS.md，然后只执行“任务 1：制作正式语音包”。不要修改应用源码，不要执行任务 2 或任务 3。现有权重已经列在文件中；若推理所需的角色参考音频确实缺失，只向我询问这一个输入。
```

---

## 任务 2：Live2D 观感微调

**负责窗口：** 窗口 B

**当前状态：已完成。** 两套服装运行模型与纹理已经更新，五种表情已经重新调整；用户追加要求的沮丧表情已按参考图加入浅蓝泪珠和白色高光。修复后的源素材副本保存在 `G:\Codex code\CodexPet-assets\live2d-source\repaired-runtime\`。

**目标：** 保持现有功能和极简结构，只处理实际可见的缩放、位置、遮挡和动作幅度问题。当前观感已经合适时，允许不修改代码。

**优先允许修改：**

- `G:\Codex code\CodexPet\src\styles.css`：角色区域、气泡、HUD、菜单与 CSS 动作。
- `G:\Codex code\CodexPet\src\live2d.ts`：只有两套模型确实需要不同缩放或位置时才修改。
- `G:\Codex code\CodexPet\src\app.ts`：只有右键菜单或点击反馈确实存在观感问题时才修改。

**不要修改：**

- `src-tauri\src\bridge.rs`、`hooks.rs`、`voice.rs` 和任何状态逻辑。
- `public\live2d` 中的运行模型，除非用户明确要求替换素材。
- `G:\Codex code\CodexPet-runtime\voice\`。
- 依赖、Tauri 配置和构建架构。

### 当前界面行为

- 默认窗口为透明、无边框、置顶桌宠。
- 右键菜单可选择默认服装、女仆服装和五个表情：中性、开心、生气、困倦、出错。
- 气泡位于顶部，HUD 位于右下角。
- 状态动作全部定义在 `src\styles.css`：呼吸、工作摇摆、等待提醒、完成庆祝、中断晃动和点击反馈。
- 两套服装当前共用自动居中缩放逻辑，缩放系数为 `0.98`。

### 执行步骤

- [x] 运行 `npm ci`，然后运行 `npm run desktop:dev` 打开当前桌宠。
- [x] 查看默认服装和女仆服装，以及五种表情和当前基础动作。
- [x] 向用户展示当前效果并确认需要调整的具体观感；不要根据想象新增功能。
- [x] 优先只修改 `src\styles.css` 中能够解决问题的最少数值。
- [x] 只有 CSS 无法解决两套服装差异时，才在 `src\live2d.ts` 中硬编码两套模型各自的缩放或位置；不增加设置项或配置文件。
- [x] 运行 `npm run build`，确认前端可以构建。
- [x] 再次打开桌宠确认用户指定的观感修改已生效。
- [x] 保留修改但不要提交 Git，并向用户列出实际修改的文件。

### 完成标准

- 默认与女仆服装都能完整显示，没有明显裁切或偏离窗口。
- 气泡不遮住角色主要面部，HUD 不遮挡关键服装区域。
- 六类 CSS 动作幅度自然，不影响阅读气泡和 HUD。
- 右键菜单在窗口边缘不会被截断。
- 没有新增 motion3、设置页、配置层或兼容分支。
- 没有改动状态、Hook、语音或 runtime 文件。

### 给窗口 B 的开场提示

```text
请先完整阅读 G:\Codex code\CodexPet\NEXT_TASKS.md，然后只执行“任务 2：Live2D 观感微调”。先打开当前桌宠让我确认希望调整的视觉问题，再做最少修改。不要修改状态、Hook、语音系统，不要执行任务 1 或任务 3，也不要提交 Git。
```

---

## 补充完成任务：修复实时 Codex 状态

**当前状态：已完成。**

发现 runtime EXE 曾错误加载开发地址 `http://localhost:1420/`，导致没有开发服务器时前端为空，表现为桌宠无法实时显示状态。根因是 release 构建未启用 Tauri 的 `custom-protocol` feature。

已完成：

- [x] 将 `scripts\build-local.ps1` 的 release 构建改为启用 `tauri/custom-protocol`。
- [x] 重新构建并部署 `G:\Codex code\CodexPet-runtime\CodexPet.exe`。
- [x] 确认 runtime EXE 独立加载 `http://tauri.localhost/`，不再依赖 Vite 1420 端口。
- [x] 确认 `C:\Users\A\.codex\hooks.json` 的八类事件各有且只有一个 CodexPet handler。
- [x] 确认 Hook 命令均指向 `G:\Codex code\CodexPet-runtime\CodexPet.exe hook`。
- [x] 当前项目在 `C:\Users\A\.codex\config.toml` 中为 `trust_level = "trusted"`。
- [x] 独立测试任务使用 `gpt-5.6-sol`、`low` 完成修复后复测。
- [x] 十二项状态验收最终 `12/12 PASS`：idle、running、waiting_choice、choice 恢复、waiting_permission、permission 恢复、completed、interrupted、SessionEnd、三会话并发、连续事件、无 GUI Hook 退出。
- [x] 前端自动测试记录为 `8/8 PASS`，Rust 自动测试记录为 `28/28 PASS`。

独立验收任务：

```text
名称：CodexPet 状态识别验收
任务 ID：01a06fcc-2463-77a2-a4ce-2b4641a2610b
模型：gpt-5.6-sol
推理强度：low
```

最终冻结前已关闭桌宠并重新运行完整测试，前端为 `8/8 PASS`，Rust 为 `28/28 PASS`。随后启动最终 runtime EXE，进程保持运行且 `codexpet-status` 命名管道连接成功。

---

## 任务 3：最终构建并冻结结构

**当前状态：已完成。** 任务 1 的正式语音已进入 runtime，任务 2 的源码修改已纳入最终构建，生成目录已经清理。

**目标：** 将最终前端修改构建进 EXE，保留正式语音，清理可再生目录并形成一个最终提交。这里不重新加入已取消的状态链路测试或长期使用测试阶段。

### 执行步骤

- [x] 检查 `git status --short`，确认仓库改动只属于点击语音接口、Live2D 调整、实时状态修复和本进度文档。
- [x] 检查 runtime 七个语音目录，确认每个 `.txt` 都有同 stem `.wav`，每个 `.wav` 也有同 stem `.txt`。
- [x] 关闭正在运行的 CodexPet，避免命名管道占用测试资源或 EXE 被 Windows 占用。
- [x] 运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-local.ps1`，并修复 release 内嵌前端构建参数。
- [x] 正式语音生成后再次运行完整构建流程；前端 `8/8 PASS`，Rust `28/28 PASS`，release 构建成功。
- [x] 启动 `G:\Codex code\CodexPet-runtime\CodexPet.exe`，确认最终程序保持运行且命名管道可连接。
- [x] 关闭程序后，删除 `node_modules`、`dist`、`src-tauri\target`、`src-tauri\gen` 和误落入仓库的 `tools` 模型目录。
- [x] 再次运行 `git status --short`，确认没有模型权重、生成语音、构建缓存或 runtime 文件进入仓库。
- [x] 暂存本进度文档、点击语音接口、Live2D 调整和实时状态修复的最终源码改动，并由本轮收尾创建最终提交。

### 最终结构

```text
G:\Codex code\CodexPet-runtime\
├── CodexPet.exe
└── voice\
    ├── idle\
    ├── running\
    ├── question\
    ├── permission\
    ├── completed\
    ├── interrupted\
    └── click\
```

### 完成标准

- [x] runtime 只有一个 EXE 和正式语音目录；六个状态目录各 2 组，`click` 目录 11 组，共 23 组。
- [x] 应用源码仍保持当前极简结构，新增内容只服务点击反馈、Live2D 和状态修复。
- [x] 正式语音、模型权重、GPT-SoVITS 和构建缓存均不进入 Git。
- [x] 最终提交由本轮收尾创建；具体提交号以 `git log -1` 为准。
- [x] 此后只替换 Live2D 素材和语音内容，不继续扩展软件功能。

### 给最终窗口的开场提示

```text
请先完整阅读 G:\Codex code\CodexPet\NEXT_TASKS.md。本轮三个任务已经完成；如需继续开发，先检查当前 Git 状态和 runtime，再提出一个新的、最小范围任务。
```
