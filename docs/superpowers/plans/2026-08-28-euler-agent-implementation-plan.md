# Euler Agent 第一版实施计划

> 日期：2026-08-28
> 对应规格：`docs/superpowers/specs/2026-08-28-euler-agent-design.md`
> 基线：PI `0.84.3` / `56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4`
> 搜索基线：`pi-web-access` `0.25.0`

## 0. 执行原则

- 采用测试驱动的小步提交：先写失败测试，确认失败原因正确，再实现最小改动并跑回归。
- 每个任务只处理一个边界；不得趁品牌修改重构 PI Core。
- 所有用户可见自有变量只使用 `EULER_*`，不得读取 `PI_*` 兼容别名。
- Provider 自己的标准变量（如 `OPENAI_API_KEY`）保持不变。
- Windows x64 是发布阻断目标；其余平台只发布通过构建和冒烟的产物。
- 每个阶段完成后运行对应的窄测试；合并前运行 `npm run check` 与 `npm test`。
- 不在代码、测试夹具或文档中保存服务器 IP、令牌、Cookie 或真实 API Key。

## 1. 建立可持续同步的 PI 下游分支

**目标：** 让 Euler 保留 PI 的 Git 历史，后续可人工合并上游，而不是复制一份失去来源的代码。

**涉及文件：**

- `.gitignore`
- `LICENSE`
- `THIRD_PARTY_NOTICES.md`（新增）
- `docs/upstream.md`（新增）
- 当前 `docs/**`

**步骤：**

1. 给当前文档提交保留 `design-approved` 分支。
2. 添加只读上游 remote：`https://github.com/earendil-works/pi.git`。
3. 从固定 commit 创建实施分支，再 cherry-pick 已批准的 Euler 文档提交。
4. 将实施分支设为本地 `main`；保留 `design-approved` 作为恢复点。
5. 在 `docs/upstream.md` 记录 PI commit、版本、同步规则和差异边界。
6. 在 `THIRD_PARTY_NOTICES.md` 登记 PI 与 `pi-web-access` 的版本、仓库、MIT 版权和许可证位置。
7. 合并 `.gitignore` 时保留 PI 规则，并继续忽略 `.superpowers/`。

**验证：**

```powershell
git merge-base --is-ancestor 56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4 HEAD
git show HEAD:docs/superpowers/specs/2026-08-28-euler-agent-design.md
git status --short
```

**提交：** `chore: establish Euler downstream from PI 0.84.3`

## 2. 建立 Euler 品牌与配置契约

**目标：** `euler` 是真正的程序入口，默认配置只进入 `~/.euler/agent`。

**修改文件：**

- `packages/coding-agent/package.json`
- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/rpc-entry.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/test/config.test.ts`
- `packages/coding-agent/test/euler-branding.test.ts`（新增）
- `packages/coding-agent/test/euler-config-isolation.test.ts`（新增）

**先写失败测试：**

- `APP_NAME === "euler"`、`APP_TITLE === "Euler"`、`CONFIG_DIR_NAME === ".euler"`。
- npm `bin` 只有 `euler`，不安装 `pi`。
- 无覆盖时 `getAgentDir()` 指向临时 HOME 下的 `.euler/agent`。
- 只设置 `.pi/agent` 文件或 `PI_CODING_AGENT_DIR` 时，Euler 不读取它们。
- 帮助、版本和启动文案不出现面向用户的 PI 品牌。

**实现：**

- 使用 `piConfig.name/configDir` 的现有品牌入口，但为显示标题加入明确的 `Euler` 大小写配置，避免只靠 `APP_NAME` 推导。
- 将 CLI bin、bundle 输出名和入口进程标记改成 Euler。
- 保留 `ExtensionAPI` 导出名与 PI 资源格式，不在此任务改 Workspace 包名。
- npm 发布包名在首次发布准备时单独确认；它不影响本阶段 `euler` bin 和源码开发。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- config.test.ts euler-branding.test.ts euler-config-isolation.test.ts
npm --workspace @earendil-works/pi-coding-agent run build
node packages/coding-agent/dist/bundle/cli.js --help
```

**提交：** `feat: establish Euler identity and config isolation`

## 3. 集中迁移 Euler 自有环境变量

**目标：** 消除运行时代码中的自有 `PI_*` 读取，防止路径、离线模式和会话元数据串到 PI。

