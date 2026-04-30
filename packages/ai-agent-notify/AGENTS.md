# ai-agent-notify 约定

- 先看 `docs/principles.md`；文档分工和阅读顺序看 `docs/README.md`。
- `notify` 负责 completion；hooks 负责 `SessionStart` / `PermissionRequest` / `Stop`；`codex-session-watch` 只负责 `InputRequest`。
- direct notify 保持单进程；Codex hooks 若不想卡 UI，靠 `hooks.json` 的 `timeout`，不要再恢复父子程序分离。
- `agentId` 只允许 `claude`、`codex`、`unknown`；入口写在 `entryPointId`；不要恢复 `source`。
- 改 hooks / watcher / SessionStart bootstrap / runtime 时，同步更新文档和测试。
- 直接在当前目录改，不建 worktree，除非用户明确要求。
