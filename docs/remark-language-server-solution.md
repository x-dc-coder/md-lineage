# MDLineage 基于 remark-language-server 的实时校验方案

## 1. 结论与架构决策

MDLineage 将采用 `remark-language-server` 作为第一阶段的实时诊断宿主，并把专有元数据规则实现为独立、可复用的校验核心。

最终形态不是长期依赖多个零散编辑器插件，而是形成统一工具链：

```text
                          @mdlineage/validator
                     解析、Schema、规则、仓库索引
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
      remark adapter       mdlineage CLI       mdlineage LSP
      第一阶段实时诊断      hooks / CI / AI      最终编辑器服务

      mdlineage MCP（与 LSP 并列，同样复用 validator）
```

对外分为两个阶段：

1. 近期：编辑器启动 `remark-language-server --stdio`，加载 `remark-lint-mdlineage`；CLI 使用相同规则做保存后及 CI 校验。
2. 最终：用户只安装一个 `mdlineage` 程序，通过 `mdlineage server --stdio`、`mdlineage check` 和 `mdlineage mcp` 获得完整能力。

`remark-language-server` 是快速交付实时诊断的宿主和长期兼容入口；最终专用 LSP 继续复用 remark/unified 的 Markdown AST 和同一校验核心，但不受 remark LSP 只擅长 lint/format 的能力限制。

## 2. 目标与非目标

### 2.1 目标

- 实时报告普通 Markdown、YAML Front Matter 和 MDLineage 元数据问题。
- 返回精确文件、行、列、稳定诊断码和可操作说明。
- CLI、LSP、CI、Git hook、MCP 和大模型调用使用同一套结果。
- 支持自定义文档类型、状态、关系词表、字段和严重级别。
- 支持 ID 唯一性、relation target、evidence anchor、链接等跨文件检查。
- 保留其他工具写入的未知 Front Matter 顶层字段。
- 权威校验确定、离线、可复现；LLM 只提供 proposal，不决定校验结果。

### 2.2 非目标

- 不在实时校验链路中调用网络、嵌入模型或 LLM。
- 不把相似度推断直接写成权威关系。
- 不在未确认时自动修改 `id`、`target` 或关系方向。
- 不把编辑器 Problems 面板作为大模型生成后的唯一门禁。
- 不在第一阶段引入图数据库。

## 3. 为什么选择 remark-language-server

`remark-language-server` 能加载 remark 配置和插件，并将插件产生的 `VFileMessage` 转换为 LSP diagnostics。选择它的原因是：

- 使用标准 LSP，可服务 VS Code、Neovim、Vim、Emacs 等编辑器。
- Markdown 被解析为 mdast，而不是只靠正则逐行判断。
- 普通 lint、GFM、Front Matter、自定义规则可以放在同一管线。
- `remark-cli` 与 Language Server 复用 `.remarkrc.mjs`，减少编辑器与 CI 规则漂移。
- 自定义插件能访问未保存的缓冲区内容，实现输入时反馈。

必须同时承认它的边界：

- remark 插件最自然的作用域是单文档。
- 它不直接提供 target 补全、ID 跳转、引用查找、安全重命名等 MDLineage 能力。
- 插件自行管理文件监听、多缓冲区 overlay 和增量索引会逐渐复杂。

因此，近期用 remark LSP 完成实时 lint，最终由专用 MDLineage LSP 管理仓库索引和语言智能。

## 4. 校验规则分层

### 4.1 通用 Markdown 层

由标准 remark 规则负责：

- 标题层级、重复标题。
- 列表缩进、空行、尾随空格。
- 围栏代码块及语言标识。
- GFM 表格、任务列表、删除线、自动链接。
- Markdown 链接基本语法。

这类诊断保留 remark 原有规则 ID，source 为 `remark`。

### 4.2 Front Matter 语法层

MDLineage 插件显式检查：

