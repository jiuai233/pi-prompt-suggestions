# 下一句灰字预测

Web 和 TUI 共用同一个插件：独立选择预测模型、推理档位，保存用户自己写的偏好原文。默认关闭；初始模型为 `xai/grok-4.7`、`low`，预填本次采用的四条 V1 参考文本。

## Web 设置

打开模型设置窗口，在左栏「语音」下方选择「灰字预测」。这里可以：

- 开关预测，从当前已启用且支持预测的模型中选择模型及其推理档；不显示不可选模型。
- 自由编辑「你的偏好」，包括清空；保存的文字原样发送，不自动总结或改写。
- 保存后从下一次已结束且空闲的对话开始使用新配置。切换左栏保留未保存草稿。
- 「重新读取」在没有未保存更改时采纳服务端最新值；有未保存草稿时只刷新模型目录和保存基线，保留草稿原文。

原通用设置里的灰字开关继续可用，和插件读取同一份配置。预测模型与主聊天模型独立。

## 两端命令

```text
/suggestions                         查看状态
/suggestions on                      开启
/suggestions off                     关闭并清除在途结果
/suggestions model                   选择已启用的预测模型
/suggestions model xai/grok-4.7       直接选择模型
/suggestions thinking                选择推理档
/suggestions thinking low            直接设置推理档
/suggestions preferences             编辑偏好原文
/suggestions preferences clear       清空偏好
```

TUI 使用现有编辑器：空输入框显示灰字，Tab 填入但不发送，Esc 清除；自己输入、开始下一轮、切换会话或模型时取消旧预测。Web 沿用现有灰字输入界面和设置控件。

## 命令行

安装后，启动参数可给本次进程覆盖默认配置：

```sh
pi --suggestions --suggestions-model xai/grok-4.7 --suggestions-thinking low
pi --suggestions-preferences "这里写我自己的偏好"
pi -p "/suggestions status"
```

也可仅为当前进程加载源码：

```sh
pi --extension ./plugins/prompt-suggestions/index.ts --suggestions
```

Git Bash 向原生程序传 `/suggestions` 时会把它改成路径，应使用 `MSYS_NO_PATHCONV=1 pi -p '/suggestions status'`。PowerShell 不需要此变量。非交互模式可执行配置命令，但没有灰字输入框；不会额外自动启动预测。

## 配置与模型

配置保存在 Pi 当前 agentDir 的 `prompt-suggestions.json`，跟随 Pi 配置目录，不写死盘符：

```json
{
  "enabled": false,
  "provider": "xai",
  "modelId": "grok-4.7",
  "thinkingLevel": "low",
  "preferences": "用户自己的原文"
}
```

首次保存前兼容读取旧 `settings.json` 的 `promptSuggestionsEnabled`；首次保存后以插件配置为准，不再维护两份开关。界面保存和命令修改默认配置；启动参数只覆盖当前进程，运行中命令可修改相应选项。

写入使用与 Pi SDK 相同的 `proper-lockfile@4.1.2` 原语：原子创建同路径旁的 `prompt-suggestions.json.lock` 目录，锁内读取最新配置、合并 patch、写临时文件并替换，最后释放锁。不同进程修改不同字段不会丢失更新；全量表单保存仍提交整份设置。锁不覆盖模型请求或通知，也不锁定或改写全局账号 `settings.json`。

模型目录和认证复用 Pi。原生会话桥接模型需要独立适配，设置菜单不列出它们。已保存的预测模型若变得不可用，显示选择提示，不会偷偷换成另一个模型；仍可关闭预测。

## 调用方式

每个完整结束且空闲的回合生成一次候选。未压缩时预测输入保留当前实际请求快照的可见用户／助手／工具文字；压缩后保留当前分支的旧用户／助手原文，清除压缩点之前的工具调用和输出，随后新增工具按当前有效投影正常进入，下次压缩再清。不调用额外摘要模型，不转发隐藏推理及主助手系统规则。固定说明和偏好在前，真实对话按独立 `conversation_evidence` 条目排列；变化的版本号只在尾部预测请求中出现。

持久预测线程按接入通道区分：

- `xai` 和 `openai` 的 `openai-responses`：首次设置 `store:true`，随后通过 `previous_response_id` 只追加新增真实证据与预测请求。复用 Pi SDK 的认证、HTTP/SSE 和 payload 钩子。
- Luna 等 `openai-codex-responses`：保持 SDK 的 `store:false`，本地保存完整预测线程，将历史交给 SDK 的自动 WebSocket 传输。同一连接内由 SDK 生成 `previous_response_id` 和新增输入；断线或进程重启后重放本地历史一次，新连接随后继续增量。不会尝试跨连接恢复旧响应 ID；WebSocket 不可用时沿用 SDK 的 SSE 降级。

