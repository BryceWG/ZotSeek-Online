/**
 * ZotSeek - Semantic Search for Zotero
 *
 * Main entry point for the plugin.
 */

// Access Zotero through the global context set by bootstrap
declare const _globalThis: any;
declare const Zotero: any;
declare const ChromeUtils: any;
declare const Components: any;
declare const Services: any;  // Zotero 8 global Services object

// Import core modules
import { PaperEmbedding, getVectorStore, IVectorStore } from './core/storage-factory';
import { embeddingPipeline, EmbeddingProgress } from './core/embedding-pipeline';
import { searchEngine, SearchResult } from './core/search-engine';
import { textExtractor, ExtractedText, ExtractedChunks } from './core/text-extractor';
import { ZoteroAPI } from './utils/zotero-api';
import { getIndexingMode } from './utils/chunker';
import { getZotero } from './utils/zotero-helper';
// Use stable progress window from toolkit to avoid crashes
import { StableProgressWindow } from './utils/stable-progress';
// UI components
import { searchDialog } from './ui/search-dialog';
import { searchDialogWithVTable } from './ui/search-dialog-with-vtable';
import { similarDocumentsWrapper } from './ui/similar-documents-wrapper';
import { toolbarButton } from './ui/toolbar-button';
import { preferencesManager } from './ui/preferences';

interface PluginInfo {
  id: string;
  version: string;
  rootURI: string;
}

/**
 * Simple logger - only uses Zotero.debug (no console)
 */
class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = `[${prefix}]`;
  }

  private log(level: string, ...args: any[]): void {
    const msg = `${this.prefix} [${level}] ${args.join(' ')}`;
    const Z = getZotero();
    if (Z && Z.debug) {
      Z.debug(msg);
    }
  }

  info(...args: any[]): void {
    this.log('INFO', ...args);
  }

  warn(...args: any[]): void {
    this.log('WARN', ...args);
  }

  error(...args: any[]): void {
    this.log('ERROR', ...args);
  }

  debug(...args: any[]): void {
    this.log('DEBUG', ...args);
  }
}

/**
 * Main plugin class
 */
class ZotSeekPlugin {
  private info: PluginInfo | null = null;
  private logger: Logger;
  private zoteroAPI: ZoteroAPI;
  public vectorStore: IVectorStore | null = null;  // Public for preference pane access
  private initialized = false;
  private indexing = false;

  // Hooks for bootstrap.js
  public hooks = {
    onStartup: () => this.onStartup(),
    onShutdown: () => this.onShutdown(),
    onMainWindowLoad: (win: Window) => this.onMainWindowLoad(win),
    onMainWindowUnload: (win: Window) => this.onMainWindowUnload(win),
    onPrefsEvent: (type: string, data: any) => this.onPrefsEvent(type, data),
  };

  constructor() {
    this.logger = new Logger('ZotSeek');
    this.zoteroAPI = new ZoteroAPI();
    this.logger.debug('Plugin initialized with ZoteroToolkit logging');
  }

  setInfo(info: PluginInfo): void {
    this.info = info;
    this.logger.info(`Plugin version: ${info.version}`);
  }

  /**
   * Initialize default preferences if not already set
   * Note: Zotero prefs only support string, int, bool - not float
   * Defaults are version-aware: Zotero 7 (Firefox < 128) uses smaller chunks
   */
  private initDefaultPreferences(): void {
    const Z = getZotero();
    if (!Z) return;

    // Detect Firefox version for version-aware defaults
    // Firefox 115 (Zotero 7) has ~8-10x slower WASM than Firefox 140 (Zotero 8)
    const platformVersion = Z.platformMajorVersion || 0;
    const isSlowFirefox = platformVersion > 0 && platformVersion < 128;

    if (isSlowFirefox) {
      this.logger.info(`Firefox ${platformVersion} detected - using optimized defaults for slower WASM`);
    }

    // Store minSimilarity as int (30 = 0.3, divide by 100 when reading)
    // Using nomic-embed-text-v1.5 with 8192 token context window
    const defaults: { [key: string]: any } = {
      'zotseek.minSimilarityPercent': 30,  // 30% = 0.3
      'zotseek.topK': 20,
      'zotseek.autoIndex': false,
      'zotseek.indexingMode': 'full',  // 'abstract' or 'full' - full paper mode is default for better search quality
      // Version-aware chunking defaults:
      // - Zotero 8 (FF 140): Larger chunks (2000 tokens), faster WASM
      // - Zotero 7 (FF 115): Smaller chunks (800 tokens), slower WASM needs O(n²) mitigation
      // Both use 100 max chunks for good coverage of full papers
      'zotseek.maxTokens': isSlowFirefox ? 800 : 2000,
      'zotseek.maxChunksPerPaper': 100,
      'zotseek.excludeBooks': true,        // Exclude books from search/indexing by default
    };

    for (const [key, defaultValue] of Object.entries(defaults)) {
      try {
        const currentValue = Z.Prefs.get(key, true);
        if (currentValue === undefined) {
          this.logger.info(`Setting default preference: ${key} = ${defaultValue}`);
          Z.Prefs.set(key, defaultValue, true);
        } else {
          this.logger.info(`Preference ${key} already set: ${currentValue}`);
        }
      } catch (e) {
        this.logger.warn(`Failed to set preference ${key}: ${e}`);
      }
    }
  }

