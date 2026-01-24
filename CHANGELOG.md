# Changelog

All notable changes to ZotSeek - Semantic Search for Zotero will be documented in this file.

## [1.6.0] - 2026-01-24

### Added
- **Checkpoint Saving** - Indexing now saves progress every 25 items
  - Resume safely after crash by simply re-running "Update Index"
  - Already-indexed items are automatically skipped
  - Shows batch progress during indexing (Batch X/Y)
- **Settings Button** - Quick access to ZotSeek preferences from the search dialog
  - Located in bottom-left corner of search dialog
  - Opens directly to the ZotSeek settings pane

### Changed
- **Redesigned Settings Panel** - Modern, visual preferences UI
  - Index statistics displayed as colorful cards (Papers, Chunks, Storage)
  - Indexing mode selection with visual radio-style cards
  - Organized sections: Auto-Indexing, Search Settings, Advanced Settings
  - Action buttons with visual hierarchy (green for recommended, yellow for destructive)
- **Improved Alerts** - Dialogs now show "ZotSeek" title instead of generic "[JavaScript Application]"

### Technical
- Implemented batch processing with `CHECKPOINT_BATCH_SIZE = 25`
- Added `isIndexed()` check to skip already-indexed items
- Replaced `win.alert()` with `Services.prompt.alert()` for proper dialog titles
- Added `updateModeCards()` for syncing visual state of mode selection cards

---

## [1.5.0] - 2026-01-20

### Added
- **Auto-Index New Items** - Automatically index papers when you add them to your library
  - Enable via Settings → ZotSeek → "Auto-index new items"
  - Waits for PDF attachments with automatic retry (exponential backoff)
  - Batches multiple items together during bulk imports
  - Shows live progress indicator while indexing
  - Respects your indexing mode setting (Abstract or Full Document)
- **Column Sorting** - Click column headers to sort search results
  - Sort by Match %, Year, Title, Authors, or Source
  - Smart defaults: Match/Year sort descending, text columns ascending
  - Visual indicators (▲/▼) show current sort direction

### Technical
- New `AutoIndexManager` singleton using `Zotero.Notifier.registerObserver()` API
- Added `indexItemsSilent()` method for background indexing with progress window
- Fixed `setIcon` compatibility issue with Zotero's ProgressWindow API

---

## [1.4.0] - 2026-01-15

### Added
- **Zotero 7 Support** - Now compatible with both Zotero 7 (stable) and Zotero 8 (beta)
  - Extended `strict_min_version` from `7.999` to `6.999`
  - Same feature set across both versions
- **Full Paper Mode Default** - Full Document indexing is now the default for better search quality
- **Version-Aware Performance Warning** - Preferences panel shows performance note only on Zotero 7
  - Warns about slower WASM performance on Firefox 115
  - Hidden on Zotero 8 where performance is optimal

### Changed
- **Version-Aware Defaults** - Chunk size defaults optimized per Zotero version
  - Zotero 7: 800 tokens per chunk (faster on slower WASM)
  - Zotero 8: 2000 tokens per chunk (full speed)

### Known Issues
- **Zotero 7 Full Document Indexing is ~8-10x Slower** - Firefox 115 (Zotero 7) has significantly slower WASM SIMD performance than Firefox 140 (Zotero 8)
  - Abstract mode works at normal speed on both versions
  - Full Document mode on Zotero 7: ~6 seconds per chunk vs ~0.5 seconds on Zotero 8
  - Worker automatically limits chunks to 3000 chars on Zotero 7
  - **Recommendation:** Use Abstract mode on Zotero 7 for faster indexing, or upgrade to Zotero 8

### Technical
- **Automated Release Script** - New `npm run release` workflow
  - Interactive version bumping via bumpp
  - Auto-generates `update.json` from `package.json` version
  - Builds and packages XPI in one command
- **Version Sync** - `package.json` is now the source of truth for version
  - `manifest.json` and `update.json` are synced automatically
- **Zotero Version Detection** - Detects Firefox version via `Zotero.platformMajorVersion`
  - Passed to ChromeWorker for chunk size optimization
  - Used in preferences UI for conditional warning display
- **Improved Worker Error Handling** - Better error messages from ChromeWorker failures

---

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