- Front Matter 是否位于文件开头。
- 起始和结束 `---` 是否成对。
- YAML 是否可解析。
- 是否存在重复 key、tab 缩进或不安全类型。
- 配置要求时是否缺少 Front Matter。

不能只依赖 `remark-frontmatter`。Markdown 对不完整结构可能降级为普通文本，因此要在 AST 解析前增加轻量边界扫描器。

### 4.3 元数据 Schema 层

JSON Schema 负责单文件结构：

- 顶层 `mdlineage` 对象是否存在。
- `schema` 是否为支持版本。
- `id`、`kind`、`status` 等必填字段及类型。
- `status`、`authority`、relation type 枚举。
- `topics`、`aliases` 元素为非空字符串。
- 每个 relation 至少有 `type`、`target`（`reasonRequired: true` 的关系同时要求非空 `reason`——该结构性检查归 Schema 层；仓库级关系语义缺 reason 的完整判定归 `MDL304`，见 §8.1）。
- ID pattern、字符串长度、数组去重。

兼容策略：

- Front Matter 顶层 `additionalProperties: true`，兼容其他工具字段。
- `mdlineage` 命名空间默认 `additionalProperties: false`，发现大模型拼错字段。
- 仓库可通过 Schema 扩展点增加自定义字段，但不能静默改变已有字段语义。
- Schema 按版本保存，例如 `schemas/mdlineage-v1.schema.json`。

### 4.4 单文档语义层

- `id` 是否符合仓库命名规则。
- relation `reason` 是否为空或无意义。
- `evidence` 指向的当前文档标题锚点是否存在。
- 是否重复声明同一关系。
- 本地 Markdown link 是否明显无效。
- deprecated 文档是否缺少替代提示。

### 4.5 仓库语义层

- `id` 是否全仓库唯一。
- relation target 是否恰好解析到一个文档。
- target 的 kind/status 是否符合关系策略。
- 跨文件 anchor 是否存在。
- 删除、移动、改 ID 后是否留下失效引用。
- `supersedes` 等配置为无环的关系是否形成环。
- 关系是否违反 source-kind/target-kind 矩阵。

仓库语义不能在每次按键时重新扫描整个仓库。

## 5. 建议的项目结构

第一阶段建议使用 TypeScript ESM，与 remark、LSP 和 JSON Schema 生态保持一致，并锁定一个受支持的 Node.js LTS 版本。

```text
md-lineage/
├── package.json
├── .remarkrc.mjs
├── mdlineage.config.yaml
├── schemas/
│   ├── mdlineage-v1.schema.json
│   └── mdlineage-config.schema.json
├── packages/
│   ├── validator/
│   │   ├── src/parse-markdown.ts
│   │   ├── src/parse-frontmatter.ts
│   │   ├── src/schema-validator.ts
│   │   ├── src/document-validator.ts
│   │   ├── src/workspace-index.ts
│   │   ├── src/workspace-validator.ts
│   │   ├── src/diagnostic.ts
│   │   └── src/config.ts
│   ├── remark-lint-mdlineage/
│   │   └── src/index.ts
│   ├── cli/
│   │   └── src/main.ts
│   ├── language-server/
│   │   └── src/server.ts
│   └── mcp-server/
│       └── src/server.ts
└── test/
    ├── fixtures/
    ├── diagnostics/
    └── lsp/
```

依赖方向必须保持单向：

```text
remark adapter ─┐
CLI ────────────┼──> validator
LSP ────────────┤
MCP ────────────┘
```

各包的发布名统一为 `@mdlineage/*`（`@mdlineage/validator`、`@mdlineage/remark-lint-mdlineage`、`@mdlineage/cli`、`@mdlineage/language-server`、`@mdlineage/mcp-server`）。每个 TypeScript 包构建到自身 `dist/`（`src/index.ts` → `dist/index.js`），包间引用一律指向 `dist` 产物。`remark-lint-mdlineage` 以 `@mdlineage/validator` 为唯一核心依赖。

