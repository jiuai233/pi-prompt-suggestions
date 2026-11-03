# 验证与诊断

先证明改动影响的真实功能，不为每次小改扩大成全宿主测试。首次接手这份独立工程，先用根npm test和npm run typecheck建立基线；后续选择受影响文件即可。

## 测什么

| 修改对象 | 首选用例 |
| --- | --- |
| 提示、可见证据、候选输出 | `plugin/core.test.mjs` |
| 原文偏好、模型选择、命令 | `plugin/api.test.mjs` |
| 压缩后的原话与工具边界 | `plugin/compaction.test.mjs` |
| 服务端响应链与恢复 | `plugin/persistent.test.mjs` |
| Codex本地历史、签名、重连输入 | `plugin/codex.test.mjs` |
| 两分钟预算、取消原因、结束日志 | `plugin/lifecycle.test.mjs` |
| TUI真实SDK装载、灰字、中文输入 | `plugin/editor.test.mjs` |
| 跨进程设置合并 | `plugin/settings-concurrency.test.mjs` |
| 文本导入的原样保存与字段保留 | `scripts/set-preferences.test.mjs` |

跨进程线程用例有约11秒真实等待。生命周期用例用模拟时钟推进真实控制器，不需要等待两分钟。

压缩主路径应确认：旧用户／助手文字保留、边界前工具剔除、边界后新工具仍在、下次压缩再清。线程主路径确认：正常追加，边界／配置／分支变化重建，取消不覆盖旧检查点。人工偏好确认：多行空格不改写，空字符串可清空，导入只改preferences。

## 无灰字时怎么查

1. 检查是否为TUI或已接入Web，开关是否开启、模型是否可用、编辑器是否为空、是否仍有主回复或队列。print模式没有灰字界面。
2. 查实际agentDir，而不是在工程目录猜配置。查看启动参数是否覆盖了磁盘默认。
3. 查看`<agentDir>/logs/prompt-suggestions.jsonl`：
   - `success`：已产出候选，继续看客户端是否允许显示或已被人隐藏。
   - `empty`：没有可发布的文字候选，不等于请求没有发生。
   - `cancelled / no_longer_needed`：请求已失效。
   - `cancelled / budget_exhausted`：单次两分钟预算用尽，不据此诊断网络或模型故障。
   - `error`：根据真实错误定位；认证、模型不可用、文件格式或服务端错误分别处理。
4. 查看检查点的revision、compactionId、配置指纹和最近请求；它只保存可恢复的成功状态，不是所有失败和扣费的账本。
5. 怀疑代码没换版时核对实际加载路径；TUI执行/reload，Web按其加载器判断是否已导入新模块。磁盘源码、安装指针和存活进程是三个不同状态。

日志`modelRequests`统计插件调用complete的次数，不是SDK内部每次网络重试次数。未知usage为null；失败SDK返回的全零占位不当成已知零消耗。插件和日志不可能撤销或完整得知已经在服务端发生、但未返回usage的消费。

## 判断缓存与质量

使用实际cacheRead和输入量计算服务端token命中，不拿本地append代替线上delta。全量重放、持续连接、本地检查点分别取证。

预测内容与真实下一句比较时，除了逐字一致，也看是否接住用户意图和未决问题；用户临时转题不是传输失败。要统计成功率或成本，纳入取消／预算耗尽／错误，不能只看成功检查点。

夹具验证机制；跨账户、真实网络下的速度、成本和命中率需要接收方自己的代表性请求。真实模型验证会使用其额度，选择明确的目标和数量再运行。
