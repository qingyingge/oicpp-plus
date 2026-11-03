#define NAPI_VERSION 8
#include <node_api.h>
#include <spawn.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <sys/wait.h>
#include <sys/types.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>
#include <errno.h>
#include <time.h>
#include <pthread.h>
#include <signal.h>

#define MAX_OUTPUT (64 * 1024 * 1024)
// stderr 只可能用于「为什么失败」的前缀诊断，回传整段没有任何消费方。
// 单独给一个小上限，比 stdout 共享 MAX_OUTPUT 能把 worker 的最坏驻留内存
// 从 每线程 2×(64MB+64MB) 降到 每线程 2×(64MB+64KB)。
#define MAX_STDERR (64 * 1024)
// 判等模式下回传给 UI 的 diff 摘录上限，与 JS 侧 MAX_CAPTURED_OUTPUT_BYTES 对齐。
#define MAX_EXCERPT (64 * 1024)

// pipe2 只在 Linux 上有（glibc 扩展），macOS/BSD 编译到这里就是 undeclared。
// 两个平台的差别只是 close-on-exec / 非阻塞的设置方式，所以用 pipe()+fcntl()
// 补一个语义等价的实现： flags 里出现的每一位都照做，不能静默忽略。
#if !defined(__linux__)
static int pipe2(int fds[2], int flags) {
    if (pipe(fds) != 0) return -1;
    for (int i = 0; i < 2; i++) {
        if (flags & O_CLOEXEC) {
            int got = fcntl(fds[i], F_GETFD);
            if (got < 0 || fcntl(fds[i], F_SETFD, got | FD_CLOEXEC) != 0) goto fail;
        }
        if (flags & O_NONBLOCK) {
            int got = fcntl(fds[i], F_GETFL);
            if (got < 0 || fcntl(fds[i], F_SETFL, got | O_NONBLOCK) != 0) goto fail;
        }
    }
    return 0;
fail:
    {
        int saved = errno;
        close(fds[0]);
        close(fds[1]);
        errno = saved;
    }
    return -1;
}
#endif

static int64_t nowMs(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + (int64_t)ts.tv_nsec / 1000000;
}

static void closePair(int p[2]) {
    if (p[0] >= 0) close(p[0]);
    if (p[1] >= 0) close(p[1]);
}

struct DrainBuf {
    char* buf;
    size_t len;
    size_t cap;
    size_t max;
    int drop;
};

// max 是这条流独立的上限（stdout 用 MAX_OUTPUT，stderr 用 MAX_STDERR）。
// 超限的那部分不是丢掉就完事，必须置 drop：调用方靠它区分「程序就输出这么多」
// 和「被我砍过」，不置位的话拿残缺输出判等会静默出错。
static void drainAppend(DrainBuf* b, const char* data, size_t n) {
    if (b->drop) return;
    if (b->len >= b->max) { b->drop = 1; return; }
    if (n > b->max - b->len) {
        n = b->max - b->len;
        b->drop = 1;
    }
    if (b->len + n > b->cap) {
        size_t ncap = b->cap ? b->cap : 8192;
        while (ncap < b->len + n) {
            if (ncap >= b->max) { ncap = b->max; break; }
            ncap *= 2;
        }
        char* nb = (char*)realloc(b->buf, ncap);
        if (!nb) { b->drop = 1; return; }
        b->buf = nb;
        b->cap = ncap;
    }
    if (n) memcpy(b->buf + b->len, data, n);
    b->len += n;
}

// Poll waitpid until deadline; on timeout kill and reap. Returns exit code, -2, or -3.
static int waitpidTimed(pid_t pid, int64_t deadlineMs) {
    int status = 0;
    for (;;) {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -2;
        }
        if (nowMs() >= deadlineMs) {
            kill(-pid, SIGKILL);
            for (;;) {
                pid_t w2 = waitpid(pid, &status, 0);
                if (w2 == pid) break;
                if (w2 < 0 && errno == EINTR) continue;
                break;
            }
            return -3;
        }
        usleep(1000);
    }
}

// 有界超时之外唯一的取值：「不限时」。用 INT64_MAX 而不是某个有限大数，
// 长时间对拍（几小时）都不会被有限大数当成真实截止时间而误杀。
#define NO_DEADLINE INT64_MAX

