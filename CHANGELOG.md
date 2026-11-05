# Changelog

## 0.3.6

- 默认不再设置超时：`timeoutMs: 0` 时插件不杀进程，工具描述符也不声明 `timeoutMs`，宿主因此不装 deadline，正在工作的 Codex 不会被中途判失败
- 需要预算时在配置或单次调用里给正数，宿主 deadline 与插件看门狗同时生效

## 0.3.5

- `codexCommand` 改为真机探查（绝对路径 → npm 全局 vendor → Codex Desktop 版本目录 → PATH），不再写死绝对路径
- 探查只接受真实 `.exe` 且必须带配套 `code-mode-host.exe`；跳过 `~/.codex/.sandbox-bin` 等暂存目录
- 选择器状态按 DSH 会话隔离，切换会话不再串用模型/努力/角色

## 0.3.4

- 子会话里每条 Codex 进度消息各占一个 step，原生子会话界面因此逐条累积，不再出现新消息覆盖旧消息
- `appendAssistant` 自行管理 `step/start` / `step/end`，turn 层不再手工开合 step

## 0.3.3

- 过滤 Codex 的环境警告（`under-development features …`），真实错误仍然保留

## 0.3.2

- `ChildSessionFactory.open()` 暴露 `progress()`；此前调用方的 `child?.progress(event)` 是静默 no-op，事件全部丢失

## 0.3.1

- 命令与输出改为以 assistant 文本呈现（`→ command` / `✓ 输出（exit N）`）；宿主要求 tool/call 与 tool/result 严格配对，不配对的写入会被静默丢弃
- 最终答复去重，只出现一次

## 0.3.0

- 模型列表改读 Codex app-server 的 `model/list`（缓存 5 分钟），`~/.codex/models_cache.json` 与内置列表仅作兜底
- 支持按调用选择 `model` / `effort` / `role`；`reviewer` 与 `planner` 强制只读沙箱
- 输入框工具行选择器（角色 / 模型 / 努力），努力等级按模型各自能力给出
- 建立 git 仓库与 README
