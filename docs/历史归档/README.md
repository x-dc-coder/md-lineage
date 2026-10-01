---
mdlineage:
  schema: 1
  id: docs.archive.index
  kind: reference
  status: archived
  authority: supporting
  topics:
    - archive
    - historical-records
  created_at: 2026-10-01
  updated_at: 2026-10-01
---

# 历史归档索引

本目录存放已结项、已更替或已废弃的历史技术方案与过程快照。

## 归档约定

1. 本目录内所有文档在 Front Matter 中统一标记为 `status: archived`；
2. 归档文档自动命中 `lifecycle.exempt` 豁免规则，不再参与 `MDL801` 超期时钟告警；
3. 现行有效文档禁止对归档文档建立强依赖关系（`depends_on` / `implements` / `refines`），以保持现行知识体系的健康独立。
