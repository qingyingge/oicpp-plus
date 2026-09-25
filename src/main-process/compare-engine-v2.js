/**
 * CompareEngineV2 — Worker Thread 多线程对拍引擎
 * 每个 Worker Thread 有独立事件循环 + 独立 spawn
 * 消除单事件循环瓶颈，实现真并行
 */
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

class CompareEngineV2 extends EventEmitter {
    constructor() {
        super();
        this._state = 'idle';
        this._workers = [];
        this._completed = 0;
        this._total = 0;
        this._errors = 0;
        this._stopRequested = false;
        this._fastspawnErrorForwarded = false;
    }

    get state() { return this._state; }

    async start(config) {
        if (this._state === 'running') throw new Error('Engine already running');
        this._state = 'running';
        this._stopRequested = false;
        this._fastspawnErrorForwarded = false;
        this._completed = 0;
        this._total = 0;
        this._errors = 0;

        try {
            const totalTests = Number(config.totalTests);
            if (!Number.isInteger(totalTests) || totalTests <= 0 || totalTests > 100000) {
                throw new Error('totalTests must be an integer between 1 and 100000');
            }
            const requestedThreads = Number.isInteger(config.threadCount) && config.threadCount > 0
                ? config.threadCount
                : os.cpus().length;
            const threadCount = Math.min(Math.max(1, requestedThreads), totalTests, 32);
            this._total = totalTests;
            const perThread = Math.ceil(totalTests / threadCount);
            const workerPath = path.join(__dirname, 'compare-worker-v6.js');

            const resolvePath = (exe) => {
                if (!exe) return '';
                if (typeof exe === 'string') return exe;
                return exe.executablePath || exe.path || '';
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

            const donePromises = [];

            for (let t = 0; t < threadCount; t++) {
                const startIdx = t * perThread + 1;
                const count = Math.min(perThread, totalTests - startIdx + 1);
                if (count <= 0) continue;

                const worker = new Worker(workerPath);
                this._workers.push(worker);

                const donePromise = new Promise((resolve) => {
                    const settle = () => {
                        worker.removeListener('message', handler);
                        worker.removeListener('error', onWorkerError);
                        worker.removeListener('exit', onWorkerExit);
                        resolve();
                    };
                    const handler = (msg) => {
                        if (msg.type === 'progress') {
                            this._completed++;
                            this.emit('progress', { current: this._completed, total: this._total, testIndex: msg.testIndex });
                        } else if (msg.type === 'error') {
                            this._errors++;
                            this.emit('error', {
                                testNumber: msg.testIndex,
                                type: msg.kind,
                                message: msg.message,
                                stdOutput: msg.stdOutput || '',
                                testOutput: msg.testOutput || '',
                                input: msg.input || '',
                                genMs: msg.genMs,
                                stdMs: msg.stdMs,
                                testMs: msg.testMs
                            });
                        } else if (msg.type === 'fastspawn-load-warning') {
                            this.emit('warning', {
                                testNumber: 0,
                                type: 'engine',
                                message: 'fastspawn unavailable; using Node child_process fallback: ' + (msg.message || 'unknown error'),
                                input: ''
                            });
                        } else if (msg.type === 'done') {
                            settle();
                        }
                    };
                    const onWorkerError = (err) => {
                        if (!this._stopRequested) {
                            this._errors++;
                            this.emit('error', { testNumber: 0, type: 'worker_crash', message: err.message, input: '' });
                        }
                        settle();
                    };
                    const onWorkerExit = () => settle();
                    worker.on('message', handler);
                    worker.on('error', onWorkerError);
                    worker.on('exit', onWorkerExit);
                });

                donePromises.push(donePromise);
                worker.postMessage({
                    type: 'run-tests',
                    startIdx, count,
                    gen, stdPath, testPath,
                    timeout: config.timeLimit || 5000,
                    generatorTimeout: config.generatorTimeout || 5000
                });
            }

            await Promise.all(donePromises);

            if (this._state === 'stopping') {
                this.emit('stopped', { completed: this._completed });
            } else {
                this.emit('complete', {
                    total: this._total, completed: this._completed, failed: this._errors,
                    warning: this._errors > 0 ? this._errors + ' tests failed' : null
                });
            }
        } catch (error) {
            this.emit('error', { testNumber: 0, type: 'engine', message: error.message, input: '' });
        } finally {
            this._workers.forEach(w => { try { w.terminate(); } catch(_) {} });
            this._workers = [];
            this._state = 'idle';
        }
    }

    async stop() {
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

module.exports = { CompareEngineV2 };
