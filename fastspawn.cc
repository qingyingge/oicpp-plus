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
#include <errno.h>
#include <time.h>
#include <pthread.h>
#include <signal.h>

#define MAX_OUTPUT (64 * 1024 * 1024)

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
    int drop;
};

static void drainAppend(DrainBuf* b, const char* data, size_t n) {
    if (b->drop) return;
    if (b->len + n > b->cap) {
        size_t ncap = b->cap ? b->cap : 8192;
        while (ncap < b->len + n) {
            if (ncap >= MAX_OUTPUT) { b->drop = 1; break; }
            ncap *= 2;
        }
        if (!b->drop) {
            char* nb = (char*)realloc(b->buf, ncap);
            if (!nb) { b->drop = 1; return; }
            b->buf = nb;
            b->cap = ncap;
        }
        if (b->drop) return;
    }
    memcpy(b->buf + b->len, data, n);
    b->len += n;
}

// Drain stdout and stderr concurrently via poll(), bounded by deadlineMs.
// Returns 0 when both pipes reach EOF, -3 on timeout (child killed & reaped).
static int drainBoth(int outFd, int errFd, int64_t deadlineMs, pid_t pid,
                     char** out, size_t* outLen, char** errOut, size_t* errLen) {
    DrainBuf ob = { NULL, 0, 0, 0 }, eb = { NULL, 0, 0, 0 };
    int outOpen = 1, errOpen = 1;
    for (;;) {
        if (!outOpen && !errOpen) break;
        struct pollfd pfds[2];
        int n = 0;
        if (outOpen) { pfds[n].fd = outFd; pfds[n].events = POLLIN; pfds[n].revents = 0; n++; }
        if (errOpen) { pfds[n].fd = errFd; pfds[n].events = POLLIN; pfds[n].revents = 0; n++; }
        int64_t remain = deadlineMs - nowMs();
        if (remain <= 0) {
            kill(pid, SIGKILL);
            int status = 0;
            for (;;) {
                pid_t w2 = waitpid(pid, &status, 0);
                if (w2 == pid) break;
                if (w2 < 0 && errno == EINTR) continue;
                break;
            }
            *out = ob.buf; *outLen = ob.len;
            if (errOut) { *errOut = eb.buf; *errLen = eb.len; }
            else if (eb.buf) free(eb.buf);
            return -3;
        }
        int to = (remain > 500) ? 500 : (int)remain;
        int pr = poll(pfds, n, to);
        if (pr < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (pr == 0) continue;
        for (int i = 0; i < n; i++) {
            if (!(pfds[i].revents & (POLLIN | POLLHUP | POLLERR))) continue;
            int fd = pfds[i].fd;
            DrainBuf* b = (fd == outFd) ? &ob : &eb;
            int* open = (fd == outFd) ? &outOpen : &errOpen;
            char chunk[65536];
            ssize_t r;
            do {
                r = read(fd, chunk, sizeof(chunk));
            } while (r < 0 && errno == EINTR);
            if (r > 0) drainAppend(b, chunk, (size_t)r);
            else *open = 0;   // EOF or read error: stop polling this fd
        }
    }
    *out = ob.buf; *outLen = ob.len;
    if (errOut) { *errOut = eb.buf; *errLen = eb.len; }
    else if (eb.buf) free(eb.buf);
    return 0;
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
            kill(pid, SIGKILL);
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

static int runOne(const char* path, const char* input, size_t inputLen,
                   int64_t timeoutMs, char** out, size_t* outLen) {
    *out = NULL; *outLen = 0;
    int inPipe[2] = {-1, -1}, outPipe[2] = {-1, -1}, errPipe[2] = {-1, -1};
    if (pipe2(inPipe, O_CLOEXEC) != 0 || pipe2(outPipe, O_CLOEXEC) != 0 || pipe2(errPipe, O_CLOEXEC) != 0) {
        closePair(inPipe); closePair(outPipe); closePair(errPipe);
        return -2;
    }

    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, inPipe[0], STDIN_FILENO);
    posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO);
    posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO);

    pid_t pid = -1;
    char* argvChild[] = { (char*)path, NULL };
    extern char** environ;
    int rc = posix_spawn(&pid, path, &actions, NULL, argvChild, environ);
    posix_spawn_file_actions_destroy(&actions);
    if (rc != 0) {
        closePair(inPipe); closePair(outPipe); closePair(errPipe);
        return -2;
    }

    close(inPipe[0]); close(outPipe[1]); close(errPipe[1]);

    if (input && inputLen > 0) {
        size_t off = 0;
        while (off < inputLen) {
            ssize_t w = write(inPipe[1], input + off, inputLen - off);
            if (w > 0) { off += (size_t)w; continue; }
            if (errno == EINTR) continue;
            break;   // EPIPE (child exited) or error
        }
    }
    close(inPipe[1]);

    int64_t deadlineMs = nowMs() + timeoutMs;

    char* outBuf = NULL; size_t outLen_ = 0;
    char* errBuf = NULL; size_t errLen = 0;
    int code;
    if (drainBoth(outPipe[0], errPipe[0], deadlineMs, pid, &outBuf, &outLen_, &errBuf, &errLen) == -3) {
        code = -3;
    } else {
        int status = 0;
        pid_t w;
        for (;;) {
            w = waitpid(pid, &status, WNOHANG);
            if (w >= 0 || errno != EINTR) break;
        }
        if (w == pid) {
            code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        } else if (w == 0) {
            code = waitpidTimed(pid, deadlineMs);
        } else {
            code = -2;
        }
    }

    close(outPipe[0]); close(errPipe[0]);
    if (errBuf) free(errBuf);
    *out = outBuf; *outLen = outLen_;
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
};

