'use strict';

// 云同步传输层的回归：这段代码必须在「没有全局 fetch」的运行时里跑通。
//
// 全局 fetch 要 Node 18+。legacy 渠道的 Electron 22 内嵌 Node 16.17，那里 fetch 是
// undefined；原先的写法会抛 ReferenceError，而函数自己的 catch 正好把它咽成
// {ok:false, status:0} —— 云同步静默失效，界面上只是「点同步没反应」，日志里也没有异常。
// vm 沙箱天生不带 fetch，所以「抽出来真跑通」本身就是那条证明（第 6 组把它显式化）。
//
// 第二组锁的是 fetch 的分类语义：4xx/5xx 不抛错，靠 ok 判定。换成 axios 后如果丢了
// validateStatus，同一个 404 会变成 status:0，前端的重试/提示分支就走错了。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { funcDecl } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const decl = funcDecl(mainSource, 'callCloudSyncApi');

// 假 axios：按真 axios 的规则处理 validateStatus，这样「选项丢了」会当场显形，
// 而不是等到线上变成另一种错误形状。
const makeAxios = (respond) => {
    const requests = [];
    return {
        requests,
        impl: async (cfg) => {
            requests.push(cfg);
            const outcome = respond(cfg);
            if (outcome instanceof Error) throw outcome;
            const ok = typeof cfg.validateStatus === 'function'
                ? cfg.validateStatus(outcome.status)
                : outcome.status >= 200 && outcome.status < 300;
            if (!ok) {
                const error = new Error(`Request failed with status code ${outcome.status}`);
                error.response = outcome;
                throw error;
            }
            return outcome;
        }
    };
};

const makeCtx = (axiosStub, options = {}) => {
    const ctx = vm.createContext({
        URL, crypto, Date, Number, Object, Array, String, Boolean, JSON, Math, Error, Promise, RegExp, Set, Map,
        axios: { request: axiosStub.impl },
        getLoginToken: () => (options.loginToken === undefined ? 'LOGIN-TOKEN' : options.loginToken),
        getLoggedInUsername: () => 'tester',
        generateEncodedToken: () => 'ENC-TOKEN',
        buildCloudSyncSignature: () => 'SIG',
        CLOUD_SYNC_BASE: 'https://sync.example.test',
        logWarn: () => { },
        logInfo: () => { }
    });
    vm.runInContext(`${decl}\nthis.api = callCloudSyncApi;`, ctx);
    return ctx;
};

async function main() {
    check('callCloudSyncApi 抽取成功', decl.length > 200, `${decl.length} 字符`);
    if (decl.length < 200) return;

    // 1) 未登录直接拒，不发请求
    {
        const axiosStub = makeAxios(() => ({ status: 200, data: '{}' }));
        const ctx = makeCtx(axiosStub, { loginToken: '' });
        const result = await ctx.api({ path: '/cloudSync/list' });
        check('未登录返回 401 且不发请求',
            result.ok === false && result.status === 401 && axiosStub.requests.length === 0);
    }

    // 2) 200 + JSON
    {
        const axiosStub = makeAxios(() => ({ status: 200, data: '{"items":[1,2]}' }));
        const ctx = makeCtx(axiosStub);
        const result = await ctx.api({ path: 'cloudSync/list', query: { b: '2', a: '1' } });
        const cfg = axiosStub.requests[0];
        check('200 分类为 ok 并解析出 JSON',
            result.ok === true && result.status === 200
            && Array.isArray(result.data.items) && result.data.items.length === 2,
            JSON.stringify(result));
        check('GET 不带 body、不声明 Content-Type',
            cfg.data === undefined && !cfg.headers['Content-Type'], JSON.stringify(cfg.headers));
        check('响应按纯文本取（保住「解析失败退回原文」那条分支）',
            cfg.responseType === 'text' && Array.isArray(cfg.transformResponse)
            && cfg.transformResponse.length === 0);
        check('有超时', cfg.timeout === 15000, String(cfg.timeout));
        check('签名头齐备',
            cfg.headers.Authorization === 'Bearer LOGIN-TOKEN' && cfg.headers['X-OICPP-Signature'] === 'SIG');
        // 路径没写前导斜杠时补上；query 按 key 排序后拼接
        const sentUrl = String(cfg.url);
        check('路径补前导斜杠且 query 已排序',
            sentUrl.startsWith('https://sync.example.test/cloudSync/list?')
            && sentUrl.indexOf('a=1') < sentUrl.indexOf('b=2'), sentUrl);
    }

    // 3) 404 不抛错，仍按 fetch 语义分类
    {
        const axiosStub = makeAxios(() => ({ status: 404, data: '{"message":"not found"}' }));
        const ctx = makeCtx(axiosStub);
        const result = await ctx.api({ method: 'post', path: '/cloudSync/create', body: { name: 'x' } });
        check('404 判为 ok:false 且 status 保留 404（validateStatus 若被删会退化成 0）',
            result.ok === false && result.status === 404
            && result.data && result.data.message === 'not found', JSON.stringify(result));
        const cfg = axiosStub.requests[0];
        check('POST 大写化并带上序列化 body 与 Content-Type',
            cfg.method === 'POST' && cfg.data === '{"name":"x"}'
            && cfg.headers['Content-Type'] === 'application/json');
    }

    // 4) 非 JSON 响应退回原文
    {
        const axiosStub = makeAxios(() => ({ status: 200, data: 'plain text body' }));
        const ctx = makeCtx(axiosStub);
        const result = await ctx.api({ path: '/cloudSync/list' });
        check('非 JSON 正文原样返回', result.ok === true && result.data === 'plain text body');
    }

    // 5) 传输层抛错 → status 0 + error 文本
    {
        const axiosStub = makeAxios(() => new Error('ECONNREFUSED'));
        const ctx = makeCtx(axiosStub);
        const result = await ctx.api({ path: '/cloudSync/list' });
        check('网络错误归一为 status:0 并带出原因',
            result.ok === false && result.status === 0 && result.error === 'ECONNREFUSED',
            JSON.stringify(result));
    }

    // 6) 沙箱里根本没有 fetch —— 这就是 Node 16 / Electron 22 的形态
    {
        const axiosStub = makeAxios(() => ({ status: 200, data: '{}' }));
        const ctx = makeCtx(axiosStub);
        const hasFetch = vm.runInContext('typeof fetch', ctx);
        const hasFormData = vm.runInContext('typeof FormData', ctx);
        check('沙箱内没有全局 fetch（跑通即证明不依赖它）',
            hasFetch === 'undefined', String(hasFetch));
        check('云同步路径也不碰 FormData',
            hasFormData === 'undefined' && !/FormData/.test(decl));
    }
}

main().then(() => {
    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
    process.exitCode = failures === 0 ? 0 : 1;
}).catch((error) => {
    check('本文件的异步守卫自身跑通', false, error.stack || error.message);
    process.exitCode = 1;
});
