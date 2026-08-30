# Euler 发布流程

> 对应任务：实施计划第 10 阶段「重命名构建、安装和发布产物」
> 状态：v0.1.0 发布前待办事项在文末列出

## 发布通道

| 通道 | 产物 | 来源 |
|------|------|------|
| npm 全局安装 | `euler-agent` 与 8 个 `@zhongchongba/euler-*` 支持包，提供 `euler` 命令 | `publish-npm` job（trusted publishing） |
| GitHub Release | `euler-<platform>.tar.gz / .zip` 独立可执行文件、source archive、SHA256SUMS | `build` + `stage-github-release` job |
| 版本检查 | `https://api.github.com/repos/zhuchongba-01/euler/releases/latest`（可用 `EULER_SKIP_VERSION_CHECK` 关闭） | `packages/coding-agent/src/utils/version-check.ts` |
| 模型目录发布 | Euler model catalog JSON | `publish-model-catalog.yml`，使用 `EULER_ARTIFACTS_R2_*` secrets |

## 触发方式

发布由 tag 驱动：`release.mjs` 准备版本与 changelog，推送 `v*` tag 后 `build-binaries.yml` 自动执行：

1. **build** — 生成 source archive（`euler-<version>-source.tar.gz`），从中构建六个平台的独立二进制，产出统一命名为 `euler-<platform>.tar.gz`（Unix）/ `euler-<platform>.zip`（Windows），二进制名为 `euler` / `euler.exe`
2. **smoke-test-binaries** — 六个平台分别运行 `--help` / `--version` 冒烟，通过后上传 `smoke-ok-<platform>` 标记
3. **stage-github-release** — 校验产物集合与校验和，剔除没有冒烟标记的平台产物并重算 SHA256SUMS，建立草稿 Release
4. **publish-npm** — 按依赖顺序打包并发布 9 个 Euler npm 包
5. **publish-github-release** — 校验通过后把草稿 Release 转正

## 平台发布策略

- **Windows x64 是硬门槛**：冒烟失败会阻塞整个发布（`allow_failure: false`）
- 其余平台（linux-x64、linux-arm64、darwin-x64、darwin-arm64、windows-arm64）允许失败：对应产物被剔除、不阻塞发布，修复后随下个版本补发
- 没有冒烟标记的平台产物永远不会进入 Release

## 本地验证

```bash
npm run check                 # lint、类型、shrinkwrap、lock 一致性
npm test                      # 全量测试（跳过需要 API key 的用例）
npm run build:offline         # 离线全量构建
node scripts/local-release.mjs  # 本地打隔离 npm / Bun 安装包
bash scripts/build-binaries.sh --platform windows-x64 --out out  # Windows 产物
```

Windows 开发机没有 Git Bash 或 Bun 时，可先只验证 npm 包分发路径：

```powershell
npm run release:local -- --out C:\tmp\euler-local-release --force --skip-test --skip-binary --skip-bun-install
C:\tmp\euler-local-release\node\euler.cmd --help
C:\tmp\euler-local-release\node\euler.cmd --version
```

构建产物一致性由 `test/euler-package-artifact.test.ts` 守护：bin 只有 `euler`、tarball 含 bundle/LICENSE/内置提示词/shrinkwrap、脚本与 workflow 中不存在 `pi-*` 产物名、Windows 冒烟硬门槛。

## 许可与第三方声明

- npm tarball 内含 `dist/LICENSE`（MIT）与 `THIRD_PARTY_NOTICES.md`（PI 与 pi-web-access 出处）
- `THIRD_PARTY_NOTICES.md` 随每次同步上游核对版本号

## 首次发布

npm 的 trusted publisher 必须在目标包已经存在后才能配置。因此首次
`0.1.0` 先在完成本地验收后从发布者已登录的终端执行
`node scripts/publish.mjs`，一次发布全部 Euler 包。随后运行
`npm run release:initial` 创建并推送 `v0.1.0`；CI 会验证已经发布的包并
发布 GitHub Release。

首次发布完成后，在 npm 的 `euler-agent` 包设置中添加 trusted publisher：
GitHub owner `zhuchongba-01`、repository `euler`、workflow
`build-binaries.yml`、environment `npm-publish`。后续版本使用
`npm run release:patch` 或 `npm run release:minor`，由 GitHub Actions 发布。
