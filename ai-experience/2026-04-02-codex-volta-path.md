# Codex 会话与 Volta Node 版本不一致

- 日期: 2026-04-02
- 场景: `D:\XAGIT\leyserkids\develop\server`

## 现象

项目 `package.json` 配了:

```json
"volta": {
  "node": "10.24.1"
}
```

但在 Codex 会话里执行 `node -v`，实际输出是 `v24.11.1`。

## 结论

这不是项目配置失效，而是 Codex 启动的 shell 注入了自己的 Node runtime，导致当前会话优先命中了 `Node 24.11.1`，没有经过 Volta shim，所以项目级版本没有生效。

## 关键点

- `where node` 先命中的是:

```text
C:\Users\ericali\AppData\Local\Volta\tools\image\node\24.11.1\node.exe
```

- 当前 shell 的父进程链是:

```text
powershell.exe <- codex.exe <- node.exe (24.11.1)
```

- 说明当前 shell 继承的是 Codex 组装过的 PATH，不完全等于开发者本机真实终端环境

## 影响

- 在 Codex 里执行 `node`、`npm`、`npx` 时，不能默认等于本机真实环境
- 使用 Volta / nvm / PATH 优先级做版本管理的项目，可能被绕开
- 排查构建问题前，先确认当前会话实际命中了哪个 `node.exe`

## 参考

- `openai/codex#2441`
  - https://github.com/openai/codex/issues/2441
- `openai/codex#4210`
  - https://github.com/openai/codex/issues/4210
- `openai/codex#3159`
  - https://github.com/openai/codex/issues/3159
- `volta-cli/volta#2040`
  - https://github.com/volta-cli/volta/issues/2040
