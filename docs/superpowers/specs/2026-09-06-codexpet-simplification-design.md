# CodexPet 简化与完善设计

日期：2026-09-06
状态：设计方向与书面设计均已获用户批准

## 1. 目标

将 CodexPet 收敛为一个个人使用的、简单稳定的 Windows 桌宠：

- 通过现有 Codex hook 和命名管道显示真实任务状态、真实运行数、等待数和运行时间。
- 使用紧凑状态卡、少量 Live2D 参数变化、气泡和语音提供状态反馈。
- 删除练剑、收剑、吃包子、打瞌睡、擦剑等复杂动作及其资源、台词、语音和恢复逻辑。
- 提供只在非透明角色区域触发的右键菜单，用于尺寸、音量、静音、状态卡、位置复位和退出。
- 修复高 DPI 下的 Live2D 模糊，不替换模型、纹理或 SDK。
- 保持源码和运行结构尽量小，不增加 app-server、内部数据库轮询、设置服务或兼容性框架。

## 2. 已确认的设计决策

### 2.1 稳定性优先

用户选择稳定性优先。实现允许为了稳定的音量、停止播放和防重叠能力，引入一个成熟的 Rust 音频播放依赖。依赖仅启用播放 PCM WAV 所需的最小功能；版本由 `Cargo.lock` 固定。

预计影响：

- `CodexPet.exe` 可能增加数百 KiB 到数 MiB。
- 删除现有复杂动作语音和道具后，完整运行目录预计仍会净减少约 3–4 MiB。
- 不增加常驻辅助进程。

### 2.2 hook-only 状态来源

生产状态只相信现有 Codex hook：

```text
Codex hook -> CodexPet.exe hook -> 命名管道 -> Rust StatusStore
             -> Tauri 状态事件 -> 状态卡 / Live2D / 气泡 / 语音
```

不增加：

- Codex app-server 后台进程。
- `state_5.sqlite`、`logs_2.sqlite` 或 rollout JSONL 轮询。
- 屏幕识别、窗口文字识别或 CUA。
- 根据普通助手文字猜测失败状态。

原因是 Windows 上独立 app-server 无法获得 Codex Desktop 已加载任务的实时状态，rollout 也不能覆盖所有失败路径。增加第二来源会提高复杂度，但仍不能证明所有失败均可识别。

### 2.3 真实失败状态的边界

Codex 当前 hook 没有 turn-failed 事件或成功/失败字段。因此：

- 保留 `failed` 的状态类型、视觉映射和台词/语音接口，便于未来接入真实事件。
- 生产代码不根据文本、超时或工具失败猜测 `failed`。
- 自动测试可以验证 `failed` 的纯展示映射，但这不算真实链路验收。
- `PROGRESS.md` 和最终验收必须把真实失败检测标为外部信号缺失，不能记录为 PASS。
- 在 Codex 提供可靠失败 hook 前，长期 Goal 不得因模拟测试而宣称全部完成。

## 3. 工作分解

实现按六个连续子项目推进。每一阶段都先增加失败测试，再做最小实现，并更新 `PROGRESS.md`。

1. 状态链路与聚合。
2. 状态卡、气泡和右键菜单。
3. Live2D 动作简化与高 DPI 渲染。
4. 台词、语音和音量控制。
5. 复杂资源与无用代码清理。
6. 构建、部署、真实状态和视觉交互验收。

这些阶段共用同一份状态模型，不另建事件总线、服务层或通用框架。

## 4. 状态模型

### 4.1 每个任务的内部状态

Rust 端按 `session_id` 保存活跃任务：

```text
Task {
  started_at_ms,
  phase: Running | WaitingInput | WaitingChoice | WaitingPermission
}
```

事件转换：

| hook 事件 | 条件 | 结果 |
|---|---|---|
| `UserPromptSubmit` | 有有效 `transcript_path` | 新建任务或恢复为 `Running` |
| `PreToolUse` | 工具是 `request_user_input`，无选项 | `WaitingInput` |
| `PreToolUse` | 工具是 `request_user_input`，有选项 | `WaitingChoice` |
| `PermissionRequest` | 当前任务存在 | `WaitingPermission` |
| `PostToolUse` | 对应等待操作完成 | 恢复为 `Running` |
| `Stop` | 当前任务存在 | 移除任务，候选终态为 `Completed` |
| `Interrupt` | 当前任务存在 | 移除任务，候选终态为 `Interrupted` |
| `SessionEnd` | 当前任务存在 | 静默移除并重新聚合 |

