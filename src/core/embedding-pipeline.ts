/**
 * Embedding Pipeline - Generate embeddings via online providers
 */

import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';

export interface EmbeddingResult {
  embedding: number[];
  modelId: string;
  processingTimeMs: number;
}

export interface EmbeddingProgress {
  current: number;
  total: number;
  currentTitle: string;
  status: 'loading' | 'processing' | 'done' | 'error';
}

export type ProgressCallback = (progress: EmbeddingProgress) => void;

export type EmbeddingProviderId = 'voyage';

export interface EmbeddingModelOption {
  id: string;
  label: string;
  description: string;
}

interface EmbeddingProviderOption {
  id: EmbeddingProviderId;
  label: string;
  endpoint: string;
}

interface EmbeddingRuntimeConfig {
  providerId: EmbeddingProviderId;
  providerLabel: string;
  modelId: string;
  apiKey: string;
  endpoint: string;
}

const EMBEDDING_PROVIDER_OPTIONS: readonly EmbeddingProviderOption[] = [
  {
    id: 'voyage',
    label: 'Voyage AI',
    endpoint: 'https://api.voyageai.com/v1/embeddings',
  },
];

export const EMBEDDING_MODEL_OPTIONS: readonly EmbeddingModelOption[] = [
  {
    id: 'voyage-3.5-lite',
    label: 'voyage-3.5-lite',
    description: 'Fast and cost-efficient general-purpose retrieval model.',
  },
  {
    id: 'voyage-3.5',
    label: 'voyage-3.5',
    description: 'Balanced quality and latency for general semantic search.',
  },
  {
    id: 'voyage-3-large',
    label: 'voyage-3-large',
    description: 'Higher quality retrieval model for broad document search.',
  },
  {
    id: 'voyage-4-lite',
    label: 'voyage-4-lite',
    description: 'Lightweight Voyage 4 model with flexible output dimensions.',
  },
  {
    id: 'voyage-4',
    label: 'voyage-4',
    description: 'Strong general-purpose retrieval model in the Voyage 4 family.',
  },
  {
    id: 'voyage-4-large',
    label: 'voyage-4-large',
    description: 'Highest-quality Voyage 4 retrieval model.',
  },
  {
    id: 'voyage-code-3',
    label: 'voyage-code-3',
    description: 'Specialized model for code search and technical snippets.',
  },
  {
    id: 'voyage-finance-2',
    label: 'voyage-finance-2',
    description: 'Domain-tuned model for finance documents and terminology.',
  },
  {
    id: 'voyage-law-2',
    label: 'voyage-law-2',
    description: 'Domain-tuned model for legal research and case text.',
  },
];

export const DEFAULT_EMBEDDING_PROVIDER: EmbeddingProviderId = 'voyage';
export const DEFAULT_EMBEDDING_MODEL = 'voyage-3.5-lite';

const MAX_REQUEST_INPUTS = 8;
const MAX_REQUEST_CHARS = 40000;
const MAX_CONCURRENT_BATCH_REQUESTS = 3;
const RATE_LIMIT_RETRY_ATTEMPTS = 2;
const RATE_LIMIT_RETRY_DELAY_MS = 1500;

function normalizeProviderId(value: unknown): EmbeddingProviderId {
  return value === 'voyage' ? value : DEFAULT_EMBEDDING_PROVIDER;
}

function getProviderOption(providerId: EmbeddingProviderId): EmbeddingProviderOption {
  return EMBEDDING_PROVIDER_OPTIONS.find(option => option.id === providerId) || EMBEDDING_PROVIDER_OPTIONS[0];
}

function isKnownModel(modelId: string): boolean {
  return EMBEDDING_MODEL_OPTIONS.some(option => option.id === modelId);
}

export function getEmbeddingProviderOptions(): readonly { id: EmbeddingProviderId; label: string }[] {
  return EMBEDDING_PROVIDER_OPTIONS.map(({ id, label }) => ({ id, label }));
}