  async onStartup(): Promise<void> {
    const Z = getZotero();
    if (!Z) {
      this.logger.error('Zotero not available');
      return;
    }

    // Wait for UI to be ready
    await Z.uiReadyPromise;

    // Log startup with timestamp
    this.logger.info('=== ZotSeek Starting ===');
    this.logger.info(`Version: ${this.info?.version || 'unknown'}`);
    this.logger.info(`Time: ${new Date().toISOString()}`);

    // Set default preferences if not already set
    this.initDefaultPreferences();

    // Initialize core modules
    try {
      await this.initializeCore();
    } catch (error) {
      this.logger.error(`Failed to initialize core modules: ${error}`);
    }

    // Register context menu using Zotero 8 MenuManager API (preferred)
    // Falls back to XUL injection for older versions
    this.registerContextMenu();

    // Register preference pane
    this.registerPreferencePane();

    // Add toolbar button for semantic search
    const win = Z.getMainWindow();
    if (win) {
      toolbarButton.add(win);
      toolbarButton.registerToolsMenu(win);
      this.logger.info('Toolbar button and Tools menu added');
    }

    // Register reader toolbar button
    await toolbarButton.registerReaderToolbar();
    this.logger.info('Reader toolbar button registered');

    // Register reader text selection context menu ("Find Related Papers")
    await toolbarButton.registerReaderContextMenu();
    this.logger.info('Reader context menu registered');

    this.logger.info('=== Plugin Started Successfully ===');
  }

  private async initializeCore(): Promise<void> {
    this.logger.info('Initializing core modules...');

    // Get SQLite vector store (lazy initialization)
    this.vectorStore = getVectorStore();

    // Don't initialize store on startup - do it lazily on first use
    this.logger.info('Vector store configured (will initialize on first use)');

    this.initialized = true;
  }

  /**
   * Ensure vector store is initialized before use
   */
  private async ensureStoreReady(): Promise<void> {
    if (!this.vectorStore) {
      this.logger.info('Getting vector store...');
      this.vectorStore = getVectorStore();
    }

    if (!this.vectorStore.isReady()) {
      this.logger.info('Initializing vector store...');
      try {
        await this.vectorStore.init();
        this.logger.info('Vector store initialized');
      } catch (error: any) {
        this.logger.error(`Vector store init failed: ${error?.message || error}`);
        throw error;
      }
    }
  }

  onMainWindowLoad(window: Window): void {
    this.logger.info('Main window loaded');
    // Menu is registered via MenuManager in onStartup, no need to re-register here
  }

  onMainWindowUnload(window: Window): void {
    this.logger.info('Main window unloading');
    // MenuManager handles cleanup automatically
  }

  /**
   * Handle preference pane events
   */
  async onPrefsEvent(type: string, data: any): Promise<void> {
    switch (type) {
      case 'load':
        this.logger.info('Preference pane loaded');
        await preferencesManager.init(data.window);
        break;
      case 'unload':
        this.logger.info('Preference pane unloaded');
        preferencesManager.destroy();
        break;
      default:
        break;
    }
  }

