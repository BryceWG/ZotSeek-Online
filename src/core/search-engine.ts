/**
 * Search Engine - Semantic search using cosine similarity
 * 
 * Supports multi-chunk documents with MaxSim aggregation:
 * - Each document may have multiple embedding chunks
 * - Search returns the max similarity across all chunks per document
 * - This ensures that matching any part of a document ranks it highly
 */

import { Logger } from '../utils/logger';
import { PaperEmbedding, IVectorStore, getVectorStore } from './storage-factory';
import { VectorStoreSQLite, TextSourceType } from './vector-store-sqlite';
import { EmbeddingPipeline, embeddingPipeline } from './embedding-pipeline';

export interface SearchResult {
  itemId: number;
  itemKey: string;
  title: string;
  similarity: number;       // 0-1 cosine similarity (max across chunks, or per-chunk if returnAllChunks)
  textSource: TextSourceType;  // Section type: summary, methods, findings, content
  matchedChunkIndex?: number;  // Which chunk had the highest similarity
  chunkIndex?: number;        // Chunk index (when returnAllChunks=true)
  authors?: string[];         // Optional: author names for display
  year?: number;              // Optional: publication year for display
  pageNumber?: number;        // 1-based page number of matched chunk
  paragraphIndex?: number;    // 0-based paragraph index within page
}

export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  libraryId?: number;
  excludeItemIds?: number[];
  returnAllChunks?: boolean;  // If true, return all matching chunks instead of MaxSim aggregation
}

const DEFAULT_OPTIONS: Required<Omit<SearchOptions, 'libraryId' | 'excludeItemIds'>> = {
  topK: 20,
  minSimilarity: 0.3,
  returnAllChunks: false,
};

/**
 * Internal structure for MaxSim aggregation
 */
interface ItemSimilarity {
  itemId: number;
  itemKey: string;
  title: string;
  textSource: TextSourceType;
  maxSimilarity: number;
  matchedChunkIndex: number;
  pageNumber?: number;
  paragraphIndex?: number;
}

export class SearchEngine {
  private store: IVectorStore | null = null;
  private pipeline: EmbeddingPipeline;
  private logger: Logger;

  constructor(pipeline: EmbeddingPipeline = embeddingPipeline) {
    this.pipeline = pipeline;
    this.logger = new Logger('SearchEngine');
  }

  /**
   * Initialize the search engine (pipeline and store)
   */
  async init(): Promise<void> {
    this.logger.info('Initializing search engine...');
    
    // Initialize embedding pipeline if needed
    if (!this.pipeline.isReady()) {
      this.logger.info('Initializing embedding pipeline...');
      await this.pipeline.init();
    }
    
    // Initialize vector store if needed
    const store = this.getStore();
    if (!store.isReady()) {
      this.logger.info('Initializing vector store...');
      await store.init();
    }
    
    this.logger.info('Search engine initialized');
  }

  /**
   * Check if the search engine is ready
   */
  isReady(): boolean {
    return this.pipeline.isReady();
  }

  /**
   * Get the vector store (lazy initialization)
   */
  private getStore(): IVectorStore {
    if (!this.store) {
      this.store = getVectorStore();
    }
    return this.store;
  }

