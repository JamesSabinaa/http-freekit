import { HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH } from '../ui/har-import.js';

export const TRAFFIC_IMPORT_TRANSACTION_ERROR_CODE =
  'ERR_TRAFFIC_IMPORT_TRANSACTION';
export const DEFAULT_TRAFFIC_IMPORT_TRANSACTION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING_TRANSACTIONS = 8;

export class TrafficImportTransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TrafficImportTransactionError';
    this.code = TRAFFIC_IMPORT_TRANSACTION_ERROR_CODE;
  }
}

function expandedJsonBytes(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TrafficImportTransactionError('Import batch is not JSON serializable');
  }
  // JSON text can occupy two bytes per code unit in a JavaScript heap. The
  // parsed objects add overhead, but this stable estimate bounds the dominant
  // captured body strings and matches the renderer's expanded-data policy.
  return serialized.length * 2;
}

function transactionError(message) {
  return new TrafficImportTransactionError(`Import transaction was discarded: ${message}`);
}

export class TrafficImportTransactionStore {
  constructor(options = {}) {
    this.maxExpandedBytes = options.maxExpandedBytes;
    this.maxEntries = options.maxEntries;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TRAFFIC_IMPORT_TRANSACTION_TIMEOUT_MS;
    this.maxPendingTransactions = options.maxPendingTransactions ??
      DEFAULT_MAX_PENDING_TRANSACTIONS;
    if (!Number.isSafeInteger(this.maxExpandedBytes) || this.maxExpandedBytes < 0) {
      throw new TypeError('Traffic import expanded-data limit must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0) {
      throw new TypeError('Traffic import entry limit must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 ||
        this.timeoutMs > 0x7fffffff) {
      throw new TypeError('Traffic import transaction timeout must be a positive timer value');
    }
    if (!Number.isSafeInteger(this.maxPendingTransactions) ||
        this.maxPendingTransactions <= 0) {
      throw new TypeError('Traffic import pending transaction limit must be positive');
    }
    this.transactions = new Map();
    this.totalExpandedBytes = 0;
  }

  _discard(id) {
    const transaction = this.transactions.get(id);
    if (!transaction) return false;
    clearTimeout(transaction.timer);
    this.transactions.delete(id);
    this.totalExpandedBytes -= transaction.expandedBytes;
    return true;
  }

  abort(id) {
    return typeof id === 'string' && this._discard(id);
  }

  _armExpiry(transaction) {
    clearTimeout(transaction.timer);
    transaction.timer = setTimeout(() => this._discard(transaction.id), this.timeoutMs);
    transaction.timer.unref?.();
  }

  stage(requests, metadata) {
    const suppliedId = metadata?.id;
    try {
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw transactionError('importTransaction must be an object');
      }
      const { id, index, count } = metadata;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) ||
          id.length > HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH) {
        throw transactionError(
          `id must use 1-${HAR_IMPORT_TRANSACTION_ID_MAX_LENGTH} letters, numbers, ` +
          'underscores, or hyphens'
        );
      }
      if (!Number.isSafeInteger(count) || count < 1 ||
          count > Math.max(1, this.maxEntries)) {
        throw transactionError('count is outside the allowed import range');
      }
      if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
        throw transactionError('index must identify one of the declared batches');
      }
      if (!Array.isArray(requests)) {
        throw transactionError('requests must be an array');
      }

      let transaction = this.transactions.get(id);
      if (!transaction) {
        if (index !== 0) throw transactionError('the first batch must have index 0');
        if (this.transactions.size >= this.maxPendingTransactions) {
          throw transactionError('too many imports are already pending');
        }
        transaction = {
          id,
          count,
          nextIndex: 0,
          entryCount: 0,
          expandedBytes: 0,
          batches: [],
          timer: null
        };
        this.transactions.set(id, transaction);
      }

      if (transaction.count !== count) {
        throw transactionError('count changed between batches');
      }
      if (transaction.nextIndex !== index) {
        throw transactionError(`expected batch index ${transaction.nextIndex}, received ${index}`);
      }
      if (transaction.entryCount + requests.length > this.maxEntries) {
        throw transactionError(`more than ${this.maxEntries} requests were supplied`);
      }

      const batchExpandedBytes = expandedJsonBytes(requests);
      if (transaction.expandedBytes + batchExpandedBytes > this.maxExpandedBytes ||
          this.totalExpandedBytes + batchExpandedBytes > this.maxExpandedBytes) {
        throw transactionError('expanded data exceeds the import memory policy');
      }

      transaction.batches.push(requests);
      transaction.nextIndex++;
      transaction.entryCount += requests.length;
      transaction.expandedBytes += batchExpandedBytes;
      this.totalExpandedBytes += batchExpandedBytes;

      if (transaction.nextIndex < transaction.count) {
        this._armExpiry(transaction);
        return {
          complete: false,
          transactionId: id,
          staged: transaction.entryCount,
          batchIndex: index,
          batchCount: count
        };
      }

      const completed = {
        complete: true,
        transactionId: id,
        requests: transaction.batches.flat(),
        staged: transaction.entryCount,
        batchIndex: index,
        batchCount: count
      };
      this._discard(id);
      return completed;
    } catch (error) {
      if (typeof suppliedId === 'string') this._discard(suppliedId);
      throw error;
    }
  }

  dispose() {
    for (const id of [...this.transactions.keys()]) this._discard(id);
  }
}