// 静默收割：只负责「别留僵尸」，不解释退出码。已收割过则拿到 ECHILD，直接退出。
static void reapQuietly(pid_t pid) {
    int status = 0;
    for (;;) {
        pid_t w = waitpid(pid, &status, 0);
        if (w == pid) break;
        if (w < 0 && errno != EINTR) break;
    }
}

// 把一个已经可读的 fd 抽干到 EAGAIN 或 EOF。
// 超过 b->max 之后必须**继续读**（只是不再存），否则对端写满管道就卡死，
// 一个大输出程序会从「输出超限」变成「超时」—— 那是完全不同的错误性质。
static void drainReadable(int fd, DrainBuf* b, int* open) {
    char chunk[65536];
    for (;;) {
        ssize_t r = read(fd, chunk, sizeof(chunk));
        if (r > 0) { drainAppend(b, chunk, (size_t)r); continue; }
        if (r == 0) { *open = 0; return; }
        int saved = errno;                // 必须紧跟 read：下面的判断不能用被改写的 errno
        if (saved == EINTR) continue;
        if (saved == EAGAIN || saved == EWOULDBLOCK) return;
        *open = 0; return;
    }
}

// 交错地「喂 stdin」与「收 stdout/stderr」，直到输入写完且两条输出流都结束。
//   0 = 正常结束，-3 = 截止时间到（已 kill），-2 = 硬错误
//
// 原先分成两段（把 input 全写完，再 drain 输出），那是个死锁：cat 这类边读边写
// 的程序把输出管道写满后就停住不再读输入，而我们还堵在写输入上、没有开始收它
// 的输出，双方互等，只能靠超时收场 —— 实测 run(cat, 3.5MB) 会耗满截止时间。
// 交错以后不光不死锁，「喂数据」还与「被测程序计算」重叠，白赚一段并行。
//
// 这里同时修掉一个会误杀健康子进程的坑。判错原先写成
//     if (wr <= 0 && errno != EINTR) kill(-pid, SIGKILL);
// 而 poll() 超时时返回 0 **且不改动 errno**，errno 此时还是上一步 write() 留下的
// EAGAIN —— 条件成立，于是「子进程只是还没来得及读」被当成错误，健康的 std/test
// 被 SIGKILL，收割状态折算成 128+9 = 137，上报成 std_re。触发条件仅仅是输入大于
// 管道缓冲，也就是任何真实规模的生成数据：实测空闲机器上单次
// run(range_bit, 3.5MB, 20000ms) 在 139ms 就被杀。现在 pr == 0 一律 continue，
// 截止时间到就固定返回 -3，不给「从收割状态反推超时」留任何路径。
static int pump(int inFd, const char* input, size_t inputLen,
                int outFd, int errFd, int64_t deadlineMs, pid_t pid,
                DrainBuf* ob, DrainBuf* eb) {
    size_t off = 0;
    int inOpen = 1;
    if (!input || inputLen == 0) { close(inFd); inOpen = 0; }   // 让子进程立刻看到 EOF
    int outOpen = 1, errOpen = 1;
    // 写不进去不等于写完了。把 EAGAIN 当成错误、或者异常时悄悄关掉 stdin，
    // 子进程会收到一个被截断的输入并「正常」算出错答案 —— 这是最难发现的一类
    // 假 WA。所以异常一律置 writeErr，让上层明确失败而不是往下走。
    int writeErr = 0;
    // 循环里不直接 return：inFd 的统一在出口关一次，中途 return 会漏掉它。
    int ret = 0;

    for (;;) {
        if (!inOpen && !outOpen && !errOpen) break;
        if (deadlineMs != NO_DEADLINE && nowMs() >= deadlineMs) {
            kill(-pid, SIGKILL);
            ret = -3;
            break;
        }

        struct pollfd pfds[3];
        int n = 0, iIn = -1, iOut = -1, iErr = -1;
        if (inOpen)  { pfds[n].fd = inFd;   pfds[n].events = POLLOUT; pfds[n].revents = 0; iIn = n;  n++; }
        if (outOpen) { pfds[n].fd = outFd;  pfds[n].events = POLLIN;  pfds[n].revents = 0; iOut = n; n++; }
        if (errOpen) { pfds[n].fd = errFd;  pfds[n].events = POLLIN;  pfds[n].revents = 0; iErr = n; n++; }

        int64_t remain = (deadlineMs == NO_DEADLINE) ? -1 : (deadlineMs - nowMs());
        int slice = (remain < 0 || remain > 200) ? 200 : (int)remain;
        int pr = poll(pfds, n, slice);
        if (pr < 0) { if (errno == EINTR) continue; ret = -2; break; }
        if (pr == 0) continue;

        if (iIn >= 0 && pfds[iIn].revents) {
            if (pfds[iIn].revents & (POLLERR | POLLNVAL)) {
                // 写端看到 POLLERR 通常只是「读端没人了」：子进程提前退出，或根本
                // 不消费输入。这不是故障 —— 关掉 stdin 继续收它的输出与退出码，
                // 结论仍然由程序自己的返回值决定。把它升格成 -2 反而会把一次
                // 合法的 AC/WA 变成「引擎错误」。
                close(inFd); inOpen = 0;
            } else {
                for (;;) {
                    ssize_t w = write(inFd, input + off, inputLen - off);
                    if (w > 0) {
                        off += (size_t)w;
                        if (off >= inputLen) { close(inFd); inOpen = 0; break; }
                        continue;
                    }
                    int saved = errno;    // 紧跟 write：下面的判断不能用被改写的 errno
                    if (saved == EINTR) continue;
                    // 管道满不是错误：结束本轮，等下一次 POLLOUT 再接着写。
                    // 把它当成失败关掉 stdin，子进程就会收到一个被截断的输入，
                    // 然后「正常」算出一个错答案 —— 最难发现的一类假 WA。
                    if (saved == EAGAIN || saved == EWOULDBLOCK) break;
                    // EPIPE：子进程不再读输入，它真正的结局由收割来说话
                    if (saved == EPIPE) { close(inFd); inOpen = 0; break; }
                    close(inFd); inOpen = 0; writeErr = 1; break;
                }
            }
        }
        if (iOut >= 0 && (pfds[iOut].revents & (POLLIN | POLLHUP | POLLERR))) drainReadable(outFd, ob, &outOpen);
        if (iErr >= 0 && (pfds[iErr].revents & (POLLIN | POLLHUP | POLLERR))) drainReadable(errFd, eb, &errOpen);
    }
    if (inOpen) close(inFd);
    if (ret) return ret;
    return writeErr ? -2 : 0;
}