  /**
   * Search for papers similar to a query string
   * Uses MaxSim aggregation: returns max similarity across all chunks per document
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.logger.info(`Searching for: "${query.substring(0, 50)}..."`);
    const startTime = Date.now();

    // Generate query embedding
    if (!this.pipeline.isReady()) {
      throw new Error('Embedding pipeline not initialized');
    }

    // Use embedQuery for search queries (applies search_query: prefix)
    const { embedding: queryEmbedding } = await this.pipeline.embedQuery(query);
    
    // Convert query embedding to normalized Float32Array for fast comparison
    const queryFloat32 = new Float32Array(queryEmbedding);
    let queryNorm = 0;
    for (let i = 0; i < queryFloat32.length; i++) {
      queryNorm += queryFloat32[i] * queryFloat32[i];
    }
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm > 0) {
      for (let i = 0; i < queryFloat32.length; i++) {
        queryFloat32[i] /= queryNorm;
      }
    }

    // Get cached embeddings for fast search
    const store = this.getStore();
    let embeddings: Array<{
      itemId: number;
      chunkIndex: number;
      itemKey: string;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>;

    if (opts.libraryId !== undefined) {
      // For library-specific search, we still need to use the non-cached method
      // Convert to the cached format
      const paperEmbeddings = await store.getByLibrary(opts.libraryId);
      embeddings = paperEmbeddings.map(e => {
        const float32Embedding = new Float32Array(e.embedding);
        let norm = 0;
        for (let i = 0; i < float32Embedding.length; i++) {
          norm += float32Embedding[i] * float32Embedding[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (let i = 0; i < float32Embedding.length; i++) {
            float32Embedding[i] /= norm;
          }
        }
        return {
          itemId: e.itemId,
          chunkIndex: e.chunkIndex,
          itemKey: e.itemKey,
          title: e.title,
          textSource: e.textSource,
          embedding: float32Embedding,
          pageNumber: e.pageNumber,
          paragraphIndex: e.paragraphIndex,
        };
      });
    } else {
      // Use cached embeddings for global search (SQLite with in-memory cache)
      embeddings = await (store as VectorStoreSQLite).getAllCached();
    }

    // Filter out excluded items
    if (opts.excludeItemIds && opts.excludeItemIds.length > 0) {
      const excludeSet = new Set(opts.excludeItemIds);
      embeddings = embeddings.filter(e => !excludeSet.has(e.itemId));
    }

    // Compute results: either all chunks or MaxSim aggregation
    let results: SearchResult[];
    if (opts.returnAllChunks) {
      // Return all matching chunks (for location/paragraph-level results)
      results = this.computeAllChunkResultsFloat32(queryFloat32, embeddings, opts.minSimilarity);
    } else {
      // Use MaxSim aggregation (one result per document with best chunk)
      results = this.computeMaxSimResultsFloat32(queryFloat32, embeddings, opts.minSimilarity);
    }

    // Sort by similarity (descending) and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, opts.topK);

    const searchTime = Date.now() - startTime;
    this.logger.info(`Found ${topResults.length} results in ${searchTime}ms`);

    return topResults;
  }

  /**
   * Find papers similar to a given paper
   * Uses MaxSim aggregation: returns max similarity across all chunks per document
   */
  async findSimilar(itemId: number, options: SearchOptions = {}): Promise<SearchResult[]> {
    this.logger.info(`Finding papers similar to item ${itemId}`);

    const store = this.getStore();
    
    // Ensure store is initialized
    if (!store.isReady()) {
      this.logger.info('Store not ready, initializing...');
      await store.init();
    }

    // Get all chunks for the source paper
    const sourceChunks = await store.getItemChunks(itemId);
    if (!sourceChunks || sourceChunks.length === 0) {
      // Fall back to single get
      const sourcePaper = await store.get(itemId);
      if (!sourcePaper) {
        throw new Error(`Paper ${itemId} not indexed`);
      }
      // Validate source embedding
      if (!sourcePaper.embedding || sourcePaper.embedding.length === 0) {
        throw new Error(`Paper ${itemId} has invalid embedding data`);
      }
      // Use the single embedding
      return this.findSimilarWithEmbedding(sourcePaper.embedding, itemId, options);
    }
    
    // Validate source chunks
    const validSourceChunks = sourceChunks.filter(c => 
      c.embedding && Array.isArray(c.embedding) && c.embedding.length > 0
    );
    
    if (validSourceChunks.length === 0) {
      throw new Error(`Paper ${itemId} has no valid embedding chunks`);
    }
    
    this.logger.debug(`Source paper has ${validSourceChunks.length} valid chunks`);

    // Exclude the source paper from results
    const excludeItemIds = [...(options.excludeItemIds || []), itemId];
    const opts = { ...DEFAULT_OPTIONS, ...options, excludeItemIds };

    // Get cached embeddings for fast similarity computation
    let embeddings: Array<{
      itemId: number;
      chunkIndex: number;
      itemKey: string;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
    }>;
    
    if (opts.libraryId !== undefined) {
      // For library-specific search, convert to cached format
      const paperEmbeddings = await store.getByLibrary(opts.libraryId);
      embeddings = paperEmbeddings.map(e => {
        const float32Embedding = new Float32Array(e.embedding);
        let norm = 0;
        for (let i = 0; i < float32Embedding.length; i++) {
          norm += float32Embedding[i] * float32Embedding[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (let i = 0; i < float32Embedding.length; i++) {
            float32Embedding[i] /= norm;
          }
        }
        return {
          itemId: e.itemId,
          chunkIndex: e.chunkIndex,
          itemKey: e.itemKey,
          title: e.title,
          textSource: e.textSource,
          embedding: float32Embedding,
        };
      });
    } else {
      // Use cached embeddings (SQLite with in-memory cache)
      embeddings = await (store as VectorStoreSQLite).getAllCached();
    }
    
    this.logger.info(`Retrieved ${embeddings.length} embedding chunks from store`);

    // Filter out excluded items
    const excludeSet = new Set(excludeItemIds);
    embeddings = embeddings.filter(e => !excludeSet.has(e.itemId));
    
    // Filter out invalid embeddings (shouldn't happen with cached data)
    const validEmbeddings = embeddings.filter(e => e.embedding && e.embedding.length > 0);

    // Convert source chunks to normalized Float32Arrays
    const sourceFloat32Chunks = validSourceChunks.map(chunk => {
      const float32 = new Float32Array(chunk.embedding);
      let norm = 0;
      for (let i = 0; i < float32.length; i++) {
        norm += float32[i] * float32[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < float32.length; i++) {
          float32[i] /= norm;
        }
      }
      return float32;
    });

    // For multi-chunk source, use the maximum similarity from any source chunk
    // to any target chunk (MaxSim on both sides)
    const itemResults = new Map<number, ItemSimilarity>();

    for (const targetChunk of validEmbeddings) {
      // Find max similarity with any source chunk using optimized dot product
      let maxSim = 0;
      for (const sourceFloat32 of sourceFloat32Chunks) {
        // Since both vectors are normalized, dot product = cosine similarity
        const sim = this.dotProductFloat32(sourceFloat32, targetChunk.embedding);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }

      // Update max for this item (MaxSim aggregation)
      const existing = itemResults.get(targetChunk.itemId);
      if (!existing || maxSim > existing.maxSimilarity) {
        itemResults.set(targetChunk.itemId, {
          itemId: targetChunk.itemId,
          itemKey: targetChunk.itemKey,
          title: targetChunk.title,
          textSource: targetChunk.textSource,
          maxSimilarity: maxSim,
          matchedChunkIndex: targetChunk.chunkIndex ?? 0,
        });
      }
    }

    // Convert to results, filter by minSimilarity
    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= opts.minSimilarity) {
        results.push({
          itemId: item.itemId,
          itemKey: item.itemKey,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
        });
      }
    }