`validator` 不依赖 LSP、编辑器或 MCP API，确保同一输入始终得到相同诊断。

## 6. 第一阶段具体实现

### 6.1 依赖

- `remark-language-server`
- `remark-cli`
- `unified` / `remark-parse`
- `remark-gfm`
- `remark-frontmatter`
- `remark-lint` 和选定的 preset
- `yaml`：保留 CST、key/value range 和注释
- `ajv`：JSON Schema 校验
- 本地包 `remark-lint-mdlineage`

全部作为仓库依赖安装并锁版本。编辑器启动仓库内版本，不依赖个人机器上的全局版本。

### 6.2 remark 配置

```js
// .remarkrc.mjs
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkPresetLintRecommended from 'remark-preset-lint-recommended'
import remarkLintMdlineage from '@mdlineage/remark-lint-mdlineage' // resolved from node_modules; builds packages/remark-lint-mdlineage/src → dist

export default {
  plugins: [
    remarkGfm,
    [remarkFrontmatter, ['yaml']],
    remarkPresetLintRecommended,
    [remarkLintMdlineage, {configFile: './mdlineage.config.yaml'}]
  ]
}
```

`.remarkrc.mjs` 只是适配配置。MDLineage 权威规则保存在不可执行的 `mdlineage.config.yaml`，避免未来迁移专用 LSP 时重写配置。

### 6.3 实时处理链

```text
didOpen / didChange
  → remark-language-server
  → remark processor
  → remark-lint-mdlineage
  → validator.validateDocument(in-memory text)
  → VFileMessage
  → publishDiagnostics
```

必须使用 LSP 客户端传入的未保存文本，不能重新读取磁盘旧内容。

编辑器启动仓库内服务：

```text
node_modules/.bin/remark-language-server --stdio
```

VS Code 与 Neovim/Emacs 两条通道的服务器来源不同，需要在文档中如实区分：

- **VS Code**：`vscode-remark` 扩展将 `remark-language-server` esbuild 打包进扩展自身（其 `package.json` 的 `dependencies` 为空，构建脚本为 `esbuild ... remark-language-server --bundle`，且不提供指向外部 server 的设置项）。因此 VS Code 下服务器版本随扩展版本走，仓库只能锁定「配置与插件」——`.remarkrc.mjs` 从 `node_modules` 加载仓库内版本的 `@mdlineage/*` 插件。配套在仓库中提交 `.vscode/settings.json`，启用 `remark.requireConfig: true`（默认 `false`）。注意该选项的语义是「没有配置文件时不做任何处理」：开启后，无 `.remarkrc.*` 的仓库将完全没有诊断；它的作用是防止误用个人全局插件，属于一致性保障而非功能开关。
- **Neovim、Emacs 等客户端**：直接注册 stdio LSP，指向 `node_modules/.bin/remark-language-server --stdio`，服务器版本由仓库锁文件控制；以 `.remarkrc.*`、`mdlineage.config.yaml` 或 `.git` 作为 root marker。

因此「仓库内锁定版本」的承诺仅对 stdio 通道完整成立；VS Code 通道锁定的是插件与规则，服务器本身随扩展更新。最终形态（M3 的 `mdlineage server`）两条通道都指向仓库内二进制，届时此差异消失。

### 6.4 CLI 与 CI

```json
{
  "scripts": {
    "lint:markdown": "remark . --frail --no-stdout",
    "check:docs": "mdlineage check .",
    "check:docs:changed": "mdlineage check --changed"
  }
}
```

- `remark`：普通 Markdown 和第一阶段单文档规则。
- `mdlineage check`：权威仓库级校验。
- pre-commit 可运行 changed 模式；`--changed` 的检测基准必须基于 `git status --porcelain` 或工作区字节扫描，不能基于 `git diff` 或暂存 blob——在 `.gitattributes` 行尾策略生效时，行尾类修改不出现在 diff 中，基于 diff 的实现会静默漏检（见 `docs/line-ending-management.md` §4.3）。
- push/CI 必须运行全量模式。

