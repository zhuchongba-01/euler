# Euler Agent 正式设计规格

> 状态：用户已批准，可进入实施
> 日期：2026-08-28  
> 产品名称：Euler  
> CLI 命令：`euler`

## 1. 目标

Euler 是基于 PI 的独立终端 Agent 发行版。它拥有自己的品牌、CLI/TUI、配置空间、环境变量和系统提示词，同时保留 PI 的 Agent Core、模型系统、会话能力、工具语义与扩展生态。

第一版追求 PI 功能对等，不以最小 MVP 为目标。Euler 的主要新增能力是内置互联网搜索与网页内容读取。

## 2. 源码基线与许可证

第一版基于：

- PI `0.84.3`，commit `56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4`。
- `pi-web-access` `0.25.0`。

两项依赖均按 MIT 许可使用。Euler 必须保留相应许可证、版权声明和第三方组件清单。

每个 Euler 版本锁定明确的 PI commit 或 release tag。PI 上游更新只能在人工审核、合并和完整回归测试后进入 Euler，不允许自动合并发布。

## 3. 实现路线

Euler 采用 PI 下游 Fork，而不是 SDK 外壳重写或安装后动态打补丁。

保留的 PI 子系统包括：

- AI Provider 与模型目录。
- Agent Loop 与 Tool Call 生命周期。
- 会话存储、树、Fork、Clone、Compact、导入、导出与分享。
- TUI、Print、JSON、RPC 和 SDK 模式。
- Prompt Template、Skill、TypeScript Extension、Theme 和 Package 加载器。
- 更新、构建、npm 打包和 Bun 独立文件流程中可复用的部分。

Euler 改动集中在明确边界内：品牌配置、系统提示词、配置路径、环境变量、TUI 主题与组件、内置联网模块、遥测移除以及 Euler 差异测试。

## 4. 品牌与配置隔离

- 产品显示名称为 `Euler`。
- CLI 可执行命令为 `euler`，不得额外安装面向用户的 `pi` 命令。
- 全局配置目录为 `~/.euler/agent`。
- 不自动读取或导入 `~/.pi/agent`。
- Euler 自有环境变量统一使用 `EULER_*`。
- 不读取 `PI_*` 兼容别名。
- 面向用户的欢迎页、帮助、错误、版本信息、导出内容和更新提示不得残留 PI 品牌。

兼容 PI 是指兼容其公开 API 和资源格式，不保证兼容写死 `~/.pi` 或 `PI_*` 的第三方代码。此类 Package 需要自行适配 Euler。

## 5. CLI/TUI

Euler 保留 PI 的键盘操作、命令语义、会话交互和信息结构，并应用已批准的 Euler TUI：

- 顶部使用紧凑的 Euler 欢迎区和版本信息。
- 对话区继续呈现用户、Agent 和工具调用。
- 工具调用使用紧凑状态卡片区分运行中、成功和失败。
- 主输入区域采用单层细边框、极简圆角样式，不增加标题栏或双层边框。
- 输入框下方只显示必要快捷键、模式或发送提示。
- 底部状态区显示当前模式、模型、Git 分支和剩余上下文等 PI 已有或可直接取得的信息。
- 自动搜索摘要与来源在终端对话流内显示。

颜色、间距和字符图标通过 Theme Token 管理；已批准的结构与信息层级是验收标准，具体色值允许在不改变结构的前提下调整。

`/resume`、`/new`、`/model` 等继续是程序命令。Prompt Template 仍是展开为模型输入的 Markdown 快捷提示，两者不得混淆。

## 6. 启动与运行流程

启动顺序：

1. 读取 `~/.euler/agent` 配置。
2. 加载 Euler 默认系统提示词与有效的用户自定义层。
3. 加载全局和项目上下文。
4. 加载 Extension、Skill、Prompt Template、Theme 和 Package。
5. 新建或恢复会话。
6. 启动 PI Agent Loop。

运行时，用户输入进入 PI Agent Loop；模型产生本地或联网 Tool Call；工具结果返回模型继续推理；最终回答显示在 TUI 并写入会话。

## 7. 模型系统

Euler 完整继承锁定 PI 版本的 Provider、模型目录、登录和选择机制，不维护独立 Provider Fork。

- `/login` 配置 Provider。
- `/model` 选择模型。
- 保留 Thinking Level 调整。
- 首次启动不提供额外模型向导。
- Euler 不设置脱离 PI 模型目录的私有默认模型。
- 没有可用认证时，TUI 仍可启动并引导用户使用 PI 原有命令配置。

