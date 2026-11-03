---
mdlineage:
  schema: 1
  id: docs.reviews.2026-11-03-cross-review-glm-5-3
  kind: report
  status: archived
  authority: supporting
  created_at: 2026-11-03
  updated_at: 2026-11-03
---

# MDLineage 修复方案独立审查报告（GLM-5.3 席位）

审查对象：`/tmp/mdlineage-fix-plan.md`
对照代码版本：`/home/dc/projects/md-lineage`（validator / cli workspaces）
审查结论：**PASS WITH AMENDMENTS**

---

## 1. 方案合理性与完备性

**Bug A（intent.statuses 失效）——根因分析准确，修复切中要害。**
已核对 `packages/validator/src/layout.ts:193-270` 的 `intentDiagnostics()`：确实只实现了 `kinds`、`authority`、`forbidStatus`、`maxDepth`、`naming` 五个分支，`statuses` 完全缺失；方案给出的 push502 补丁与既有 `intent.kinds` 分支（layout.ts:226-231）风格一致，`data` 字段（`rule/status/allowed`）可测试性好。结论：分析成立，修法正确。

**Bug B（files.exclude 误报 MDL401）——根因分析准确，但修复点覆盖不完整。**
已核对 `packages/cli/src/paths.ts:76`：`knownWorkspacePaths()` 确实用 `filter.inUniverse(clean)` 过滤，而 `path-filter.ts:183` 的 `inUniverse` 就是 `!excludedByRules(path, this.rules)`，用户级 `files.exclude` 直接把真实文件踢出链接解析宇宙——根因成立。**但方案遗漏了第二个同类病灶：`expandMarkdownPaths()` 的 `others` 收集**（paths.ts:183：非 md 文件走 `inUniverse`，md 文件走 `inReportSet` 后未入 found）。当用户显式 `mdlineage check docs/report.md` 时，known paths 部分来自 `others`，被排除的非 md 目标同样会在单文件检查中误报 MDL401。修复必须同时覆盖 `knownWorkspacePaths()` 与 `expandMarkdownPaths()` 的非 md 分支，否则 Bug B 只修了一半。

**Bug C（基线频次穿透）——根因准确，但方案自相矛盾且存在硬伤。**
`baselineMatches`（baseline.ts:84-87）确实仅做 `(code, path)` 成员判断，同文件新增同类违规被静默吞掉，`verifyBaseline`（packages/cli/src/baseline.ts:361-395）只对账 `reported/stale`——根因成立。但方案存在内部矛盾：既宣称“保持 v1 格式完全兼容（`codes: Record<string, string[]>`）”，又要求“实际违规次数 > 基线生成时的发生次数时判漂移”。**v1 文件里根本没有存储生成时的频次**——运行时只能数出“当前 M 次”，无从得知“预期 N 次”。`+ ${path} ${code} (new occurrence: expected N, found M)` 这行输出在纯 v1 格式下无法实现，除非硬编码 N=1 或 N=∞，前者会立刻打破现有 8 个项目的基线，后者等于没修。另外方案把改动定位在 `packages/validator/src/baseline.ts`，但 `verifyBaseline` 实际在 `packages/cli/src/baseline.ts:361`，文件归因有误。

**Bug D（归因与退出码）——分析准确，修复方向正确但细节需收紧。**
已核对 `packages/cli/src/main.ts:467-471` 的硬编码文案属实。需注意 `--exclude` 是通过 `extraExclude` 合入 `PathFilter.rules` 的（path-filter.ts:146），要在 `excluded` 归因中区分 `config-exclude` 与 `cli-exclude`，必须给 `compileRules` 的规则对象增加来源标记并在 `excludedByRules` 匹配时透出第一个命中规则的 origin——这不是 `paths.ts` 单方面能完成的，方案低估了改动面。

---

## 2. 向后兼容与破坏性风险

**Bug C 是本方案最大的破坏性风险点，按现方案落地会直接打破存量基线：**
- 现有 8 个项目的 `.mdlineage-baseline.json` 均为 v1 无频次格式。若回退语义取“缺省 expected=1”，任何基线登记时同文件本就有 ≥2 条同类违规的项目（这在 MDL001/MDL401 类高频债务中非常常见）会立即 `verify` exit 1。
- 方案自己的验收标准写着“严格保持 21 条规则 / 23 次出现不发生非预期漂移”，而 23 次出现 > 21 条 (code, path) 规则，**已经证明存量基线中存在同键多 occurrence**。

**建议的无损兼容实现：**
1. 保持 `BASELINE_VERSION = 1`，序列化时在 v1 键之外增加可选 `occurrences?: Record<code, Record<path, number>>`；v1 文件照常解析为 `Baseline`，`occurrences` 缺省。
2. v1 基线（无频次）保持现有行为不变（无限抑制），存量 8 项目零破坏。
3. 只有带 `occurrences` 时启用频次守护：`suppressWithBaseline` 按出现序消耗配额，`verifyBaseline` 对账 `found > expected` 报 new occurrence 并 exit 1。
4. 本仓库自身的 21 条规则基线运行 `baseline update` 升级到带频次，即可满足“23 次出现不漂移”。

---

## 3. 边界场景与遗漏

- **Bug B 边界**：必须同时覆盖“全仓 check”与“显式单文件/目录 check（走 `expandMarkdownPaths` 的 `others`）”两条链路；
- **Bug A 边界**：`statuses` 与 `forbidStatus` 并存时，有效白名单是交集；
- **Bug D 边界**：归因需要在 `compileRules` 产物上携带 origin（builtin/config/cli），`excludedByRules` 返回命中规则来源。
