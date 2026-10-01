'use strict';

// fastspawn.cc 是 POSIX-only 扩展：Windows 上 build-fastspawn.js 直接跳过，
// 于是 native 代码的语法/类型错误要到 POSIX 机器打包时才暴露。
// 本脚本在 Windows 上用 g++ -fsyntax-only + 最小 N-API/POSIX 桩做静态检查，
// 让 CI 在任何平台都能拦住这一类错误。
//
// 用法：node scripts/check-fastspawn-syntax.js
// 无 g++ 时跳过（不判 FAIL），避免在没有编译器的环境里把 CI 打红。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'fastspawn.cc');

if (!fs.existsSync(source)) {
    console.log('[fastspawn-syntax] fastspawn.cc 不存在，跳过');
    process.exit(0);
}

function findGpp() {
    if (process.env.GXX) return process.env.GXX;
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['g++'], { encoding: 'utf8' });
    if (probe.status === 0) {
        const first = (probe.stdout || '').split(/\r?\n/).find((l) => l.trim());
        if (first) return first.trim();
    }
    // 项目自带的 MinGW（用户常把它下到 ~/.oicpp/Compilers/<ver>/mingw64/bin）
    const compilersRoot = path.join(os.homedir(), '.oicpp', 'Compilers');
    if (fs.existsSync(compilersRoot)) {
        const candidates = [];
        for (const ver of fs.readdirSync(compilersRoot)) {
            candidates.push(path.join(compilersRoot, ver, 'mingw64', 'bin', 'g++.exe'));
        }
        const hit = candidates.find((p) => fs.existsSync(p));
        if (hit) return hit;
    }
    return null;
}

const gpp = findGpp();
if (!gpp) {
    console.log('[fastspawn-syntax] 未找到 g++，跳过语法检查');
    process.exit(0);
}

