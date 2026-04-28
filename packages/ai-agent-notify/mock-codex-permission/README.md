# mock-codex-permission

这个目录用于本地复现 Codex 的 `PermissionRequest`。

## 作用

- 目录内的 `.codex/config.toml` 把当前项目覆盖成：
  - `approval_policy = "on-request"`
  - `sandbox_mode = "read-only"`
- 在这个组合下，Codex 可以读文件，但编辑文件或执行命令都需要先申请批准，适合验证 `PermissionRequest` 通知链路。

## 使用方法

1. 从这个目录启动 Codex。
2. 确保 Codex 已经 trust 当前项目，否则不会加载项目级 `.codex/config.toml`。
3. 让 Codex 执行一个会越过只读边界的动作，例如：
   - 修改 `target.txt`
   - 新建一个文件
   - 运行一个 shell 命令

如果你的全局 `~/.codex/hooks.json` 已经接了 `PermissionRequest` hook，这个目录可以稳定复现对应通知。