static int runOne(const char* path, const char* input, size_t inputLen,
                   int64_t timeoutMs, char** out, size_t* outLen, int* truncated,
                   char** errOut, size_t* errLen, int* errTruncated, int* signalOut) {
    *out = NULL; *outLen = 0;
    if (errOut) { *errOut = NULL; *errLen = 0; }
    if (truncated) *truncated = 0;
    if (errTruncated) *errTruncated = 0;
    if (signalOut) *signalOut = 0;
    int inPipe[2] = {-1, -1}, outPipe[2] = {-1, -1}, errPipe[2] = {-1, -1};
    if (pipe2(inPipe, O_CLOEXEC) != 0 || pipe2(outPipe, O_CLOEXEC) != 0 || pipe2(errPipe, O_CLOEXEC) != 0) {
        closePair(inPipe); closePair(outPipe); closePair(errPipe);
        return -2;
    }

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP);
    posix_spawnattr_setpgroup(&attributes, 0);
    posix_spawn_file_actions_adddup2(&actions, inPipe[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO);

    pid_t pid = -1;
    char* argvChild[] = { (char*)path, NULL };
    extern char** environ;
    int rc = posix_spawn(&pid, path, &actions, &attributes, argvChild, environ);
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attributes);
    if (rc != 0) {
        closePair(inPipe); closePair(outPipe); closePair(errPipe);
        return -2;
    }

    close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);
    // timeoutMs <= 0 表示「不限时」，与 main.js run-program 的 useTimeouts 语义一致：
    //   const useTimeouts = Number.isFinite(effectiveTimeLimit) && effectiveTimeLimit > 0;
    // 原先直接 nowMs() + timeoutMs，0 会让 deadlineMs == nowMs()，pump 首次进入
    // 截止时间检查就立刻 SIGKILL，std/test 双双判超时 —— 清零时限想跑无限制对拍时
    // 每一组都 TLE，而回退到 child_process 路径又正常，两套引擎行为分裂。
    // 这里把不限时映射为 INT64_MAX：poll 仍按 200ms 一段走，只是不再有整体截止时间。
    // 不能用有限大数替代，长时间对拍仍会误杀。
    int64_t deadlineMs = (timeoutMs > 0) ? (nowMs() + timeoutMs) : NO_DEADLINE;
    // 三个 fd 都要非阻塞：pump 是「一次 poll，然后把每个就绪 fd 抽干到 EAGAIN」，
    // 少设一个就会在抽干的那一步卡住整个线程 —— 输出 fd 尤其容易漏，历史上
    // 漏掉的后果是「先写完 stdin 再收输出」那种两段式写法，它本身就会死锁。
    fcntl(inPipe[1], F_SETFL, fcntl(inPipe[1], F_GETFL, 0) | O_NONBLOCK);
    fcntl(outPipe[0], F_SETFL, fcntl(outPipe[0], F_GETFL, 0) | O_NONBLOCK);
    fcntl(errPipe[0], F_SETFL, fcntl(errPipe[0], F_GETFL, 0) | O_NONBLOCK);
    // 管道默认 64KB。3.5MB 的生成数据要 54 次 EAGAIN+poll 往返才能喂完，每一
    // 次往返都是一次「子进程还没来得及读」的窗口 —— 上面那个误杀就是在这里
    // 被触发的。加大容量同时减少往返和暴露面；非 Linux 或权限不足时静默跳过，
    // 容量只是优化项，不是正确性前提。