**新增文件：**

- `packages/coding-agent/src/euler-env.ts`
- `packages/coding-agent/test/euler-env.test.ts`

**修改文件：**

- `packages/coding-agent/src/config.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/src/cli.ts`
- `packages/coding-agent/src/rpc-entry.ts`
- `packages/coding-agent/src/cli/args.ts`
- `packages/coding-agent/src/core/experimental.ts`
- `packages/coding-agent/src/core/telemetry.ts`
- `packages/coding-agent/src/core/package-manager.ts`
- `packages/coding-agent/src/package-manager-cli.ts`
- `packages/coding-agent/src/server/create-harness.ts`
- `packages/coding-agent/src/utils/tools-manager.ts`
- `packages/coding-agent/src/utils/version-check.ts`
- `packages/coding-agent/src/utils/clipboard-image.ts`
- `scripts/auto-pi.sh`（改名为 `scripts/auto-euler.sh`）
- `scripts/profile-coding-agent-node.mjs`
- 所有直接断言上述变量的测试

**先写失败测试：**

- `EULER_CODING_AGENT_DIR`、`EULER_OFFLINE`、`EULER_SKIP_VERSION_CHECK` 等各自生效。
- 对应 `PI_*` 单独存在时完全无效。
- Bash 子进程仅收到 `EULER_SESSION_ID`、`EULER_SESSION_FILE`、`EULER_PROVIDER`、`EULER_MODEL`、`EULER_REASONING_LEVEL`。
- 外部 Provider 的 API Key 环境变量不受影响。

**实现：**

- 在 `euler-env.ts` 集中定义所有 Euler 自有变量名和布尔解析，业务文件不再手写字符串。
- 迁移 package dir、offline、version check、share viewer、managed install、installer base、benchmark、experimental、clipboard 和动态会话变量。
- 删除帮助文档中的 `PI_TELEMETRY`；Euler 不提供遥测变量。
- 用 `rg` 审计剩余 `PI_*`：只允许第三方兼容说明、上游历史/夹具或明确的迁移测试出现。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- euler-env.test.ts config.test.ts create-harness.test.ts package-manager.test.ts version-check.test.ts
rg -n "process\.env\.PI_|\bPI_[A-Z0-9_]+\b" packages/coding-agent/src scripts
```

第二条命令必须由人工逐条确认，不以盲目全局替换通过。

**提交：** `refactor: isolate Euler runtime environment`

## 4. 移除遥测并改为无标识版本查询

**目标：** 普通启动不发送安装报告；版本检查只读取公开 Release 元数据，失败不影响启动。

**修改文件：**

- `packages/coding-agent/src/core/telemetry.ts`
- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/utils/version-check.ts`
- `packages/coding-agent/src/package-manager-cli.ts`
- `packages/coding-agent/test/version-check.test.ts`
- `packages/coding-agent/test/euler-network-policy.test.ts`（新增）
- `packages/coding-agent/test/settings-manager.test.ts`

**先写失败测试：**

- 启动初始化绝不请求 `/api/report-install`。
- 设置文件不生成或读取 `enableInstallTelemetry`。
- 版本查询只访问可配置的公开 GitHub Release API，Header 不含设备 ID、会话 ID、用户名、工作目录或模型。
- `EULER_OFFLINE=1` 时不发版本查询或搜索请求。
- 版本服务 4xx、5xx、超时和无效 JSON 都返回“无更新信息”，不阻止启动。
- `euler update` 才进入更新路径。

**实现：**

