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
    // 轮次序号：start() 用 ++CompareEngineV2._runCounter 分配本轮 _runId，
    // 配合 isCurrentRun() 把上一轮 worker 的迟到消息挡在门外。
    // 必须初始化 —— 未初始化时 ++undefined === NaN，而 NaN !== NaN，
    // isCurrentRun() 恒为 false，会把本轮每条 worker 消息都当成上一轮的
    // 迟��消息丢弃，表现为对拍秒结束且完成数恒为 0。
    static _runCounter = 0;

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
        if (this._state === 'running' || this._state === 'stopping') throw new Error('Engine already running');
        this._state = 'running';
        this._stopRequested = false;
        this._fastspawnErrorForwarded = false;
        this._completed = 0;
        this._total = 0;
        this._errors = 0;
        // 本次运行的标识。stop() 是 fire-and-forget：旧 worker 的消息可能在
        // terminate 生效前抵达，若不加归属校验，这些迟到的 progress/error 会被
        // 算到下一次运行头上（完成数虚高、错误张冠李戴）。
        this._runId = ++CompareEngineV2._runCounter;
        const runId = this._runId;
        const isCurrentRun = () => this._runId === runId;

        try {
            const totalTests = Number(config.totalTests);
            if (!Number.isInteger(totalTests) || totalTests <= 0 || totalTests > 100000) {
                throw new Error('totalTests must be an integer between 1 and 100000');
            }
            const requestedThreads = Number.isInteger(config.threadCount) && config.threadCount > 0
                ? config.threadCount
                : os.cpus().length;
            // 0 = 不限时，与 main.js run-program 的 useTimeouts 语义保持一致；不能用 || 兜底
            const runTimeout = (Number.isFinite(config.timeLimit) && config.timeLimit > 0) ? config.timeLimit : 0;
            const genTimeout = (Number.isFinite(config.generatorTimeout) && config.generatorTimeout > 0) ? config.generatorTimeout : 0;
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
                        // 上一轮遗留的迟到消息：不再计入本轮状态，也不再向上广播
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
                            // 每个 worker 都会独立上报一次，一次对拍就是十条同样的告警。
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
                    const onWorkerError = (err) => {
                        if (isCurrentRun() && !this._stopRequested) {
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
                    timeout: runTimeout,
                    generatorTimeout: genTimeout
                });
            }

            await Promise.all(donePromises);

            // worker 崩溃/提前退出时，它负责的那批测试根本没跑完，
            // 但完成数只统计了真正跑过的。不指出这点，UI 会显示
            // 「已完成 N 组」并给出 100% 覆盖率，缺口不可见。
            if (isCurrentRun() && this._state === 'running' && this._completed < this._total) {
                this.emit('warning', {
                    testNumber: 0,
                    type: 'incomplete_run',
                    code: 'incomplete_run',
                    // 不在此处拼英文文案：只给计数，由渲染层按 i18n 组装
                    completed: this._completed,
                    total: this._total,
                    missing: this._total - this._completed,
                    message: '',
                    input: ''
                });
            }

            if (this._state === 'stopping') {
                this.emit('stopped', { total: this._total, completed: this._completed, failed: this._errors });
            } else {
                // 不在此处拼英文文案，只给计数，由渲染层按 i18n 组装
                this.emit('complete', {
                    total: this._total, completed: this._completed, failed: this._errors
                });
            }
        } catch (error) {
            this.emit('error', { testNumber: 0, type: 'engine', code: 'engine_start', message: error.message, input: '' });
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