#if defined(__linux__) && defined(F_SETPIPE_SZ)
    fcntl(inPipe[1], F_SETPIPE_SZ, 1024 * 1024);
    fcntl(outPipe[0], F_SETPIPE_SZ, 1024 * 1024);
#endif

    // inPipe[1] 由 pump 负责关闭（所有分支恰好关一次），这里不能再 close
    DrainBuf ob = { NULL, 0, 0, MAX_OUTPUT, 0 };
    DrainBuf eb = { NULL, 0, 0, MAX_STDERR, 0 };
    int ioRc = pump(inPipe[1], input, inputLen, outPipe[0], errPipe[0], deadlineMs, pid, &ob, &eb);

    int code;
    if (ioRc != 0) {
        // ioRc == -3 时 pump 已经 kill 过子进程。结论必须直接照抄 ioRc，
        // 绝不能再从收割状态反推 —— 128+9 = 137 就是这样来的。
        code = ioRc;
        reapQuietly(pid);
    } else {
        int status = 0;
        pid_t w;
        for (;;) {
            w = waitpid(pid, &status, WNOHANG);
            if (w >= 0 || errno != EINTR) break;
        }
        if (w == pid) {
            if (WIFSIGNALED(status)) {
                if (signalOut) *signalOut = WTERMSIG(status);
                code = 128 + WTERMSIG(status);
            } else {
                code = WEXITSTATUS(status);
            }
        } else if (w == 0) {
            code = waitpidTimed(pid, deadlineMs);
        } else {
            code = -2;
        }
    }

    close(outPipe[0]); close(errPipe[0]);
    *out = ob.buf; *outLen = ob.len;
    // truncated 只取 stdout：它是「被测程序的输出超限」这个判定的依据，
    // 混进 stderr 会让一个正常退出但喷了 70MB 日志的程序被误判 output_limit。
    if (truncated) *truncated = ob.drop ? 1 : 0;
    // stderr 原先在这里被直接 free 掉 —— 于是原生路径永远看不到它，RE 只能报
    // 一个「exit 139」而无从展示崩溃栈。所有权现在交给调用方。
    if (errOut) { *errOut = eb.buf; *errLen = eb.len; }
    else if (eb.buf) free(eb.buf);
    if (errTruncated) *errTruncated = eb.drop ? 1 : 0;
    return code;
}

struct RunPairArg {
    const char* path;
    const char* input;
    size_t inputLen;
    int64_t timeoutMs;
    int code;
    char* out;
    size_t outLen;
    int truncated;
    char* err;
    size_t errLen;
    int errTruncated;
    int signal;
};

static void* runPairThread(void* arg) {
    RunPairArg* a = (RunPairArg*)arg;
    a->code = runOne(a->path, a->input, a->inputLen, a->timeoutMs,
                     &a->out, &a->outLen, &a->truncated,
                     &a->err, &a->errLen, &a->errTruncated, &a->signal);
    return NULL;
}

