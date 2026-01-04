/**
 * ZotSeek Search Dialog with VirtualizedTable
 *
 * This dialog provides a native Zotero-style interface for semantic search
 * using the VirtualizedTableHelper from zotero-plugin-toolkit.
 */

import { SearchResultsTable } from './results-table';
import { SearchEngine, searchEngine, SearchResult } from '../core/search-engine';
import { HybridSearchEngine, HybridSearchResult, SearchMode } from '../core/hybrid-search';
import { ZoteroAPI } from '../utils/zotero-api';
import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';

declare const Zotero: any;

export class ZotSeekDialogVTable {
  private logger: Logger;
  private zoteroAPI: ZoteroAPI;
  private resultsTable: SearchResultsTable | null = null;
  private window: Window | null = null;

  // Raw results from search (all individual paragraph matches)
  private rawResults: HybridSearchResult[] = [];
  // Currently displayed results (may be aggregated in section mode)
  private displayedResults: HybridSearchResult[] = [];

  private enrichedData: Map<number, any> = new Map();
  private isSearching: boolean = false;
  private searchTimeout: number | null = null;
  private lastQuery: string = '';
  private autoSearchDelay: number = 500; // milliseconds to wait after typing stops
  private minQueryLength: number = 3; // minimum characters before auto-search triggers

  // Hybrid search
  private hybridSearch: HybridSearchEngine;
  private searchMode: SearchMode = 'hybrid';
  private autoAdjustWeights: boolean = true;

  // Results granularity: 'section' shows aggregated by section, 'location' shows exact page/paragraph
  private granularity: 'section' | 'location' = 'section';

  // Indexing mode: 'abstract' or 'full' - affects whether granularity toggle is shown
  private indexingMode: 'abstract' | 'full' = 'abstract';

  constructor() {
    this.logger = new Logger('ZotSeekDialogVTable');
    this.zoteroAPI = new ZoteroAPI();
    this.hybridSearch = new HybridSearchEngine(searchEngine);
    
    // Load preferences
    this.loadPreferences();
  }
  
  /**
   * Load hybrid search preferences from Zotero prefs
   */
  private loadPreferences(): void {
    try {
      const Z = getZotero();
      if (Z && Z.Prefs) {
        const mode = Z.Prefs.get('extensions.zotero.zotseek.hybridSearch.mode', true);
        if (mode === 'hybrid' || mode === 'semantic' || mode === 'keyword') {
          this.searchMode = mode;
        }

        this.autoAdjustWeights = Z.Prefs.get('extensions.zotero.zotseek.hybridSearch.autoAdjustWeights', true) !== false;

        // Load indexing mode to determine if granularity toggle should be shown
        const indexMode = Z.Prefs.get('extensions.zotero.zotseek.indexingMode', true);
        this.logger.info(`Loaded indexingMode preference: "${indexMode}" (type: ${typeof indexMode})`);
        if (indexMode === 'abstract' || indexMode === 'full') {
          this.indexingMode = indexMode;
        } else {
          // Default to showing the toggle (full mode) if preference is unclear
          this.indexingMode = 'full';
          this.logger.warn(`Unknown indexingMode "${indexMode}", defaulting to "full"`);
        }
      }
    } catch (e) {
      this.logger.warn('Failed to load preferences, using defaults:', e);
    }
  }