删除现有的“最终消息以问号结尾就算等待输入”规则。只有结构化的 `request_user_input` 才能产生 `WaitingInput` 或 `WaitingChoice`。

### 4.2 聚合状态和优先级

聚合优先级固定为：

```text
WaitingChoice / WaitingPermission / WaitingInput
  > Running
  > Failed / Interrupted 临时态
  > Completed 临时态
  > Idle
```

同一优先级内，`WaitingChoice` 优先于 `WaitingPermission`，后者优先于 `WaitingInput`，使状态卡能显示最具体的待处理事项。

计数含义：

- `running_count`：仅 `Running` 任务数。
- `waiting_count`：三个 Waiting 状态的任务数。
- `active_count`：两者之和，仅供内部或辅助显示。
- `active_since_ms`：所有活跃任务中最早的 `started_at_ms`。

状态卡不得把 `active_count` 标成“运行中”。

### 4.3 终态显示

- 只有在没有更高优先级活跃任务时，`Completed` 或 `Interrupted` 才作为短暂主状态显示。
- 新的运行或等待事件会立即覆盖终态。
- 终态显示结束后重新读取真实聚合状态；没有活跃任务时回到 `Idle`。
- 不为每个已完成子任务叠加队列或历史列表。

## 5. 前端状态卡和气泡

### 5.1 状态卡

状态卡包含：

- 名称 `CodexPet`。
- 状态圆点与状态名称。
- `运行 N` 和可选的 `等待你 M`。
- 从最早活跃任务开始计算的 `HH:MM:SS`。

颜色：

| 状态 | 颜色 |
|---|---|
| Idle | 灰蓝 |
| Running | 青蓝 |
| Waiting | 琥珀 |
| Completed | 绿色 |
| Failed | 红色 |
| Interrupted | 紫色 |

状态卡为紧凑半透明样式，不引入 UI 框架。状态卡和气泡均为 `pointer-events: none`，且不加入原生窗口可点击区域，因此不会扩大桌宠的点击范围。

### 5.2 气泡

- 气泡文本由当前状态或摸头交互决定。
- 同一状态且计数未发生有意义变化时，不重复显示和播放。
- 等待输入与等待选择使用不同文本。
- 状态气泡优先于空闲反馈；新的真实状态立即覆盖旧气泡。
- 气泡和语音来自同一台词条目；语音缺失时仍可显示文本，但不得播放其他状态的语音冒充。

## 6. Live2D 反馈

### 6.1 状态映射

使用现有模型、现有表情和现有参数：

| 状态 | 反馈 |
|---|---|
| Idle | 中性表情、呼吸、眨眼、极轻微摇摆 |
| Running | 专注表情，头部和身体运动幅度减小 |
| Waiting | 疑问或期待表情，轻微偏头 |
| Completed | 短暂开心表情，然后恢复真实状态 |
| Failed | 担忧表情，仅保留映射，不伪造触发 |
| Interrupted | 短暂惊讶，然后恢复真实状态 |
| Headpat | 开心或害羞的临时覆盖，结束后恢复当前真实状态 |

只使用“主状态 + 一个临时覆盖层”。不保留复杂有限状态机、动作中断栈、动作恢复点或道具同步。

### 6.2 空闲反馈

空闲时仅保留两种无语音轻反馈，例如轻微偏头和轻微侧看：

- 进入 Idle 后首次至少等待 45 秒。
- 后续间隔随机为 60–180 秒。
- 不连续重复同一种反馈。
- 离开 Idle 立即取消计时器和当前空闲反馈。
- 呼吸和眨眼是持续基础行为，不计入随机反馈。

### 6.3 删除的动作

删除或停用：

- 练剑、挥剑、收剑。
- 吃包子。
- 打瞌睡及睡眠气泡。
- 擦剑。
- 道具跟随、武器角度和复杂姿态参数。
- 上述动作的中断、恢复、重入和定时语音逻辑。

