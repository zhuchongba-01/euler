# Euler 与 PI 资源生态兼容性

> 对应任务：实施计划第 9 阶段「完成 PI 资源生态兼容与透明查看」
> 基线：PI `0.84.3` / `56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4`

Euler 以 PI 为下游发行版，PI 生态的绝大多数资源无需修改即可在 Euler 中使用。本文说明哪些可以直接复用、哪些需要适配，以及 Euler 如何避免静默读取 PI 的私有配置。

## 资源格式：完全兼容

以下资源格式与 PI 0.84.3 保持一致，文件语义、目录优先级（全局 `~/.euler/agent/` → 项目 `.euler/` → 显式路径）和冲突规则均未改变：

| 资源 | 全局位置 | 项目位置 | 说明 |
|------|----------|----------|------|
| Prompt Template | `~/.euler/agent/prompts/` | `.euler/prompts/` | frontmatter 的 `description`、`argument-hint`、`$1`/`$@`/`$ARGUMENTS` 参数展开全部保留 |
| Skill | `~/.euler/agent/skills/` | `.euler/skills/` | `SKILL.md` + YAML frontmatter；名称冲突时全局优先并产生 collision 诊断 |
| Extension | `~/.euler/agent/extensions/` | `.euler/extensions/` | TypeScript 工厂函数；`pi.registerCommand` / `pi.registerTool` 等 API 不变 |
| Theme | `~/.euler/agent/themes/` | `.euler/themes/` | JSON 主题格式不变 |
| Package | `~/.euler/agent/settings.json` 的 `packages` | 项目 settings | `package.json` 中 `pi` manifest（extensions/skills/prompts/themes）不变 |

多资源 Package（一个包同时带 Extension、Skill、Prompt、Theme）的发现与加载规则与 PI 相同。

## ExtensionAPI：类型快照锁定

`ExtensionAPI` 及相关公共类型通过快照测试锁定（`test/euler-resource-compat.test.ts` + `test/fixtures/euler-extension-api-snapshot.txt`）。快照取自 PI 基线 commit `56f3f33` 的 `src/core/extensions/types.ts` 导出面（153 个声明）。任何对公共类型面的增删都会使测试失败，保证面向扩展作者的 API 与 PI 保持一致。

## 关键差异：路径与配置目录

Euler 的配置根目录是 `~/.euler/agent`，项目级目录是 `.euler/`。Euler **不读取** `.pi/` 目录和 `PI_*` 环境变量；PI 的同名资源不会被继承。

已有 PI 资源的迁移方式（手动即可）：

```bash
# 复制全局资源
mkdir -p ~/.euler/agent
cp -r ~/.pi/agent/skills ~/.pi/agent/prompts ~/.pi/agent/extensions ~/.pi/agent/themes ~/.euler/agent/
# settings.json 中的 packages 列表可按需手工合并
```

项目级资源将 `.pi/` 目录重命名为 `.euler/` 即可。

## 第三方扩展的 PI 引用诊断

写死了 `PI_*` 环境变量或 `.pi` 路径的第三方扩展在 Euler 中**不会静默读取 PI 数据**。扩展加载器会扫描每个文件型扩展的入口源码（inline 内置扩展除外），发现 PI 引用时产生 `warning` 级诊断，例如：

```
Extension references PI configuration (PI_CODING_AGENT_DIR, .pi/agent).
Euler does not read PI configuration or ~/.pi; update the extension to use
Euler paths (~/.euler/agent) and EULER_* environment variables.
```

诊断随 `LoadExtensionsResult.diagnostics` 暴露。修复方式：把 `.pi` 路径改为 `~/.euler/agent`，把 `PI_*` 变量改为对应的 `EULER_*` 变量（对照 `src/euler-env.ts` 中的映射）。

## 兼容性验证

以下测试持续保证本文件所述行为：

- `test/euler-resource-compat.test.ts`：干净 HOME 零资源、PI 项目资源不串读、代表性资源加载、ExtensionAPI 快照、PI 引用诊断
- `test/euler-branding.test.ts` / `test/euler-config-isolation.test.ts`：品牌与配置隔离
- `test/euler-env.test.ts`：`EULER_*` 环境变量契约

## 已知边界

- 内置扩展（`llama.cpp`、`Euler Web Access`）为 Euler 自有模块，不参与 Package 清单，也无法被 `euler remove` 卸载（见实施计划第 6 阶段）。
- Euler 发布自己的 npm Workspace 包；第三方扩展应改用 `euler-agent` 和
  `@zhongchongba/euler-*` 导入路径。
- 扩展加载器的 PI 引用扫描仅覆盖扩展入口文件；扩展运行时再动态拼接 `.pi` 路径不在扫描范围内。
