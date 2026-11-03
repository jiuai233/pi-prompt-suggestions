# 个人偏好、配置及文件放置

实际运行配置只有一份：**当前Pi agentDir下的`prompt-suggestions.json`**。人类可通过UI、命令或文件编辑偏好原文；Skill文案和源码默认值不代替运行配置。

## 三类文件分清楚

| 文件 | 用途 | 修改后何时生效 |
| --- | --- | --- |
| 工程`plugin/preferences.mjs` | 随源码发布的四条V1初始参考 | 仅作为未设置preferences时的默认；已有配置字段不会被它覆盖 |
| `<agentDir>/prompt-suggestions.json` | 真正的个人运行配置，`preferences`是字符串 | 新预测读取；通过同进程API保存还会通知其订阅者取消旧预测 |
| 人自己的UTF-8文本编辑稿 | 方便人类用编辑器写多行偏好 | 需显式导入；没有文件监听器自动同步 |

模型提出改进建议时，交给人编辑或确认；当前插件没有自动总结并写入偏好的功能。修改`SKILL.md`不会改变运行偏好；不要在Skill或主助手系统规则里另维护一份“生效偏好”。

## 运行文件布局

```text
<agentDir>/
  prompt-suggestions.json
  prompt-suggestions/
    threads/
      <主会话ID指纹>.json
  logs/
    prompt-suggestions.jsonl
```

默认agentDir通常为：

- Windows：`C:/Users/<用户名>/.pi/agent`
- macOS／Linux：`~/.pi/agent`

显式设置`PI_CODING_AGENT_DIR`后，整个配置、检查点和日志都跟随它。Web也要指向同一个实际agentDir，才会与TUI共用个人配置；配置页上的cwd用于模型可见范围，不意味着每个项目有独立偏好JSON。

线程名实际是`SHA256(JSON.stringify(主会话ID))`，由`threads.mjs`生成，不必手工计算。Codex检查点包含可见对话和完整预测历史，可能有私密正文；日志没有正文，但会有模型、会话标识及错误信息。分享工程时保留源码和模板，个人运行目录由接收方自己生成。

## 推荐：直接用现有编辑界面

### TUI

```text
/suggestions preferences
```

打开多行编辑器，粘贴人类自己的原文并保存。清空使用：

```text
/suggestions preferences clear
```

独立模型／档位用`/suggestions model`和`/suggestions thinking`选择；用`/suggestions on`开启，`off`关闭。非交互模式不显示灰字；没有交互编辑器时不要期待无参数命令能弹出编辑器。

### 已接入的Web

模型设置 → 灰字预测 → 你的偏好。可以编辑、清空、保存原文。未保存草稿由UI保留；“重新读取”在有未保存更改时保留草稿，只更新服务端基线及模型目录。

## 方式二：用文本编辑器写，再显式导入

工程附`examples/preferences.txt`。复制到自己的工作目录，例如`Documents/prompt-suggestion-preferences.txt`，由人用UTF-8编辑。它是编辑稿，不是自动生效路径，也不必放在插件源码里。

在本工程根执行：

Windows示例，替换自己的用户名和真实目录：

```sh
node scripts/set-preferences.mjs --agent-dir "C:/Users/alice/.pi/agent" --file "C:/Users/alice/Documents/prompt-suggestion-preferences.txt"
```

macOS／Linux示例：

```sh
node scripts/set-preferences.mjs --agent-dir "$HOME/.pi/agent" --file "$HOME/Documents/prompt-suggestion-preferences.txt"
```

脚本调用`writeSuggestionSettings`，只patch `preferences`，保留开关、模型和推理档，不自动开启预测，不输出偏好正文。空文件会导入空字符串。多行、空格原样保留，不经过模型总结。

脚本是另一个进程，它的订阅通知不能跨进程即时到达已经打开的Web/TUI。下一次预测会读取新值；如果要求立即停止旧偏好生成的在途结果，先在正在使用的客户端执行`/suggestions off`，导入后再执行`on`。更换整个插件代码时才需要按宿主方式reload，不必每次修改偏好都重装代码。

## 方式三：直接编辑运行JSON

可从`examples/prompt-suggestions.example.json`了解格式：

```json
{
  "enabled": false,
  "provider": "xai",
  "modelId": "grok-4.7",
  "thinkingLevel": "low",
  "preferences": "先解释原理与差异。\n目标已经明确时直接推进。"
}
```

这是字段示例，不表示接收方拥有对应模型或认证。UI／命令选择的是接收方已启用且支持独立预测的模型。

编辑已有文件时只改目标字段，避免拿模板覆盖自己的模型和开关。字符串里的换行写`\n`、引号写`\"`，文件为合法UTF-8 JSON。想避免转义就用上面的多行编辑器或文本导入脚本。

直接写文件没有进入插件的锁内read/merge/write事务，也不会发出进程内配置通知。避免与UI同时保存；保存后新预测会读取它。要立即清掉旧候选，使用当前客户端的`off`／`on`。文件的语法错误会可见失败，不会被当成空偏好偷偷忽略。

## 默认值、覆盖与优先级

- 运行JSON存在时读取它；缺字段按源码默认补齐，`preferences:""`仍是有效的主动清空。
- 首次保存前兼容旧`settings.json`的`promptSuggestionsEnabled`；首次生成插件配置后不再双写这个旧开关。
- 启动参数`--suggestions`、`--suggestions-model`、`--suggestions-thinking`、`--suggestions-preferences`是本进程覆盖；磁盘文件相同，不意味着有覆盖参数的进程也采用它。
- `writeSuggestionSettings`使用proper-lockfile、锁内合并、原子替换，适合UI与命令同时更新不同字段；全量表单仍会提交整份设置。
- Web/TUI同进程内的保存会通知相应订阅者；另一个进程或文本编辑器的保存，不是跨进程实时广播。

后续想做每项目偏好、自动画像、配置热监听或偏好版本管理，需要单独定义产品语义；当前工程不预设这些功能。