  /**
   * Register context menu items
   * Note: MenuManager API requires l10nID (localization) for labels.
   * Using XUL injection for now as it works with plain text labels.
   * Reference: https://www.zotero.org/support/dev/zotero_8_for_developers
   */
  private registerContextMenu(): void {
    const Z = getZotero();
    if (!Z) return;

    // Use XUL injection - works reliably with plain text labels
    // MenuManager API requires l10nID localization which we haven't set up yet
    this.registerWithXUL(Z);
  }

  /**
   * Register menus using XUL element injection
   * Works on both Zotero 7 and 8
   */
  private registerWithXUL(Z: any): void {
    this.logger.info('Registering menus via XUL injection');

    const win = Z.getMainWindow();
    if (!win) {
      this.logger.warn('No main window available for XUL injection');
      return;
    }

    const doc = win.document;
    const itemMenu = doc.getElementById('zotero-itemmenu');

    if (!itemMenu) {
      this.logger.warn('Could not find zotero-itemmenu');
      return;
    }

    // Check if already registered
    if (doc.getElementById('zotseek-find-similar')) {
      this.logger.debug('Context menu already registered');
      return;
    }

    // Create separator
    const separator = doc.createXULElement('menuseparator');
    separator.id = 'zotseek-separator';

    // Create "Find Similar Documents" menu item
    const findSimilarItem = doc.createXULElement('menuitem');
    findSimilarItem.id = 'zotseek-find-similar';
    findSimilarItem.setAttribute('label', 'Find Similar Documents');
    findSimilarItem.addEventListener('command', () => this.onFindSimilar());

    // Create "Open ZotSeek" menu item for general search
    const openSearchItem = doc.createXULElement('menuitem');
    openSearchItem.id = 'zotseek-open-dialog';
    openSearchItem.setAttribute('label', 'Open ZotSeek...');
    openSearchItem.addEventListener('command', () => searchDialogWithVTable.open());

    // Create "Index Selected" menu item
    const indexSelectedItem = doc.createXULElement('menuitem');
    indexSelectedItem.id = 'zotseek-index-selected';
    indexSelectedItem.setAttribute('label', 'Index Selected for ZotSeek');
    indexSelectedItem.addEventListener('command', () => this.onIndexSelected());

    // Create "Index Collection" menu item
    const indexCollectionItem = doc.createXULElement('menuitem');
    indexCollectionItem.id = 'zotseek-index-collection';
    indexCollectionItem.setAttribute('label', 'Index Current Collection');
    indexCollectionItem.addEventListener('command', () => this.onIndexCollection());

    // Create "Index Library" menu item
    const indexLibraryItem = doc.createXULElement('menuitem');
    indexLibraryItem.id = 'zotseek-index-library';
    indexLibraryItem.setAttribute('label', 'Update Library Index');
    indexLibraryItem.addEventListener('command', () => this.onIndexLibrary());

    itemMenu.appendChild(separator);
    itemMenu.appendChild(findSimilarItem);
    itemMenu.appendChild(openSearchItem);
    itemMenu.appendChild(indexSelectedItem);
    itemMenu.appendChild(indexCollectionItem);
    itemMenu.appendChild(indexLibraryItem);

    this.logger.info('Context menu registered successfully');
  }

  /**
   * Register the preference pane
   * Reference: https://www.zotero.org/support/dev/zotero_7_for_developers#preference_panes
   */
  private registerPreferencePane(): void {
    const Z = getZotero();
    if (!Z || !Z.PreferencePanes) {
      this.logger.warn('Zotero.PreferencePanes not available');
      return;
    }

    try {
      Z.PreferencePanes.register({
        pluginID: this.info?.id || 'zotseek@zotero.org',
        src: `${this.info?.rootURI || 'chrome://zotseek/'}content/preferences.xhtml`,
        label: 'ZotSeek',
        image: `${this.info?.rootURI || 'chrome://zotseek/'}content/icons/favicon.png`,
      });
      this.logger.info('Preference pane registered successfully');
    } catch (error) {
      this.logger.error(`Failed to register preference pane: ${error}`);
    }
  }