export function getEmbeddingModelOptions(_providerId: string = DEFAULT_EMBEDDING_PROVIDER): readonly EmbeddingModelOption[] {
  return EMBEDDING_MODEL_OPTIONS;
}

export function getEmbeddingProviderLabel(providerId: string): string {
  const normalized = normalizeProviderId(providerId);
  return getProviderOption(normalized).label;
}

export function getConfiguredEmbeddingSettings(Z = getZotero()): EmbeddingRuntimeConfig {
  const providerId = normalizeProviderId(Z?.Prefs?.get('zotseek.embeddingProvider', true));
  const provider = getProviderOption(providerId);
  const requestedModel = String(Z?.Prefs?.get('zotseek.embeddingModel', true) || '').trim();
  const modelId = isKnownModel(requestedModel) ? requestedModel : DEFAULT_EMBEDDING_MODEL;
  const apiKey = String(Z?.Prefs?.get('zotseek.embeddingApiKey', true) || '').trim();

  return {
    providerId,
    providerLabel: provider.label,
    modelId,
    apiKey,
    endpoint: provider.endpoint,
  };
}

export function getConfiguredEmbeddingModelId(Z = getZotero()): string {
  const config = getConfiguredEmbeddingSettings(Z);
  return `${config.providerId}:${config.modelId}`;
}

export function hasConfiguredApiKey(Z = getZotero()): boolean {
  return Boolean(getConfiguredEmbeddingSettings(Z).apiKey);
}

export function formatEmbeddingModelId(modelId: string): string {
  if (!modelId || modelId === 'none') {
    return 'None';
  }

  const separatorIndex = modelId.indexOf(':');
  if (separatorIndex > 0) {
    const providerId = modelId.slice(0, separatorIndex);
    const providerLabel = getEmbeddingProviderLabel(providerId);
    const providerModelId = modelId.slice(separatorIndex + 1);
    return `${providerLabel} / ${providerModelId}`;
  }

  if (isKnownModel(modelId)) {
    return `${getEmbeddingProviderLabel(DEFAULT_EMBEDDING_PROVIDER)} / ${modelId}`;
  }

  return modelId;
}

/**
 * Embedding Pipeline backed by online embedding APIs
 */
export class EmbeddingPipeline {
  private logger: Logger;
  private ready = false;

  constructor() {
    this.logger = new Logger('EmbeddingPipeline');
  }

  /**
   * Validate configuration and mark the pipeline ready
   */
  async init(): Promise<void> {
    if (this.ready) return;

    const config = this.getValidatedConfig();
    this.logger.info(`Embedding provider ready: ${config.providerLabel} (${config.modelId})`);
    this.ready = true;
  }

  private getValidatedConfig(): EmbeddingRuntimeConfig {
    const config = getConfiguredEmbeddingSettings();

    if (!config.apiKey) {
      throw new Error(
        `${config.providerLabel} API key is missing. Open Zotero Settings -> ZotSeek and add your API key.`
      );
    }

    return config;
  }

