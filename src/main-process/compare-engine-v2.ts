import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';

interface CompareConfig {
    totalTests: number;
    threadCount?: number;
    timeLimit?: number;
    generatorTimeout?: number;
    generator: string | { executablePath?: string; path?: string; exe?: string };
    stdExe: string | { executablePath?: string; path?: string; exe?: string };
    testExe: string | { executablePath?: string; path?: string; exe?: string };
}

interface WorkerMessageProgress {
    type: 'progress';
    testIndex: number;
}

interface WorkerMessageError {
    type: 'error';
    kind: string;
    code: string;
    exitCode: number;
    message: string;
    stdOutput?: string;
    testOutput?: string;
    input?: string;
    inputTruncated?: boolean;
    stdOutputTruncated?: boolean;
    testOutputTruncated?: boolean;
    genMs?: number;
    stdMs?: number;
    testMs?: number;
    testIndex: number;
}

interface WorkerMessageFastspawnWarning {
    type: 'fastspawn-load-warning';
    message: string;
}

interface WorkerMessageDone {
    type: 'done';
}

type WorkerMessage = WorkerMessageProgress | WorkerMessageError | WorkerMessageFastspawnWarning | WorkerMessageDone;

export class CompareEngineV2 extends EventEmitter {
    static _runCounter = 0;

    private _state: 'idle' | 'running' | 'stopping' = 'idle';
    private _workers: Worker[] = [];
    private _completed = 0;
    private _total = 0;
    private _errors = 0;
    private _stopRequested = false;
    private _fastspawnErrorForwarded = false;
    private _runId = 0;

    get state(): string {
        return this._state;
    }