- 删除交互模式中的 `report-install` 请求和设置项。
- 将产品遥测实现固定为 NOOP；不影响 ExtensionAPI 中已有的无操作契约。
- 版本端点通过发布配置注入，默认指向 Euler 仓库公开 Release 元数据；仓库尚未发布时安静降级。
- 移除面向 PI installer/`pi.dev` 的默认更新地址；发布任务建立 Euler 产物清单后再启用自更新。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- version-check.test.ts euler-network-policy.test.ts settings-manager.test.ts
rg -n "report-install|enableInstallTelemetry|PI_TELEMETRY|pi\.dev/api/latest-version" packages/coding-agent/src
```

**提交：** `privacy: remove telemetry and identify-free update checks`

## 5. 落地透明的 Euler 系统提示词

**目标：** 以 PI 提示词为基线，只修改身份并加入联网工具与网页不可信规则；用户修改可验证、备份和回退。

**新增文件：**

- `packages/coding-agent/src/prompts/euler-system.md`
- `packages/coding-agent/src/core/system-prompt-manager.ts`
- `packages/coding-agent/test/system-prompt-manager.test.ts`
- `scripts/check-euler-system-prompt.mjs`
- `docs/system-prompt-diff.md`（生成并提交）

**修改文件：**

- `packages/coding-agent/src/core/system-prompt.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/trust-manager.ts`
- `packages/coding-agent/test/system-prompt.test.ts`
- 根 `package.json`

**先写失败测试：**

- 默认提示词含 Euler 身份、四个本地工具、四个联网工具和网页内容不可信规则。
- 默认提示词不含“inside pi”或 PI 文档链接。
- `APPEND_SYSTEM.md` 追加在默认提示词之后。
- `SYSTEM.md` 完整覆盖时返回风险诊断。
- 空文件、未知模板变量或无效编码不替换上一份有效内容。
- 保存前原有效文件进入带时间戳备份；恢复默认删除覆盖但保留备份。
- 加载损坏文件时使用编译内置提示词并显示警告，CLI 仍启动。

**实现：**

- 将默认提示词保存为可直接查看的 Markdown，并在构建时内嵌，避免安装文件缺失导致无法启动。
- 复用 PI 已有全局/项目 `SYSTEM.md` 与 `APPEND_SYSTEM.md` 优先级。
- 新管理器只负责校验、原子写入、备份、恢复和诊断，不改变 PI 的资源加载模型。
- 差异脚本固定比较基线 commit 的 `system-prompt.ts` 与 Euler Markdown，越界变化令 CI 失败。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- system-prompt.test.ts system-prompt-manager.test.ts
node scripts/check-euler-system-prompt.mjs
```

**提交：** `feat: add transparent and recoverable Euler system prompt`

## 6. 固定并内置 `pi-web-access` 0.25.0

**目标：** 联网功能像 PI 的隐藏内联 Extension 一样随主程序加载，但不出现在用户 Package 清单、不能被 Package 管理器卸载。

**新增目录与文件：**

- `packages/coding-agent/src/extensions/web-access/**`（从 0.25.0 固定导入并保留许可证头/许可证文件）
- `packages/coding-agent/src/extensions/web-access/euler-config.ts`
- `packages/coding-agent/test/web-access-builtin.test.ts`
- `packages/coding-agent/test/web-access-routing.test.ts`
- `packages/coding-agent/test/web-access-offline.test.ts`

**修改文件：**

- `packages/coding-agent/src/extensions/index.ts`
- `packages/coding-agent/package.json`
- `package-lock.json`
- `THIRD_PARTY_NOTICES.md`
- shrinkwrap/install-lock 生成物

**先写失败测试：**

- 默认加载的工具正好包含 `web_search`、`fetch_content`、`get_search_content`、`source_check`。
- `/websearch`、`/curator`、`/search` 已注册。
- 内置扩展标记为 hidden，不出现在 Package 资源清单，`euler remove` 不能移除。
- 配置路径是 `~/.euler/agent/web-search.json`，不读取 `.pi` 或 `PI_CODING_AGENT_DIR`。
- 未配置 Key 时先调用 Exa MCP；失败后只调用 DuckDuckGo HTTP。
- 默认自动路由不会触及 Firecrawl 或任何收费 Provider。
- 显式配置其他 Provider 后也必须由用户明确选择，不能进入默认 auto 路由。
- `EULER_OFFLINE=1` 时四个工具快速返回离线错误，不发网络请求。

**实现：**

