import * as os from 'os';

const DEFAULT_CPU_THREADS = 2;
const WARM_UP_DELAY_MS = 2000;

let cachedCpuThreads: number | null = null;

function detectCpuThreads(): number {
    try {
        const cpus = os.cpus();
        const count = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : DEFAULT_CPU_THREADS;
        return Math.max(1, count);
    } catch (_) {
        return DEFAULT_CPU_THREADS;
    }
}

export function getCpuThreads(): number {
    if (cachedCpuThreads === null) {
        cachedCpuThreads = detectCpuThreads();
    }
    return cachedCpuThreads;
}

export function scheduleCpuThreadsWarmUp(delayMs: number = WARM_UP_DELAY_MS): NodeJS.Timeout | undefined {
    if (cachedCpuThreads !== null) return undefined;
    const timer = setTimeout(() => {
        try {
            getCpuThreads();
        } catch (_) { }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

export function resetCpuThreadsCache(): void {
    cachedCpuThreads = null;
}

export { DEFAULT_CPU_THREADS, detectCpuThreads };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_CPU_THREADS,
        detectCpuThreads,
        getCpuThreads,
        scheduleCpuThreadsWarmUp,
        resetCpuThreadsCache
    };
}