---
mdlineage:
  schema: 1
  id: docs.index
  kind: guide
  status: active
  authority: canonical
  topics:
    - documentation-index
    - mdlineage
  created_at: 2026-10-01
  updated_at: 2026-10-01
---

# MDLineage 项目文档全景导航

本页面是 MDLineage 官方知识库的**总索引与全景地图**。全仓文档遵循[《全场景通用知识库目录规范》](./使用手册/全场景通用知识库目录规范.md)进行结构治理：
- **面向开发者的使用手册（`使用手册/`）**：采用**中文命名与纯中文内容**，提供完整的使用指南、命令行参考与排错手册；
- **底层架构设计与技术规范（`specs/`）**：采用英文命名与原版技术规范（RFC），记录编译核心设计；
- **项目演进计划与台账（`project/`）**：采用英文命名，记录项目愿景、路线图与演进台账；
- **模型审查与交互报告（`reviews/`）**：采用英文命名，记录红队审查报告。

---

## 1. 使用手册（面向开发者 · 中文文档）

| 文档名称 | 主题说明 | 适用场景 |
|---|---|---|
| [`使用指南.md`](./使用手册/使用指南.md) | 端到端完整入门、五大包介绍与核心工作流概览 | 初次使用、功能全景认知 |
| [`全场景通用知识库目录规范.md`](./使用手册/全场景通用知识库目录规范.md) | 五大通用骨架与领域插槽模型、双轨制命名、生命周期流转规范 | 知识库搭建、规范约束、目录治理 |
| [`命令行参考.md`](./使用手册/命令行参考.md) | CLI 所有子命令用法、退出码契约、选项参数与重构命令 | 命令行操作、终端运维、CI 集成 |
| [`配置指南.md`](./使用手册/配置指南.md) | `mdlineage.config.yaml` 全量配置字典与旁路清单语法参考 | 仓库规则配置、自定义 Schema、目录契约 |
| [`诊断码速查.md`](./使用手册/诊断码速查.md) | MDL001–MDL801 诊断码清单、排错原因与修复指引 | 遇到校验报错、CI 门禁排查 |
| [`编辑器配置.md`](./使用手册/编辑器配置.md) | VS Code、Neovim 与通用的专用 LSP/MCP 接线指南 | IDE 实时诊断与语言服务配置 |

---

## 2. 架构设计与技术规范（specs/ · 技术 RFC）

| 文档名称 | 主题说明 | 适用场景 |
|---|---|---|
| [`architecture.md`](./specs/architecture.md) | 系统总体分层架构、派生索引层与可靠性边界 | 理解系统架构、模块依赖、数据流 |
| [`frontmatter-spec.md`](./specs/frontmatter-spec.md) | Front Matter v1 元数据模式契约与字段定义 | 编写或扩展元数据结构 |
| [`dir-conventions.md`](./specs/dir-conventions.md) | P4 目录意图契约与链接重构引擎设计规范 | 了解目录约束与自愈算法原理 |
| [`remark-language-server-solution.md`](./specs/remark-language-server-solution.md) | 统一语言服务（LSP/remark）技术实现方案 | 语言服务与编辑器插件维护 |
| [`line-ending-management.md`](./specs/line-ending-management.md) | 跨平台 CRLF/LF 换行符检测与自动修复方案 | 解决跨操作系统换行符漂移 |

---

## 3. 迭代计划与项目台账（project/）

| 文档名称 | 主题说明 | 适用场景 |
|---|---|---|
| [`vision.md`](./project/vision.md) | MDLineage 的核心理念、北极星指标与长期愿景 | 理解项目初衷与发展哲学 |
| [`roadmap.md`](./project/roadmap.md) | 阶段里程碑与功能演进计划 | 查看后续开发计划与功能优先级 |
| [`progress.md`](./project/progress.md) | 历史里程碑（M0–M4）交付记录与研发台账 | 回溯已完成功能与测试审计记录 |
| [`open-source-landscape.md`](./project/open-source-landscape.md) | 开源 Markdown 生态与现有静态网站生成器对比 | 选型分析与生态定位 |

---

## 4. 质量审查与模型交互（reviews/）

| 审查报告 | 审查主题 | 审查结论 |
|---|---|---|
| [`2026-09-21-round1-adjudication.md`](./reviews/2026-09-21-round1-adjudication.md) | 第一轮红队交叉审查分歧最终裁决报告 | 确定统一实现路线 |
| [`2026-09-21-round1-atria-dawn-preview.md`](./reviews/2026-09-21-round1-atria-dawn-preview.md) | Atria-Dawn-Preview 第一轮独立架构审查 | 红队审查意见 |
| [`2026-09-21-round1-glm-5.3.md`](./reviews/2026-09-21-round1-glm-5.3.md) | glm-5.3 第一轮独立架构审查 | 红队审查意见 |