### 6.5 第一阶段跨文件检查

remark 插件可以首次使用时建立只读仓库快照，但实时结果属于“尽力而为”：

- 当前文件使用未保存内容。
- 其他文件使用最近磁盘内容。
- 配置、Schema 或 Markdown 保存后使缓存失效。
- 不能保证另一个尚未保存的缓冲区已进入索引。

因此：

- YAML、Schema、当前文档 anchor 检查实时且权威。
- duplicate ID、target resolution 在保存前是实时提示，CLI/CI 结果才是权威结果。
- 诊断需标记是否基于 workspace snapshot。

## 7. 个性化支持

个性化能力分为四级。

### 7.1 Level 1：声明式配置

```yaml
# mdlineage.config.yaml
configVersion: 1

files:
  include: ['**/*.md']
  exclude: ['node_modules/**', 'dist/**', 'vendor/**']

metadata:
  key: mdlineage
  required: true
  preserveUnknownTopLevelFields: true
  rejectUnknownMdlineageFields: true

vocabulary:
  kinds: [policy, guide, architecture, reference]
  statuses: [draft, active, deprecated]
  authorities: [canonical, supporting]

relations:
  depends_on:
    impact: true
    reasonRequired: true
    selfReference: forbidden
  implements:
    impact: true
    reasonRequired: true
  refines:
    impact: true
    reasonRequired: true
  supersedes:
    impact: true
    reasonRequired: true
    cycles: forbidden
  contradicts:
    severity: warning
    reasonRequired: true
  example_of:
    impact: false
  related_to:
    impact: false

diagnostics:
  MDL301: error
  MDL304: warning
```

关系方向的权威定义在词表中（`docs/frontmatter-spec.md`「Initial relationship vocabulary」），配置只承载 impact、reasonRequired、selfReference、cycles 等校验开关，不提供 per-relation 方向参数——方向一致性由 schema 层按词表校验。

配置文件自身由 `mdlineage-config.schema.json` 校验，可在 YAML 编辑器中获得补全和诊断。

### 7.2 Level 2：JSON Schema 扩展

```yaml
schemaFile: ./schemas/acme-mdlineage-v1.schema.json
```

扩展 Schema 可约束：

- 自定义 kind 的附加字段。
- owner、review date、service name 等业务字段。
- 路径与文档类型的条件规则。
- 特定 relation type 的补充字段。

不允许 Markdown 文件通过 `$schema` 任意切换远程地址。Schema 关联由仓库配置决定，默认禁止网络获取。

### 7.3 Level 3：声明式仓库策略

```yaml
policies:
  - name: policy-docs-must-be-canonical
    when:
      path: docs/policies/**/*.md
    require:
      kind: policy
      authority: canonical

  - name: examples-cannot-supersede-policies
    relation:
      sourceKind: example
      type: supersedes
      targetKind: policy
    forbid: true
```

声明式策略必须生成稳定 diagnostic code，并由 config schema 校验。能声明表达的规则不应优先使用任意代码插件。

### 7.4 Level 4：自定义规则插件

```ts
export default defineRule({
  code: 'ACME001',
  scope: 'workspace',
  defaultSeverity: 'error',
  create(context) {
    return {
      workspace(index) {
        // 使用只读索引检查组织规则
      }
    }
  }
})
```

规则上下文只暴露稳定接口：

- `DocumentSnapshot`
- Markdown AST
- Front Matter value、JSON Pointer、source range
- headings、anchors、links
- 只读 `WorkspaceIndex`
- `report()`、受限 `suggestFix()`

插件不得直接写文件。修复必须返回 TextEdit，由客户端展示并由用户确认。生产环境只加载显式 allowlist 中且锁定版本的插件；不可信插件后续放进 worker process，并设置超时和内存限制。

