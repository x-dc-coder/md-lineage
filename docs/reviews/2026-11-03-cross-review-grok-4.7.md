---
mdlineage:
  schema: 1
  id: docs.reviews.2026-11-03-cross-review-grok-4-7
  kind: report
  status: archived
  authority: supporting
  created_at: 2026-11-03
  updated_at: 2026-11-03
---

# MDLineage 修复方案独立审查报告（Grok-4.7 席位）

审查对象：`/tmp/mdlineage-fix-plan.md`
对照代码版本：`/home/dc/projects/md-lineage`（validator / cli workspaces）
审查结论：**PASS WITH AMENDMENTS**

---

## 核心修正清单

四个缺陷的定位是正确的，缺陷 A 的插入点也可以直接落地；但按方案原文实现缺陷 B 和缺陷 C，会留下通道分裂，并让本仓 `baseline verify` 的 21 条规则 / 23 次出现立刻变红。下面的修正是合并前的必改项：

### 1. 缺陷 A：`intent.statuses`
- `intentDiagnostics()`（`packages/validator/src/layout.ts:193–271`）确实遗漏了 `statuses` 校验。
- 根目录 `schemas/diagnostic-codes.json` 里 MDL502 的描述仍把 status 归到 `intent.kinds` / `intent.authority`，需同步更新；通过 `copy-schemas.mjs` 自动同步。
- 明确多条 `layout` 规则是全部命中、不是后者覆盖。两条规则的 `statuses` 同时命中时，有效白名单是交集。

### 2. 缺陷 B：链接宇宙与通道统一
- **方案只改 CLI `knownWorkspacePaths()` 不够**：LSP（`server.ts:754`）、MCP `validate_repository`（`server-impl.ts:697`）、联邦成员、`retrieve` 都走 `scanWorkspaceUniverse`，不走 CLI 的 `knownWorkspacePaths`。只改 CLI 会让主仓 `check` 与 LSP/MCP 对同一条链接给出不同的 MDL401，违反通道同词汇原则。
- **必改设计**：
  - 新增 `inLinkUniverse`，不改动 `inUniverse` 的现有公开契约（`path-filter.test.ts:99`）。
  - 链接宇宙只去掉内置黑洞（`node_modules` / `dist` / `vendor`），仍尊重字面 `files.include` 和 `!` 否定（last-match-wins）。用户 `files.exclude`、CLI `--exclude`、`files.include` 收窄、gitignore **都不**把它移出链接宇宙。
  - 报告集继续用 `inReportSet`。硬剪枝拆成两套：链接遍历只剪不与否定/字面 include 冲突的内置黑洞；报告遍历保持现有的 `hardPrunePatterns()`。
  - `scanWorkspaceUniverse` 中：`knownPaths` 用 `inLinkUniverse`，`documents` 用 `inReportSet`。CLI、LSP、MCP、联邦成员同源生效。

### 3. 缺陷 C：基线频次对账
- 现行 v1 基线 `codes` 是路径集合（21 条规则 / 23 次出现），没有存储单文件内的出现次数。
- **无损兼容设计**：
  ```ts
  interface Baseline {
    version: 1; // 保持版本 1，旧版 CLI 忽略未知键
    codes: Readonly<Record<string, readonly string[]>>; // 形状不变
    occurrences?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  }
  ```
  - 缺省 `occurrences` 时保持无限抑制（存量 8 个项目零漂移，本仓 21/23 exit 0）。
  - 存在 `occurrences` 时按出现序消耗配额，超额或减少均报漂移并 exit 1。
  - 回合内的消费计数只放在 `suppressWithBaseline` 和 `diffAgainstBaseline` 的局部作用域，避免并发竞争。

### 4. 缺陷 D：文案与退出码
- `main.ts:467–469` 与 `fix.ts:151–153` 共用按规则来源选文案的函数。
- `compileRules` 时给每条规则打上 `default` / `config` / `cli` 标签，归因取最后一条命中规则的来源。
- 退出码收紧：至少有一个位置参数被归入 `excluded`，且没有任何 Markdown 进入报告集时，返回 exit 2；无参数或显式 `.` 的全仓扫描保持 exit 0。

### 5. 规范与层级计算
- `directoryDepth()` 是相对 match 前缀、去掉文件名后的目录层数：`docs/历史归档/2026-11/a.md` 对 `docs/历史归档/**` 的深度是 **1**（不是 2）。要封住「分类 + 一个月桶」、禁止再下一层，`maxDepth` 必须写 **1**。
