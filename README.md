# MDLineage

面向 Markdown 知识库的元数据与一致性工具：把"文档之间靠什么关联"变成可校验、可反查的图谱，同时守住文档自身的健康——元数据契约、链接可达性、目录归属与行尾。

## 快速开始

```bash
# 安装：从 Releases 页面下载 5 个 mdlineage-*.tgz 后执行
npm i -g ./mdlineage-*-*.tgz
cd /path/to/your/repo
mdlineage init --write           # 生成配置、清单骨架、schemas/ 与 .gitattributes
mdlineage manifest seed --write  # 为现有文档批量生成 id/kind/status
mdlineage check                  # 校验：0 诊断即通过
```

```
$ mdlineage check
mdlineage: 12 files checked, no diagnostics
```

## 核心能力

- **一致性校验**：元数据契约、跨文档引用、悬空关系、目录归属与行尾，一条命令给出稳定诊断码（`MDL*`）。
- **零改动元数据**：元数据可放进 `mdlineage.manifest.yaml` 旁路清单，正文一个字节都不用动。
- **文档图谱**：`depends_on`、`supersedes` 等跨文档关系入索引，改一篇即可反查影响面。
- **渐进接入**：`metadata.required: false` 起步，存量不必一次整改；CI 用 `baseline` 卡住新增问题。
- **同一内核，四种接入**：CLI、LSP、MCP 与 remark 插件共用同一套校验器。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `mdlineage check` | 校验文档；`--changed` 只看改动，`--frail` 让警告也算失败 |
| `mdlineage init` | 生成配置、清单骨架、`.gitattributes` 与 `schemas/`（默认 dry-run） |
| `mdlineage manifest seed` | 为存量文档生成清单条目（默认 dry-run，`--write` 落盘） |
| `mdlineage baseline update` / `verify` | 登记接受债 / CI 门禁：诊断必须与基线完全一致 |
| `mdlineage fix` | 只做安全修复（缺失字段、重复关系、行尾），默认 dry-run |
| `mdlineage server --stdio` / `mcp --stdio` | LSP / MCP 通道，接入编辑器与 AI Agent |

## 文档

- [使用指南](docs/使用手册/使用指南.md)：安装、接入与日常流程
- [命令行参考](docs/使用手册/命令行参考.md)：全部命令、退出码与输出格式
- [配置指南](docs/使用手册/配置指南.md)：`mdlineage.config.yaml` 与自定义 schema
- [诊断码速查](docs/使用手册/诊断码速查.md)：每个 `MDL` 码的含义与修法
- [编辑器配置](docs/使用手册/编辑器配置.md)：VS Code / Neovim / Cursor 接入
- 设计与规划：`docs/specs/`、`docs/project/`；变更与已知限制见 `docs/project/progress.md`

## 开发

```bash
npm ci && npm run build
npm test           # 全部包测试
npm run check:md   # 用本工具检查本仓库
npm run lint:md    # remark 门禁（README 与 docs/ 均在范围内）
```

## 许可证

[MIT](LICENSE)
