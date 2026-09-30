---
mdlineage:
  schema: 1
  id: docs.open-source-landscape
  kind: reference
  status: active
---

# Open-source project landscape

This page records projects that informed the design. They are references for capabilities and patterns; this document does not imply that MDLineage will depend on them or copy their code. Before adopting code or packaging a dependency, review its current license, maintenance status, API, and operational requirements.

| Project | Relevant idea | Possible use in MDLineage | Boundary |
|---|---|---|---|
| [CocoIndex](https://github.com/cocoindex-io/cocoindex) | Incremental data processing and a Markdown-to-knowledge-graph example | Study for refreshing derived indexes when files change | Pipeline engine, not the product’s Front Matter contract |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | Entity, relationship, and claim extraction; graph communities and layered summaries | Borrow candidate discovery and periodic global theme analysis | Could be too expensive or heavyweight for routine edits; use selectively |
| [Neo4j MCP](https://neo4j.com/docs/mcp/current/client-configuration/) | MCP access to graph schema and graph operations | Reference for connecting an agent to a graph-backed index | MDLineage should not require Neo4j or expose raw Cypher as its only interface |
| [Graphiti](https://github.com/getzep/graphiti) | Temporal facts, provenance, incremental graph updates, and MCP tools | Study for source provenance and changing or superseded facts | Designed as agent memory/context graph; repository document synchronization remains separate |
| [RAGFlow](https://github.com/infiniflow/ragflow) | Document ingestion, dataset-wide knowledge graphs, and retrieval UI | Reference for an integrated document-RAG workflow | A broader RAG platform; not a minimal repository-native metadata tool |
| [LightRAG](https://github.com/HKUDS/LightRAG) | Combining graph structure with vector retrieval and incremental insertion | Compare as a lightweight graph-RAG retrieval approach | Retrieval framework; Front Matter authoring and review still need a layer |

## Design decisions drawn from these references

1. Build semantic relationships from text, but retain source evidence and provenance.
2. Use community or theme summaries for periodic global analysis, not on every file save.
3. Track changes incrementally and rebuild only affected derived outputs when possible.
4. Give agents focused MCP tools for retrieval, impact analysis, and validation.
5. Keep confirmed metadata in Markdown so it can be reviewed and versioned with the source.

## Source links

- CocoIndex Markdown knowledge graph example: <https://cocoindex.io/docs/examples/docs-to-knowledge-graph/>
- GraphRAG indexing overview: <https://microsoft.github.io/graphrag/index/overview/>
- GraphRAG command-line update operation: <https://microsoft.github.io/graphrag/cli/>
- Graphiti MCP server: <https://github.com/getzep/graphiti/tree/main/mcp_server>
- RAGFlow knowledge graph construction guide: <https://ragflow.io/docs/> (see the knowledge-graph section; the historical GitHub path `docs/guides/dataset/advanced/construct_knowledge_graph.md` no longer resolves)
- LightRAG project: <https://github.com/HKUDS/LightRAG>
