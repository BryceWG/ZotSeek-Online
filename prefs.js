// Default preferences for ZotSeek
// Note: Zotero prefs only support string, int, bool - not float
// minSimilarityPercent is stored as integer (30 = 30% = 0.3)

pref("extensions.zotero.zotseek.minSimilarityPercent", 30);
pref("extensions.zotero.zotseek.topK", 20);
pref("extensions.zotero.zotseek.autoIndex", false);
pref("extensions.zotero.zotseek.autoIndexDelay", 10);
pref("extensions.zotero.zotseek.embeddingProvider", "voyage");
pref("extensions.zotero.zotseek.embeddingModel", "voyage-3.5-lite");
pref("extensions.zotero.zotseek.embeddingApiKey", "");

// Indexing mode: "abstract" (title+abstract) or "full" (abstract + PDF sections)
pref("extensions.zotero.zotseek.indexingMode", "abstract");

// Chunking options for online embedding APIs
// Smaller chunks improve retrieval quality and reduce per-request payload size
pref("extensions.zotero.zotseek.maxTokens", 2000);
pref("extensions.zotero.zotseek.maxChunksPerPaper", 100);

// Item type filtering
// Exclude books from search results (books lack paper sections and are too long to index well)
pref("extensions.zotero.zotseek.excludeBooks", true);

// Hybrid search settings
// Combines semantic search with Zotero's keyword search using Reciprocal Rank Fusion
pref("extensions.zotero.zotseek.hybridSearch.enabled", true);
// Search mode: "hybrid", "semantic", or "keyword"
pref("extensions.zotero.zotseek.hybridSearch.mode", "hybrid");
// Semantic weight (0-100): 50 = equal weight, higher = more semantic, lower = more keyword
// Stored as integer percentage since Zotero prefs don't support floats
pref("extensions.zotero.zotseek.hybridSearch.semanticWeightPercent", 50);
// RRF constant k (typical: 60, from original RRF paper)
pref("extensions.zotero.zotseek.hybridSearch.rrfK", 60);
// Auto-adjust weights based on query analysis
pref("extensions.zotero.zotseek.hybridSearch.autoAdjustWeights", true);