### 7.5 组织 preset

```yaml
extends:
  - '@acme/mdlineage-preset'
```

preset 可包含基础 Schema、关系词表、默认 severity、路径 override、声明式策略及批准的规则插件。仓库可收紧 preset；放宽 error 级组织规则必须显式写出 override 和原因。

## 8. 诊断协议

### 8.1 诊断码区间

| 范围 | 类别 |
|---|---|
| `MDL0xx` | Front Matter 边界和 YAML |
| `MDL1xx` | JSON Schema |
| `MDL2xx` | 单文档语义 |
| `MDL3xx` | 仓库身份和关系 |
| `MDL4xx` | Markdown link/anchor |
| `MDL5xx` | 仓库策略（含目录布局；码待定，见 `docs/dir-conventions.md` 开放问题） |
| `MDL6xx` | 行尾卫生（编码检查暂未纳入，BOM/编码码为后续扩展） |
| `MDL9xx` | 配置或内部状态（码待定，如配置无法解析、引用不存在的 schemaFile） |

初始诊断：

- `MDL001`：Front Matter 未闭合。
- `MDL002`：YAML 无法解析。
- `MDL003`：缺少 `mdlineage` 元数据。
- `MDL101`：不支持的 Schema 版本。
- `MDL102`：缺少必填字段。
- `MDL103`：类型或枚举错误。
- `MDL104`：未知 `mdlineage` 字段。
- `MDL201`：evidence anchor 不存在。
- `MDL202`：当前文档重复关系。
- `MDL301`：文档 ID 重复。
- `MDL302`：relation target 不存在。
- `MDL303`：relation target 有歧义（仅在配置启用路径或别名回退解析时可能触发；纯 ID 解析下由 `MDL301` 保证唯一性，此码为扩展保留）。
- `MDL304`：关系缺少 reason。
- `MDL305`：关系形成禁止的环。
- `MDL401`：Markdown 文件链接不存在。
- `MDL402`：Markdown heading anchor 不存在。
- `MDL601`：文件内混用多种行尾符。
- `MDL602`：行尾符与仓库策略不符（默认 LF，见 `docs/line-ending-management.md`）。

### 8.2 严重级别

- Error：无法解析、Schema 失败、重复 ID、无效 target、禁止关系。
- Warning：缺少推荐 reason、引用 deprecated 文档、可疑关系。
- Information：迁移和补充 metadata 建议。
- Hint：低影响格式建议。

解析失败、配置损坏、重复 ID 等完整性错误不可降为 Hint。

### 8.3 精确位置

Ajv 只返回 JSON Pointer。validator 必须维护：

```text
JSON Pointer → YAML CST node → source offsets → LSP UTF-16 range
```

必须测试中文、emoji 和组合字符，不能把 UTF-8 byte offset 直接当 LSP character。

## 9. 修复策略

### 9.1 可安全自动修复

- 插入缺失数组或空对象。
- 修正唯一明确的字段名拼写。
- 将唯一匹配枚举值规范化。
- 删除当前文档内完全重复的 relation。
- 为缺失 Front Matter 生成空模板，但不生成业务结论。

能力边界：remark LSP 阶段的编辑器内 QuickFix 由 `unified-language-server` 生成，它只读取诊断携带的 `expected` 替换值数组，产出单个 `TextEdit.replace(diagnostic.range, replacement)`（Insert/Replace/Remove 三种）。因此上面需要多行 YAML 结构编辑的修复项（插入数组元素、删除重复 relation）在 M1 阶段只能以两种方式落地：CLI 侧 `mdlineage fix`（validator 直接产出完整 TextEdit 集合），或 M3 专用 LSP 的自定义 Code Action。另外 remark/unified 的 lint severity 只有 0/1/2 三档，§8.2 的 Information 与 Hint 两级在 remark 通道下会塌缩为 Warning，四级严重度从 M3 专用 LSP 起完整生效。