static void* runPairThread(void* arg) {
    RunPairArg* a = (RunPairArg*)arg;
    a->code = runOne(a->path, a->input, a->inputLen, a->timeoutMs, &a->out, &a->outLen);
    return NULL;
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
    int code = runOne(pathBuf, input, inputLen, timeoutMs, &outBuf, &outLen);
    free(pathBuf);

    napi_value result, rCode, rOut;
    napi_create_object(env, &result);
    napi_create_int64(env, code, &rCode);
    napi_set_named_property(env, result, "code", rCode);
    void* bufData = NULL;
    napi_create_buffer_copy(env, outLen, outBuf, &bufData, &rOut);
    napi_set_named_property(env, result, "output", rOut);
    if (outBuf) free(outBuf);
    return result;
}

static napi_value RunPair(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
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

    RunPairArg arg1 = { path1, input, inputLen, timeoutMs, 0, NULL, 0 };
    RunPairArg arg2 = { path2, input, inputLen, timeoutMs, 0, NULL, 0 };

    pthread_t t1, t2;
    int p1 = pthread_create(&t1, NULL, runPairThread, &arg1);
    int p2 = pthread_create(&t2, NULL, runPairThread, &arg2);

    if (p1 != 0 || p2 != 0) {
        if (p1 == 0) pthread_join(t1, NULL);
        if (p2 == 0) pthread_join(t2, NULL);
        if (p1 != 0) { arg1.code = runOne(path1, input, inputLen, timeoutMs, &arg1.out, &arg1.outLen); }
        if (p2 != 0) { arg2.code = runOne(path2, input, inputLen, timeoutMs, &arg2.out, &arg2.outLen); }
    } else {
        pthread_join(t1, NULL);
        pthread_join(t2, NULL);
    }

    free(path1); free(path2);

    napi_value result;
    napi_create_object(env, &result);

    napi_value r;
    napi_create_int64(env, arg1.code, &r);
    napi_set_named_property(env, result, "code1", r);
    napi_create_int64(env, arg2.code, &r);
    napi_set_named_property(env, result, "code2", r);

    void* bufData1 = NULL;
    napi_create_buffer_copy(env, arg1.outLen, arg1.out, &bufData1, &r);
    napi_set_named_property(env, result, "out1", r);

    void* bufData2 = NULL;
    napi_create_buffer_copy(env, arg2.outLen, arg2.out, &bufData2, &r);
    napi_set_named_property(env, result, "out2", r);

    if (arg1.out) free(arg1.out);
    if (arg2.out) free(arg2.out);
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

static napi_value Init(napi_env env, napi_value exports) {
    signal(SIGPIPE, SIG_IGN);
    napi_property_descriptor descs[5] = {
        { "run", NULL, Run, NULL, NULL, NULL, napi_default, NULL },
        { "runPair", NULL, RunPair, NULL, NULL, NULL, napi_default, NULL },
        { "spawn", NULL, Spawn, NULL, NULL, NULL, napi_default, NULL },
        { "waitpid", NULL, Waitpid, NULL, NULL, NULL, napi_default, NULL },
        { "waitpidBlocking", NULL, WaitpidBlocking, NULL, NULL, NULL, napi_default, NULL }
    };
    napi_define_properties(env, exports, 5, descs);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
