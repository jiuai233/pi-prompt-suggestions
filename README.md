# Pi Prompt Suggestions

为 Pi 提供下一句灰字预测。使用独立模型和预测线程，结合真实对话与用户编辑的偏好，在主聊天结束且空闲后生成候选。支持 TUI，并提供 Web 宿主接入参考。

候选只在输入框显示；Tab 填入后仍需手动发送。预测使用额外模型额度，不执行候选中的任务，不修改主聊天模型。运行环境为 Node.js 24 或更高版本，开发验证使用 Pi SDK 1.4.0。

## 安装与启用

从 GitHub 安装指定版本：

```sh
pi install git:github.com/jiuai233/pi-prompt-suggestions@v1.3.1
```

npm 分发包为 `@jiuai233/pi-prompt-suggestions`，首次发布完成后可安装：

```sh
pi install npm:@jiuai233/pi-prompt-suggestions
```

已有会话执行 `/reload`，再配置预测模型并开启：

```text
/suggestions model
/suggestions thinking
/suggestions preferences
/suggestions on
```

预测默认关闭。配置使用当前 Pi 的模型目录和认证；主聊天完成后，空输入框显示灰字，Tab 接受，Esc 清除。

## 包里有什么

```text
package.json / package-lock.json    独立开发依赖和 Pi 包入口
plugin/                            完整插件源码、声明、测试与原使用说明
skills/develop-prompt-suggestions/  Agent 接手入口及设计、配置、接入、验收资料
scripts/set-preferences.mjs         把人类编辑的 UTF-8 原文导入个人配置
examples/                          可复制的设置模板和偏好编辑稿
host-reference/piweb/               当前 Web 专属接缝源码、片段与测试参考
SOURCE.json / FILES.json            来源、导出调整与文件 SHA256
AGENT-HANDOFF.md                    可以直接给下一个 Agent 的任务入口
VERIFICATION.md                    独立工程实际验证结果
```

`host-reference` 是移植参考，不是一套能独立启动的 Web 应用。插件的模型调用、持久化、配置和 TUI 都不依赖这个目录。个人认证、真实对话、检查点、日志和当前用户的私有配置没有打包。

## 最短开发路径

在本工程根目录执行，参考环境为 Node.js 24 和 Pi SDK 1.4.0：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

测试使用夹具，不调用付费模型。运行依赖只有 `proper-lockfile`；Pi SDK、TypeScript 为开发依赖。Pi 本身向扩展提供的包仍声明为 peer，而不是把 SDK 当业务运行依赖塞进插件。

已经安装 Pi 1.4.0 的机器可临时加载整个包：

```sh
pi -e .
```

也可只临时加载扩展：`pi -e ./plugin/index.ts`。然后在 TUI 中配置：

```text
/suggestions model
/suggestions thinking
/suggestions preferences
/suggestions on
```

模型从接收方实际已启用的目录选择，认证使用接收方自己的 Pi 配置。不要照抄导出者的模型别名。完成一轮普通聊天后，空输入框会显示候选；Tab 只填入，发送仍由人决定。

需要永久装载时，用 `pi install <本工程的绝对路径>` 注册整个包；已有会话执行 `/reload`。本地路径安装不会替你准备依赖，先完成上面的 `npm ci`。纯运行安装可用 `npm ci --omit=dev --omit=peer --ignore-scripts`，开发与测试则安装完整依赖。不要再同时注册 `plugin/index.ts`，以免重复装载。

## 为什么这样设计

- **主聊天不承担预测任务**：使用独立模型与线程，不污染主会话响应链。
- **压缩后清的是旧工具，不是用户原话**：保留当前分支的旧用户／助手可见文字，清除压缩点之前的工具调用及结果；新工具继续进入，下次压缩再清。保持意图原文，同时控制最膨胀的历史材料。
- **持久线程保留稳定前缀**：正常时追加新证据而不是每轮改写历史；进程重启可恢复。传输增量、服务端 token 缓存和本地检查点是三回事。
- **偏好由人说了算**：保存人类原文，允许编辑和清空；模型只把它当预测参考，不自动把聊天提炼成人设。
- **生命周期不过度设计**：仍有效的请求允许慢一些；新一轮使旧预测失效时取消。两分钟只是总资源预算，非故障诊断或完成保证。

原理与取舍的完整依据在 [设计说明](skills/develop-prompt-suggestions/references/design.md)。

## 个人偏好放在哪里