### 9.2 只能建议

- 生成或修改稳定 `id`。
- 改变 relation type 或方向。
- 选择 relation target。
- 添加 `supersedes`、`contradicts` 等强关系。
- 删除未知 Front Matter 字段。

Front Matter 修复必须采用 CST/TextEdit 局部编辑，不能 parse 后整体 stringify，以免破坏注释、字段顺序、引号风格和其他工具字段。

## 10. 最终 MDLineage Language Server

### 10.1 对外命令

```text
mdlineage server --stdio
mdlineage check [paths...]
mdlineage check --changed
mdlineage fix [paths...]        （已实现）
mdlineage init                  （已实现）
mdlineage config validate       （未实现）
mdlineage index rebuild         （未实现）
mdlineage mcp
```

`fix` 输出安全修复（含行尾规范化，见 `docs/line-ending-management.md` §4.2），已实现（默认 dry-run，`--write` 落盘）；`init` 引导仓库接入：生成 `mdlineage.config.yaml`、`.gitattributes` 行尾策略（`* text=auto eol=lf` 或配置的策略）与空 schema 目录，已有属性文件时只追加缺失路径并先展示 dry-run diff——已实现，同样默认 dry-run。`config validate` 与 `index rebuild` 仍未实现。

编辑器只配置一个 LSP：

```text
command: mdlineage
args: [server, --stdio]
filetypes: [markdown]
root markers: [mdlineage.config.yaml, .git]
```

服务 local-first：默认不监听 TCP、不上传文档、不要求账号或网络。

### 10.2 最终 LSP 能力

- Diagnostics：语法、Schema、ID、relation、link、policy。
- Completion：字段、枚举、relation type、target ID、evidence anchor。
- Hover：字段文档、目标文件、关系方向及状态。
- Go to Definition：target ID 或链接跳转。
- Find References：查找对 ID、文件、标题的引用。
- Rename：以 WorkspaceEdit 安全重命名 ID 并更新引用。
- Code Action：安全修复、插入模板、创建缺失元数据。
- Document Symbols：标题和元数据结构。
- Workspace Symbols：按 ID、标题、alias 搜索。
- Workspace Diagnostics：重复 ID、失效引用、关系策略、索引错误。

### 10.3 增量索引生命周期

```text
initialize
  → 读取配置和 Schema
  → 扫描 Markdown
  → 建立 ID/path/heading/link/relation 索引

didOpen / didChange
  → 更新当前文件内存 overlay
  → 只重新解析当前文件
  → 校验当前文件和直接受影响引用方

didSave
  → 提交 overlay 到 workspace snapshot
  → 更新反向引用和依赖集合

watched file create/delete/rename
  → 增量更新索引
  → 重验受影响文档

didClose
  → 丢弃未保存 overlay
  → 回到磁盘 snapshot
```

索引是可重建的派生数据。MVP 使用内存索引；需要时增加本地持久化缓存，但缓存不是事实来源，也不提交到 Git。

### 10.4 从 remark LSP 迁移

迁移时不重写规则：

1. `validator` 保持不变。
2. remark adapter 把 diagnostics 转成 `VFileMessage`。
3. 专用 LSP 把同一 diagnostics 转成 LSP Diagnostic。
4. `.remarkrc.mjs` 继续支持纯 remark 用户。
5. `mdlineage.config.yaml` 始终是权威配置。

正式 LSP 发布后，默认只启动 `mdlineage server`，避免两个 LSP 重复 diagnostics 和 formatting。仍需其他 remark 插件时，可以并行运行，但要关闭重叠 capability。

## 11. 大模型校验闭环

大模型未必能读取编辑器 Problems 面板，因此必须提供机器可读 CLI：

```bash
mdlineage check --changed --format json
```

推荐流程：

```text
读取规范和 Schema
  → 生成/修改 Markdown
  → mdlineage check --changed --format json
  → 将 code/path/range/message 返回模型
  → 模型修正
  → 再校验
  → 通过后结束
```

