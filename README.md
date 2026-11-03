# Pi Prompt Suggestions

为 Pi 提供下一句灰字预测：主聊天结束且空闲后，结合当前对话和个人偏好，在输入框中显示候选。按 Tab 填入，确认后手动发送。

**主作者：[@syansunyang-collab](https://github.com/syansunyang-collab)**

## 功能

- 使用独立的预测模型和线程，可单独选择模型与推理档位。
- 支持编辑个人偏好，按原文保存，允许清空。
- 支持 TUI 灰字显示；仓库附有 Web 宿主接入参考。
- 开始新一轮、切换会话或关闭预测时，取消旧预测。

预测默认关闭，使用额外的模型额度。候选只填入输入框，不会自动发送或执行。

## 安装

需要 Node.js 24 或更高版本及 Pi。当前开发验证使用 Pi SDK 1.4.0。

```sh
pi install npm:@jiuai233/pi-prompt-suggestions
```

也可从 GitHub 安装指定版本：

```sh
pi install git:github.com/jiuai233/pi-prompt-suggestions@v1.3.2
```

安装后，已有会话执行 `/reload`。

## 开始使用

依次选择预测模型、推理档位，编辑个人偏好并开启预测：

```text
/suggestions model
/suggestions thinking
/suggestions preferences
/suggestions on
```

模型和认证复用当前 Pi 配置，预测模型与主聊天模型独立。

完成一轮聊天后，空输入框会显示灰字：

- **Tab**：接受候选，填入输入框。
- **Esc**：清除候选。
- **直接输入**：继续编写自己的消息。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/suggestions` | 查看当前状态 |
| `/suggestions on` | 开启预测 |
| `/suggestions off` | 关闭预测并清除旧结果 |
| `/suggestions model` | 选择预测模型 |
| `/suggestions thinking` | 选择推理档位 |
| `/suggestions preferences` | 编辑个人偏好 |
| `/suggestions preferences clear` | 清空个人偏好 |

## 个人偏好与配置

通过 `/suggestions preferences` 编辑偏好，保存的文字会原样用于后续预测，不会被自动总结或改写。

配置保存在当前 Pi 配置目录的 `prompt-suggestions.json` 中，默认路径为 `~/.pi/agent/prompt-suggestions.json`。设置了 `PI_CODING_AGENT_DIR` 时，配置跟随该目录。

文本文件导入、配置字段及各平台路径见[配置说明](skills/develop-prompt-suggestions/references/configuration.md)。

## 开发与接入

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

测试不调用付费模型。本地临时加载使用 `pi -e .`。

- [插件开发说明](skills/develop-prompt-suggestions/SKILL.md)
- [宿主接入说明](skills/develop-prompt-suggestions/references/integration.md)

`host-reference/piweb` 提供 Web 接入参考，不能独立启动为 Web 应用。

## 作者与贡献

- **主作者**：[@syansunyang-collab](https://github.com/syansunyang-collab)。
- **项目整理与维护**：[@jiuai233](https://github.com/jiuai233)。

欢迎通过 [Issues](https://github.com/jiuai233/pi-prompt-suggestions/issues) 反馈问题，或提交 Pull Request 参与改进。

## 许可证

项目采用 [MIT](LICENSE) 许可证。`host-reference/piweb` 中的第三方代码保留其原许可证和版权声明。