    // Sort by similarity (descending) and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, opts.topK);

    this.logger.info(`Found ${topResults.length} similar papers`);

    return topResults;
  }

  /**
   * Find similar papers using a single embedding (legacy path)
   */
  private async findSimilarWithEmbedding(
    sourceEmbedding: number[], 
    sourceItemId: number, 
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const store = this.getStore();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const excludeItemIds = [...(options.excludeItemIds || []), sourceItemId];

    // Get all embeddings
    let embeddings: PaperEmbedding[];
    if (opts.libraryId !== undefined) {
      embeddings = await store.getByLibrary(opts.libraryId);
    } else {
      embeddings = await store.getAll();
    }

    // Filter out excluded items
    const excludeSet = new Set(excludeItemIds);
    embeddings = embeddings.filter(e => !excludeSet.has(e.itemId));

    // Filter valid embeddings
    const validEmbeddings = embeddings.filter(e => 
      e.embedding && Array.isArray(e.embedding) && e.embedding.length > 0
    );

    // Use MaxSim aggregation
    const results = this.computeMaxSimResults(sourceEmbedding, validEmbeddings, opts.minSimilarity);

    // Sort and return top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, opts.topK);
  }

  /**
   * Compute MaxSim results: max similarity per item across all its chunks
   */
  private computeMaxSimResults(
    queryEmbedding: number[], 
    embeddings: PaperEmbedding[],
    minSimilarity: number
  ): SearchResult[] {
    const itemResults = new Map<number, ItemSimilarity>();

    for (const chunk of embeddings) {
      if (!chunk.embedding || !Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);

      // MaxSim: keep only the highest similarity per item
      const existing = itemResults.get(chunk.itemId);
      if (!existing || similarity > existing.maxSimilarity) {
        itemResults.set(chunk.itemId, {
          itemId: chunk.itemId,
          itemKey: chunk.itemKey,
          title: chunk.title,
          textSource: chunk.textSource,
          maxSimilarity: similarity,
          matchedChunkIndex: chunk.chunkIndex ?? 0,
        });
      }
    }

    // Convert to results, filter by minSimilarity
    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= minSimilarity) {
        results.push({
          itemId: item.itemId,
          itemKey: item.itemKey,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
        });
      }
    }

    return results;
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    // Defensive checks
    if (!a || !Array.isArray(a)) {
      this.logger.error(`cosineSimilarity: vector 'a' is invalid: ${typeof a}`);
      return 0;
    }
    if (!b || !Array.isArray(b)) {
      this.logger.error(`cosineSimilarity: vector 'b' is invalid: ${typeof b}`);
      return 0;
    }
    if (a.length === 0 || b.length === 0) {
      return 0;
    }
    if (a.length !== b.length) {
      this.logger.error(`Vectors must have the same length (a=${a.length}, b=${b.length})`);
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Compute MaxSim results with Float32Array for optimal performance
   * Expects pre-normalized vectors for fast dot product computation
   */
  private computeMaxSimResultsFloat32(
    queryEmbedding: Float32Array,
    embeddings: Array<{
      itemId: number;
      chunkIndex: number;
      itemKey: string;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>,
    minSimilarity: number
  ): SearchResult[] {
    const itemResults = new Map<number, ItemSimilarity>();

    for (const chunk of embeddings) {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        continue;
      }

      // Since both vectors are normalized, dot product = cosine similarity
      const similarity = this.dotProductFloat32(queryEmbedding, chunk.embedding);

      // MaxSim: keep only the highest similarity per item
      const existing = itemResults.get(chunk.itemId);
      if (!existing || similarity > existing.maxSimilarity) {
        itemResults.set(chunk.itemId, {
          itemId: chunk.itemId,
          itemKey: chunk.itemKey,
          title: chunk.title,
          textSource: chunk.textSource,
          maxSimilarity: similarity,
          matchedChunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          paragraphIndex: chunk.paragraphIndex,
        });
      }
    }

    // Convert to results, filter by minSimilarity
    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= minSimilarity) {
        results.push({
          itemId: item.itemId,
          itemKey: item.itemKey,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
          pageNumber: item.pageNumber,
          paragraphIndex: item.paragraphIndex,
        });
      }
    }

    return results;
  }

  /**
   * Compute ALL chunk results (no aggregation) with Float32Array
   * Returns every matching chunk with its individual score and location
   * Used for "By Location" mode in parent-child retrieval
   */
  private computeAllChunkResultsFloat32(
    queryEmbedding: Float32Array,
    embeddings: Array<{
      itemId: number;
      chunkIndex: number;
      itemKey: string;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>,
    minSimilarity: number
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const chunk of embeddings) {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        continue;
      }

      // Since both vectors are normalized, dot product = cosine similarity
      const similarity = this.dotProductFloat32(queryEmbedding, chunk.embedding);

      // Include all chunks above minSimilarity threshold
      if (similarity >= minSimilarity) {
        results.push({
          itemId: chunk.itemId,
          itemKey: chunk.itemKey,
          title: chunk.title,
          similarity,
          textSource: chunk.textSource,
          chunkIndex: chunk.chunkIndex,
          matchedChunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          paragraphIndex: chunk.paragraphIndex,
        });
      }
    }

    return results;
  }

  /**
   * Optimized dot product for normalized Float32Arrays
   * Since vectors are pre-normalized, dot product equals cosine similarity
   */
  private dotProductFloat32(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      this.logger.error(`Vectors must have the same length (a=${a.length}, b=${b.length})`);
      return 0;
    }

    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }

    return dotProduct;
  }

  /**
   * Get search statistics
   */
  async getStats(): Promise<{ indexedPapers: number; modelId: string }> {
    const store = this.getStore();
    const stats = await store.getStats();
    return {
      indexedPapers: stats.indexedPapers,
      modelId: stats.modelId,
    };
  }
}

// Singleton instance
export const searchEngine = new SearchEngine();