`public/live2d/props/` 中只服务于这些动作的资源全部删除。

## 7. 高 DPI 渲染

### 7.1 渲染策略

- Pixi 初始化使用 `resolution: window.devicePixelRatio`、`autoDensity: true` 和抗锯齿。
- CSS 尺寸表示逻辑窗口大小；Canvas backing store 使用逻辑尺寸乘以 DPR。
- 窗口或尺寸档变化时，调用 renderer resize 并重新计算模型缩放和位置。
- 不通过 CSS 放大低分辨率 Canvas。
- 原生点击遮罩继续在逻辑分辨率生成，避免高 DPI 使点击测试和 CPU 成本成倍增加。

### 7.2 素材边界

现有主要纹理为 2048×2048，对当前 400×560 窗口足够。除非实际截图证明纹理本身是瓶颈，否则：

- 不放大或重绘纹理。
- 不修改 `.moc3`、模型布局、表情 JSON 或 Live2D SDK。
- 不增加动态质量档位、滤镜链或多套纹理。

## 8. 右键菜单与交互优先级

### 8.1 打开范围

- 只有鼠标位于 Live2D 非透明角色像素上并按右键时打开菜单。
- 状态卡、气泡和透明窗口区域不打开菜单。
- 右键不触发摸头、拖动、表情、动作、气泡或语音。

### 8.2 菜单内容

- 尺寸：75%、100%、125%。
- 音量：0–100 滑块。
- 静音切换。
- 状态卡显示/隐藏。
- 复位到主显示器工作区右下角。
- 退出 CodexPet。

菜单行为：

- 在窗口边缘内钳制位置。
- Escape 或点击菜单外关闭。
- 操作音量滑块时保持打开。
- 菜单打开时加入原生窗口点击区域；关闭后移除。
- 不引入 UI 框架。

### 8.3 左键与拖动

交互优先级固定为：

```text
菜单控件 > 右键菜单 > 拖动 > 摸头
```

左键按下先记录位置；移动超过小阈值后启动原生窗口拖动并取消摸头；未移动的短点击在抬起时触发摸头。这样一次操作不会同时拖动和摸头。

## 9. 尺寸、位置和设置

基准逻辑窗口为 400×560：

- 75%：300×420。
- 100%：400×560。
- 125%：500×700。

调整尺寸时同时更新窗口、Canvas、Live2D viewport、状态卡和气泡比例，不拉伸旧画面。调整后把窗口限制在当前显示器工作区内；复位命令把窗口放到主显示器工作区右下角。

仅用一个 localStorage JSON 保存：

```text
size, volume, muted, status_panel_visible
```

不增加设置文件、迁移、校验和、哈希或设置服务。Tauri capability 只补充前端实际需要的 `set-size` 和 `set-position` 权限。

## 10. 音频和台词

### 10.1 播放器

Rust 端保留一个 `AudioPlayer`：

- 同一时间只有一个播放实例。
- 新状态或摸头播放前停止旧语音。
- 音量修改立即作用于当前播放和后续播放。
- 静音记住用户原来的非零音量。
- 滑块调到 0 自动进入静音；从 0 调高自动解除静音。
- 播放失败只记录简短错误，不增加重试队列或备用播放器。

### 10.2 台词库

保留小型目录式 TXT/WAV 配对，不增加数据库或复杂 manifest：

- idle
- running
- waiting_input
- waiting_choice
- permission
- completed
- interrupted
- failed（仅准备映射，当前无真实触发）
- headpat

先复用措辞匹配的现有语音。确实缺少的条目才发送给现有 `语音包` 任务，继续使用已经验证的 GPT-SoVITS 模型、参考音频和参数。该任务只生成语音，不修改源码、配置或 Git。

删除或停用动作目录中除摸头以外的类别，并删除剑相关旧 click 台词；不保留无生产引用的语音调度测试。

## 11. 源码清理边界

预计处理：