  /**
   * Initialize the dialog (called from XHTML onload)
   */
  async init(win: Window): Promise<void> {
    this.window = win;
    const doc = win.document;

    // Reload preferences each time dialog opens (in case they changed)
    this.loadPreferences();

    try {
      // Initialize results table
      this.resultsTable = new SearchResultsTable({
        containerId: 'zotseek-results-container',
        onSelectionChange: (indices) => this.onSelectionChange(indices),
        onActivate: (index) => this.onActivate(index),
      });

      await this.resultsTable.init(win);

      // Bind event handlers
      const searchBtn = doc.getElementById('zotseek-btn');
      const queryInput = doc.getElementById('zotseek-query') as HTMLInputElement;
      const openBtn = doc.getElementById('zotseek-open-btn');
      const closeBtn = doc.getElementById('zotseek-close-btn');

      searchBtn?.addEventListener('click', () => this.performSearch());

      // Add auto-search on input with debouncing
      queryInput?.addEventListener('input', (e) => {
        const query = (e.target as HTMLInputElement).value.trim();

        // Clear existing timeout
        if (this.searchTimeout) {
          win.clearTimeout(this.searchTimeout);
          this.searchTimeout = null;
        }

        // Don't search if query is empty
        if (!query) {
          this.setStatus(''); // Clear status when no query
          // Clear results if query is cleared
          this.rawResults = [];
          this.displayedResults = [];
          this.enrichedData.clear();
          this.resultsTable?.setResults([]);
          this.lastQuery = '';
          return;
        }

        // Check minimum query length
        if (query.length < this.minQueryLength) {
          this.setStatus(`Type at least ${this.minQueryLength} characters...`);
          return;
        }

        // Skip if same query and we have results
        if (query === this.lastQuery && this.rawResults.length > 0) {
          return;
        }

        // Set status to indicate we're waiting
        this.setStatus('Searching in a moment...');

        // Set new timeout for auto-search
        this.searchTimeout = win.setTimeout(() => {
          this.performSearch();
        }, this.autoSearchDelay);
      });

      // Keep Enter key for immediate search
      queryInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !this.isSearching) {
          // Clear any pending auto-search
          if (this.searchTimeout) {
            win.clearTimeout(this.searchTimeout);
            this.searchTimeout = null;
          }
          this.performSearch();
        }
      });

      openBtn?.addEventListener('click', () => this.openSelected());
      closeBtn?.addEventListener('click', () => this.close());

      // Find Pages button
      const findPagesBtn = doc.getElementById('zotseek-find-pages-btn');
      findPagesBtn?.addEventListener('click', () => this.findExactPages());

      // Add keyboard shortcuts
      win.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.close();
        }
      });
      
      // Initialize search mode dropdown
      const modeSelect = doc.getElementById('search-mode-select') as HTMLSelectElement;
      if (modeSelect) {
        // Set current value from preference
        modeSelect.value = this.searchMode;
        
        // Handle mode changes
        modeSelect.addEventListener('command', (e) => {
          const newMode = (e.target as HTMLSelectElement).value as SearchMode;
          this.setSearchMode(newMode);
        });
        
        // Also handle 'change' event for HTML select elements
        modeSelect.addEventListener('change', (e) => {
          const newMode = (e.target as HTMLSelectElement).value as SearchMode;
          this.setSearchMode(newMode);
        });
      }
      
      // Initialize granularity radio buttons
      // Only show granularity toggle when indexing mode is "full" (has page/paragraph data)
      const granularityRow = doc.getElementById('granularity-row');
      const sectionRadio = doc.getElementById('granularity-section') as HTMLInputElement;
      const locationRadio = doc.getElementById('granularity-location') as HTMLInputElement;

      if (granularityRow) {
        // Always show granularity toggle - it will just show "—" for location if no page data
        // This lets users see the option exists and understand why results might differ
        (granularityRow as HTMLElement).style.display = '';
        this.logger.info(`Granularity row shown (indexingMode="${this.indexingMode}")`);
      } else {
        this.logger.warn('granularity-row element not found!');
      }

      if (sectionRadio && locationRadio) {
        // Set initial state
        sectionRadio.checked = this.granularity === 'section';
        locationRadio.checked = this.granularity === 'location';

        // Handle changes
        sectionRadio.addEventListener('change', () => {
          if (sectionRadio.checked) {
            this.setGranularity('section');
          }
        });

        locationRadio.addEventListener('change', () => {
          if (locationRadio.checked) {
            this.setGranularity('location');
          }
        });
      }

      // Expose setSearchMode globally for XUL command attribute
      (win as any).searchDialogVTable = {
        setSearchMode: (mode: SearchMode) => this.setSearchMode(mode),
        getSearchMode: () => this.getSearchMode(),
        setGranularity: (g: 'section' | 'location') => this.setGranularity(g),
        getGranularity: () => this.granularity,
      };

      // Focus the input
      queryInput?.focus();

      this.logger.info(`Search dialog initialized (mode: ${this.searchMode})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      this.logger.error('Failed to initialize dialog:', errorMessage);
      this.logger.error('Stack trace:', errorStack);
      this.setStatus(`Failed to initialize dialog: ${errorMessage}`);
    }
  }

  /**
   * Perform the search using hybrid search
   */
  private async performSearch(): Promise<void> {
    if (!this.window || this.isSearching) return;
    const doc = this.window.document;

    const queryInput = doc.getElementById('zotseek-query') as HTMLInputElement;
    const query = queryInput?.value?.trim();

    if (!query) {
      this.setStatus(''); // Don't show error, user knows to enter query
      return;
    }

    // Skip if same query as last search
    if (query === this.lastQuery && this.rawResults.length > 0) {
      return;
    }

    this.isSearching = true;
    this.lastQuery = query;
    const searchBtn = doc.getElementById('zotseek-btn') as HTMLButtonElement;
    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching...';
    }

    try {
      this.setStatus('Initializing search...');
      this.setOpenButtonEnabled(false);

      // Show search mode in status
      const modeLabel = this.searchMode === 'hybrid' ? 'Hybrid' : 
                        this.searchMode === 'semantic' ? 'Semantic' : 'Keyword';
      this.setStatus(`${modeLabel} search: Initializing...`);

      // Initialize search engine if needed (hybrid search will init as needed)
      if (this.searchMode !== 'keyword' && !searchEngine.isReady()) {
        this.setStatus('Loading AI model (first time may take a moment)...');
        await searchEngine.init();
      }

      // Perform hybrid search
      this.setStatus(`${modeLabel} search: Finding items...`);

      // Determine if we need all chunks (location mode) or aggregated results (section mode)
      const returnAllChunks = this.granularity === 'location';

      // Use smart search (auto-adjusts weights) or regular search based on preference
      if (this.searchMode === 'hybrid' && this.autoAdjustWeights) {
        this.rawResults = await this.hybridSearch.smartSearch(query, {
          finalTopK: returnAllChunks ? 150 : 50, // Get more results in location mode
          minSimilarity: 0.2,
          mode: this.searchMode,
          returnAllChunks,
        });
      } else {
        this.rawResults = await this.hybridSearch.search(query, {
          finalTopK: returnAllChunks ? 150 : 50,
          minSimilarity: 0.2,
          mode: this.searchMode,
          returnAllChunks,
        });
      }

      // In location mode, rawResults already has all chunks; in section mode, it's already aggregated
      // Apply additional granularity filtering as safety measure
      this.displayedResults = this.applyGranularity(this.rawResults);

      // Update table with results (metadata is already populated by hybrid search)
      await this.resultsTable?.setHybridResults(this.displayedResults);

      // Force a re-render
      if (this.resultsTable) {
        await this.resultsTable.render();
      }

      // Update status with detailed info
      const statusMsg = this.buildStatusMessage();
      this.setStatus(statusMsg);

      // Enable Find Pages button if we have results
      this.setFindPagesEnabled(this.displayedResults.length > 0);

      // Keep focus on the search input
      const searchInput = this.window?.document.getElementById('zotseek-query') as HTMLInputElement;
      searchInput?.focus();

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Search failed: ${message}`);
      this.logger.error('Search failed:', error);
    } finally {
      this.isSearching = false;
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      }
    }
  }
  
  /**
   * Build status message with search result summary
   */
  private buildStatusMessage(): string {
    if (this.displayedResults.length === 0) {
      return 'No items found';
    }

    // Count results by source
    let bothCount = 0;
    let semanticOnlyCount = 0;
    let keywordOnlyCount = 0;

    for (const r of this.displayedResults) {
      if (r.source === 'both') bothCount++;
      else if (r.source === 'semantic') semanticOnlyCount++;
      else if (r.source === 'keyword') keywordOnlyCount++;
    }

    // Build status with granularity info
    let statusParts: string[] = [];

    if (this.granularity === 'section' && this.rawResults.length !== this.displayedResults.length) {
      // Show aggregation info: "Found 15 items (from 42 matches)"
      statusParts.push(`Found ${this.displayedResults.length} items (from ${this.rawResults.length} matches)`);
    } else {
      statusParts.push(`Found ${this.displayedResults.length} items`);
    }

    if (this.searchMode === 'hybrid' && bothCount > 0) {
      statusParts.push(`(🔗 ${bothCount} · 🧠 ${semanticOnlyCount} · 🔤 ${keywordOnlyCount})`);
    }

    return statusParts.join(' ');
  }

  /**
   * Apply granularity to results
   * - 'section': Aggregate by item, keep best score per item
   * - 'location': Show all individual matches
   */
  private applyGranularity(results: HybridSearchResult[]): HybridSearchResult[] {
    if (this.granularity === 'location') {
      // Show all individual paragraph matches
      return results;
    }

    // Section mode: Aggregate by itemId, keep best match per item
    const bestByItem = new Map<number, HybridSearchResult>();

    for (const result of results) {
      const existing = bestByItem.get(result.itemId);
      if (!existing) {
        bestByItem.set(result.itemId, result);
      } else {
        // Keep the one with higher score (use rrfScore for hybrid, semanticScore for semantic)
        const existingScore = existing.rrfScore ?? existing.semanticScore ?? 0;
        const newScore = result.rrfScore ?? result.semanticScore ?? 0;
        if (newScore > existingScore) {
          bestByItem.set(result.itemId, result);
        }
      }
    }

    // Return aggregated results, maintaining original order
    const itemOrder = new Map<number, number>();
    results.forEach((r, i) => {
      if (!itemOrder.has(r.itemId)) {
        itemOrder.set(r.itemId, i);
      }
    });

    return Array.from(bestByItem.values()).sort((a, b) => {
      return (itemOrder.get(a.itemId) ?? 0) - (itemOrder.get(b.itemId) ?? 0);
    });
  }
  
  /**
   * Set the search mode
   */
  setSearchMode(mode: SearchMode): void {
    this.searchMode = mode;
    this.logger.info(`Search mode changed to: ${mode}`);

    // Save preference
    try {
      const Z = getZotero();
      if (Z && Z.Prefs) {
        Z.Prefs.set('extensions.zotero.zotseek.hybridSearch.mode', mode, true);
      }
    } catch (e) {
      this.logger.warn('Failed to save search mode preference:', e);
    }

    // Clear results and re-search if there's a query
    this.lastQuery = '';
    this.rawResults = [];
    this.displayedResults = [];
    this.resultsTable?.setHybridResults([]);

    // Trigger new search if there's a query
    const queryInput = this.window?.document.getElementById('zotseek-query') as HTMLInputElement;
    if (queryInput?.value?.trim()) {
      this.performSearch();
    }
  }
  
  /**
   * Get current search mode
   */
  getSearchMode(): SearchMode {
    return this.searchMode;
  }

  /**
   * Set the results granularity
   */
  async setGranularity(granularity: 'section' | 'location'): Promise<void> {
    const oldGranularity = this.granularity;
    this.granularity = granularity;
    this.logger.info(`Granularity changed to: ${granularity}`);

    // Update results table display mode
    if (this.resultsTable) {
      this.resultsTable.setGranularity(granularity);
    }

    // If granularity changed and we have a query, re-search to get appropriate data
    // Location mode needs all chunks, section mode needs aggregated results
    if (oldGranularity !== granularity && this.lastQuery) {
      // Clear lastQuery to force re-search
      const query = this.lastQuery;
      this.lastQuery = '';
      this.rawResults = [];
      this.displayedResults = [];
      await this.performSearch();
    }
  }

  /**
   * Handle selection change in table
   */
  private onSelectionChange(indices: number[]): void {
    this.setOpenButtonEnabled(indices.length > 0);

    // Don't update status with selection - the table highlight is enough
  }

  /**
   * Handle double-click / Enter on row
   */
  private onActivate(index: number): void {
    const result = this.resultsTable?.getResultAt(index);
    if (result) {
      // Get page number (exact from Find Pages, or estimated from index)
      const exactPage = this.resultsTable?.getExactPage(result.itemId);
      const hybridResult = result as HybridSearchResult;
      const pageNumber = exactPage || hybridResult.pageNumber;

      this.openItem(result.itemId, pageNumber);
    }
  }

  /**
   * Open the selected item(s)
   */
  private openSelected(): void {
    const result = this.resultsTable?.getSelectedResult();
    if (result) {
      // Get page number (exact from Find Pages, or estimated from index)
      const exactPage = this.resultsTable?.getExactPage(result.itemId);
      const hybridResult = result as HybridSearchResult;
      const pageNumber = exactPage || hybridResult.pageNumber;

      this.openItem(result.itemId, pageNumber);
    }
  }

  /**
   * Open an item in Zotero, optionally to a specific page
   */
  private async openItem(itemId: number, pageNumber?: number): Promise<void> {
    try {
      // Select the item in the library
      this.zoteroAPI.selectItem(itemId);

      // If we have a page number, open PDF to that page
      if (pageNumber) {
        await this.zoteroAPI.openPDFToPage(itemId, pageNumber);
        this.logger.info(`Opened item ${itemId} to page ${pageNumber}`);
      }

      // Keep dialog open so user can browse more results
    } catch (error) {
      this.logger.error('Failed to open item:', error);
      this.setStatus('Failed to open item in Zotero');
    }
  }

  /**
   * Update status text
   */
  private setStatus(message: string): void {
    const statusEl = this.window?.document.getElementById('zotseek-status-text');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  /**
   * Enable/disable open button
   */
  private setOpenButtonEnabled(enabled: boolean): void {
    const btn = this.window?.document.getElementById('zotseek-open-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = !enabled;
    }
  }

  /**
   * Enable/disable find pages button
   */
  private setFindPagesEnabled(enabled: boolean): void {
    const btn = this.window?.document.getElementById('zotseek-find-pages-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = !enabled;
    }
  }

  /**
   * Find exact PDF page numbers for all search results
   * Uses PDFWorker to search each PDF page-by-page
   */
  private async findExactPages(): Promise<void> {
    if (!this.resultsTable || this.displayedResults.length === 0) return;

    const findPagesBtn = this.window?.document.getElementById('zotseek-find-pages-btn') as HTMLButtonElement;
    if (findPagesBtn) {
      findPagesBtn.disabled = true;
      findPagesBtn.textContent = 'Finding...';
    }

    try {
      const itemIds = this.resultsTable.getResultItemIds();
      const foundPages = new Map<number, number>();
      let processed = 0;
      let found = 0;

      this.setStatus(`Finding page locations (0/${itemIds.length})...`);

      for (const itemId of itemIds) {
        processed++;

        // Get search text (title) for this item
        const searchText = this.resultsTable.getSearchTextForItem(itemId);
        if (!searchText) continue;

        // Find exact page using PDFWorker
        try {
          const page = await this.zoteroAPI.findExactPage(itemId, searchText);
          if (page !== null) {
            foundPages.set(itemId, page);
            found++;
          }
        } catch (error) {
          this.logger.warn(`Failed to find page for item ${itemId}:`, error);
        }

        // Update status periodically
        if (processed % 3 === 0 || processed === itemIds.length) {
          this.setStatus(`Finding page locations (${processed}/${itemIds.length})...`);
        }
      }

      // Update the table with found pages
      await this.resultsTable.updateExactPages(foundPages);

      // Show completion status
      this.setStatus(`Found ${found}/${processed} page locations`);
      this.logger.info(`Found exact pages for ${found}/${processed} items`);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Failed to find pages: ${message}`);
      this.logger.error('Find pages failed:', error);
    } finally {
      if (findPagesBtn) {
        findPagesBtn.disabled = false;
        findPagesBtn.textContent = 'Find Pages';
      }
    }
  }

  /**
   * Close the dialog
   */
  private close(): void {
    this.window?.close();
  }

  /**
   * Cleanup (called from XHTML onunload)
   */
  cleanup(): void {
    // Clear any pending search timeout
    if (this.searchTimeout && this.window) {
      this.window.clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    this.resultsTable?.destroy();
    this.resultsTable = null;
    this.rawResults = [];
    this.displayedResults = [];
    this.enrichedData.clear();
    this.window = null;
    this.lastQuery = '';
    this.logger.info('Search dialog cleaned up');
  }
}

// Export singleton for XHTML binding
export const zotseekDialogVTable = new ZotSeekDialogVTable();

// Set up for standalone dialog bundle - like BetterNotes does
// (Zotero is already declared at the top of the file)

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  try {
    await zotseekDialogVTable.init(window);
  } catch (error) {
    console.error('Failed to initialize dialog:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

// Cleanup on window unload
window.addEventListener("unload", () => {
  zotseekDialogVTable.cleanup();
});
