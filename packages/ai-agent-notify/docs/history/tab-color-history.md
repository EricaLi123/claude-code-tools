# Windows Terminal Tab Color Development History

## 留档目的

- 记录 Windows Terminal tab 高亮为什么最后会变成现在这套方案。
- 记录哪些看起来更“官方”或更简单的路线已经被真实机器验证否决。
- 避免以后再次回到会污染输入、会误清颜色、或启动链不稳定的旧方案。

## 背景

这个通知工具需要在 Windows Terminal 多 Tab 场景下，既能提醒用户“有一个会话需要关注”，又能让用户在回到终端时快速定位到对应的 Tab。

窗口级通知已经有：

- Toast
- 任务栏闪烁

但这些只能定位到窗口，不能定位到同一窗口里的具体 Tab。因此后来引入了 Windows Terminal Tab 颜色提示。

## 目标

需要同时满足几件事：

1. Hook 触发时，目标 Tab 能变色。
2. 用户回到目标 Tab 后，颜色能自动恢复。
3. 不允许靠固定定时器自动清掉。
4. 不允许通过修改前台输入行、注入命令、打断用户交互来恢复颜色。
5. 同一 Windows Terminal 窗口里的其他 Tab 操作，不能误清掉目标 Tab 的颜色。

## 用户约束

这轮开发里，用户明确给过几条约束，最终方案必须服从：

- 不做纯定时自动恢复，因为用户可能离开电脑一段时间，回来还需要看到颜色提示。
- 不接受会污染当前输入行的方案。
- 不接受会影响当前终端交互的方案。
- 希望最终方案基于证据，不靠猜测。

## 最初可确认的事实

在排查前期，先通过日志和手工验证确认了几件事：

1. `shellPid` 最终可以拿对。
   手工 `echo $PID` 与日志里的目标 shell pid 可以对上。

2. 手工在前台 PowerShell 执行下面这句，可以恢复默认颜色：

   ```powershell
   $ESC = [char]0x1B
   Write-Host "$ESC]104;264$ESC\\" -NoNewline
   ```

3. `cli.js` 直接往当前进程 `stdout/stderr` 写 `OSC 4;264` 时，手工执行场景可以让当前 Tab 变色。

4. Windows Terminal 的 action / keybinding 路径在这台机器上不可靠。
   用户手工按过绑定热键，颜色也没有恢复。

这些事实非常重要，因为后面所有方案取舍都围绕它们展开。

## 尝试过但放弃的方案

### 1. Windows Terminal Action / Keybinding Reset

思路：

- 安装时往 WT `settings.json` 注入一个隐藏 action
- action 做 `setTabColor(null)`
- watcher 检测到用户回来后，通过热键触发这个 action

为什么看起来合理：

- 理论上是官方支持路径
- 不需要注入前台 shell 命令
- 不需要自己写 reset OSC

为什么放弃：

- 用户手工按快捷键都不能清掉颜色。
- 自动触发和手工触发都失败，说明不是“按键发送方式”的问题，而是这台机器上的 WT action 本身没有把 `OSC 4;264` 设出来的颜色清掉。

结论：

- `setTabColor(null)` 这条路在当前用户机器上不成立。
- 相关脚本最终被删除，不再保留为正式方案。

### 2. 前台 PowerShell 命令注入

思路：

- watcher 检测到用户回到目标窗口后
- 通过 `WScript.Shell.SendKeys` 等方式，往前台 PowerShell 输入一条极短命令
- 让前台 shell 自己输出 `OSC 104;264`

为什么一度尝试：

- 用户手工执行那条 PowerShell reset 命令是有效的
- 所以让前台 shell 自己执行，看起来是最短路径

为什么放弃：

- 这会污染当前输入行。
- 会影响用户正在进行的交互。
- 用户明确拒绝这类方案。

结论：

- 虽然有效，但违反交互约束，不能作为最终实现。

### 3. Node 直接 detached spawn watcher

思路：

- `cli.js` 直接 `spawn(..., detached: true)` 拉起 watcher
- 让 watcher 继承当前终端输出流
- `cli.js` 快速退出，watcher 在后台等用户回来

为什么一度看起来合理：

- 结构最简单
- 不需要额外 launcher
- 直觉上最容易保留原始终端输出流

为什么放弃：

- 日志里能看到 Node 拿到了 watcher pid，但对应 watcher 本身没有写出自己的 `started` 日志。
- 这说明在当前机器上，这条启动链并没有真正把 watcher 稳定拉起来。

结论：

- 当前用户机器上，Node 直接 detached child 不是稳定方案。

### 4. 仅用“前台窗口 + 系统最后输入时间”判定用户回来

思路：

- watcher 记录 `baselineForeground`
- watcher 记录 `baselineLastInputTick`
- 只要目标 WT 窗口重新成为前台，且系统最后输入时间变化了，就 reset

为什么一度采用：

- 旧版 watcher 对 console input 的焦点事件观察不稳定
- 纯系统级信号更容易拿到

为什么不够：

- 同一个 Windows Terminal 窗口里，tab2 的输入也会让系统 `last input tick` 变化。
- 于是会出现：
  tab1 触发 hook 变色，用户停留在 tab2 操作，tab1 却被误重置。

结论：

- 只能作为辅助信号，不能单独作为 reset 条件。

## 为什么最终还是回到“直接写 OSC”

真正决定方向的证据有两条：