  private buildRequestBatches<T extends { text: string }>(items: T[]): T[][] {
    const batches: T[][] = [];
    let currentBatch: T[] = [];
    let currentChars = 0;

    for (const item of items) {
      const itemChars = item.text.length;
      const wouldExceedLimit =
        currentBatch.length >= MAX_REQUEST_INPUTS ||
        (currentBatch.length > 0 && currentChars + itemChars > MAX_REQUEST_CHARS);

      if (wouldExceedLimit) {
        batches.push(currentBatch);
        currentBatch = [];
        currentChars = 0;
      }

      currentBatch.push(item);
      currentChars += itemChars;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private parseResponseJson(response: any): any {
    const raw = response?.responseText ?? response?.response;

    if (typeof raw === 'string') {
      return JSON.parse(raw);
    }

    if (raw && typeof raw === 'object') {
      return raw;
    }

    throw new Error('Empty response from embedding provider');
  }

  private extractErrorBody(error: any): any {
    const raw =
      error?.responseText ??
      error?.response?.responseText ??
      error?.xmlhttp?.responseText ??
      error?.xhr?.responseText ??
      error?.response?.response;

    if (!raw) {
      return null;
    }

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    return raw;
  }

  private formatProviderError(config: EmbeddingRuntimeConfig, error: any): string {
    const status = this.getErrorStatus(error);
    const errorBody = this.extractErrorBody(error);

    let detail = '';
    if (typeof errorBody === 'string') {
      detail = errorBody;
    } else if (errorBody && typeof errorBody === 'object') {
      detail = String(errorBody.detail || errorBody.error || errorBody.message || '').trim();
    }

    if (status === 401) {
      return `${config.providerLabel} rejected the API key (401 Unauthorized).`;
    }

    if (status === 429) {
      return `${config.providerLabel} rate limit reached (429). Please try again shortly.`;
    }

    if (detail) {
      return `${config.providerLabel} request failed${status ? ` (${status})` : ''}: ${detail}`;
    }

    const message = error?.message ? String(error.message) : 'Unknown request error';
    return `${config.providerLabel} request failed${status ? ` (${status})` : ''}: ${message}`;
  }

  private getErrorStatus(error: any): number | null {
    const status = error?.status || error?.response?.status || error?.xmlhttp?.status || error?.xhr?.status;
    return typeof status === 'number' ? status : null;
  }

  private isRateLimitError(error: any): boolean {
    if (this.getErrorStatus(error) === 429) {
      return true;
    }

    const message = error?.message ? String(error.message) : '';
    return /rate limit|\b429\b/i.test(message);
  }

  private async delay(ms: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, ms));
  }

  private async requestEmbeddingsWithRetry(
    inputs: string[],
    inputType: 'query' | 'document'
  ): Promise<EmbeddingResult[]> {
    let attempt = 0;

    while (true) {
      try {
        return await this.requestEmbeddings(inputs, inputType);
      } catch (error: any) {
        if (!this.isRateLimitError(error) || attempt >= RATE_LIMIT_RETRY_ATTEMPTS) {
          throw error;
        }

        const delayMs = RATE_LIMIT_RETRY_DELAY_MS * Math.pow(2, attempt);
        this.logger.warn(
          `Embedding request rate limited, retrying in ${delayMs}ms (attempt ${attempt + 1}/${RATE_LIMIT_RETRY_ATTEMPTS})`
        );
        await this.delay(delayMs);
        attempt++;
      }
    }
  }