// 在原地做与 JS normalizeOutput 完全等价的归一化，返回归一化后的长度。
// 归一化只会删字节（CRLF→LF、行尾空白、结尾空行），写游标恒不超过读游标，
// 所以不需要第二块缓冲 —— 在 MAX_OUTPUT 量级上这省掉一整份拷贝。
//
// 逐行处理，与 JS 的 replace(/\\r\\n/g) + split/map/join + replace(/\\n+$/g)
// 一一对应。三个容易写错的地方：
//   1. '\\r' 只在「紧挨着行尾 '\\n' 的那个 '\\r'」时才丢。末行没有换行时末尾的
//      '\\r' 是内容本身，JS 的 /\\r\\n/g 不会碰它 —— 靠 terminated 标志区分。
//   2. 行尾删的是 [ \\t]，不含 '\\r'（"a\\r\\r\\n" 归一化成 "a\\r" 而不是 "a"）。
//   3. 前导与中间的空行必须保留，只有结尾的连续换行整体删掉。
// 顺带记录是否存在 >= 0x80 的字节，判等要用（见 compareNormalized）。
static size_t normalizeInPlace(char* buf, size_t len, int* anyHigh) {
    size_t r = 0, w = 0;
    int first = 1;
    int high = 0;
    for (;;) {
        size_t nl = r;
        while (nl < len && buf[nl] != '\n') {
            if ((unsigned char)buf[nl] >= 0x80) high = 1;
            nl++;
        }
        int terminated = (nl < len);
        size_t end = nl;
        size_t s = r;
        if (terminated && end > s && buf[end - 1] == '\r') end--;
        while (end > s && (buf[end - 1] == ' ' || buf[end - 1] == '\t')) end--;
        if (!first) buf[w++] = '\n';
        first = 0;
        while (s < end) buf[w++] = buf[s++];
        if (!terminated) break;
        r = nl + 1;
    }
    while (w > 0 && buf[w - 1] == '\n') w--;
    if (anyHigh) *anyHigh = high;
    return w;
}

// 判等结论：1 = 相等，0 = 不等，-1 = 本层不裁，交回 JS 终裁。
//
// 纯 ASCII 时 UTF-8 解码是单射，「字节相等」与 JS 的「字符串相等」完全等价，
// 所以 memcmp 可以认证两侧。但 normalizeOutput 是先 .toString('utf8') 再比的，
// 无效字节序列会各自塌成一个 U+FFFD —— 于是存在「字节不同而解码相同」的输出，
// C 层直接判不等就会把 AC 报成 WA。对拍器最坏的失效模式正是无声的假 WA，
// 所以只要任一侧出现过 >= 0x80 的字节就不自己下结论，把两段交回 JS 用
// 现成的 outputsEqual 判定。真实评测数据是 ASCII，这条回退几乎不会触发。
static int compareNormalized(const char* o1, size_t l1, const char* o2, size_t l2,
                             int high1, int high2) {
    if (high1 || high2) return -1;
    if (l1 != l2) return 0;
    if (l1 == 0) return 1;
    return memcmp(o1, o2, l1) == 0 ? 1 : 0;
}

// 把一块 C 内存作为 Buffer 挂到对象属性上，然后立即 free —— napi_create_buffer_copy
// 自己拷了一份，不必等 GC。Run/RunPair 现在有 4 块这样的缓冲，统一走这里，
// 免得某一处漏了 free 而没人会去看。
static void setBufferProp(napi_env env, napi_value obj, const char* name, char* data, size_t len) {
    napi_value buf;
    void* copy = NULL;
    napi_create_buffer_copy(env, len, data, &copy, &buf);
    napi_set_named_property(env, obj, name, buf);
    if (data) free(data);
}

