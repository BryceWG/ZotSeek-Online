# Changelog

All notable changes to ZotSeek - Semantic Search for Zotero will be documented in this file.

## [1.3.0] - 2026-01-08

### Added
- **Search from PDF Selection** - Select text in PDF and right-click to find related documents
  - Appears in context menu when text is selected: "Find Related Documents"
  - Opens ZotSeek search dialog pre-filled with selected passage
  - Automatically excludes the current document from search results
  - Great for exploring concepts while reading
- **GPU Acceleration (Experimental)** - Automatic WebGPU detection for faster indexing
  - Up to 10-20x faster embeddings when WebGPU is available
  - Automatic fallback to CPU (WASM) when WebGPU is not supported
  - Check debug console for "Model loaded on GPU" or "Model loaded on CPU"
  - Note: Waiting for Zotero/Firefox to enable WebGPU (Firefox 141+ on Windows, macOS/Linux coming)

### Fixed
- **Scrolling on Windows** - Fixed VirtualizedTable scrolling in search dialogs on Windows
  - Results list now scrolls properly when content exceeds visible area
  - Affects both main ZotSeek search and "Find Similar Documents" dialogs

### Technical
- Added `createViewContextMenu` event listener for PDF reader text selection
- Search dialog now accepts `initialQuery` and `excludeItemId` parameters
- Added WebGPU detection with automatic fallback to WASM in embedding worker
- Used absolute positioning for bounded height in XUL windows (fixes CSS flex issues)

---

## [1.2.0] - 2026-01-05

### Added
- **Result Granularity Toggle** - Switch between two search result views in Full Document mode:
  - **By Section** (default): Aggregated results showing 1 result per paper with best matching section
  - **By Location**: All matching paragraphs with exact page & paragraph numbers and individual scores
- **References Filtering** - Bibliography sections are now automatically excluded from indexing
  - Detects section headers: "References", "Bibliography", "Works Cited", "Literature Cited"
  - Recognizes citation entry patterns: `[1]`, `Smith, J. (2021).`, DOI links
  - Stops indexing once references section is detected
- **Passage-Level Location** - Results in "By Location" mode show exact page and paragraph numbers
- **PDF Navigation** - Clicking a result in "By Location" mode opens PDF to the exact page

### Technical
- Added `returnAllChunks` option to search pipeline for parent-child retrieval pattern
- Added `chunkIndex` field to search results for unique chunk identification
- Implemented `computeAllChunkResultsFloat32()` for all-chunks mode in SearchEngine
- Modified RRF fusion to use `itemId-chunkIndex` composite key when returning all chunks
- Added `isReferencesHeader()` and `isReferenceEntry()` detection in chunker

---

## [1.1.0] - 2025-12-27

### Changed
- **Database Storage** - Moved from tables in Zotero's main database to separate `zotseek.sqlite` file
  - Uses SQLite ATTACH DATABASE pattern (inspired by Better BibTeX)
  - Keeps Zotero's main database clean and unbloated
  - Automatic migration from old schema (no user action required)
- **Menu Label** - Renamed "Index for ZotSeek" to "Index Selected for ZotSeek" for clarity

### Added
- **Database Path Display** - Settings panel now shows the database file location
- **Uninstall Cleanup** - Automatically removes database file and preferences on plugin uninstall

### Technical
- Database file stored at: `<Zotero Data Directory>/zotseek.sqlite`
- Migration copies data from old `zs_` tables, then drops them and runs VACUUM
- Added `getDatabasePath()` and `deleteDatabase()` methods to vector store

---

## [1.0.0] - 2025-12-26

### Initial Release 🎉

#### Core Features
- 🔍 **Semantic Search** - Find papers by meaning using local AI embeddings (nomic-embed-text-v1.5)
- 📚 **Find Similar Papers** - Right-click any paper to discover semantically related papers
- 🔎 **ZotSeek Search Dialog** - Search your library with natural language queries
- 🔗 **Hybrid Search** - Combines AI embeddings with Zotero's keyword search using RRF
  - Three search modes: Hybrid (recommended), Semantic Only, Keyword Only
  - Result indicators: 🔗 (both sources), 🧠 (semantic only), 🔤 (keyword only)
- 🗂️ **Flexible Indexing** - Index individual collections or entire library
  - Abstract mode: Fast, uses title + abstract only
  - Fulltext mode: Complete document analysis with section-aware chunking
- 🔒 **100% Local** - No data sent to cloud, works offline after model loads

#### Smart Features
- 📑 **Section-Aware Results** - Shows which section matched (Abstract, Methods, Results)
- 🎯 **Query Analysis** - Automatically adjusts weights based on query type
- ⚡ **Lightning Fast** - First search ~200ms, subsequent searches <50ms with caching
- 💾 **Smart Caching** - Pre-normalized Float32Arrays for instant searches
- 📊 **Stable Progress Tracking** - Reliable progress bars with ETA

#### Technical
- 🧠 **ChromeWorker Implementation** - Transformers.js runs in background thread
- 🛡️ **Rock-Solid SQLite** - Reliable parallel queries for Zotero 8
- ⚙️ **Settings Panel** - Easy configuration in Zotero preferences
- ❌ **Cancellation Support** - Cancel long-running operations anytime