- 将上游 Extension factory 注册进 `builtInExtensions`，名称为 `Euler Web Access`，`hidden: true`。
- 将上游 `.pi`/`PI_CODING_AGENT_DIR` 路径适配为 Euler 配置函数。
- 将复制源码中对 `@earendil-works/pi-coding-agent` 的自引用改为仓库内相对导入；`pi-ai`、`pi-tui` 等公开兼容类型仍复用固定 PI 包。
- 在适配层固定默认 `workflow = "auto-summary"`、默认 Provider 顺序 `["exa", "duckduckgo"]`。
- 收窄默认 auto 路由，收费 Provider 代码可以保留以支持用户显式配置，但默认永远不可达。
- 保留上游 SSRF、防重定向泄密、正文缓存和内容长度限制。
- 依赖固定精确版本；生成 shrinkwrap/install lock 并做 runtime audit。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- web-access-builtin.test.ts web-access-routing.test.ts web-access-offline.test.ts
npm run check:ts-imports
npm audit --omit=dev
```

**提交：** `feat: embed zero-config Euler web access`

## 7. 适配终端内搜索输出与浏览器命令边界

**目标：** Agent 自动搜索只在终端显示摘要和来源；仅用户执行 `/websearch` 时打开浏览器整理页。

**修改文件：**

- `packages/coding-agent/src/extensions/web-access/index.ts`
- `packages/coding-agent/src/extensions/web-access/curator-server.ts`
- `packages/coding-agent/src/extensions/web-access/curator-page.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `packages/coding-agent/test/web-access-rendering.test.ts`（新增）
- `packages/coding-agent/test/web-access-curator.test.ts`（新增）

**先写失败测试：**

- 自动 `web_search` 的折叠视图显示 provider、结果数、一行摘要和来源数。
- 展开视图显示摘要、标题和 URL，且不会触发浏览器打开函数。
- `/websearch` 才启动本地 curator server 并打开一次浏览器。
- `/curator auto-summary` 不打开浏览器。
- 摘要模型失败时返回确定性的结果列表和来源。
- 工具输出和网页内容不能注入终端控制序列。

**实现：**

- 保留上游 `auto-summary` 逻辑，调整渲染为 Euler 的紧凑工具卡。
- 将打开浏览器的调用限制在 `/websearch` 命令处理器。
- 对标题、摘要、URL 做终端转义与长度上限。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- web-access-rendering.test.ts web-access-curator.test.ts
npm run check:browser-smoke
```

**提交：** `feat: render web research safely in Euler terminal`

## 8. 实现已批准的 Euler TUI

**目标：** 在不重写 PI TUI 架构的前提下，落地 Euler 欢迎区、圆角单框输入区、紧凑工具卡和状态栏。

**修改文件：**

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/modes/interactive/components/custom-editor.ts`
- `packages/coding-agent/src/modes/interactive/components/dynamic-border.ts`
- `packages/coding-agent/src/modes/interactive/components/footer.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- `packages/coding-agent/src/modes/interactive/theme/dark.json`
- `packages/coding-agent/src/modes/interactive/theme/light.json`
- `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- `packages/coding-agent/test/euler-tui-render.test.ts`（新增）
- `packages/coding-agent/test/theme-controller.test.ts`
- `packages/coding-agent/test/theme-detection.test.ts`

**先写失败测试：**

- 启动欢迎区显示 `Euler` 和版本，不显示 π/PI 产品标记。
- 输入区使用单层 `╭─╮/╰─╯` 细边框，无标题栏和第二层边框。
- 窄终端不会越界；无 Unicode 能力时使用安全 ASCII 回退。
- 工具卡的运行、成功、失败状态有不同 token，而非写死颜色。
- footer 保留模式、模型、Git 分支和上下文信息。
- PI 既有键位和 `/resume`、`/new`、`/model` 行为不变。

**实现：**

- 只替换组件装配与 Theme Token，保留输入编辑器、命令路由和会话事件。
- 将已批准结构编码为渲染测试夹具；色值可后续微调，但结构变化需更新验收。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- euler-tui-render.test.ts theme-controller.test.ts theme-detection.test.ts
npm --workspace @earendil-works/pi-coding-agent run build
node packages/coding-agent/dist/bundle/cli.js --offline
```

人工检查 Windows Terminal：80、120、160 列宽，浅色/深色主题，各执行一次成功和失败工具调用。

**提交：** `feat: apply Euler terminal experience`

## 9. 完成 PI 资源生态兼容与透明查看

**目标：** 保持 Prompt Template、Skill、Extension、Theme、Package 语义，同时确认 Euler 没有默认 Skill 或默认 Package。

**修改文件：**

- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/package-manager.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/test/euler-resource-compat.test.ts`（新增）
- `packages/coding-agent/test/package-manager.test.ts`
- `packages/coding-agent/test/prompt-templates.test.ts`
- `packages/coding-agent/test/skills.test.ts`
- `docs/compatibility.md`（新增）

**先写失败测试：**