JSON 示例：

```json
{
  "path": "docs/example.md",
  "code": "MDL302",
  "severity": "error",
  "message": "Relation target 'docs.unknown' does not exist",
  "range": {
    "start": {"line": 12, "character": 14},
    "end": {"line": 12, "character": 26}
  },
  "data": {
    "jsonPointer": "/mdlineage/relations/0/target"
  }
}
```

自动重试必须有次数上限。validator 只报告确定问题，不通过反复调用 LLM 猜 target。

## 12. MCP 服务

MCP 复用 validator 和 Workspace Index，提供：

- `validate_document(path, content?)`
- `validate_repository(paths?)`
- `get_schema(version?)`
- `list_document_ids(query?, kind?, status?)`
- `resolve_relation_target(id)`
- `suggest_metadata(path)`
- `search_documents(query, filters?)`
- `analyze_impact(document_id | diff)`
- `apply_metadata_patch(proposal_id, write?)`

前七项（至 `analyze_impact`）为确定性操作。`suggest_metadata` 可使用检索或 LLM，但返回结果必须标记为 proposal，不能混入 diagnostics，也不能直接写权威 Front Matter。

工具面的总表（含 `get_document` 等只读操作）以本节为准；`docs/architecture.md` 的 Agent interface 是概念层清单，落地签名以这里为准。proposal 的存储与生命周期：`suggest_metadata` 将 proposal（含 evidence、confidence、分析版本、内容哈希）写入本地待审队列，`apply_metadata_patch(proposal_id)` 经用户确认后将补丁作为 TextEdit 应用并生成可审阅 diff——默认只返 diff、不落盘；`write: true` 是显式 opt-in，把审阅过的内容原子写入 Front Matter。LLM 没有隐式写 Front Matter 的通道，落盘只经由这个显式接受动作并显式开启。

## 13. 性能和并发目标

- 输入停止约 200ms 后开始校验，避免每个按键触发完整处理。
- 普通文档单文件解析和 Schema 校验目标 P95 小于 50ms。
- 编辑器目标在 300ms 左右看到当前文件诊断。
- 只重验修改文档及其直接引用方。
- 发布前检查 LSP document version，丢弃过期任务结果。
- 大文件超过阈值时降级昂贵规则并显示一次说明。
- 配置或 Schema 更新后清理相关缓存并重验打开文件。

## 14. 测试策略

### 14.1 Parser 和 range

- 未闭合 `---`。
- YAML 缩进、重复 key、tab、多文档 marker。
- 中文 alias、emoji、UTF-16 range。
- 块字符串、引号、注释保留。
- GFM slug、重复 heading、Unicode heading。

### 14.2 Schema

- 每个必填字段缺失。
- 类型错误、字段拼写错误。
- Schema 版本升级和不支持版本。
- 未知顶层字段保留。
- 未知 `mdlineage` 字段诊断。

### 14.3 Workspace

- duplicate ID。
- target 不存在、歧义、self reference。
- 文件新增、删除、重命名、ID 修改。
- relation cycle。
- 两个未保存文件同时修改 ID。
- Windows、WSL、POSIX 路径规范化。

### 14.4 接口一致性

同一 fixture 在以下入口必须生成相同 code、message、range：

- validator API
- remark plugin
- CLI JSON
- LSP diagnostics
- MCP validation

一致性承诺覆盖 MDLineage 自有规则（MDLxxx 码）。普通 Markdown 规则保留 remark 原有规则 ID（§4.1），它们经 remark 通道原样透传，CLI/LSP 只保证透传结果一致，不将其改写为 MDL 码。

### 14.5 大模型常见错误 fixtures

- 把 `relations` 写成对象。
- relation 缩进错误。
- 把 target 写成文件路径而非稳定 ID。
- 生成不允许的 relation type。
- 修改标题后未更新 evidence。
- 复制文档后保留旧 ID。