1. 手工执行 reset OSC 有效。
2. `cli.js` 直接写 set-color OSC 有效。

这说明最可靠的通路不是：

- WT action
- 热键
- 前台命令注入

而是：

- 找到真正对应目标 Tab 的输出通道
- 直接写 OSC

所以最终实现，不再围绕“怎样让别的层帮我清颜色”，而是围绕“怎样稳定地写到目标 Tab 自己的 console/输出通道”来设计。

## 最终方案

### 设色

分两步：

1. `cli.js` 在当前 hook 进程里，先尝试往自己的 `stdout/stderr` 写 `OSC 4;264`。
   这对手工执行场景通常足够快。

2. 同时启动 watcher。
   watcher 启动后会：
   - `AttachConsole(shellPid)`
   - 打开 `CONOUT$`
   - 再写一遍 `OSC 4;264`

这样做的原因是：

- 手工执行时，当前进程标准流往往直接连着目标 Tab。
- 异步 hook 场景里，这个假设未必成立，所以 watcher 必须再从目标 console 兜底设色。

### watcher 启动方式

最终不是 Node detached child，也不是前台挂死的同步启动，而是：

- `cli.js`
  - `spawnSync` 调 `start-tab-color-watcher.ps1`
- `start-tab-color-watcher.ps1`
  - `Start-Process -NoNewWindow` 启动 `tab-color-watcher.ps1`

后来又补了一次修正：

- 不能再靠 launcher 的 `stdout` 把 watcher pid 回传给 Node
- 因为 watcher 会继承句柄，导致 `spawnSync` 卡住

所以现在改成：

- launcher 把 watcher pid 写到一个临时 pid 文件
- `cli.js` 读取 pid 文件
- launcher 本身的 stdio 走 `ignore`

这样手工执行不再卡住。

### reset 条件

最终 reset 不是“只要当前窗口回来就行”，而是同时满足：

1. 目标 WT 窗口重新成为前台
2. 系统最后输入时间发生变化
3. 目标 console 自己的 `CONIN$` 收到了新输入事件

这里第 3 条是关键修正。

它的作用是避免：

- tab1 变色
- 用户留在 tab2 输入
- tab1 被误 reset

因为 tab2 的输入不会出现在 tab1 这条 console 的 `CONIN$` 上。

### reset 执行方式

reset 也走双通道：

- 先尝试标准流
- 再尝试附着后的 `CONOUT$`

序列就是：

```text
ESC ] 104 ; 264 ESC \
```

也就是清掉 `FRAME_BACKGROUND` 的覆盖色。

## 当前实现的核心文件

- `bin/cli.js`
  负责读 hook、找 hwnd、找 shell pid、发通知、启动 watcher

- `scripts/get-shell-pid.ps1`
  优先从当前 console 自动识别交互 shell

- `scripts/find-hwnd.ps1`
  找窗口句柄，并提供父链回退的 shell pid

- `scripts/start-tab-color-watcher.ps1`
  用 `Start-Process -NoNewWindow` 启动 watcher，并通过 pid 文件回传 watcher pid

- `scripts/tab-color-watcher.ps1`
  真正负责：
  - attach 目标 console
  - 兜底设色
  - 等待目标 console 的返回输入
  - 自动 reset

## 这次开发里的关键教训

### 1. 不要把“理论上官方支持”误当成“在用户机器上真的有效”

`setTabColor(null)` 看起来是最正统的方案，但真实机器上手工触发都失败，就必须放弃。

### 2. 对这种终端/控制台问题，最重要的是先找“哪条通路真的生效”

这次真正有效的不是 action、不是注入，而是：

- 目标输出通道
- 直接写 OSC

一旦这个事实被确认，很多分叉都可以果断裁掉。

### 3. 用户约束不是“最后再考虑”，而是直接决定架构

如果忽视“不能影响交互”这个约束，前台命令注入其实早就可以“看起来解决问题”。

但那不是正确答案。

### 4. 同一窗口多 Tab 的问题，本质不是窗口级问题，而是 console 级问题

只看 foreground hwnd 会误判。
必须把“目标 console 自己有没有收到输入”纳入判定。

### 5. 进程启动链是否稳定，必须以日志为准

这次 `detached child` 和 `spawnSync + stdout pipe` 都不是拍脑袋推翻的，而是日志明确显示：

- watcher 没真正启动
- 或者父进程被子进程继承的管道句柄拖住

## 当前仍成立的设计边界

- 不做定时自动恢复
- 不修改前台输入行
- 不依赖 Windows Terminal action
- 仅在 Windows Terminal 下启用 tab 颜色 watcher

## 如果以后还要继续演进

几个可能的后续方向：

1. 进一步减少 watcher 日志量，保留更结构化的关键状态。
2. 如果要支持更多终端，需要重新评估是否存在对应的“Tab 级提示”能力。
3. 如果未来 Windows Terminal 对 `setTabColor(null)` 行为修复，可以重新评估是否要回归官方 action 路径，但前提仍然是用户机器上实测有效。

## 总结

这次演进的核心不是“找到一个能跑的 hack”，而是逐步收敛出一个满足用户约束、并且在真实机器上有证据支持的方案：

- 设色走目标输出通道
- 恢复不碰前台输入
- 判定必须下沉到目标 console
- 启动链以稳定性优先

最终形成的实现虽然比最初想象复杂，但每一步复杂度都来自真实问题，而不是过度设计。