  /**
   * Public method to clear the index (called from preferences pane)
   */
  public async clearIndex(): Promise<void> {
    const Z = getZotero();

    const confirmed = Services.prompt.confirm(
      Z?.getMainWindow(),
      'Clear ZotSeek Index',
      'This will delete all stored embeddings. You will need to re-index your library.\n\nContinue?'
    );

    if (!confirmed) return;

    // Create stable progress window for clearing
    const progressWindow = new StableProgressWindow({
      title: 'Clearing ZotSeek Index',
    });

    try {
      progressWindow.updateProgress('Initializing storage...', null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        progressWindow.updateProgress('Deleting all embeddings...', 50);
        await this.vectorStore.clear();

        progressWindow.complete('Index cleared successfully!');
        this.logger.info('Index cleared via preferences');

        // Show additional alert for confirmation
        setTimeout(() => {
          this.showAlert('Index cleared successfully.\n\nYou can now re-index your library.');
        }, 500);
      }
    } catch (error: any) {
      this.logger.error(`Failed to clear index: ${error}`);
      progressWindow.error(`Failed to clear index: ${error.message || error}`, true);
      this.showAlert(`Failed to clear index: ${error.message || error}`);
    }
  }

  /**
   * Public method to index the entire library (called from preferences pane)
   */
  public indexLibrary(): void {
    this.onIndexLibrary();
  }

  /**
   * Public method to rebuild the index (clear + reindex)
   * This ensures the new indexing mode setting is applied
   */
  public async rebuildIndex(): Promise<void> {
    const Z = getZotero();

    const confirmed = Services.prompt.confirm(
      Z?.getMainWindow(),
      'Rebuild ZotSeek Index',
      'This will delete all stored embeddings and rebuild the index with your current settings.\n\n' +
      'This may take several minutes depending on library size.\n\nContinue?'
    );

    if (!confirmed) return;

    // First clear the index
    const progressWindow = new StableProgressWindow({
      title: 'Rebuilding ZotSeek Index',
    });

    try {
      progressWindow.updateProgress('Clearing existing index...', null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        await this.vectorStore.clear();
        this.logger.info('Index cleared for rebuild');
        progressWindow.addLine('✓ Existing index cleared', 'chrome://zotero/skin/tick.png');

        // Close the progress window briefly
        progressWindow.close();

        // Now trigger re-indexing of the entire library
        await this.onIndexLibrary();
      }
    } catch (error: any) {
      this.logger.error(`Failed to rebuild index: ${error}`);
      progressWindow.error(`Failed to rebuild index: ${error.message || error}`, true);
      this.showAlert(`Failed to rebuild index: ${error.message || error}`);
    }
  }

  /**
   * Public method to refresh stats in the preferences pane
   */
  public async refreshStats(): Promise<void> {
    const doc = getZotero()?.getMainWindow()?.document;
    if (!doc) return;

    const setText = (id: string, value: string) => {
      const el = doc.getElementById(id);
      if (el) el.textContent = value;
    };

      setText('zotseek-stat-papers', 'Loading...');

    try {
      const stats = await this.getStats();
      setText('zotseek-stat-papers', stats.indexedPapers.toLocaleString());
      setText('zotseek-stat-chunks', stats.totalChunks.toLocaleString());
      setText('zotseek-stat-avgchunks', stats.avgChunksPerPaper.toString());
      setText('zotseek-stat-storage', stats.storageSize);
      setText('zotseek-stat-dbpath', stats.databasePath || '-');
      setText('zotseek-stat-model', stats.modelId);
      setText('zotseek-stat-lastindexed', stats.lastIndexed);
    } catch (e) {
      this.logger.error(`Failed to refresh stats: ${e}`);
      setText('zotseek-stat-papers', 'Error');
    }
  }