static napi_value Run(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }

    size_t pathLen = 0;
    napi_get_value_string_utf8(env, argv[0], NULL, 0, &pathLen);
    char* pathBuf = (char*)malloc(pathLen + 1);
    napi_get_value_string_utf8(env, argv[0], pathBuf, pathLen + 1, &pathLen);
    pathBuf[pathLen] = '\0';

    char* input = NULL;
    size_t inputLen = 0;
    if (argc > 1) {
        napi_valuetype t;
        napi_typeof(env, argv[1], &t);
        if (t == napi_string || t == napi_object) {
            void* data = NULL;
            if (napi_get_buffer_info(env, argv[1], &data, &inputLen) == napi_ok && data && inputLen > 0) input = (char*)data;
        }
    }

    int64_t timeoutMs = 10000;
    if (argc > 2) { int64_t v; if (napi_get_value_int64(env, argv[2], &v) == napi_ok) timeoutMs = v; }

    char* outBuf = NULL; size_t outLen = 0;
    char* errBuf = NULL; size_t errLen = 0;
    int truncated = 0, errTruncated = 0, sig = 0;
    int code = runOne(pathBuf, input, inputLen, timeoutMs, &outBuf, &outLen, &truncated,
                      &errBuf, &errLen, &errTruncated, &sig);
    free(pathBuf);

    napi_value result, rCode, rTrunc, rErrTrunc, rSig;
    napi_create_object(env, &result);
    napi_create_int64(env, code, &rCode);
    napi_set_named_property(env, result, "code", rCode);
    napi_get_boolean(env, truncated ? true : false, &rTrunc);
    napi_set_named_property(env, result, "truncated", rTrunc);
    napi_get_boolean(env, errTruncated ? true : false, &rErrTrunc);
    napi_set_named_property(env, result, "errTruncated", rErrTrunc);
    // signal 而非只给 128+signum：JS 侧要靠它区分「程序自己非零退出」(std_exit)
    // 和「被信号杀死」(std_error)，这两条走不同的 i18n 文案。
    napi_create_int64(env, sig, &rSig);
    napi_set_named_property(env, result, "signal", rSig);
    setBufferProp(env, result, "output", outBuf, outLen);
    setBufferProp(env, result, "stderr", errBuf, errLen);
    return result;
}

static napi_value RunPair(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value argv[5];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }

    size_t pathLen1 = 0;
    napi_get_value_string_utf8(env, argv[0], NULL, 0, &pathLen1);
    char* path1 = (char*)malloc(pathLen1 + 1);
    napi_get_value_string_utf8(env, argv[0], path1, pathLen1 + 1, &pathLen1);
    path1[pathLen1] = '\0';

    size_t pathLen2 = 0;
    napi_get_value_string_utf8(env, argv[1], NULL, 0, &pathLen2);
    char* path2 = (char*)malloc(pathLen2 + 1);
    napi_get_value_string_utf8(env, argv[1], path2, pathLen2 + 1, &pathLen2);
    path2[pathLen2] = '\0';

    char* input = NULL;
    size_t inputLen = 0;
    if (argc > 2) {
        napi_valuetype t;
        napi_typeof(env, argv[2], &t);
        if (t == napi_string || t == napi_object) {
            void* data = NULL;
            if (napi_get_buffer_info(env, argv[2], &data, &inputLen) == napi_ok && data && inputLen > 0) input = (char*)data;
        }
    }

    int64_t timeoutMs = 10000;
    if (argc > 3) { int64_t v; if (napi_get_value_int64(env, argv[3], &v) == napi_ok) timeoutMs = v; }

    // compare 为真时在本层直接判等，只回结论：MB 级输出交给 JS 比要先
    // toString + split/map/join，实测每组 67-292ms，而同尺寸 memcmp 不到 1ms。
    int compare = 0;
    if (argc > 4) { bool b = false; if (napi_get_value_bool(env, argv[4], &b) == napi_ok) compare = b ? 1 : 0; }

    RunPairArg arg1 = { path1, input, inputLen, timeoutMs, 0, NULL, 0, 0, NULL, 0, 0, 0 };
    RunPairArg arg2 = { path2, input, inputLen, timeoutMs, 0, NULL, 0, 0, NULL, 0, 0, 0 };

    pthread_t t1, t2;
    int p1 = pthread_create(&t1, NULL, runPairThread, &arg1);
    int p2 = pthread_create(&t2, NULL, runPairThread, &arg2);

    if (p1 != 0 || p2 != 0) {
        if (p1 == 0) pthread_join(t1, NULL);
        if (p2 == 0) pthread_join(t2, NULL);
        // 线程建不出来就退化成串行，但必须走同一个 runOne —— 少传一个出参
        // 就会让 stderr/signal 停在未初始化状态。
        if (p1 != 0) {
            arg1.code = runOne(path1, input, inputLen, timeoutMs, &arg1.out, &arg1.outLen,
                               &arg1.truncated, &arg1.err, &arg1.errLen, &arg1.errTruncated, &arg1.signal);
        }
        if (p2 != 0) {
            arg2.code = runOne(path2, input, inputLen, timeoutMs, &arg2.out, &arg2.outLen,
                               &arg2.truncated, &arg2.err, &arg2.errLen, &arg2.errTruncated, &arg2.signal);
        }
    } else {
        // join 之后才能读两个线程写的缓冲，这是本函数唯一的同步点。
        // pthread 内严禁碰 napi，所以判等也必须等 join 完再做。
        pthread_join(t1, NULL);
        pthread_join(t2, NULL);
    }

    free(path1); free(path2);

    // 输出超限优先于判等：残缺的输出比出「相等」是假的 AC，比出「不等」是假的 WA，
    // 两种都不能信，交回 JS 报 output_limit。此时也不做归一化。
    int verdict = 0;
    if (compare) {
        if (arg1.truncated || arg2.truncated) {
            verdict = -1;
        } else {
            int high1 = 0, high2 = 0;
            size_t n1 = normalizeInPlace(arg1.out, arg1.outLen, &high1);
            size_t n2 = normalizeInPlace(arg2.out, arg2.outLen, &high2);
            arg1.outLen = n1;
            arg2.outLen = n2;
            verdict = compareNormalized(arg1.out, n1, arg2.out, n2, high1, high2);
        }
    }

    napi_value result;
    napi_create_object(env, &result);

    napi_value r;
    napi_create_int64(env, arg1.code, &r);
    napi_set_named_property(env, result, "code1", r);
    napi_create_int64(env, arg2.code, &r);
    napi_set_named_property(env, result, "code2", r);

    napi_value rTrunc, rSig1, rSig2;
    // truncated 现在只反映 stdout（见 runOne），一个大 stderr 不再触发 output_limit。
    napi_get_boolean(env, (arg1.truncated || arg2.truncated) ? true : false, &rTrunc);
    napi_set_named_property(env, result, "truncated", rTrunc);
    napi_create_int64(env, arg1.signal, &rSig1);
    napi_set_named_property(env, result, "signal1", rSig1);
    napi_create_int64(env, arg2.signal, &rSig2);
    napi_set_named_property(env, result, "signal2", rSig2);

    if (compare) {
        napi_value rVerdict;
        napi_create_int64(env, verdict, &rVerdict);
        napi_set_named_property(env, result, "normEqual", rVerdict);
    }

    setBufferProp(env, result, "stderr1", arg1.err, arg1.errLen);
    setBufferProp(env, result, "stderr2", arg2.err, arg2.errLen);

    if (compare && verdict == 1) {
        // 相等：两组大输出没有任何消费方（progress 消息不带它们），直接释放，
        // 省掉 2×MB 的跨边界拷贝 —— 这是最常见的一条路径。
        if (arg1.out) free(arg1.out);
        if (arg2.out) free(arg2.out);
        napi_value empty;
        void* dummy = NULL;
        napi_create_buffer_copy(env, 0, NULL, &dummy, &empty);
        napi_set_named_property(env, result, "out1", empty);
        napi_set_named_property(env, result, "out2", empty);
    } else {
        // 不等或不裁：把两段原文交给 JS，diff 视图与 captureText 的截断标记
        // 都按原样工作，不新增出参形状。
        setBufferProp(env, result, "out1", arg1.out, arg1.outLen);
        setBufferProp(env, result, "out2", arg2.out, arg2.outLen);
    }
    return result;
}

