# 上游同步规则（PI → Euler）

> 对应任务：实施计划第 1 阶段「建立可持续同步的 PI 下游分支」、第 14 阶段「发布与上游维护」

Euler 是 [earendil-works/pi](https://github.com/earendil-works/pi)（下称 PI）的下游发行版，保留完整 Git 历史以便持续人工合并上游。

## 当前锁定

| 项 | 值 |
|------|------|
| 基线 commit | `56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4`（PI 0.84.3） |
| 上游 remote | `upstream` → `https://github.com/earendil-works/pi.git`（fetch-only，push 已禁用） |
| 搜索基线 | `pi-web-access` `0.25.0`（已内嵌为 `src/extensions/web-access/`） |
| 恢复点 | `design-approved` 分支（批准设计时的文档快照） |

核实锁定状态：

```bash
git merge-base --is-ancestor 56f3f33a9a675ef2a2c30cf2e35a6a385cdf2ed4 HEAD
git remote -v
```

## Euler 与上游的边界

**复用上游（随合并更新）**：Agent 核心、会话系统、模型适配（`packages/ai`）、工具系统、TUI 库（`packages/tui`）、Extension 机制、Package 语义、遥测 NOOP 契约。

**Euler 自有层（合并时需要审计保护）**：

- 品牌与入口：`piConfig`（name/title/configDir）、`euler` bin、欢迎区与 TUI 外观
- 配置隔离：`~/.euler/agent`、`.euler/`、`src/euler-env.ts`（`EULER_*` 变量契约）
- 系统提示词：`src/prompts/euler-system.md` + `src/core/system-prompt-manager.ts`
- 内置 web access：`src/extensions/web-access/`（`Euler Web Access`，hidden）
- 隐私策略：无遥测、无标识版本检查（`src/utils/version-check.ts`）
- 构建发布：`euler-*` 产物命名、平台发布策略（`.github/workflows/build-binaries.yml`）

## 同步流程

PI 发布新版后：

1. 从当前锁定 commit 建 `sync/pi-<version>` 分支，合并上游目标 tag。
2. 审读完整差异，特别审计：system prompt、`ExtensionAPI` 类型面（快照测试会失败提醒）、模型目录、会话格式、网络请求点（对照 `scripts/check-euler-network-policy.mjs`）、发布脚本。
3. 解决 `euler-system.md`、`euler-env.ts`、web access 适配层的冲突；跑 `node scripts/check-euler-system-prompt.mjs --check` 重新生成 `docs/system-prompt-diff.md`。
4. 运行全部 PI 基线测试与 Euler 差异测试（`npm run check`、`./test.sh`）。
5. 人工批准后合入 Euler `main`，更新本文件的"当前锁定"表。

## 相关文档

- `docs/compatibility.md`：资源格式兼容与第三方扩展 PI 引用诊断
- `docs/releasing.md`：发布流程与产物命名
- `THIRD_PARTY_NOTICES.md`：PI 与 pi-web-access 的许可证声明（合并后核对版本号）
