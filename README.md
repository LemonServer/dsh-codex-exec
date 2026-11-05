# DSH Codex Exec

## 一句话定位

DSH 负责计划与审查，Codex 负责执行；本插件提供一个 `codex_exec` 工具，并在输入框工具行提供模型、努力等级与角色选择器。

## 安装

在本目录执行：

```sh
npm pack
dsh plugin --profile <profile> add <生成的 tgz>
```

改完插件需重启 DSH 并刷新页面。

## 前置条件

本机需安装 Codex CLI 并已登录；`codex login status` 应显示已登录。

## 工具签名

`codex_exec` 参数：

- `task`（必填）：交给 Codex 的任务。
- `scope`（必填）：本次委派负责的范围。
- `model`：Codex 模型。
- `effort`：模型支持的努力等级。
- `role`：`executor`、`reviewer` 或 `planner`。
- `cwd`：执行工作目录。
- `sandbox`：执行沙箱。
- `timeoutMs`：超时时间（毫秒）。

## 角色语义

`executor` 可写；`reviewer` 与 `planner` 强制使用只读沙箱，只做只读分析。

## 生效优先级

调用参数 > 目标会话的界面选择 > 配置文件默认值（`defaultModel`、`defaultEffort`、`defaultRole`）。

选择器状态**按 DSH 会话隔离**：每个会话各记一份模型/努力/角色，切换会话不会串味；从未调整过的会话使用配置文件里的默认值。

## 模型与努力等级来源

优先读取 Codex app-server 的 `model/list`（缓存 5 分钟），其次读取 `~/.codex/models_cache.json`，最后使用内置兜底。每个模型只显示该模型支持的努力等级；例如 `gpt-6-luna` 最高为 `max`，`gpt-6-astra` 支持 `ultra`。

## Codex 可执行文件定位

`codexCommand` 默认是 `codex`，插件会**在本机探查**而不是写死绝对路径，顺序如下：

1. 配置里给出的绝对 `.exe`（存在且带 `codex-code-mode-host.exe` 时）
2. npm 全局包：`%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-<platform>\vendor\...\bin\codex.exe`
3. Codex Desktop 的版本目录：`%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`（取最新）
4. `PATH` 中的 `codex.exe`（跳过 `~/.codex/.sandbox-bin` 这类暂存目录）

只有真实存在的 `.exe` 才会被选中：`.cmd` 垫片无法在不带 shell 的情况下 spawn，缺少配套 `code-mode-host.exe` 的副本也无法执行工具。

## 超时

默认**不设上限**：`timeoutMs: 0` 时插件不杀进程，工具描述符也不声明 `timeoutMs`——宿主只有在工具声明了该字段时才装 deadline，因此正在干活的 Codex 不会被中途判定失败。

需要硬性预算时在 `cordis.patch.yml` 里设一个正数（同时作用于宿主 deadline 和插件自身的看门狗），或在单次调用里传 `timeoutMs`。

## 配置文件

在 `cordis.patch.yml` 中可设置 `codexCommand`（建议保持 `codex` 让插件自查）、`sandbox`、`timeoutMs`、`defaultModel`、`defaultEffort`、`defaultRole` 和 `models`。`models` 留空表示自动读取模型目录。

## 子会话

每次调用会创建一个 DSH 原生子会话，并流式写入 Codex 的命令调用、输出与消息。
