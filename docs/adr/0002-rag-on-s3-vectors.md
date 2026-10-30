# ADR-0002: RAG with Bedrock Knowledge Bases on S3 Vectors

**Context.** The assistant needs retrieval over operating documents (glossary, procedures, runbooks, incident reviews). Options: Bedrock Knowledge Bases on OpenSearch Serverless, on Aurora pgvector, or on Amazon S3 Vectors; or a hand-built pipeline.

**Decision.** Use a Bedrock Knowledge Base with **S3 Vectors** storage, Titan Text Embeddings v2 (1,024 dimensions, cosine), fixed-size 400-token chunks with 15% overlap, and a deploy-time trigger that re-ingests whenever `knowledge/` changes.

**Consequences.**
- No always-on vector cluster. OpenSearch Serverless has a minimum OCU charge that would dwarf the rest of the dev environment; S3 Vectors is pay-per-use.
- Managed ingestion, chunking and retrieval; the agent calls `Retrieve` and cites source file names.
- S3 Vectors has lower query throughput and fewer search features (no hybrid keyword search) than OpenSearch. For large corpora or hybrid search, swap the `storageConfiguration` to OpenSearch Serverless; the agent code doesn't change.
- Bedrock metadata keys are configured as non-filterable to stay within S3 Vectors metadata limits.
