# 宿主接入与移植

插件核心不依赖原发布器。TUI可直接加载本包；Web或其他Agent需要把“真实证据、空闲状态、模型调用、候选显示”接到自己的宿主。

## 先做最小离线调用

工程根运行：

```sh
node examples/minimal-core.mjs
```

它使用模拟complete，不请求远端。实际接入时保留参数结构，替换为目标宿主的SDK模型与complete函数。

## 共享API接入形态

```typescript
import { convertToLlm, getAgentDir } from "@earendil-works/pi-coding-agent";
import { SuggestionController, buildCompactedSuggestionContext } from "./plugin/api.mjs";

const predictor = new SuggestionController(
  text => publishToComposer({ type: "prompt_suggestion", text }),
  error => reportPredictionError(error),
);

// 只在完整回合结束、队列空且当前会话空闲时调用。
const projected = sessionManager.buildSessionProjection();
const compacted = buildCompactedSuggestionContext(sessionManager.getBranch(), projected.entries);
predictor.start({
  enabled: settings.enabled,
  model: selectedPredictionModel,
  thinkingLevel: settings.thinkingLevel,
  preferences: settings.preferences,
  messages: [...capturedActualRequestMessages, finalAssistantMessage],
  compaction: compacted && { id: compacted.id, messages: convertToLlm(compacted.messages) },
  sessionId: sessionManager.getSessionId(),
  revision: sessionManager.getLeafId(),
  agentDir: getAgentDir(),
  complete: (model, context, options) => runtime.completeSimple(model, context, options),
  isCurrent: () => sameSessionAndLeaf() && isIdle() && queueIsEmpty(),
});

// 新一轮、关闭、会话/配置改变、销毁宿主时：
predictor.clear();
```

示例中的宿主函数需要替换，不是一段可直接粘贴启动的完整应用。`model`是SDK模型对象，不只是字符串；`revision`使用稳定叶节点或等价版本标识，实际调用保证为字符串。`complete`接收并传递signal、独立sessionId和传输选项，不能把它换成主Agent的`prompt()`。

`SuggestionController.start`可返回结束处理Promise，UI通常不等待它；结束处理包含写简短日志，不阻塞主聊天。直接调用`generateSuggestion`适合隔离验证或自管生命周期，但不会自动获得Controller的两分钟预算、结束日志和候选发布保护。

## 保持四个接缝

### 真实证据

先捕获主模型本轮实际请求中的可见投影，再补最后一条助手回复。不要拿原始日志重新无限拼工具输出，绕过宿主的截断、引用或上下文编辑。压缩后另外调用共享压缩投影函数，传当前分支和带来源的projected entries；只有摘要的宿主必须先解决原件可用性，不能声称逐字保留。

### 空闲与当前性

使用真正的settled，而不是每个工具调用、每条流式delta或一次低层agent_end都触发。最终助手回复应为正常文本结束，队列为空、未中止。捕获会话ID、叶节点、模型和配置版本，发布时再检查仍然对应当前状态。

同一revision去重；需要取消旧结果时使用clear。不要在超时后自动换模型、裁短材料或额外重派。已有新一轮已经开始时，保护主聊天优先，而不是为了保住预测缓存继续发布旧结果。

### 配置与模型目录

复用`readSuggestionSettings`、`writeSuggestionSettings`及模型能力校验。使用接收方已启用的模型和认证，不静默替换已保存但不可用的预测模型。Web设置页的cwd只用于模型范围；agentDir是配置身份，两个维度不要混在一起。

订阅通知仅进程内共享；从另一个进程编辑磁盘不等于正在运行的请求立刻取消。直接文件编辑与立即切换策略见同目录configuration.md。

### 展示与接受

TUI使用`SuggestionEditor`：灰字是覆盖层，Tab仅填入，Esc清除，中文输入与粘贴沿用原编辑器。Web用事件把候选送到空输入框；输入中、附件、中文组合输入、流式主回复等场景由实际UI判断是否显示。

Web现有前端的“隐藏灰字”与服务端“取消生成”不是同一个动作：本参考前端输入会隐藏候选，服务端在新提交或会话变更等路径clear。迁移时分别验证，不把隐藏当成网络请求已经取消。

## Web参考目录如何读

`host-reference/piweb`保留原路径与引用，直接拷贝到别的应用通常还需替换宿主依赖：

| 文件 | 提供的参考 | 接收方要接的能力 |
| --- | --- | --- |
| `lib/prompt-suggestions.ts` | 共享Controller → 候选事件 | 本地插件加载器、事件发送 |
| `lib/prompt-suggestions-plugin.ts` | 按真实安装槽路径动态import | 原控制面的resolveUnit可换成本地明确模块路径；保留版本变更后新模块身份 |
| `lib/prompt-suggestion-settings.ts` | API配置读写与订阅 | 实际agentDir／全局设置文件位置 |
| `lib/prompt-suggestion-command.ts` | slash命令不进入主模型 | 命令分发与UI输入 |
| `lib/prompt-suggestion-models.ts` | 复用主宿主模型可见范围 | 已启用模型目录、推理档、延迟provider装载 |
| `app/api/prompt-suggestions/settings/route.ts` | 设置GET/PUT与校验 | 自己的请求来源校验、认证及模型目录 |
| `components/PromptSuggestionSettings.tsx` | 人工原文编辑、草稿、独立选模 | React、i18n、SettingsUi样式组件 |
| `*.excerpt.txt` | 大文件中的空闲触发、捕获、清理、事件和灰字接受片段 | 自己的会话状态机与输入框 |

原引用中的`@/lib`、`control/core`、ModelsConfig、SettingsUi、useI18n、RPC wrapper都属于原宿主，不是插件运行依赖。参考测试同样依赖原Web，放在host-reference而不是根npm test中。需要完整Web时从其上游及对应宿主工程接入，不把这份参考误当成完整网站。

## SDK与升级

本独立工程固定原版npm SDK1.4.0用于开发验证；原生产宿主额外的传输恢复、身份及推理补丁没有随工程安装。插件复用所处宿主的SDK策略，不声明自己实现了这些补丁。

升级SDK时先跑TUI装载与压缩投影测试，再检查消息结构、投影来源、模型目录以及Codex的store:false和连接内续接行为。不同通道的真实缓存命中、重试和断线表现应以接收方实际SDK与usage验证，不能用纯夹具测试替代收益结论。