## 15. 安全边界

- 默认禁止 Markdown 声明远程 Schema。
- CI 使用 lockfile 和固定 Schema 版本。
- validator 不执行 Markdown 中的代码、HTML 或表达式。
- `.remarkrc.mjs` 是可执行代码，编辑器应遵守 workspace trust。
- 最终 LSP 优先读取不可执行 YAML/JSON 配置。
- 自定义插件只从显式 allowlist 加载。
- LLM/网络能力与 validator 进程解耦。
- 默认日志只记录路径、诊断码和必要片段，不记录整篇私有文档。

## 16. 实施里程碑与验收

### M0：规则合同

交付：

- `mdlineage-v1.schema.json`
- `mdlineage-config.schema.json`
- 初始诊断码表
- 有效/无效 fixtures

验收：当前 Front Matter 规范中的每条确定性规则都有对应 Schema 或 diagnostic code。

### M1：remark 实时单文档校验

交付：

- `.remarkrc.mjs`
- validator 的 parser/schema/document 部分
- `remark-lint-mdlineage`
- VS Code、Neovim 示例配置
- CLI/CI 脚本

验收：编辑未保存文件时，YAML、Schema、evidence、普通 Markdown 错误实时显示，CLI 产生同样结果。

### M2：仓库索引和权威 CLI

交付：

- Workspace Index
- duplicate ID、target、跨文件 anchor、cycle 校验
- JSON、文本、SARIF 输出
- changed-files 模式

验收：新增、删除、移动、修改文档后，受影响关系被增量发现；CI 能阻止破坏仓库完整性的变更。

### M3：专用 MDLineage LSP

交付：

- `mdlineage server --stdio`
- 未保存 buffer overlay
- target completion、definition、references、rename
- 安全 Code Action

验收：编辑器只启动一个 LSP 即可完成实时校验和元数据导航；诊断与 CLI 一致。

### M4：MCP 和组织扩展

交付：

- MCP validation/search/impact tools
- `apply_metadata_patch`（proposal 待审队列与显式接受闭环）
- preset、自定义规则 API
- 插件 allowlist/隔离

验收：大模型能在提交前获得结构化诊断；proposal 经显式接受产生可审阅的 diff，`write: true` 时把审阅过的内容原子写入 Front Matter（默认只返 diff、不落盘）；组织规则无需 fork 核心项目即可复用。

## 17. 推荐首批范围

首批实现：

1. YAML Front Matter 边界与解析。
2. `mdlineage-v1` JSON Schema。
3. `schema`、`id`、`kind`、`status`、`authority`、`topics`、`aliases`、`relations`。
4. evidence 对当前 heading 的检查。
5. duplicate ID 和 target resolution。
6. remark LSP diagnostics 和 CLI JSON 输出。

首批不实现：

- LLM 关系推断。
- 自动接受 metadata proposal。
- 图数据库。
- 自动重命名 ID。
- 任意第三方 JS rule 的无沙箱加载。

这一范围已能解决大模型最常见的结构破坏，并为后续补全、跳转、影响分析和 MCP 建立稳定底座。

## 18. 开源组件参考

- remark-language-server：<https://github.com/remarkjs/remark-language-server>
- remark-frontmatter：<https://github.com/remarkjs/remark-frontmatter>
- remark-lint：<https://github.com/remarkjs/remark-lint>
- rumdl，可作为通用 Markdown lint/format 的对照实现：<https://github.com/rvben/rumdl>
- markdownlint custom rules：<https://github.com/DavidAnson/markdownlint/blob/main/doc/CustomRules.md>
- efm-langserver，CLI 到 LSP 的通用代理：<https://github.com/mattn/efm-langserver>
- mdschema，声明式 Markdown 结构验证参考：<https://github.com/jackchuka/mdschema>
- schematter，Front Matter 与文档结构 Schema 参考：<https://github.com/iwe-org/schematter>