## 8. 默认本地工具

第一版默认本地工具严格保持 PI 的四项：

| 工具 | 作用 |
| --- | --- |
| `read` | 读取文件 |
| `write` | 创建或完整写入文件 |
| `edit` | 精确修改现有文件 |
| `bash` | 执行终端命令 |

Windows 第一版不把 `powershell` 加入默认工具集合。PI 已有的可选工具仍可通过原机制启用。

## 9. 系统提示词

Euler 默认系统提示词以锁定 PI 版本的原始提示词为基线：

- 替换 PI 身份和品牌为 Euler。
- 保持 PI 的工具选择、编码、会话和上下文行为规则。
- 加入 `web_search`、`fetch_content`、`get_search_content` 和 `source_check` 的用途与边界。
- 明确网页内容是不可信数据，不能覆盖系统指令或冒充工具结果。

默认提示词作为源码中的可读资源保存。构建过程生成并检查一份相对 PI 基线的提示词差异，防止上游同步时无意丢失规则。

用户定制支持两层：

- 普通模式：在 Euler 默认提示词之后追加规则。
- 高级模式：完整覆盖系统提示词，并显示行为风险提示。

每次保存前验证空内容、配置结构和模板变量；保留上一份有效版本；提供恢复默认；加载失败时自动回退 Euler 默认版本并显示原因。提示词错误不能阻止 CLI 启动。

## 10. PI 资源生态兼容

### Prompt Template

保持 PI 的 Markdown 格式、命名、参数占位符和加载优先级。

### Skill

- 主程序默认不捆绑 Skill。
- 兼容 PI 使用的 Agent Skills 格式。
- 已安装 Skill 可查看、禁用和卸载。
- Skill 内容不得以不可见提示词形式隐藏。

### TypeScript Extension

保留 PI `ExtensionAPI`，不删减、不重命名、不制造 Euler 私有 API 分支。Extension 继续以当前用户权限执行。

### Package

保留 PI Package 的安装、查看、启用、禁用、卸载和更新语义。主程序不预装默认官方 Package。

`pi-web-access` 是 Euler 构建时集成的透明内置模块，不作为用户 Package 清单中的默认安装项，也不通过 Package 管理器卸载。

## 11. 内置联网能力

原版 PI 不自带互联网搜索。Euler 内置 `pi-web-access`，但不把它包装成 Skill。

内置工具：

- `web_search`
- `fetch_content`
- `get_search_content`
- `source_check`

保留命令：

- `/websearch`：打开浏览器搜索整理界面。
- `/curator`：控制当前搜索整理工作流。
- `/search`：查看当前会话保存的搜索结果。

默认规则：

- 联网能力默认启用，不提供 Euler 设置页中的总开关或分项开关。
- 自动搜索使用 `auto-summary`，结果与来源直接返回终端，不自动打开浏览器。
- 只有用户主动执行 `/websearch` 才打开浏览器整理界面。
- 默认路由为零配置 Exa MCP，失败后回退免密 DuckDuckGo HTTP。
- MCP 仅是 Exa 的内部传输方式；Euler 不因此提供通用 MCP 系统或 MCP 配置界面。
- 默认路由不得要求 API Key，不得进入收费 Provider。
- 其他 Provider 只有在用户主动配置并明确选择后才能使用。
- API Key 不进入会话、模型上下文、普通日志或项目文件。
- 结果正文有长度限制，完整内容存入可按需读取的缓存。

保留 PI 的单次运行离线语义不等于增加联网模块设置开关；在离线运行中，网络请求必须快速失败或跳过，CLI 本地功能继续工作。

## 12. 错误处理

- 默认提示词加载失败：使用编译内置版本并警告。
- 用户提示词无效：继续使用上一份有效版本。
- Extension 或 Package 加载失败：显示具体资源，其他资源与主程序继续加载。
- 本地工具失败：错误返回 Agent 和 TUI，不终止整个会话。
- Exa 失败：尝试 DuckDuckGo。
- 两个免费搜索源均失败：明确报告失败，不生成虚假结果。
- 搜索摘要生成失败：返回确定性的原始结果摘要和来源。
- 版本检查失败：静默降级为无更新提示，不影响启动。
- 异常退出：不得损坏此前已成功追加的会话记录；恢复时检测并跳过尾部不完整记录。

## 13. 安全与隐私