两类线程都使用主会话 ID 加 `:prompt-suggestions` 的独立身份，不续接主聊天的响应链。过去输出的候选明确标为预测，不算用户实际发言，也不进入主会话历史。其他已支持 API 保留独立全量请求。

检查点位于当前 agentDir 的 `prompt-suggestions/threads/<主会话ID的SHA256>.json`，保存响应 ID、证据与配置指纹、最新候选、请求统计和累计费用折算。Codex 另保存完整预测输入、预测回复及其自身续接签名，以便重连恢复；不保存认证信息、主系统规则或主助手隐藏推理。xAI/OpenAI 服务端存储路径不另存全文。TUI 与 Web 对同一会话共用检查点，进程重启后下次预测可继续。每线程文件锁只串行化自己的预测；不同会话可并行。

Codex 的检查点 `lastRequest.mode=append` 表示新增证据被接入本地预测历史，不表示该次一定在线路上传了增量；`inputMessages/inputCharacters` 是传给 SDK 的上下文大小。实际 full/delta 由 SDK 当前连接状态决定。

只有已确认的旧证据是当前证据的精确前缀且主压缩条目ID未改变时才续接。发生主压缩后，下次预测从原生当前分支取出压缩点之前的用户和助手可见文字，删除旧工具结果、助手中的工具调用及纯工具调用消息；主摘要不替代这些原文，主会话近期保留区里的旧工具也不会重复带入。压缩点之后的新证据复用SDK带来源的有效投影，维持截断或引用语义；下一次主压缩再清掉这些工具。检查点保存compactionId，确保同一压缩边界内继续增量、边界变化时重建。分支或当前证据改写、预测模型／偏好／提示／推理配置改变时也重建相应有效证据。依赖服务端响应保存的检查点超过30天时重新建链；Codex 本地历史不受该期限限制。服务端明确返回已存响应不存在，或预测链本身超过窗口时，用当前完整有效证据重建一次。当前证据本身仍超窗则报告失败，不截短材料。普通网络错误不自动重发。服务端响应保留期和缓存寿命不是一回事；增量传输也不表示历史输入不计费。

开始下一轮或关闭开关会取消旧请求，迟到结果既不显示也不覆盖检查点。共享控制器允许仍有效的慢请求继续完成，单次总资源预算为两分钟（包含等锁和 SDK 重试），到点取消并记录 `budget_exhausted`，不据此判断网络或模型故障；失效取消记录为 `no_longer_needed`。不增加插件级重试，不改变主聊天的重试策略。

每次预测结束向当前 agentDir 的 `logs/prompt-suggestions.jsonl` 追加一条记录：会话和版本标识、模型、耗时、结果、取消原因、模型调用次数及已知用量。不保存对话、偏好或候选正文；未知用量为 `null`，不是零。日志写入失败会报告错误，但不丢弃已完成的候选。崩溃或取消不能撤销服务端已经产生的用量。预测不声明工具、不执行返回的工具调用、不改主模型；采用仍只填入输入框，不自动发送。预测使用额外模型额度。

## 插件接口与发布

- `api.mjs` / `api.d.mts`：共享配置、命令、模型能力和预测控制器，API 版本 1。
- `core.mjs`：证据条目、持久续接与预测；`threads.mjs`：每线程锁和原子检查点；`preferences.mjs`：可编辑的 V1 初始内容。
- `index.ts` / `editor.ts`：TUI 接线。
- Web 通过 `plugin.prompt-suggestions` 当前安装槽动态加载 API，宿主只保留设置路由和灰字显示接线。更新卡片或选模型无需构建 Web；更新生成逻辑仅需更新插件并刷新对应会话。

开发或隔离测试可用 `PI_PROMPT_SUGGESTIONS_UNIT_ROOT` 指向本插件源码目录；生产通过正式单元安装路径加载。

## 定向验证

```sh
node --test plugins/prompt-suggestions/*.test.mjs apps/piweb/web/tests/prompt-suggestion-settings-ui.test.mjs apps/piweb/web/lib/prompt-suggestion-settings.test.mjs
node apps/piweb/web/node_modules/typescript/bin/tsc --project plugins/prompt-suggestions/tsconfig.json
```

测试使用真实 SDK 扩展加载器、编辑器和模型返回夹具，覆盖独立选模、原文保存、灰字按键、取消、跨进程恢复与同线程并发，不调用付费模型。