实际生效的是 **Pi 当前 agentDir 下的 `prompt-suggestions.json` 的 `preferences` 字段**。默认通常是 `~/.pi/agent/prompt-suggestions.json`；使用 `PI_CODING_AGENT_DIR` 时跟随该目录。

推荐从 TUI 的 `/suggestions preferences` 或已接入 Web 的“你的偏好”编辑。喜欢文本文件的话，可复制 `examples/preferences.txt` 为自己的 UTF-8 编辑稿，然后显式导入：

```sh
node scripts/set-preferences.mjs --agent-dir "<实际 agentDir 绝对路径>" --file "<偏好编辑稿路径>"
```

这个脚本只更新 `preferences`，不改模型、推理档或开关。文本文件是编辑稿，JSON 才是运行配置；修改编辑稿后要重新导入。详情与 Windows／macOS／Linux 路径例子见 [配置与人工编辑](skills/develop-prompt-suggestions/references/configuration.md)。

## 给其他 Agent 怎么用

把完整文件夹或 ZIP 交给它，附上：

> 先读 `AGENT-HANDOFF.md` 与 `skills/develop-prompt-suggestions/SKILL.md`，按我要改的方向读取相应参考；先跑独立工程测试，再改插件。Web 接线在 host-reference，只作为移植参考。我的真实偏好由我编辑，不替我总结改写。

整个包的 `pi.skills` 已声明 Skill。非 Pi 的 Agent 也可直接读取其 `SKILL.md`，或把该 Skill 文件夹连同 `references` 放进其支持的 skills 目录；运行与修改仍需这份插件工程。只有 Skill 文案不会凭空安装插件。

## 自动检查与版本发布

GitHub Actions 在提交到 `main` 或创建 PR 时，使用 Node.js 24 在 Linux 和 macOS 上安装依赖、运行测试、检查类型并检查打包内容。测试不调用付费模型，工作流无需配置模型密钥。

Dependabot 每周一 10:00（UTC+8）检查 npm 依赖和 GitHub Actions 更新，通过 PR 提交修改；Pi SDK 的相关包归为同组更新。

版本发布由 `v*` 标签触发。`package.json`、`plugin/package.json` 和 `plugin/unit.json` 的版本必须与标签一致。工作流通过测试和类型检查后，生成 `.tgz` 安装包并创建 GitHub Release 草稿，发布说明由 GitHub 自动生成。仓库自带的 `GITHUB_TOKEN` 用于创建草稿，无需单独配置访问令牌。

仓库连接远程且当前版本提交完成后，可通过标签准备发布：

```sh
git tag -a v1.3.1 -m "发布：灰字预测 1.3.1"
git push origin v1.3.1
```

GitHub Release 草稿发布后，`publish.yml` 使用 npm Trusted Publishing 发布 npm 包。预发布版本使用 `next` 标签，正式版本使用 `latest`；工作流也支持手动指定版本标签重新触发。

npm 首次发布需要包维护者登录并执行：

```sh
npm login
npm publish --access public --ignore-scripts
```

随后在 npm 包设置中配置 Trusted Publisher：

| 字段 | 值 |
| --- | --- |
| Organization or user | `jiuai233` |
| Repository | `pi-prompt-suggestions` |
| Workflow filename | `publish.yml` |
| Environment name | 留空 |
| Allowed actions | 允许 `npm publish` |

Trusted Publisher 配置完成后须在两天内成功发布一次以完成验证。后续版本通过 GitHub 工作流发布，无需保存长期 npm 发布令牌。包包含 `pi-package` 关键词，符合 Pi 包广场的发现条件；广场显示时间取决于索引更新。

## 许可证

项目采用 [MIT](LICENSE) 许可证。`host-reference/piweb` 的第三方代码保留原 MIT 许可证和版权声明。

## 来源与边界

- 业务源码及导出适配列表在 `SOURCE.json`；运行时 `.mjs`、`index.ts`、`editor.ts` 保持原版。只调整导出副本的测试 SDK 路径、TypeScript 路径映射和 typecheck 命令，以脱离原 monorepo。
- 本包使用原版 npm Pi SDK 1.4.0 做独立开发验证，不导入原机的 SDK 补丁或控制面。本机定制的无限网络恢复、身份或推理补丁不是插件本身；需要其行为时，应作为目标宿主的独立适配处理。
- 原 `plugin/README.md` 保留了原 monorepo 的操作路径；本独立包的安装、测试命令以本页为准。
- Web 参考来自 `agegr/pi-web` v0.13.0 基础上的当前接入，保留原 LICENSE；没有附带完整 Web、发布器、账号或个人域名配置。
