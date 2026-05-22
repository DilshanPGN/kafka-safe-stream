/**
 * Run async fn over items with bounded concurrency.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {(info: { current: number, total: number, item: T }) => void} [onProgress]
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, limit, fn, onProgress) {
    const list = Array.isArray(items) ? items : [];
    const total = list.length;
    if (total === 0) return [];

    const concurrency = Math.max(1, Math.min(limit || 1, total));
    const results = new Array(total);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
        while (nextIndex < total) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await fn(list[index], index);
            completed += 1;
            if (typeof onProgress === 'function') {
                onProgress({ current: completed, total, item: list[index] });
            }
        }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i += 1) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

/**
 * @param {number} attempt 0-based
 * @returns {number} delay ms
 */
function exponentialBackoffMs(attempt) {
    const delays = [500, 2000, 5000];
    return delays[Math.min(attempt, delays.length - 1)];
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientKafkaError(err) {
    if (!err) return false;
    const msg = String(err.message || err);
    const code = err.code || '';
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timeout|timed out|Broker not available|connection error|The group is rebalancing/i.test(msg)) {
        return true;
    }
    if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(code))) {
        return true;
    }
    return false;
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, shouldRetry?: (err: unknown) => boolean, onRetry?: (attempt: number, err: unknown) => void }} [options]
 * @returns {Promise<T>}
 */
async function withRetry(fn, options) {
    const maxAttempts = (options && options.maxAttempts) || 3;
    const shouldRetry = (options && options.shouldRetry) || isTransientKafkaError;
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt >= maxAttempts - 1 || !shouldRetry(err)) {
                throw err;
            }
            if (options && typeof options.onRetry === 'function') {
                options.onRetry(attempt, err);
            }
            await new Promise((r) => setTimeout(r, exponentialBackoffMs(attempt)));
        }
    }
    throw lastErr;
}

module.exports = {
    mapWithConcurrency,
    exponentialBackoffMs,
    isTransientKafkaError,
    withRetry,
};
