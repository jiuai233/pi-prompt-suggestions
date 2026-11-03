# 独立工程验证结果

验证日期：2026-11-02（UTC+8）。平台：Windows x64，Node.js 24.12.0；工程使用新安装的原版npm Pi SDK1.4.0，而不是引用原Web目录或其SDK补丁。

## 已通过

| 检查 | 结果 |
| --- | --- |
| 根目录`npm install --ignore-scripts --no-audit --no-fund` | 独立依赖安装成功，生成根package-lock.json；ZIP不含node_modules，接收方使用npm ci |
| `npm test` | 49项全部通过，包括原插件功能、真实SDK装载、压缩边界、跨进程续接、配置合并及新增文本导入 |
| `npm run typecheck` | TypeScript退出0 |
| `node examples/minimal-core.mjs` | 离线输出候选，paidRequests=0 |
| 新增文本导入复验 | 保留多行、空格、引号和其他配置字段；空文件清空preferences；不打印原文 |
| 真实Pi CLI整包加载 | 使用隔离agentDir，从包根`--extension`加载；`/suggestions status`注册成功并显示默认关闭，退出0 |
| 真实SDK Skill加载 | 发现`develop-prompt-suggestions`，diagnostics为0 |
| Skill结构校验 | 入口与四份references通过，无错误或警告 |
| 文档链接核对 | 新增交接文档与Skill相对Markdown链接全部存在 |
| 业务源码核对 | api/core/threads/settings/preferences的mjs、index/editor的ts及两份声明与原1.3.1逐字一致 |
| 隐私范围 | 未复制个人认证、运行配置、models.json、真实会话、线程检查点、生产日志或node_modules |

整包CLI探针最初只断言stdout，SDK实际通过通知通道写到stderr；合并两路输出后通过，插件未因这个探针断言而修改。

## 导出时调整的内容

- `plugin/editor.test.mjs`与`compaction.test.mjs`：SDK导入由原monorepo的apps/piweb/web/node_modules改为本工程根node_modules。
- `plugin/tsconfig.json`：去掉原monorepo的paths映射，按正常NodeNext解析根开发依赖。
- `plugin/package.json`：typecheck命令使用本地tsc；根package提供统一开发与Pi资源入口。
- 新增的Skill、人工偏好导入脚本、示例和宿主参考不改变原插件生成逻辑。

## 使用边界

49项是本独立工程的离线／SDK夹具测试，不是跨账户真实模型性能测试。Web参考保留了原宿主依赖，未作为独立网站构建或运行；移植到目标Web时验证其模型目录、会话事件、来源校验、设置UI和输入框行为。接收方真实速度、token缓存及额度消耗从其自身SDK与usage检查。

文件清单与SHA256见FILES.json；压缩包旁提供.zip.sha256。打包不携带依赖安装目录；本次临时CLI配置和测试状态均已清理。