// 最小桩：只声明 fastspawn.cc 实际用到的 N-API 与 POSIX 符号
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastspawn-stub-'));
const write = (rel, body) => {
    const p = path.join(stubDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
};

write('node_api.h', `
#ifndef STUB_NODE_API_H
#define STUB_NODE_API_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_deprecated__* napi_deprecated;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef enum { napi_ok = 0 } napi_status;
typedef enum { napi_undefined, napi_null, napi_boolean, napi_number, napi_string,
               napi_symbol, napi_object, napi_function, napi_external, napi_bigint } napi_valuetype;
typedef enum { napi_default, napi_jsconstructor, napi_property, napi_default_method } napi_property_attributes;
typedef struct {
    const char* utf8name; napi_value name; napi_callback method;
    napi_callback getter; napi_callback setter; napi_value value;
    napi_property_attributes attributes; void* data;
} napi_property_descriptor;
napi_status napi_get_cb_info(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, napi_deprecated*);
napi_status napi_throw_error(napi_env, const char*, const char*);
napi_status napi_typeof(napi_env, napi_value, napi_valuetype*);
napi_status napi_get_value_string_utf8(napi_env, napi_value, char*, size_t, size_t*);
napi_status napi_get_value_int64(napi_env, napi_value, int64_t*);
napi_status napi_get_value_double(napi_env, napi_value, double*);
napi_status napi_get_value_bool(napi_env, napi_value, bool*);
napi_status napi_get_buffer_info(napi_env, napi_value, void**, size_t*);
napi_status napi_create_object(napi_env, napi_value*);
napi_status napi_create_int64(napi_env, int64_t, napi_value*);
napi_status napi_create_int32(napi_env, int32_t, napi_value*);
napi_status napi_create_double(napi_env, double, napi_value*);
napi_status napi_get_boolean(napi_env, bool, napi_value*);
napi_status napi_create_buffer_copy(napi_env, size_t, const void*, void**, napi_value*);
napi_status napi_set_named_property(napi_env, napi_value, const char*, napi_value);
napi_status napi_define_properties(napi_env, napi_value, size_t, const napi_property_descriptor*);
napi_status napi_create_function(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
napi_status napi_create_string_utf8(napi_env, const char*, size_t, napi_value*);
napi_status napi_get_undefined(napi_env, napi_value*);
napi_status napi_module_register(napi_env, napi_deprecated*);
#define NAPI_MODULE(modname, regfunc) extern "C" napi_value __napi_##regfunc(napi_env, napi_value);
#ifdef __cplusplus
}
#endif
#endif
`);

write('posix_stub.h', `
#ifndef STUB_POSIX_H
#define STUB_POSIX_H
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
typedef unsigned long nfds_t;
#ifndef O_CLOEXEC
#define O_CLOEXEC 0x80000
#endif
#ifndef O_NONBLOCK
#define O_NONBLOCK 0x800
#define F_SETFL 4
#define F_GETFL 3
#endif
#ifndef POLLIN
#define POLLIN 0x001
#define POLLOUT 0x004
#define POLLHUP 0x010
#define POLLERR 0x008
#endif
#ifndef WNOHANG
#define WNOHANG 1
#endif
#ifndef SIGKILL
#define SIGKILL 9
#define SIGPIPE 13
#endif
#ifndef STDIN_FILENO
#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#endif
#define WIFEXITED(s)   (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s)    ((s) & 0x7f)
#define POSIX_SPAWN_SETPGROUP 0x02
struct pollfd { int fd; short events; short revents; };
typedef struct posix_spawn_file_actions { int d; } posix_spawn_file_actions_t;
typedef struct posix_spawnattr { int d; } posix_spawnattr_t;
static inline void posix_spawn_file_actions_init(posix_spawn_file_actions_t* a) { (void)a; }
static inline void posix_spawn_file_actions_destroy(posix_spawn_file_actions_t* a) { (void)a; }
static inline int posix_spawn_file_actions_adddup2(posix_spawn_file_actions_t* a, int f, int n) { (void)a; (void)f; return n; }
static inline void posix_spawnattr_init(posix_spawnattr_t* a) { (void)a; }
static inline void posix_spawnattr_destroy(posix_spawnattr_t* a) { (void)a; }
static inline int posix_spawnattr_setflags(posix_spawnattr_t* a, short f) { (void)a; (void)f; return 0; }
static inline int posix_spawnattr_setpgroup(posix_spawnattr_t* a, pid_t p) { (void)a; (void)p; return 0; }
#ifdef __cplusplus
extern "C" {
#endif
extern char** environ;
int pipe2(int pipefd[2], int flags);
int posix_spawn(pid_t*, const char*, const posix_spawn_file_actions_t*, const posix_spawnattr_t*, char* const[], char* const[]);
int kill(pid_t, int);
pid_t waitpid(pid_t, int*, int);
int poll(struct pollfd*, nfds_t, int);
int usleep(unsigned int);
int fcntl(int, int, ...);
#ifdef __cplusplus
}
#endif
#endif
`);

write('spawn.h', '#include "posix_stub.h"\n');
write('poll.h', '#include "posix_stub.h"\n');
write('unistd.h', '#include "posix_stub.h"\n');
write('sys/wait.h', '#include "../posix_stub.h"\n');
write('sys/time.h', '#include "../posix_stub.h"\n');

const result = spawnSync(gpp, ['-fsyntax-only', '-std=c++17', '-I', stubDir, source], {
    encoding: 'utf8'
});

fs.rmSync(stubDir, { recursive: true, force: true });

if (result.error) {
    console.log(`[fastspawn-syntax] 无法执行 g++：${result.error.message}，跳过`);
    process.exit(0);
}

const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
if (result.status !== 0) {
    console.error('[fastspawn-syntax] fastspawn.cc 语法/类型检查失败：');
    console.error(output);
    process.exit(1);
}

const warnings = output.split(/\r?\n/).filter((l) => /warning:/i.test(l));
console.log(`[fastspawn-syntax] fastspawn.cc 通过 g++ -fsyntax-only${warnings.length ? `（${warnings.length} 条警告）` : ''}`);
process.exit(0);