  /**
   * Public method to get index statistics (called from preferences pane)
   */
  public async getStats(): Promise<{
    indexedPapers: number;
    totalChunks: number;
    avgChunksPerPaper: number;
    modelId: string;
    storageSize: string;
    databasePath: string;
    lastIndexed: string;
    lastIndexDuration?: string;
    indexedWithMode?: string;
  }> {
    try {
      this.logger.debug('getStats() called');
      await this.ensureStoreReady();
      if (!this.vectorStore) {
        this.logger.warn('getStats(): vectorStore is null');
        // Try to get database path even if store is not ready
        let databasePath = '-';
        try {
          const Z = getZotero();
          if (Z?.DataDirectory?.dir) {
            databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
          }
        } catch (e) { /* ignore */ }

        return {
          indexedPapers: 0,
          totalChunks: 0,
          avgChunksPerPaper: 0,
          modelId: 'none',
          storageSize: '0 KB',
          databasePath,
          lastIndexed: 'Never',
        };
      }

      this.logger.debug('getStats(): Calling vectorStore.getStats()');
      const stats = await this.vectorStore.getStats();
      this.logger.debug(`getStats(): Got stats: ${JSON.stringify(stats)}`);

      // Get the indexing mode that was used to build the current index
      let indexedWithMode: string | undefined;
      try {
        const storedMode = await this.vectorStore.getMetadata('indexingMode');
        if (storedMode) {
          // Convert to human-readable format
          // Support both old mode names (fulltext, hybrid) and new (full)
          const modeLabels: { [key: string]: string } = {
            'abstract': 'Abstract Only',
            'full': 'Full Paper',
            // Legacy mode names for backward compatibility
            'fulltext': 'Full Paper',
            'hybrid': 'Full Paper'
          };
          indexedWithMode = modeLabels[storedMode] || storedMode;
        }
      } catch (e) {
        this.logger.debug(`Could not get indexing mode from metadata: ${e}`);
      }

      // Get the last index duration
      let lastIndexDuration: string | undefined;
      try {
        const storedDuration = await this.vectorStore.getMetadata('lastIndexDurationMs');
        if (storedDuration) {
          const durationMs = parseInt(storedDuration, 10);
          if (!isNaN(durationMs)) {
            lastIndexDuration = this.formatDuration(durationMs);
          }
        }
      } catch (e) {
        this.logger.debug(`Could not get last index duration from metadata: ${e}`);
      }

      // Format storage size
      let storageSize: string;
      if (stats.storageUsedBytes < 1024) {
        storageSize = `${stats.storageUsedBytes} B`;
      } else if (stats.storageUsedBytes < 1024 * 1024) {
        storageSize = `${(stats.storageUsedBytes / 1024).toFixed(1)} KB`;
      } else {
        storageSize = `${(stats.storageUsedBytes / (1024 * 1024)).toFixed(1)} MB`;
      }

      // Format last indexed date
      let lastIndexed: string;
      if (stats.lastIndexed) {
        lastIndexed = stats.lastIndexed.toLocaleString();
      } else {
        lastIndexed = 'Never';
      }

      // Get database path - use vectorStore method if available, otherwise construct it
      let databasePath = '-';
      try {
        if (this.vectorStore && typeof this.vectorStore.getDatabasePath === 'function') {
          databasePath = this.vectorStore.getDatabasePath();
        } else {
          // Fallback: construct path directly
          const Z = getZotero();
          if (Z?.DataDirectory?.dir) {
            databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
          }
        }
      } catch (e) {
        this.logger.debug(`Could not get database path: ${e}`);
      }

      return {
        indexedPapers: stats.indexedPapers,
        totalChunks: stats.totalChunks,
        avgChunksPerPaper: stats.avgChunksPerPaper,
        modelId: stats.modelId === 'none' ? 'None' : stats.modelId.replace('Xenova/', ''),
        storageSize,
        databasePath,
        lastIndexed,
        lastIndexDuration,
        indexedWithMode,
      };
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error}`);
      // Try to get database path even on error
      let databasePath = '-';
      try {
        const Z = getZotero();
        if (Z?.DataDirectory?.dir) {
          databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
        }
      } catch (e) { /* ignore */ }

      return {
        indexedPapers: 0,
        totalChunks: 0,
        avgChunksPerPaper: 0,
        modelId: 'Error',
        storageSize: 'Error',
        databasePath,
        lastIndexed: 'Error',
      };
    }
  }

  /**
   * Index selected items for semantic search
   */
  private async onIndexSelected(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    const selectedItems = this.zoteroAPI.getSelectedItems();
    if (selectedItems.length === 0) {
      this.showAlert('Please select items to index.');
      return;
    }

    this.logger.info(`Indexing ${selectedItems.length} selected items`);
    await this.indexItems(selectedItems);
  }

  /**
   * Index current collection
   * Reference: https://windingwind.github.io/doc-for-zotero-plugin-dev/main/collection-operations.html
   */
  private async onIndexCollection(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // Get the selected collection using ZoteroPane
    const ZoteroPane = Z.getActiveZoteroPane();
    const collection = ZoteroPane?.getSelectedCollection();

    if (!collection) {
      this.showAlert('Please select a collection first.\n\n(Click on a collection in the left sidebar)');
      return;
    }

    const collectionName = collection.name;
    const items = collection.getChildItems().filter((item: any) => item.isRegularItem());

    if (items.length === 0) {
      this.showAlert(`Collection "${collectionName}" has no items to index.`);
      return;
    }

    this.logger.info(`Indexing collection "${collectionName}" (${items.length} items)`);
    await this.indexItems(items);
  }

  /**
   * Index entire library
   */
  private async onIndexLibrary(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // Use Services.prompt for Zotero 8 compatibility
    const confirmed = Services.prompt.confirm(
      Z.getMainWindow(),
      'Update Library Index',
      'This will index all unindexed items in your library for semantic search.\n\n' +
      'Items that are already indexed will be skipped.\n\n' +
      'This may take several minutes depending on the number of new items.\n\n' +
      'Continue?'
    );

    if (!confirmed) return;

    this.logger.info('Indexing entire library');
    const items = await this.zoteroAPI.getLibraryItems();
    this.logger.info(`Found ${items.length} items to index`);

    await this.indexItems(items);
  }

  /**
   * Index items for semantic search
   * Uses the configurable indexing mode (abstract, fulltext, or hybrid)
   */
  private async indexItems(items: any[]): Promise<void> {
    this.indexing = true;
    const Z = getZotero();
    const indexStartTime = Date.now(); // Track total indexing time

    // Create stable progress window using toolkit
    const progressWindow = new StableProgressWindow({
      title: 'ZotSeek Indexing',
      cancelCallback: () => {
        this.indexing = false;
        this.logger.info('Indexing cancelled by user');
      }
    });

    try {
      // Ensure vector store is ready
      progressWindow.updateProgress('Initializing storage...', null);
      await this.ensureStoreReady();

      // Get indexing mode
      const indexingMode = getIndexingMode(Z);
      this.logger.info(`Indexing mode: ${indexingMode}`);
      progressWindow.addLine(`Indexing mode: ${indexingMode}`);

      // Reset pipeline to ensure fresh initialization
      embeddingPipeline.reset();

      progressWindow.updateProgress('Loading AI model (Transformers.js)...', null);
      await embeddingPipeline.init();
      this.logger.info('Embedding pipeline initialized (Transformers.js)')
      progressWindow.addLine('✓ AI model loaded', 'chrome://zotero/skin/tick.png');

      // Extract chunks from items based on indexing mode
      this.logger.info(`Extracting chunks from items (mode: ${indexingMode})...`);
      progressWindow.setHeadline(`Extracting text from ${items.length} items...`);

      const extractedItems = await textExtractor.extractChunksFromItems(items, indexingMode, undefined, (progress) => {
        if (progressWindow.isCancelled()) {
          throw new Error('Cancelled by user');
        }

        // Use the new updateProgressWithETA method for better display
        progressWindow.updateProgressWithETA(
          `Processing: ${progress.currentTitle}`,
          progress.current,
          progress.total
        );
      });

      // Count total chunks
      const totalChunks = extractedItems.reduce((sum, item) => sum + item.chunks.length, 0);
      this.logger.info(`Extracted ${totalChunks} chunks from ${extractedItems.length} items`);
      progressWindow.addLine(`✓ Extracted ${totalChunks} chunks from ${extractedItems.length} items`, 'chrome://zotero/skin/tick.png');

      // Prepare all chunks for embedding
      const textsForEmbedding: Array<{ id: string; text: string; title: string }> = [];
      for (const extracted of extractedItems) {
        for (const chunk of extracted.chunks) {
          // Use itemId_chunkIndex as the ID for embedding
          textsForEmbedding.push({
            id: `${extracted.itemId}_${chunk.index}`,
            text: chunk.text,
            title: extracted.title,
          });
        }
      }

      // Generate embeddings for all chunks
      this.logger.info(`Generating embeddings for ${textsForEmbedding.length} chunks...`);
      progressWindow.setHeadline(`Generating embeddings for ${textsForEmbedding.length} chunks...`);

      const embeddingMap = new Map<string, { embedding: number[]; modelId: string }>();

      let processed = 0;
      const startTime = Date.now();

      for (const item of textsForEmbedding) {
        if (progressWindow.isCancelled()) {
          throw new Error('Cancelled by user');
        }

        processed++;

        // Use the stable progress window's ETA calculation
        progressWindow.updateProgressWithETA(
          `Processing: ${item.title}`,
          processed,
          textsForEmbedding.length
        );

        const result = await embeddingPipeline.embed(item.text);
        if (result) {
          embeddingMap.set(item.id, result);
        }

        // Yield to UI thread periodically
        if (processed % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      progressWindow.addLine(`✓ Generated ${embeddingMap.size} embeddings`, 'chrome://zotero/skin/tick.png');

      // Store embeddings in vector store
      progressWindow.setHeadline('Saving embeddings to database...');
      progressWindow.updateProgress('Storing embeddings...', null);

      const paperEmbeddings: PaperEmbedding[] = [];
      for (const extracted of extractedItems) {
        // Delete existing chunks for this item before adding new ones
        await this.vectorStore!.deleteItemChunks(extracted.itemId);

        for (const chunk of extracted.chunks) {
          const embeddingKey = `${extracted.itemId}_${chunk.index}`;
          const embeddingResult = embeddingMap.get(embeddingKey);

          if (embeddingResult) {
            paperEmbeddings.push({
              itemId: extracted.itemId,
              chunkIndex: chunk.index,
              itemKey: extracted.itemKey,
              libraryId: extracted.libraryId,
              title: extracted.title,
              abstract: extracted.abstract || undefined,
              chunkText: chunk.text,
              // Store the actual chunk type for better search result display
              // e.g., 'summary', 'methods', 'findings', 'content'
              textSource: chunk.type,
              embedding: embeddingResult.embedding,
              modelId: embeddingResult.modelId,
              indexedAt: new Date().toISOString(),
              contentHash: extracted.contentHash,
              // Passage-level location (Phase 2)
              pageNumber: chunk.pageNumber,
              paragraphIndex: chunk.paragraphIndex,
              startChar: chunk.startChar,
              endChar: chunk.endChar,
            });
          }
        }
      }

      await this.vectorStore!.putBatch(paperEmbeddings);
      this.logger.info(`Stored ${paperEmbeddings.length} embedding chunks for ${extractedItems.length} items`);

      // Store the indexing mode in metadata so we know what mode was used to build the index
      await this.vectorStore!.setMetadata('indexingMode', indexingMode);
      this.logger.info(`Stored indexing mode '${indexingMode}' in metadata`);

      // Calculate and store indexing duration
      const indexDurationMs = Date.now() - indexStartTime;
      await this.vectorStore!.setMetadata('lastIndexDurationMs', String(indexDurationMs));
      this.logger.info(`Indexing completed in ${indexDurationMs}ms`);

      // Calculate stats for display
      const avgChunksPerItem = extractedItems.length > 0
        ? Math.round((paperEmbeddings.length / extractedItems.length) * 10) / 10
        : 0;

      // Format duration for display
      const durationFormatted = this.formatDuration(indexDurationMs);

      // Show completion
      progressWindow.setHeadline('Indexing Complete!');
      progressWindow.addLine(`✓ Mode: ${indexingMode}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Items indexed: ${extractedItems.length}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Total chunks: ${paperEmbeddings.length}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Avg chunks/item: ${avgChunksPerItem}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Duration: ${durationFormatted}`, 'chrome://zotero/skin/tick.png');

      if (items.length - extractedItems.length > 0) {
        progressWindow.addLine(`⚠ Skipped: ${items.length - extractedItems.length} items`);
      }

      progressWindow.complete('Indexing completed successfully!', true);

    } catch (error: any) {
      this.logger.error(`Indexing failed: ${error}`);

      if (!progressWindow.isCancelled()) {
        progressWindow.error(`Indexing failed: ${error.message || error}`, false);
        // Keep window open for 10 seconds so user can see the error
        setTimeout(() => progressWindow.close(), 10000);
      }

      this.showAlert(`Indexing failed: ${error.message || error}`);
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else if (ms < 3600000) {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    } else {
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.round((ms % 3600000) / 60000);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Find papers similar to selected item
   */
  private async onFindSimilar(): Promise<void> {
    this.logger.info('Find Similar Documents triggered');

    const Z = getZotero();
    if (!Z) return;

    const selectedItems = this.zoteroAPI.getSelectedItems();
    if (selectedItems.length === 0) {
      this.showAlert('Please select an item first.');
      return;
    }

    const item = selectedItems[0];
    const title = item.getField('title');
    this.logger.info(`Finding papers similar to: ${title}`);
    this.logger.info(`Item ID: ${item.id}, Key: ${item.key}, Type: ${typeof item.id}`);

    try {
      // Ensure store is ready
      await this.ensureStoreReady();

      // Check if item is indexed
      this.logger.debug(`Checking if item ${item.id} is indexed...`);
      const isIndexed = await this.vectorStore!.isIndexed(item.id);
      this.logger.debug(`isIndexed result: ${isIndexed}`);

      if (!isIndexed) {
        // Use Services.prompt for Zotero 8 compatibility
        const indexNow = Services.prompt.confirm(
          Z.getMainWindow(),
          'Item Not Indexed',
          `"${title}" is not indexed yet.\n\nWould you like to index it now?`
        );

        if (indexNow) {
          await this.indexItems([item]);
        } else {
          return;
        }
      }

      // Check if embedding pipeline is ready
      if (!embeddingPipeline.isReady()) {
        // The dialog will show its own loading message
        await embeddingPipeline.init();
      }

      // Open the similar documents dialog
      similarDocumentsWrapper.open(item);

    } catch (error) {
      this.logger.error(`Find similar failed: ${error}`);
      this.showAlert(`Search failed: ${error}`);
    }
  }

  /**
   * Display search results in a dialog
   */
  private showSearchResults(queryTitle: string, results: SearchResult[]): void {
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (!win) return;

    const resultText = results.map((r, i) =>
      `${i + 1}. [${Math.round(r.similarity * 100)}%] ${r.title}`
    ).join('\n');

    win.alert(
      `Similar to: "${queryTitle}"\n\n` +
      `Found ${results.length} similar papers:\n\n` +
      resultText +
      '\n\n(Click on items in the list to navigate)'
    );

    // Select first result in Zotero
    if (results.length > 0) {
      this.zoteroAPI.selectItem(results[0].itemId);
    }
  }

  /**
   * Show progress (placeholder - will be replaced with proper UI)
   */
  private showProgress(message: string, current: number, total: number): void {
    this.logger.info(`Progress: ${message} (${current}/${total})`);
    // TODO: Show actual progress bar UI
  }

  /**
   * Show alert dialog
   */
  private showAlert(message: string): void {
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (win) {
      win.alert(message);
    }
  }

  async onShutdown(): Promise<void> {
    this.logger.info('Shutting down plugin');

    // Remove XUL-injected menu elements and toolbar button
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (win) {
      this.removeXULElements(win);
      toolbarButton.remove(win);
    }

    // Unregister Tools menu and reader toolbar
    toolbarButton.unregisterToolsMenu();
    toolbarButton.unregisterReaderToolbar();

    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }

  /**
   * Remove XUL-injected menu elements (fallback cleanup)
   */
  private removeXULElements(window: Window): void {
    const doc = window.document;
    const ids = [
      'zotseek-find-similar',
      'zotseek-open-dialog',
      'zotseek-index-selected',
      'zotseek-index-collection',
      'zotseek-index-library',
      'zotseek-separator',
    ];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
    this.logger.debug('XUL elements removed');
  }

  // Public API for other plugins/scripts
  public api = {
    search: (query: string, options?: any) => searchEngine.search(query, options),
    findSimilar: (itemId: number, options?: any) => searchEngine.findSimilar(itemId, options),
    indexItems: (items: any[]) => this.indexItems(items),
    getStats: () => this.vectorStore?.getStats() ?? Promise.resolve({ totalPapers: 0, indexedPapers: 0, modelId: 'none', lastIndexed: null, storageUsedBytes: 0 }),
    isReady: () => this.initialized && embeddingPipeline.isReady(),
  };
}

// Create plugin instance
const addon = new ZotSeekPlugin();

// Attach to Zotero global (like BetterNotes does)
const Z = getZotero();
if (Z) {
  Z.ZotSeek = addon;
}

// Also expose on _globalThis for bootstrap access
if (typeof _globalThis !== 'undefined') {
  _globalThis.addon = addon;
}