    async start(config: CompareConfig): Promise<void> {
        if (this._state === 'running' || this._state === 'stopping') { throw new Error('Engine already running'); }
        this._state = 'running';
        this._stopRequested = false;
        this._fastspawnErrorForwarded = false;
        this._completed = 0;
        this._total = 0;
        this._errors = 0;

        this._runId = ++CompareEngineV2._runCounter;
        const runId = this._runId;
        const isCurrentRun = (): boolean => this._runId === runId;

        try {
            const totalTests = Number(config.totalTests);
            if (!Number.isInteger(totalTests) || totalTests <= 0 || totalTests > 100000) {
                throw new Error('totalTests must be an integer between 1 and 100000');
            }
            const requestedThreads = Number.isInteger(config.threadCount) && (config.threadCount ?? 0) > 0
                ? config.threadCount!
                : os.cpus().length;
            const runTimeout = (Number.isFinite(config.timeLimit) && config.timeLimit! > 0) ? config.timeLimit! : 0;
            const genTimeout = (Number.isFinite(config.generatorTimeout) && config.generatorTimeout! > 0) ? config.generatorTimeout! : 0;
            const threadCount = Math.min(Math.max(1, requestedThreads), totalTests, 32);
            this._total = totalTests;
            const perThread = Math.ceil(totalTests / threadCount);
            const workerPath = path.join(__dirname, 'compare-worker-v6.js');

            const resolvePath = (exe: string | { executablePath?: string; path?: string; exe?: string }): string => {
                if (!exe) return '';
                if (typeof exe === 'string') return exe;
                return exe.executablePath || exe.path || exe.exe || '';
            };

            const gen = config.generator;
            const stdPath = resolvePath(config.stdExe);
            const testPath = resolvePath(config.testExe);
            const hasGen = typeof gen === 'string'
                ? gen.trim().length > 0
                : !!(gen && (gen.executablePath || gen.path || gen.exe));

            if (!hasGen || !stdPath || !testPath) {
                const genDesc = typeof gen === 'string' ? gen : ((gen && gen.executablePath) || '');
                throw new Error('Missing executable paths: gen=' + genDesc + ' std=' + stdPath + ' test=' + testPath);
            }

            const donePromises: Promise<unknown>[] = [];

            for (let t = 0; t < threadCount; t++) {
                const startIdx = t * perThread + 1;
                const count = Math.min(perThread, totalTests - startIdx + 1);
                if (count <= 0) continue;

                const worker = new Worker(workerPath);
                this._workers.push(worker);

                const donePromise = new Promise<void>((resolve) => {
                    const settle = () => {
                        worker.removeListener('message', handler);
                        worker.removeListener('error', onWorkerError);
                        worker.removeListener('exit', onWorkerExit);
                        resolve();
                    };
                    const handler = (msg: WorkerMessage): void => {
                        // 上一轮遗留的迟到消息：不再计入本轮状态，也不再向上广播
                        // if (!isCurrentRun()) { settle(); return; }
                        if (!isCurrentRun()) { settle(); return; }
                        if (msg.type === 'progress') {
                            this._completed++;
                            this.emit('progress', { current: this._completed, total: this._total, testIndex: msg.testIndex });
                        } else if (msg.type === 'error') {
                            this._errors++;
                            this.emit('error', {
                                testNumber: msg.testIndex,
                                type: msg.kind,
                                code: msg.code,
                                exitCode: msg.exitCode,
                                message: msg.message,
                                stdOutput: msg.stdOutput || '',
                                testOutput: msg.testOutput || '',
                                input: msg.input || '',
                                inputTruncated: !!msg.inputTruncated,
                                stdOutputTruncated: !!msg.stdOutputTruncated,
                                testOutputTruncated: !!msg.testOutputTruncated,
                                genMs: msg.genMs,
                                stdMs: msg.stdMs,
                                testMs: msg.testMs
                            });
                        } else if (msg.type === 'fastspawn-load-warning') {
                            if (this._fastspawnErrorForwarded) return;
                            this._fastspawnErrorForwarded = true;
                            this.emit('warning', {
                                testNumber: 0,
                                type: 'fastspawn_fallback',
                                code: 'fastspawn_fallback',
                                message: 'fastspawn unavailable, falling back to Node child_process: ' + (msg.message || 'unknown error'),
                                input: ''
                            });
                        } else if (msg.type === 'done') {
                            settle();
                        }
                    };
                    const onWorkerError = (err: Error): void => {
                        if (isCurrentRun() && !this._stopRequested) {
                            this._errors++;
                            this.emit('error', { testNumber: 0, type: 'worker_crash', message: err.message, input: '' });
                        }
                        settle();
                    };
                    const onWorkerExit = (): void => settle();
                    worker.on('message', handler);
                    worker.on('error', onWorkerError);
                    worker.on('exit', onWorkerExit);
                });

                donePromises.push(donePromise);
                worker.postMessage({
                    type: 'run-tests',
                    startIdx, count,
                    gen, stdPath, testPath,
                    timeout: runTimeout,
                    generatorTimeout: genTimeout
                });
            }

            await Promise.all(donePromises);

            if (isCurrentRun() && this._state === 'running' && this._completed < this._total) {
                this.emit('warning', {
                    testNumber: 0,
                    type: 'incomplete_run',
                    code: 'incomplete_run',
                    completed: this._completed,
                    total: this._total,
                    missing: this._total - this._completed,
                    message: '',
                    input: ''
                });
            }

            const finalState = this._state as 'idle' | 'running' | 'stopping';
            if (finalState === 'stopping') {
                this.emit('stopped', { total: this._total, completed: this._completed, failed: this._errors });
            } else {
                this.emit('complete', {
                    total: this._total, completed: this._completed, failed: this._errors
                });
            }
        } catch (error) {
            this.emit('error', { testNumber: 0, type: 'engine', code: 'engine_start', message: (error as Error).message, input: '' });
        } finally {
            this._workers.forEach(w => { try { w.terminate(); } catch(_) {} });
            this._workers = [];
            this._state = 'idle';
        }
    }

    async stop(): Promise<void> {
        if (this._state !== 'running' && this._state !== 'stopping') return;
        this._stopRequested = true;
        this._state = 'stopping';
        const workers = this._workers.slice();
        workers.forEach(w => { try { w.postMessage({ type: 'stop' }); } catch(_) {} });
        setTimeout(() => {
            workers.forEach(w => { try { w.terminate(); } catch(_) {} });
        }, 2000).unref();
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CompareEngineV2 };
}