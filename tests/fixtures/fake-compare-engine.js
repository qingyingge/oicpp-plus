'use strict';

// 在 vm 沙箱里跑「真引擎 + 假 Worker」。
//
// CompareEngineV2 只依赖 events / worker_threads / path / os，不碰 electron，
// 所以把 Worker 换成假件就能直接观察它对 worker 消息的真实处理：
// 事件载荷、计数归属、超时归一化下发值 —— 这些都能变成断言，
// 不用再正则比 `/emit\('complete', \{ total: this\._total .../` 这种一改版就误报的长相。
//
// makeEngineWithFakeWorker 的 opts：
//   registry  每建一个假 Worker 就 push 进来；要自己控制消息时序（迟到消息、
//             跑到一半停）的场景靠它拿 worker 句柄
//   manual    true 时一条消息都不自动发，全由测试自己 emit
//   posts     记录引擎下发给 worker 的每个 postMessage 载荷（超时归一化就看这个）

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const repoRoot = path.resolve(__dirname, '..', '..');

const makeEngineWithFakeWorker = (progressCount, opts = {}) => {
    const engineSrc = fs.readFileSync(
        path.join(repoRoot, 'src', 'main-process', 'compare-engine-v2.js'), 'utf8');
    const sandbox = {
        // 编译产物用这个对象挂模块标记，真实环境里由模块包装器提供，沙箱必须补上这个绑定
        require, module: { exports: {} }, exports: {}, console,
        setTimeout, clearTimeout, Promise, EventEmitter,
        os: { cpus: () => [{ length: 4 }] },
        path,
        __dirname: path.join(repoRoot, 'src', 'main-process'),
        fs: { existsSync: () => true, mkdirSync: () => {}, rmSync: () => {} },
        Worker: class FakeWorker extends EventEmitter {
            constructor() {
                super();
                this.pid = 1234;
                this.posts = [];
                if (opts.registry) opts.registry.push(this);
                // manual：一条都不自动发，由测试自己控制消息时序
                if (opts.manual) return;
                setImmediate(() => {
                    for (let i = 1; i <= progressCount; i++) this.emit('message', { type: 'progress', testIndex: i });
                    this.emit('message', { type: 'done' });
                });
            }
            postMessage(msg) {
                this.posts.push(msg);
                if (opts.posts) opts.posts.push(msg);
            }
            terminate() { return Promise.resolve(); }
            removeAllListeners() { return this; }
        }
    };
    vm.createContext(sandbox);
    // 剥掉原生引入改用沙箱假件；源码形态（解构 require）与 tsc 产物形态（命名空间对象）
    // 是同一条语句的两种写法，两种都要接住，否则编译方式一改，假件就静默失效。
    vm.runInContext(engineSrc
        .replace(/^const \{ EventEmitter \} = require\('events'\);$/m, '')
        .replace(/^const \{ Worker \} = require\('worker_threads'\);$/m, '')
        .replace(/^const events_1 = require\("events"\);$/m, 'const events_1 = { EventEmitter };')
        .replace(/^const worker_threads_1 = require\("worker_threads"\);$/m, 'const worker_threads_1 = { Worker };'),
    sandbox, { filename: 'compare-engine-v2.js' });
    return sandbox.module.exports.CompareEngineV2;
};

// 跑完整一轮真引擎：建 worker → 注入 messages → 可选 stop → 收 done。
// 返回 { engine, events, posts, workers }，events 按类型记载荷，调用方自己挑。
const runEngine = async (options = {}) => {
    const { messages = [], config = {}, stop = false, sendDone = true } = options;
    const workers = [];
    const posts = [];
    const Ctor = makeEngineWithFakeWorker(0, { registry: workers, posts, manual: true });
    const engine = new Ctor();
    const events = [];
    for (const type of ['progress', 'error', 'warning', 'complete', 'stopped']) {
        engine.on(type, (payload) => events.push({ type, payload }));
    }
    const started = engine.start({
        totalTests: 3, threadCount: 1,
        generator: 'g.exe', stdExe: 'a.exe', testExe: 'b.exe',
        timeLimit: 0, generatorTimeout: 0, ...config
    });
    // 等 worker 建好、消息监听装上，再注入消息
    await new Promise((resolve) => setImmediate(resolve));
    for (const msg of messages) workers[0].emit('message', msg);
    await new Promise((resolve) => setImmediate(resolve));
    if (stop) await engine.stop();
    if (sendDone) workers[0].emit('message', { type: 'done' });
    await started;
    return { engine, events, posts, workers };
};

const pick = (events, type) => events.filter((e) => e.type === type).map((e) => e.payload);

module.exports = { makeEngineWithFakeWorker, runEngine, pick };