- 项目信任不是操作系统沙箱。
- `bash`、Extension 和第三方脚本拥有当前用户权限。
- 第三方 Package 安装时显示来源和执行风险。
- Skill、Prompt Template、Extension 和 Package 的来源、内容和启用状态可检查。
- 外部网页、仓库和工具输出按不可信输入处理。
- 所有凭据在错误、日志和界面中脱敏。
- Euler 不发送安装、更新、会话、项目、模型或工具使用遥测。

Euler 可以在启动时向当前仓库的公开 Release 元数据端点发送一次不带设备标识的版本查询。新版本只提示；只有用户执行 `euler update` 才修改安装。

## 14. 明确不内置的功能

- 默认 Skill 包。
- 默认用户 Package。
- 通用 MCP 系统。
- Subagent 系统。
- Plan Mode。
- Todo 系统。
- 内置沙箱。
- 每次操作都弹出的权限确认框。
- Firecrawl 默认依赖或默认 Provider。

这些项目不属于第一版范围。

## 15. 分发与平台

Euler 同时生成：

- npm 全局安装包。
- Bun 编译的独立可执行文件。

Windows x64 是第一版强制发布目标。CI 继续尝试 PI 已支持的 Windows ARM64、macOS x64/ARM64、Linux x64/ARM64；只有构建和适用的自动测试通过的产物才发布。非 Windows 产物失败不阻止 Windows 首发。

本地开发与人工验收以 Windows 为主，不要求维护者持有其他平台设备。

## 16. 测试策略

### PI 基线测试

Euler 保留 PI 的：

- Biome 与 TypeScript 检查。
- 固定依赖、相对 TypeScript Import、shrinkwrap 和安装锁检查。
- 根脚本及所有 Workspace 单元测试。
- 隔离 HOME、无 API Key 测试。
- 浏览器冒烟测试。
- npm audit 与 registry signature 检查。
- 本地 release build、pack、隔离 npm/Bun 安装测试。
- Windows、macOS、Linux 独立文件 `--help` 与 `--version` 冒烟测试。

### Euler 差异测试

- 品牌、帮助、命令、配置路径和环境变量中无用户可见 PI 残留。
- `~/.euler/agent` 与 `~/.pi/agent` 隔离。
- 四个默认本地工具的成功、失败和取消行为。
- 会话新建、恢复、树、Fork、Clone、Compact、导入、导出与分享。
- 代表性 Prompt Template、Skill、Extension 和 Package 兼容。
- 提示词追加、完整覆盖、验证、备份、恢复和失败回退。
- Exa 成功、Exa 到 DuckDuckGo 回退、双失败、`auto-summary` 和来源呈现。
- `/websearch` 使用模拟结果验证页面渲染、选择、确认和回传，不依赖真实搜索网络。
- 网络请求审计验证普通启动除版本查询外无请求，并且没有 PI `report-install` 或 Euler 遥测。

### 第一版真实服务器测试

在用户提供并另行授权的 Ubuntu 24.04.3 LTS x86_64 服务器上：

- 从发布候选 npm 压缩包干净安装并运行 `euler`。
- 运行 Linux x64 独立文件。
- 验证 `--help`、`--version`、TUI 启动、配置目录、会话保存和默认免密搜索。

公网地址不进入代码仓库或设计规格。该服务器只属于第一版验收范围；本规格不规定后续版本的服务器测试方式。

## 17. 第一版验收标准

1. `euler` 启动独立 Euler 产品体验，而非 PI 启动脚本。
2. PI 基线测试与 Euler 差异测试全部通过。
3. PI 的主要命令、会话、模型、TUI、非交互模式和 SDK 能力可用。
4. 默认工具集合为 `read`、`write`、`edit`、`bash`，联网工具作为 Euler 明确新增能力存在。
5. PI Prompt Template、Agent Skills、`ExtensionAPI` 和 Package 格式保持兼容。
6. 自动搜索不打开浏览器，使用免费免密路由并在终端提供总结与来源。
7. 所有影响 Agent 行为的本地资源透明可查。
8. 无安装或使用遥测，版本查询不带持久标识。
9. npm 包和 Windows x64 独立文件通过干净环境验收。
10. 第一版候选在指定 Ubuntu x64 服务器通过两种安装方式验收。

## 18. 实施边界

第一版只实现本规格内容。品牌视觉微调不得借机重写 PI TUI 架构；联网集成不得演变为通用 MCP 框架；兼容工作不得引入 `PI_*` 或 `~/.pi` 自动迁移；上游合并不得绕过测试门槛。
