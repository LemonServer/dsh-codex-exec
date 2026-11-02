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

调用参数 > 界面选择器 > 配置文件默认值（`defaultModel`、`defaultEffort`、`defaultRole`）。

## 模型与努力等级来源

优先读取 Codex app-server 的 `model/list`（缓存 5 分钟），其次读取 `~/.codex/models_cache.json`，最后使用内置兜底。每个模型只显示该模型支持的努力等级；例如 `gpt-6-luna` 最高为 `max`，`gpt-6-astra` 支持 `ultra`。

## 配置文件

在 `cordis.patch.yml` 中可设置 `codexCommand`、`sandbox`、`timeoutMs`、`defaultModel`、`defaultEffort`、`defaultRole` 和 `models`。`models` 留空表示自动读取模型目录。

## 子会话

每次调用会创建一个 DSH 原生子会话，并流式写入 Codex 的命令调用、输出与消息。