- 干净 `~/.euler/agent` 下 Skill 和用户 Package 数量均为 0。
- 代表性 PI Prompt Template 参数、Skill `SKILL.md`、TypeScript Extension 和多资源 Package 可直接加载。
- 资源列表显示路径、来源和启用状态；Skill 内容可查看、禁用、重新启用和卸载。
- `ExtensionAPI` 公共类型快照与 PI 基线一致。
- 写死 `.pi`/`PI_*` 的第三方包得到清晰兼容诊断，而非静默读取 PI 数据。

**实现：**

- 不改格式和优先级，只改 Euler 路径与用户文案。
- 隐藏内置 Extension 仅限真正的产品内部模块；Skill 永不隐藏。
- 在兼容文档列出可直接复用项，以及硬编码 PI 路径/变量时需要的改动。

**验证：**

```powershell
npm test --workspace @earendil-works/pi-coding-agent -- euler-resource-compat.test.ts package-manager.test.ts prompt-templates.test.ts skills.test.ts
npm run check:ts-imports
```

**提交：** `test: guarantee PI resource compatibility in Euler`

## 10. 重命名构建、安装和发布产物

**目标：** npm 全局安装和 Bun 独立文件都只提供 `euler`；生成六个平台候选，Windows x64 为硬门槛。

**修改文件：**

- `packages/coding-agent/package.json`
- `scripts/build-coding-agent-bundle.mjs`
- `scripts/build-binaries.sh`
- `scripts/local-release.mjs`
- `scripts/release.mjs`
- `scripts/publish.mjs`
- `scripts/create-source-archive.sh`
- `scripts/generate-coding-agent-shrinkwrap.mjs`
- `scripts/generate-coding-agent-install-lock.mjs`
- `.github/workflows/build-binaries.yml`
- `.github/workflows/ci.yml`
- `packages/coding-agent/test/euler-package-artifact.test.ts`（新增）
- `docs/releasing.md`（新增）

**先写失败测试：**

- `npm pack --dry-run` 产物包含 `euler` bin、许可证、默认提示词和内置搜索运行文件。
- tarball 安装后 `euler --help`/`--version` 成功，`pi` 命令不存在。
- standalone 文件名是 `euler.exe` 或 `euler`，压缩包名是 `euler-<platform>`。
- 构建产物中没有对开发仓库或 `~/.pi` 的运行时依赖。
- Windows x64 失败阻止发布；非 Windows matrix 项失败只跳过对应产物，不阻止已通过的 Windows x64。

**实现：**

- 首次发布前查询 npm registry 并由用户确认最终包名；确认后一次性写入 package metadata 和发布文档。CLI bin 始终为 `euler`。
- PI Core/AI/TUI 等 Workspace 包继续依赖并兼容上游 `@earendil-works/*` 固定版本，不以 Euler 名义重复发布；发布脚本只发布新的 Euler CLI 包。
- 将二进制、压缩包、source archive、更新 manifest 和 GitHub Release 文案统一为 Euler。
- 移除 PI 的 R2 secret 名、`pi.dev` announcement 和 PI installer 默认端点；使用 GitHub Release 作为第一版公开更新源。
- 保留固定 action 版本、provenance、shrinkwrap、install-lock 和 registry signature 检查。

**验证：**

```powershell
npm run check
npm run publish:dry
node scripts/local-release.mjs
bash scripts/build-binaries.sh --platform windows-x64
```

然后在隔离临时目录安装 tarball，运行 `euler --help`、`euler --version` 和 `euler --offline`。

**提交：** `build: produce Euler npm and standalone distributions`

## 11. 建立无网络、搜索和零遥测验收套件

**目标：** 把产品承诺变成 CI 门槛，而不是人工约定。

**新增文件：**

- `packages/coding-agent/test/e2e/euler-clean-home.test.ts`
- `packages/coding-agent/test/e2e/euler-network-audit.test.ts`
- `packages/coding-agent/test/e2e/euler-session-smoke.test.ts`
- `packages/coding-agent/test/e2e/euler-resource-smoke.test.ts`
- `packages/coding-agent/test/e2e/euler-web-smoke.test.ts`
- `scripts/check-euler-branding.mjs`
- `scripts/check-euler-network-policy.mjs`

**覆盖场景：**