- 移除 `src/action-voice.ts` 及只验证已取消动作的测试。
- 将 `src/motion.ts` 收敛为基础呼吸/眨眼、状态参数、两种 Idle 反馈和 Headpat 覆盖。
- 从 `src/app.ts` 删除武器、道具和复杂动作调度 DOM/逻辑。
- 从 `src/styles.css` 删除武器、道具和已取消动画样式。
- 删除 `public/live2d/props/`。
- 从 Rust voice loader 删除旧 action/click 类别引用，保留状态和 Headpat。

不做：

- 不顺手重构无关文件。
- 不删除正常的 `HashMap`。
- 不删除 `package-lock.json` 或 `Cargo.lock` 中标准的完整性字段。
- 不清理 `target`、`node_modules`、模型工具或用户其他目录。
- 不覆盖当前工作树中与目标无关的用户修改。

## 12. 测试和验收

### 12.1 自动测试

前端测试至少覆盖：

- 状态卡标签、颜色、运行数、等待数和运行时间。
- 等待输入与等待选择不混淆。
- 终态不覆盖仍在运行或等待的任务。
- 状态重复时不重复气泡和语音。
- Idle 首次延迟、60–180 秒区间、非连续重复和离开 Idle 取消。
- Headpat 结束后恢复当前真实状态。
- 右键不触发拖动或摸头。
- 菜单边缘钳制、Escape/外部关闭、滑块保持打开。
- 设置读取、写入和 75/100/125 尺寸。
- DPR 到 Pixi resolution 和 Canvas backing store 的映射。

Rust 测试至少覆盖：

- 0、1、2 个 Running 任务。
- WaitingInput、WaitingChoice、WaitingPermission 及恢复。
- 真实 `running_count` 和 `waiting_count`。
- Completed/Interrupted 的聚合优先级和 Idle 恢复。
- 未知或重复终止事件不产生错误终态。
- AudioPlayer 的音量、静音和停止状态，不要求单元测试实际声卡输出。

### 12.2 构建与部署

依次运行：

```text
npm test
npm run build
cargo test
cargo build --release --features tauri/custom-protocol
```

运行中的 `CodexPet.exe` 会占用固定命名管道，因此完整 Rust 测试前先正常退出桌宠。release 构建完成后再复制到 `G:\Codex code\CodexPet-runtime` 并启动；不得使用旧 EXE 做验收。

### 12.3 真实状态验收

复用现有 `CodexPet 状态识别验收` 测试任务，不创建重复任务。测试任务使用 `gpt-5.6-sol`、low reasoning，只测试和报告，不修改源码、配置或 Git。

真实验收包括：

- 0、1、2 个运行任务。
- 等待文字输入。
- 等待选项选择。
- 权限等待及恢复。
- 正常完成。
- 中断。
- 回到 Idle。
- 运行数、等待数和计时正确。
- 气泡不重复，终态后表情恢复。

真实 `failed` 因 Codex hook 缺少信号记录为 BLOCKED，不用模拟结果替代。

### 12.4 视觉和交互验收

- 使用当前允许的只读 WebView2 CDP 或等价现有渲染环境取得截图；不使用 CUA。
- 比较修改前后 75%、100%、125% 的脸部、眼睛、嘴、轮廓和文字清晰度。
- 检查尺寸切换无低分辨率拉伸、无明显抖动或跳位。
- 检查透明区域点击穿透、角色区域拖动/摸头、右键菜单和状态卡非交互区域。
- 记录截图路径、结论和仍需用户肉眼确认的项目到 `PROGRESS.md`。
- `npm run build` 通过不能替代视觉验收。

## 13. 完成标准

满足以下条件才算实现阶段完成：

- 所有未被外部 Codex 信号阻塞的显式需求都有代码和对应验证证据。
- 前端测试、Rust 测试、release 构建均通过。
- runtime 使用本次构建的 EXE 并能正常加载 `tauri.localhost`。
- 真实状态验收除 `failed` 外逐项 PASS。
- 视觉与交互已实际运行检查，并获得用户对最终效果的确认。
- `PROGRESS.md` 记录已完成项、证据、体积变化和 `failed` 阻塞。
- Git 状态确认没有夹带与本目标无关的修改。

长期 Goal 只有在真实 `failed` 也有可靠信号并完成验收后才能标记为完全完成；在此之前保持外部阻塞说明。