static napi_value Spawn(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }
    size_t pathLen = 0;
    napi_get_value_string_utf8(env, argv[0], NULL, 0, &pathLen);
    char* pathBuf = (char*)malloc(pathLen + 1);
    napi_get_value_string_utf8(env, argv[0], pathBuf, pathLen + 1, &pathLen);
    pathBuf[pathLen] = '\0';
    int inPipe[2] = {-1, -1}, outPipe[2] = {-1, -1}, errPipe[2] = {-1, -1};
    if (pipe2(inPipe, O_CLOEXEC) != 0 || pipe2(outPipe, O_CLOEXEC) != 0 || pipe2(errPipe, O_CLOEXEC) != 0) {
        closePair(inPipe); closePair(outPipe); closePair(errPipe);
        napi_throw_error(env, NULL, "pipe2"); free(pathBuf); return NULL;
    }
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, inPipe[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO);
    pid_t pid = -1;
    char* argvChild[] = { pathBuf, NULL };
    extern char** environ;
    int rc = posix_spawn(&pid, pathBuf, &actions, NULL, argvChild, environ);
    posix_spawn_file_actions_destroy(&actions);
    free(pathBuf);
    if (rc != 0) {
        close(inPipe[0]); close(inPipe[1]);
        close(outPipe[0]); close(outPipe[1]);
        close(errPipe[0]); close(errPipe[1]);
        napi_throw_error(env, NULL, strerror(rc));
        return NULL;
    }
    close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);
    napi_value result, v;
    napi_create_object(env, &result);
    napi_create_int64(env, pid, &v); napi_set_named_property(env, result, "pid", v);
    napi_create_int32(env, inPipe[1], &v); napi_set_named_property(env, result, "stdinFd", v);
    napi_create_int32(env, outPipe[0], &v); napi_set_named_property(env, result, "stdoutFd", v);
    napi_create_int32(env, errPipe[0], &v); napi_set_named_property(env, result, "stderrFd", v);
    return result;
}

