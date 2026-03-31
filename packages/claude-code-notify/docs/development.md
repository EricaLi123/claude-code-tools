# 开发说明

README 只保留安装、配置、常用命令和面向使用者的限制说明；内部实现、信号来源、误报抑制、定位链路和设计取舍统一记录在这里。

## 当前结论

- completion 通知继续走顶层 `notify` 直达；approval 仍然是单独链路。
- `codex-session-watch` 负责 approval 检测，`codex-mcp-sidecar` 负责启动期 terminal 线索与 watcher 兜底拉起。
- Windows 平台实现细节、wrapper 行为和 tab 高亮实现单独记录在 [`windows-runtime.md`](./windows-runtime.md)。
- 带日期、带机器环境前提、带排障过程的材料统一归档到 [`history/`](./history/)。

## 架构速览

```text
Completion:
  Claude hook / Codex legacy notify
    → bin/cli.js
      → detectTerminalContext()
      → notify.ps1
      → Windows Terminal tab watcher (when applicable)

Approval:
  Codex session start
    → codex-mcp-sidecar
      → record startup terminal context
      → ensure codex-session-watch is running
  Later approval event
    → codex-session-watch
      → read rollout / codex-tui.log
      → optionally reuse sidecar terminal mapping
      → notify.ps1
```

## 提醒 + 定位的职责拆分

- completion 不走 sidecar 这条链；它只依赖 `notify` 触发当场的 terminal context。
- approval 的“检测”和“定位”故意分开：watcher 负责看到 approval，sidecar 负责补回原始 terminal / tab 身份。

## 文档导航

### 活跃设计文档

- [架构与职责边界](./architecture.md)
- [Codex approval 检测与定位](./codex-approval.md)
- [Windows 运行时与通知实现](./windows-runtime.md)

### 历史与实测归档

- [`history/`](./history/)
- [Codex notify 实测结论](./history/codex-notify-findings.md)
- [2026-03-18 app-server approval 验证](./history/codex-approval-notification-session-2026-03-18.md)
- [Windows Terminal Tab 颜色演进](./history/tab-color-history.md)