- 隔离 HOME、无 API Key、无现有 PI/Euler 配置启动。
- 默认本地工具 `read/write/edit/bash` 的成功、失败、取消。
- 新建、恢复、树、Fork、Clone、Compact、导入、导出、分享的可离线部分。
- Prompt Template、Skill、Extension、Theme、Package 代表夹具。
- Exa 成功、回退 DuckDuckGo、双失败、摘要失败回退和 `/websearch` 模拟浏览器冒烟。
- 网络审计：普通离线启动 0 请求；普通在线启动除 Release 查询外 0 请求；搜索仅访问选择的 Provider 和抓取 URL。
- 所有请求无持久设备标识；日志、会话和快照无密钥。
- 用户可见品牌扫描无 PI 残留；许可证和上游说明不计为失败。

**验证：**

```powershell
npm run check
npm test
npm run check:browser-smoke
npm audit --omit=dev
```

**提交：** `test: add Euler release acceptance gates`

## 12. Windows x64 发布候选验收

**目标：** 在用户当前 Windows 机器验证真实安装体验。

**步骤：**

1. 从干净 checkout 运行全部检查。
2. 生成 npm tarball 和 Windows x64 standalone zip。
3. 使用临时 HOME 和临时 npm prefix 安装 tarball。
4. 分别验证 npm `euler` 与 `euler.exe`：帮助、版本、TUI、配置目录、会话恢复、资源加载和模拟搜索。
5. 在用户明确允许真实联网后，执行一次 Exa 成功路径和一次强制 DuckDuckGo 回退。
6. 保存脱敏验收日志与 SHA-256 校验值到 Release 草稿，不提交凭据或绝对用户路径。

**阻断条件：** Windows x64 任一安装方式失败、出现 PI 配置串读、出现安装遥测、默认搜索进入收费 Provider，均不得发布。

**提交：** `chore: prepare Euler v0.1.0 release candidate`

## 13. Ubuntu 24.04 x64 第一版服务器验收

**前置条件：** 用户另行明确授权 SSH 连接并提供认证方式；没有授权时不得连接。

**步骤：**

1. 仅上传候选 tarball、Linux x64 文件和校验值到临时目录。
2. 使用隔离 HOME/npm prefix，避免读取服务器已有配置。
3. 验证 npm 安装的 `euler --help`、`--version`、TUI 启动、配置创建、会话保存与恢复。
4. 验证 Linux x64 standalone 同样场景。
5. 真实验证 Exa MCP 与 DuckDuckGo 回退，记录 provider、耗时、来源数和退出码，不记录搜索正文中的敏感数据。
6. 删除服务器临时候选文件；保留脱敏测试结果和校验值。

**通过标准：** npm 与 standalone 两条路径全部通过，且没有 `.pi` 读取、收费 Provider、遥测或凭据泄漏。

## 14. 发布与上游维护

**发布顺序：**

1. 用户确认 npm 包名、GitHub 仓库公开状态和 `v0.1.0` 版本。
2. CI 重跑全部门槛。
3. 先生成 GitHub Release 草稿并上传已通过平台的产物。
4. npm trusted publishing 成功后发布 GitHub Release。
5. 仅把通过的平台列入 Release；Windows x64 必须存在。
6. 启动后的版本提示只指向该公开 Release。

**后续同步 PI：**

1. 建立 `sync/pi-<version>` 分支。
2. 查看从当前锁定 commit 到目标 commit 的完整差异。
3. 特别审计 system prompt、ExtensionAPI、模型目录、会话格式、网络请求和发布脚本。
4. 合并后重新生成 `docs/system-prompt-diff.md`。
5. 运行全部 PI 基线与 Euler 差异测试。
6. 人工批准后才能合入 Euler `main`。

## 15. 完成定义

只有同时满足下列条件，Euler 第一版才算完成：

- 正式规格 17 节的十项验收标准全部通过。
- `npm run check`、`npm test`、浏览器冒烟、audit、pack/install 和 Windows x64 standalone 验收全部通过。
- Ubuntu npm 与 Linux x64 standalone 验收通过。
- `rg` 审计确认运行时代码不读取 `PI_*` 或 `~/.pi`。
- 普通启动不存在安装/使用遥测；版本查询不带持久标识。
- 默认搜索只走 Exa MCP → DuckDuckGo，且不产生费用。
- PI 与 `pi-web-access` 许可证和第三方声明完整。
- 发布产物、文档、帮助、TUI 和命令统一使用 Euler 品牌。