static napi_value Waitpid(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }
    int64_t pid = 0;
    napi_get_value_int64(env, argv[0], &pid);
    int status = 0;
    pid_t w = waitpid((pid_t)pid, &status, WNOHANG);
    if (w == pid) {
        int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        napi_value r; napi_create_int32(env, code, &r); return r;
    }
    napi_value r; napi_create_int32(env, -1, &r); return r;
}

static napi_value WaitpidBlocking(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }
    int64_t pid = 0;
    napi_get_value_int64(env, argv[0], &pid);
    int64_t timeoutMs = 10000;
    if (argc > 1) { int64_t v; if (napi_get_value_int64(env, argv[1], &v) == napi_ok) timeoutMs = v; }
    int code = waitpidTimed((pid_t)pid, nowMs() + timeoutMs);
    napi_value r; napi_create_int32(env, code, &r); return r;
}

// 测试专用：把两段输出喂进与 runPair 判等**完全相同**的那条路径（同一个
// normalizeInPlace + compareNormalized），返回结论与归一化结果。
// 差分测试拿它跟 JS 的 normalizeOutput 逐条对拍 —— 这是挡在「C 少写一个条件
// 就变成大规模假 WA」前面的唯一一道闸，所以必须复用真实实现而不是另写一份。
static napi_value NormalizeCompare(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) { napi_throw_error(env, NULL, "cb_info"); return NULL; }

    char* bufs[2] = { NULL, NULL };
    size_t lens[2] = { 0, 0 };
    int highs[2] = { 0, 0 };
    for (int i = 0; i < 2; i++) {
        void* data = NULL;
        size_t len = 0;
        if (napi_get_buffer_info(env, argv[i], &data, &len) == napi_ok && data && len > 0) {
            bufs[i] = (char*)malloc(len);
            if (!bufs[i]) {
                if (bufs[0]) free(bufs[0]);
                napi_throw_error(env, NULL, "oom");
                return NULL;
            }
            memcpy(bufs[i], data, len);
            lens[i] = len;
        }
    }

    size_t n1 = normalizeInPlace(bufs[0], lens[0], &highs[0]);
    size_t n2 = normalizeInPlace(bufs[1], lens[1], &highs[1]);
    int verdict = compareNormalized(bufs[0], n1, bufs[1], n2, highs[0], highs[1]);

    napi_value result, rv;
    napi_create_object(env, &result);
    napi_create_int64(env, verdict, &rv);
    napi_set_named_property(env, result, "verdict", rv);
    // 归一化结果要先拷出来，下面就把源缓冲 free 了
    setBufferProp(env, result, "a", bufs[0], n1);
    setBufferProp(env, result, "b", bufs[1], n2);
    napi_value h1, h2;
    napi_get_boolean(env, highs[0] ? true : false, &h1);
    napi_get_boolean(env, highs[1] ? true : false, &h2);
    napi_set_named_property(env, result, "high1", h1);
    napi_set_named_property(env, result, "high2", h2);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    signal(SIGPIPE, SIG_IGN);
    napi_property_descriptor descs[6] = {
        { "run", NULL, Run, NULL, NULL, NULL, napi_default, NULL },
        { "runPair", NULL, RunPair, NULL, NULL, NULL, napi_default, NULL },
        { "spawn", NULL, Spawn, NULL, NULL, NULL, napi_default, NULL },
        { "waitpid", NULL, Waitpid, NULL, NULL, NULL, napi_default, NULL },
        { "waitpidBlocking", NULL, WaitpidBlocking, NULL, NULL, NULL, napi_default, NULL },
        { "normalizeCompare", NULL, NormalizeCompare, NULL, NULL, NULL, napi_default, NULL }
    };
    napi_define_properties(env, exports, 6, descs);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