  private async runWithConcurrency<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
  ): Promise<T[]> {
    if (tasks.length === 0) {
      return [];
    }

    const results = new Array<T>(tasks.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency, tasks.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= tasks.length) {
            return;
          }

          results[index] = await tasks[index]();
        }
      })
    );

    return results;
  }

  private reportBatchProgress(
    batch: { title: string }[],
    total: number,
    progressState: { processed: number },
    onProgress?: ProgressCallback
  ): void {
    for (const item of batch) {
      progressState.processed++;

      if (onProgress) {
        onProgress({
          current: progressState.processed,
          total,
          currentTitle: item.title,
          status: 'processing',
        });
      }
    }
  }

  private async processBatch(
    batch: { id: string; text: string; title: string }[],
    total: number,
    results: Map<string, EmbeddingResult>,
    progressState: { processed: number },
    onProgress?: ProgressCallback
  ): Promise<void> {
    try {
      const batchResults = await this.requestEmbeddingsWithRetry(
        batch.map(item => item.text),
        'document'
      );

      batch.forEach((item, index) => {
        results.set(item.id, batchResults[index]);
      });

      this.reportBatchProgress(batch, total, progressState, onProgress);
    } catch (batchError: any) {
      this.logger.warn(`Batch embedding failed, retrying per item: ${batchError?.message || batchError}`);

      for (const item of batch) {
        try {
          const [result] = await this.requestEmbeddingsWithRetry([item.text], 'document');
          results.set(item.id, result);
        } catch (itemError: any) {
          this.logger.error(`Failed to embed item "${item.title}": ${itemError?.message || itemError}`);
        } finally {
          this.reportBatchProgress([item], total, progressState, onProgress);
        }
      }
    }
  }

  private async requestEmbeddings(inputs: string[], inputType: 'query' | 'document'): Promise<EmbeddingResult[]> {
    const config = this.getValidatedConfig();
    const Z = getZotero();

    if (!Z?.HTTP?.request) {
      throw new Error('Zotero HTTP API is not available in this context.');
    }

    const payload = {
      input: inputs,
      model: config.modelId,
      input_type: inputType,
      truncation: true,
    };

    const startedAt = Date.now();

    try {
      const response = await Z.HTTP.request('POST', config.endpoint, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        timeout: 60000,
      });

      const responseJson = this.parseResponseJson(response);
      const data = Array.isArray(responseJson?.data) ? responseJson.data : null;
      if (!data || data.length !== inputs.length) {
        throw new Error('Unexpected embedding response shape');
      }

      const returnedModel = typeof responseJson.model === 'string' && responseJson.model
        ? responseJson.model
        : config.modelId;
      const processingTimeMs = Date.now() - startedAt;

      return data.map((item: any) => {
        const rawEmbedding = item?.embedding;
        if (!Array.isArray(rawEmbedding)) {
          throw new Error('Embedding vector missing from response');
        }

        return {
          embedding: rawEmbedding.map((value: unknown) => Number(value)),
          modelId: `${config.providerId}:${returnedModel}`,
          processingTimeMs,
        };
      });
    } catch (error: any) {
      const wrappedError: any = new Error(this.formatProviderError(config, error));
      const status = this.getErrorStatus(error);
      if (status !== null) {
        wrappedError.status = status;
      }
      throw wrappedError;
    }
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string, isQuery: boolean = false): Promise<EmbeddingResult> {
    if (!this.ready) {
      await this.init();
    }

    const [result] = await this.requestEmbeddingsWithRetry([text], isQuery ? 'query' : 'document');
    return result;
  }

  /**
   * Convenience method for embedding search queries
   */
  async embedQuery(query: string): Promise<EmbeddingResult> {
    return this.embed(query, true);
  }

  /**
   * Convenience method for embedding documents
   */
  async embedDocument(text: string): Promise<EmbeddingResult> {
    return this.embed(text, false);
  }

  /**
   * Generate embeddings for multiple texts with batched API requests
   */
  async embedBatch(
    texts: { id: string; text: string; title: string }[],
    onProgress?: ProgressCallback
  ): Promise<Map<string, EmbeddingResult>> {
    if (!this.ready) {
      await this.init();
    }

    const results = new Map<string, EmbeddingResult>();
    const total = texts.length;
    const progressState = { processed: 0 };

    const batches = this.buildRequestBatches(texts);
    const concurrency = Math.max(1, Math.min(MAX_CONCURRENT_BATCH_REQUESTS, batches.length));

    this.logger.info(
      `Embedding ${total} texts in ${batches.length} request batches (concurrency ${concurrency})`
    );

    await this.runWithConcurrency(
      batches.map(batch => async () => {
        await this.processBatch(batch, total, results, progressState, onProgress);
      }),
      concurrency
    );

    if (onProgress) {
      onProgress({
        current: total,
        total,
        currentTitle: '',
        status: 'done',
      });
    }

    return results;
  }

  /**
   * Check if pipeline is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Reset pipeline to force re-validation after settings changes
   */
  reset(): void {
    this.logger.info('Resetting embedding pipeline');
    this.ready = false;
  }

  /**
   * Get current provider/model identifier
   */
  getModelId(): string {
    return getConfiguredEmbeddingModelId();
  }

  /**
   * Get model info
   */
  getModelInfo(): { id: string; dimensions: number; description: string } {
    const config = getConfiguredEmbeddingSettings();

    return {
      id: this.getModelId(),
      dimensions: 1024,
      description: `${config.providerLabel} embeddings API (${config.modelId})`,
    };
  }

  /**
   * Cleanup pipeline state
   */
  destroy(): void {
    this.reset();
  }
}

// Singleton instance
export const embeddingPipeline = new EmbeddingPipeline();
