# Search Architecture

A comprehensive guide to how semantic and hybrid search works in ZotSeek.

---

## Table of Contents

1. [Overview](#overview)
2. [Search Modes](#search-modes)
3. [Hybrid Search with RRF](#hybrid-search-with-rrf)
4. [Semantic Search Pipeline](#semantic-search-pipeline)
   - [MaxSim Aggregation](#maxsim-aggregation)
   - [Parent-Child Retrieval Pattern](#parent-child-retrieval-pattern)
5. [Chunking Strategy](#chunking-strategy)
   - [Trade-offs: Chunk Size Selection](#trade-offs-chunk-size-selection)
   - [Version-Aware Defaults](#version-aware-defaults)
   - [Paragraph-Based Chunking](#paragraph-based-chunking)
   - [Token Estimation](#token-estimation)
   - [Chunk Overlap](#chunk-overlap)
6. [Section-Aware Chunking](#section-aware-chunking)
   - [References Filtering](#references-filtering)
7. [Performance Optimizations](#performance-optimizations)
8. [Query Analysis](#query-analysis)

---

## Overview

The plugin offers three search modes, each optimized for different use cases:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SEARCH ARCHITECTURE OVERVIEW                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                              USER QUERY                                      │
│                                  │                                           │
│                                  ▼                                           │
│                       ┌───────────────────┐                                  │
│                       │   Query Analyzer  │                                  │
│                       │   (Auto-weights)  │                                  │
│                       └─────────┬─────────┘                                  │
│                                 │                                            │
│              ┌──────────────────┼──────────────────┐                         │
│              │                  │                  │                         │
│              ▼                  ▼                  ▼                         │
│    ┌─────────────────┐ ┌───────────────┐ ┌─────────────────┐                │
│    │ 🧠 Semantic      │ │ 🔗 Hybrid     │ │ 🔤 Keyword      │                │
│    │ (Embeddings)    │ │ (RRF Fusion)  │ │ (Zotero Search) │                │
│    └────────┬────────┘ └───────┬───────┘ └────────┬────────┘                │
│             │                  │                  │                          │
│             │         ┌───────┴───────┐          │                          │
│             │         │               │          │                          │
│             ▼         ▼               ▼          ▼                          │
│    ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐             │
│    │ Cosine     │ │ Semantic   │ │ Keyword    │ │ Title/     │             │
│    │ Similarity │ │ Results    │ │ Results    │ │ Author/    │             │
│    └────────────┘ └─────┬──────┘ └─────┬──────┘ │ Year Match │             │
│                         │              │        └────────────┘             │
│                         └──────┬───────┘                                    │
│                                │                                            │
│                                ▼                                            │
│                    ┌───────────────────────┐                                │
│                    │  Reciprocal Rank      │                                │
│                    │  Fusion (RRF)         │                                │
│                    │                       │                                │
│                    │  score = Σ 1/(k+rank) │                                │
│                    └───────────┬───────────┘                                │
│                                │                                            │
│                                ▼                                            │
│                    ┌───────────────────────┐                                │
│                    │   RANKED RESULTS      │                                │
│                    │   with indicators:    │                                │
│                    │   🔗 Both sources     │                                │
│                    │   🧠 Semantic only    │                                │
│                    │   🔤 Keyword only     │                                │
│                    └───────────────────────┘                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Search Modes

### 🔗 Hybrid (Recommended)

Combines semantic understanding with exact keyword matching for best results.

| Query Type | Pure Semantic | Pure Keyword | Hybrid |
|------------|---------------|--------------|--------|
| "trust in AI" | ✅ Great | ❌ Poor | ✅ Great |
| "Smith 2023" | ❌ Poor | ✅ Great | ✅ Great |
| "RLHF" | ⚠️ Maybe | ✅ Exact only | ✅ Both |
| "automation bias healthcare" | ✅ Good | ⚠️ Partial | ✅ Best |

### 🧠 Semantic Only

Uses AI embeddings to find conceptually related papers, even with different wording.

**Best for:**
- Conceptual queries: "how does automation affect human decision making"
- Finding related work with different terminology
- Exploratory research

**Limitations:**
- Doesn't understand author names or years
- May miss exact technical terms

### 🔤 Keyword Only

Uses Zotero's built-in quick search on titles, authors, years, tags.

**Best for:**
- Author searches: "Smith 2023"
- Exact terms: "PRISMA 2020"
- Tag-based filtering

**Limitations:**
- No semantic understanding
- Won't find synonyms or related concepts

---

## Hybrid Search with RRF

### What is Reciprocal Rank Fusion?

RRF is a technique for combining ranked lists from different search systems without requiring score normalization or tuning.

```
                    RECIPROCAL RANK FUSION (RRF)
                    ════════════════════════════

    Formula:  RRF_score(doc) = Σ 1/(k + rank_i)

    Where:
    • k = constant (default: 60, from original RRF paper)
    • rank_i = document's rank in each result list

    ┌─────────────────────────────────────────────────────────────────┐
    │ EXAMPLE: Query "Smith automation bias healthcare"               │
    ├─────────────────────────────────────────────────────────────────┤
    │                                                                 │
    │ SEMANTIC SEARCH (by similarity):                                │
    │ ┌────┬──────────────────────────────────────────┬─────────┐    │
    │ │Rank│ Paper                                    │ Score   │    │
    │ ├────┼──────────────────────────────────────────┼─────────┤    │
    │ │ 1  │ Automation bias in clinical AI systems   │ 89%     │    │
    │ │ 2  │ Human-AI decision making in medicine     │ 85%     │    │
    │ │ 3  │ Trust calibration for automated systems  │ 82%     │    │
    │ └────┴──────────────────────────────────────────┴─────────┘    │
    │                                                                 │
    │ KEYWORD SEARCH (by relevance):                                  │
    │ ┌────┬──────────────────────────────────────────┬─────────┐    │
    │ │Rank│ Paper                                    │ Score   │    │
    │ ├────┼──────────────────────────────────────────┼─────────┤    │
    │ │ 1  │ Smith, J. - "Bias in ML systems"         │ 95%     │    │
    │ │ 2  │ Automation bias in clinical AI systems   │ 90%     │    │
    │ │ 3  │ Healthcare AI ethics review              │ 85%     │    │
    │ └────┴──────────────────────────────────────────┴─────────┘    │
    │                                                                 │
    │ RRF FUSION (k=60):                                              │
    │ ┌────────────────────────────────────────────────────────────┐ │
    │ │                                                            │ │
    │ │ "Automation bias in clinical AI systems"                   │ │
    │ │   Semantic: rank 1 → 1/(60+1) = 0.0164                    │ │
    │ │   Keyword:  rank 2 → 1/(60+2) = 0.0161                    │ │
    │ │   TOTAL: 0.0325  ← HIGHEST (appears in BOTH!)             │ │
    │ │                                                            │ │
    │ │ "Smith, J. - Bias in ML systems"                          │ │
    │ │   Semantic: not found → 0                                  │ │
    │ │   Keyword:  rank 1 → 1/(60+1) = 0.0164                    │ │
    │ │   TOTAL: 0.0164                                           │ │
    │ │                                                            │ │
    │ │ "Human-AI decision making in medicine"                     │ │
    │ │   Semantic: rank 2 → 1/(60+2) = 0.0161                    │ │
    │ │   Keyword:  not found → 0                                  │ │
    │ │   TOTAL: 0.0161                                           │ │
    │ │                                                            │ │
    │ └────────────────────────────────────────────────────────────┘ │
    │                                                                 │
    │ FINAL RANKING:                                                  │
    │ 1. 🔗 Automation bias in clinical AI   (0.0325) - BOTH        │
    │ 2. 🔤 Smith, J. - Bias in ML systems   (0.0164) - Keyword     │
    │ 3. 🧠 Human-AI decision making         (0.0161) - Semantic    │
    │                                                                 │
    └─────────────────────────────────────────────────────────────────┘
```

### Why RRF?

| Property | Benefit |
|----------|---------|
| **No score normalization** | Works on ranks, not raw scores |
| **No tuning required** | k=60 works well across domains |
| **Robust** | Top results from ANY source get boosted |
| **Production-proven** | Used by Elasticsearch, Vespa, Pinecone |

### Result Indicators

| Icon | Meaning | Interpretation |
|------|---------|----------------|
| 🔗 | Found by BOTH | High confidence - matches semantically AND by keywords |
| 🧠 | Semantic only | Conceptually related but may use different terminology |
| 🔤 | Keyword only | Exact match but not indexed for semantic search |

---

## Semantic Search Pipeline

### Embedding Generation

```
┌─────────────────────────────────────────────────────────────────────┐
│                     EMBEDDING PIPELINE                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  INPUT TEXT                           EMBEDDING VECTOR               │
│  ┌─────────────────────────┐         ┌─────────────────────┐        │
│  │ "Machine learning for   │         │ [0.023, -0.045,     │        │
│  │  medical diagnosis      │   →     │  0.012, 0.089,      │        │
│  │  using deep neural      │         │  -0.034, 0.056,     │        │
│  │  networks..."           │         │  ... 768 values]    │        │
│  └─────────────────────────┘         └─────────────────────┘        │
│                                                                      │
│  MODEL: nomic-embed-text-v1.5                                       │
│  ├── Context: 8192 tokens                                           │
│  ├── Dimensions: 768                                                │
│  ├── Size: 131MB (quantized)                                        │
│  └── Quality: Outperforms OpenAI text-embedding-3-small             │
│                                                                      │
│  INSTRUCTION PREFIXES (improve retrieval quality):                   │
│  ├── Documents: "search_document: <text>"                           │
│  └── Queries:   "search_query: <text>"                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Cosine Similarity

```
                         COSINE SIMILARITY
                         ═════════════════

                              A · B
    similarity(A, B) = ─────────────────
                        ||A|| × ||B||

    Where:
    • A · B = dot product = Σ(a[i] × b[i])
    • ||A|| = magnitude = √(Σ a[i]²)

    ┌─────────────────────────────────────────────────────────────┐
    │ INTERPRETATION:                                             │
    ├─────────────────────────────────────────────────────────────┤
    │                                                             │
    │  1.0 ████████████████████████████████████ Identical        │
    │  0.9 ███████████████████████████████████  Very similar     │
    │  0.7 █████████████████████████████        Related topics   │
    │  0.5 ███████████████████                  Loosely related  │
    │  0.3 ███████████                          Different topics │
    │  0.0                                       Completely different│
    │                                                             │
    └─────────────────────────────────────────────────────────────┘
```

### MaxSim Aggregation

When a paper has multiple chunks, we use **MaxSim** (Maximum Similarity):

```
    Paper A has 4 chunks: [summary, methods, findings, content]

    Query: "statistical analysis techniques"

    Similarities:
    ├── summary:  0.45  (abstract mentions statistics)
    ├── methods:  0.89  ← HIGHEST (detailed methods section)
    ├── findings: 0.52  (results discuss significance)
    └── content:  0.32  (background section)

    MaxSim Result: 0.89 (methods chunk matched best)
    Source Display: "Methods" ← Shows WHERE the match was found
```

This ensures that if *any* part of a paper matches your query, the paper ranks highly.

### Parent-Child Retrieval Pattern

ZotSeek implements a **parent-child retrieval pattern** that supports two granularity modes:

```
┌─────────────────────────────────────────────────────────────────────┐
│                   PARENT-CHILD RETRIEVAL                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  INDEXING: Paragraph-level (child chunks)                           │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Paper A                                                      │   │
│  │ ├── Chunk 0: Abstract (page 1, para 0)                      │   │
│  │ ├── Chunk 1: Intro paragraph 1 (page 2, para 0)             │   │
│  │ ├── Chunk 2: Intro paragraph 2 (page 2, para 1)             │   │
│  │ ├── Chunk 3: Methods paragraph 1 (page 3, para 0)           │   │
│  │ └── ...                                                      │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│              ┌───────────────┴───────────────┐                      │
│              ▼                               ▼                       │
│  ┌─────────────────────┐         ┌─────────────────────┐           │
│  │  BY SECTION MODE    │         │  BY LOCATION MODE   │           │
│  │  (returnAllChunks   │         │  (returnAllChunks   │           │
│  │   = false)          │         │   = true)           │           │
│  ├─────────────────────┤         ├─────────────────────┤           │
│  │                     │         │                     │           │
│  │ MaxSim aggregation  │         │ Return ALL chunks   │           │
│  │ 1 result per paper  │         │ with individual     │           │
│  │ Best chunk score    │         │ scores & locations  │           │
│  │                     │         │                     │           │
│  │ Result:             │         │ Results:            │           │
│  │ Paper A: 89%        │         │ Paper A, p3 ¶0: 89% │           │
│  │ (Methods section)   │         │ Paper A, p2 ¶1: 52% │           │
│  │                     │         │ Paper A, p1 ¶0: 45% │           │
│  └─────────────────────┘         └─────────────────────┘           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

#### By Section Mode (Default)

- **Aggregation**: MaxSim - returns highest similarity across all chunks
- **Results**: 1 result per paper
- **Display**: Shows which section matched (Abstract, Methods, Results)
- **Use case**: Overview of matching papers

#### By Location Mode

- **Aggregation**: None - returns every matching chunk
- **Results**: Multiple results per paper (one per matching paragraph)
- **Display**: Shows exact page & paragraph number
- **Use case**: Finding specific passages, evidence linking

#### Technical Implementation

```typescript
// Search options
interface SearchOptions {
  returnAllChunks?: boolean;  // true = By Location, false = By Section
}

// RRF fusion key changes based on mode
const key = returnAllChunks
  ? `${itemId}-${chunkIndex}`  // Unique per chunk
  : String(itemId);            // Unique per paper
```

---

## Chunking Strategy

### Trade-offs: Chunk Size Selection

Embedding time scales **O(n²)** with sequence length due to transformer attention. Chunk size directly impacts both indexing speed and search quality:

| Chunk Size | Speed | Precision | Recall | Best For |
|------------|-------|-----------|--------|----------|
| **500-800 tokens** | Very fast (~0.3-0.5s/chunk) | High | Lower | Finding specific claims, methods, passages |
| **2000 tokens** | Moderate (~3s/chunk) | Balanced | Balanced | General use (default for Zotero 8) |
| **4000+ tokens** | Slow (~10s+/chunk) | Lower | Higher | Finding papers about broad topics |
| **7000 tokens** | Very slow (~45s/chunk) | Low | High | Not recommended |

**Precision vs Recall:**
- **Smaller chunks** = more precise matches to specific passages, but may miss broader context
- **Larger chunks** = captures more context, but similarity scores get "diluted" by surrounding text

### Version-Aware Defaults

ZotSeek automatically adjusts chunk size based on your Zotero version:

| Zotero Version | Firefox Engine | Default maxTokens | Reason |
|----------------|----------------|-------------------|--------|
| **Zotero 7** | Firefox 115 ESR | **800** | ~8-10x slower WASM/SIMD performance |
| **Zotero 8** | Firefox 140 ESR | **2000** | Faster WASM, can handle larger chunks |

This is set automatically on first run. You can override it in Settings > ZotSeek.

### Paragraph-Based Chunking

The `maxTokens` setting is a **ceiling, not a target**. The chunker:

1. Splits text at paragraph boundaries (`\n\n`)
2. Accumulates paragraphs into a chunk
3. Flushes when adding another paragraph would exceed `maxTokens`
4. **Never splits a paragraph across chunks**

```
Example with maxTokens=800:

Paragraph 1: 200 tokens  ─┐
Paragraph 2: 350 tokens   ├─► Chunk 1 (550 tokens)
                         ─┘
Paragraph 3: 400 tokens  ─┐
                          ├─► Chunk 2 (400 tokens) ← under limit, that's OK
                         ─┘
Paragraph 4: 900 tokens  ─┐
                          ├─► Chunk 3 (900 tokens) ← exceeds limit, but kept whole
                         ─┘
```

A chunk might be 400 tokens if that's where the paragraph ends naturally. Paragraphs larger than `maxTokens` are kept whole (not split mid-sentence).

### Token Estimation

Tokens are estimated at ~1.3 tokens per word for English academic text:

```
1000 words ≈ 1300 tokens ≈ 6000 characters
```

| maxTokens | Approximate Size |
|-----------|------------------|
| 500 | ~385 words, ~1500 chars |
| 800 | ~615 words, ~2400 chars |
| 2000 | ~1540 words, ~6000 chars |

### Chunk Overlap

Currently, there is **no overlap** between chunks. Each paragraph belongs to exactly one chunk.

The paper title is prepended to each chunk for embedding context, but this is for retrieval quality, not overlap.

**Why no overlap?**
- Keeps index size predictable
- Paragraphs are natural semantic boundaries in academic writing
- Avoids duplicate matches for the same content

Overlap is common in RAG systems (e.g., LangChain defaults to ~200 token overlap) and could be added as a future enhancement for cases where important information spans paragraph boundaries.

---

## Section-Aware Chunking

### Academic Paper Structure

Unlike generic chunkers that split at arbitrary character boundaries, our chunker respects academic paper structure:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SECTION-AWARE CHUNKING                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  INPUT: Full PDF Text                                               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Title: Deep Learning for Medical Diagnosis                   │   │
│  │                                                              │   │
│  │ Abstract: We propose a novel approach to medical...          │   │
│  │                                                              │   │
│  │ 1. Introduction                                              │   │
│  │ Machine learning has revolutionized healthcare...            │   │
│  │                                                              │   │
│  │ 2. Related Work                                              │   │
│  │ Prior studies by Smith et al. (2020) showed...              │   │
│  │                                                              │   │
│  │ 3. Methods                                                   │   │
│  │ We collected data from 500 patients...                       │   │
│  │                                                              │   │
│  │ 4. Results                                                   │   │
│  │ Our analysis shows 95% accuracy...                          │   │
│  │                                                              │   │
│  │ 5. Discussion                                                │   │
│  │ These findings suggest that AI can assist...                │   │
│  │                                                              │   │
│  │ 6. Conclusion                                                │   │
│  │ In summary, we demonstrated...                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│  OUTPUT: Semantic Chunks                                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                                                              │  │
│  │  CHUNK 1: summary                                            │  │
│  │  ├── Title + Abstract                                        │  │
│  │  └── "What is this paper about?"                             │  │
│  │                                                              │  │
│  │  CHUNK 2-3: methods                                          │  │
│  │  ├── Introduction + Related Work + Methods                   │  │
│  │  └── "How did they do it?"                                   │  │
│  │                                                              │  │
│  │  CHUNK 4-5: findings                                         │  │
│  │  ├── Results + Discussion + Conclusion                       │  │
│  │  └── "What did they find?"                                   │  │
│  │                                                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  SECTION PATTERNS DETECTED:                                         │
│  ├── Methods-like: Introduction, Background, Literature Review,     │
│  │                 Methods, Methodology, Materials, Data Collection │
│  │                                                                  │
│  └── Findings-like: Results, Findings, Evaluation, Discussion,     │
│                     Conclusions, Implications, Limitations         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Chunk Types and Display

| Chunk Type | Contains | Source Display | Purpose |
|------------|----------|----------------|---------|
| `summary` | Title + Abstract | "Abstract" | What is this paper about? |
| `methods` | Intro, Background, Methods | "Methods" | How did they do it? |
| `findings` | Results, Discussion, Conclusions | "Results" | What did they find? |
| `content` | Fallback (no sections detected) | "Content" | Generic content |

### Fallback Behavior

When a PDF doesn't have recognizable section headers (e.g., book chapters, reports, non-standard formats):

1. **Section detection fails** - No "Results", "Methods", etc. found
2. **Fallback triggered** - Entire text split at paragraph boundaries
3. **Chunks labeled `content`** - Displays as "Content" in Source column

| Document Type | Chunks Created | Source Column Shows |
|---------------|----------------|---------------------|
| Standard academic paper | summary + methods + findings | Abstract, Methods, Results |
| Book chapter / Report | summary + content chunks | Abstract, Content, Content... |
| Abstract-only mode | summary only | Abstract |
| No PDF, no abstract | title only | Abstract |

The search still works perfectly with `content` chunks - you just won't know which *part* of the document matched.

### References Filtering

The chunker automatically detects and excludes bibliography sections to keep search results focused on actual content:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    REFERENCES FILTERING                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  PDF TEXT PROCESSING:                                                │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Page 1: Abstract...                    ✓ INDEXED            │   │
│  │ Page 2: Introduction...                ✓ INDEXED            │   │
│  │ Page 3: Methods...                     ✓ INDEXED            │   │
│  │ Page 4: Results...                     ✓ INDEXED            │   │
│  │ Page 5: Discussion...                  ✓ INDEXED            │   │
│  │ Page 6: Conclusion...                  ✓ INDEXED            │   │
│  │ Page 7: References                     ✗ HEADER DETECTED    │   │
│  │         [1] Smith, J. (2021)...        ✗ SKIPPED            │   │
│  │         [2] Jones, A. (2020)...        ✗ SKIPPED            │   │
│  │ Page 8: More references...             ✗ SKIPPED            │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  DETECTION PATTERNS:                                                 │
│  ├── Headers: "References", "Bibliography", "Works Cited",          │
│  │            "Literature Cited", "Citations"                        │
│  │                                                                   │
│  └── Citation entries (fallback if header missed):                  │
│      ├── [1], [2], [3]...         (numbered style)                  │
│      ├── 1. Author...              (numbered list)                  │
│      ├── Smith, J. A. (2021).     (APA style)                       │
│      ├── doi: 10.1234/...         (DOI pattern)                     │
│      └── pp. 123-456, Vol. 12     (publication details)             │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

Once a references header is detected, all remaining pages are skipped. Individual citation entries are also detected as a fallback in case the header was missed.

### Performance-Optimized Chunking

See [Chunking Strategy](#chunking-strategy) for detailed trade-offs. Summary:

| Chunk Size | Time per Chunk | Notes |
|------------|----------------|-------|
| 7000 tokens | ~45 seconds | Too slow for practical use |
| 2000 tokens | ~3 seconds | Default for Zotero 8 |
| 800 tokens | ~0.5 seconds | Default for Zotero 7 |
| 500 tokens | ~0.3 seconds | Fastest, highest precision |

**Default settings:**
- `maxTokens`: 800 (Zotero 7) / 2000 (Zotero 8) — version-aware
- `maxChunksPerPaper`: 100 — covers most full papers
- Paragraph-aware splitting (never splits mid-paragraph)

---

## Performance Optimizations

### Embedding Cache

```
┌─────────────────────────────────────────────────────────────────────┐
│                      CACHING ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  FIRST SEARCH (cache miss):                                         │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐                    │
│  │  Query   │ ──► │  SQLite  │ ──► │  Cache   │                    │
│  │          │     │  (disk)  │     │  (RAM)   │                    │
│  └──────────┘     └──────────┘     └──────────┘                    │
│       │                                  │                          │
│       │         ~200ms load              │                          │
│       └──────────────────────────────────┘                          │
│                                                                      │
│  SUBSEQUENT SEARCHES (cache hit):                                   │
│  ┌──────────┐     ┌──────────┐                                     │
│  │  Query   │ ──► │  Cache   │  ──► Results in <50ms               │
│  │          │     │  (RAM)   │                                      │
│  └──────────┘     └──────────┘                                     │
│                                                                      │
│  CACHE CONTENTS:                                                    │
│  • Pre-normalized Float32Arrays (ready for dot product)            │
│  • Item metadata (title, authors, year)                            │
│  • ~75MB for 1000 papers                                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Performance Benchmarks

Tested on MacBook Pro M3:

| Operation | Time |
|-----------|------|
| Model loading | ~1.5 seconds |
| Index 1 chunk | ~3 seconds |
| Index 10 papers (40 chunks) | ~2 minutes |
| First search | ~200ms |
| Subsequent searches | <50ms |
| Hybrid search | ~150ms |

---

## Query Analysis

The plugin automatically adjusts semantic vs keyword weights based on query characteristics:

```
┌─────────────────────────────────────────────────────────────────────┐
│                      QUERY ANALYSIS                                  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  KEYWORD BOOSTERS (favor exact matching):                           │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │ Pattern              │ Example              │ Boost            ││
│  ├──────────────────────┼──────────────────────┼──────────────────┤│
│  │ Year present         │ "Smith 2023"         │ +15% keyword     ││
│  │ Author pattern       │ "Jones et al."       │ +20% keyword     ││
│  │ Acronym              │ "RLHF models"        │ +10% keyword     ││
│  │ Quoted phrase        │ "machine learning"   │ +15% keyword     ││
│  │ Special characters   │ "p < 0.05"           │ +10% keyword     ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  SEMANTIC BOOSTERS (favor meaning matching):                        │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │ Pattern              │ Example                      │ Boost    ││
│  ├──────────────────────┼──────────────────────────────┼──────────┤│
│  │ Question format      │ "how does AI affect..."      │ +15% sem ││
│  │ Conceptual (4+ words)│ "trust in automated systems" │ +10% sem ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  EXAMPLES:                                                          │
│  ┌────────────────────────────────────────────────────────────────┐│
│  │ Query                        │ Weight │ Reasoning              ││
│  ├──────────────────────────────┼────────┼────────────────────────┤│
│  │ "Smith 2023"                 │ 35%/65%│ Year + author pattern  ││
│  │ "how does AI affect trust"   │ 65%/35%│ Question + conceptual  ││
│  │ "machine learning"           │ 50%/50%│ Balanced query         ││
│  │ "PRISMA 2020 guidelines"     │ 25%/75%│ Acronym + year         ││
│  └────────────────────────────────────────────────────────────────┘│
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Keyword Scoring

For keyword-only results, we calculate relevance scores based on:

```
Base score: 0.50 (any match)

Bonuses:
├── Title match:     +0.30 × (matched_terms / total_terms)
├── All in title:    +0.15 (if ALL query terms appear in title)
├── Year match:      +0.15 (if query contains the paper's year)
└── Author match:    +0.10 (if query matches author last name, 3+ chars)

Maximum: 1.00 (100%)
```

---

## Configuration

### Search Settings

| Preference | Default | Description |
|------------|---------|-------------|
| `hybridSearch.mode` | `"hybrid"` | `"hybrid"`, `"semantic"`, or `"keyword"` |
| `hybridSearch.semanticWeightPercent` | `50` | Balance (0=keyword, 100=semantic) |
| `hybridSearch.rrfK` | `60` | RRF constant (higher = more weight to top ranks) |
| `hybridSearch.autoAdjustWeights` | `true` | Auto-adjust based on query analysis |

### Chunking Settings

| Preference | Default | Description |
|------------|---------|-------------|
| `indexingMode` | `"full"` | `"abstract"` or `"full"` |
| `maxTokens` | 800 / 2000 | Max tokens per chunk (version-aware: 800 on Zotero 7, 2000 on Zotero 8) |
| `maxChunksPerPaper` | `100` | Max chunks per paper |

---

## Summary

ZotSeek combines:

1. **Semantic Understanding** - AI embeddings capture meaning, not just keywords
2. **Keyword Precision** - Zotero's search finds exact author/year/term matches
3. **Intelligent Fusion** - RRF combines both without score normalization
4. **Section Awareness** - Chunks respect academic paper structure
5. **Performance** - Optimized chunking and caching for fast searches

This hybrid approach gives you the best of both worlds: finding conceptually related papers while still being able to search for specific authors, years, and technical terms.

