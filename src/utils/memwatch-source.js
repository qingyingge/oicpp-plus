"use strict";
// memwatch.exe — attaches to an already-running process and reports its peak
// memory, enforcing an optional limit while it watches.
//
// Attached-by-PID instead of CreateProcess: the caller keeps owning stdio and
// process lifetime, so no stream relay is needed here. PeakWorkingSetSize is a
// kernel-maintained high-water mark, so the value reported at the end is exact
// from the moment we attach, no matter how the allocation was timed.
//
// usage: memwatch.exe <pid> <limitBytes>
// output (stdout): "<peakWorkingSet> <privateUsage> <exceeded> <ok>"
//                  or "attach-failed <win32ErrorCode>" when OpenProcess fails.
//
// Reference: Project_LemonLime/Project_LemonLime src/core/processrunner_win.cpp
// uses the same max(PrivateUsage, PeakWorkingSetSize) metric.
module.exports = String.raw `#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <psapi.h>

namespace {

const DWORD kPollIntervalMs = 10;

typedef BOOL (WINAPI* GetProcessMemoryInfoFn)(HANDLE, PPROCESS_MEMORY_COUNTERS, DWORD);

bool ReadCounters(HANDLE process, GetProcessMemoryInfoFn getProcessMemoryInfo,
    unsigned long long* outPeakWorkingSet, unsigned long long* outPrivateUsage)
{
    PROCESS_MEMORY_COUNTERS_EX counters;
    ZeroMemory(&counters, sizeof(counters));
    counters.cb = sizeof(counters);

    if (!getProcessMemoryInfo(process, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters)))
    {
        return false;
    }

    *outPeakWorkingSet = static_cast<unsigned long long>(counters.PeakWorkingSetSize);
    *outPrivateUsage = static_cast<unsigned long long>(counters.PrivateUsage);
    return true;
}

HMODULE LoadMemoryInfoModule()
{
    // Resolved dynamically for the same reason consolepauser does it: keeps the
    // helper buildable without an explicit psapi link dependency.
    HMODULE psapi = LoadLibraryA("psapi.dll");
    if (psapi) return psapi;
    return LoadLibraryA("kernel32.dll");
}

}

int main(int argc, char** argv)
{
    if (argc < 2)
    {
        fprintf(stderr, "usage: memwatch.exe <pid> <limitBytes>\n");
        return 2;
    }

    DWORD pid = static_cast<DWORD>(_strtoui64(argv[1], nullptr, 10));
    unsigned long long limitBytes = 0;
    if (argc >= 3)
    {
        limitBytes = _strtoui64(argv[2], nullptr, 10);
    }
    if (pid == 0)
    {
        fprintf(stdout, "attach-failed 0\n");
        fflush(stdout);
        return 3;
    }

    HMODULE module = LoadMemoryInfoModule();
    if (!module)
    {
        fprintf(stdout, "attach-failed %lu\n", static_cast<unsigned long>(GetLastError()));
        fflush(stdout);
        return 3;
    }

    GetProcessMemoryInfoFn getProcessMemoryInfo =
        reinterpret_cast<GetProcessMemoryInfoFn>(GetProcAddress(module, "GetProcessMemoryInfo"));
    if (!getProcessMemoryInfo)
    {
        getProcessMemoryInfo = reinterpret_cast<GetProcessMemoryInfoFn>(
            GetProcAddress(module, "K32GetProcessMemoryInfo"));
    }
    if (!getProcessMemoryInfo)
    {
        fprintf(stdout, "attach-failed 0\n");
        fflush(stdout);
        return 3;
    }

    HANDLE process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, pid);
    if (!process)
    {
        fprintf(stdout, "attach-failed %lu\n", static_cast<unsigned long>(GetLastError()));
        fflush(stdout);
        return 3;
    }

    unsigned long long peakWorkingSet = 0;
    unsigned long long privateUsage = 0;
    unsigned long long measured = 0;
    int exceeded = 0;
    int ok = 0;

    for (;;)
    {
        unsigned long long currentPeak = 0;
        unsigned long long currentPrivate = 0;
        if (ReadCounters(process, getProcessMemoryInfo, &currentPeak, &currentPrivate))
        {
            ok = 1;
            peakWorkingSet = currentPeak;
            privateUsage = currentPrivate;
            measured = currentPeak > currentPrivate ? currentPeak : currentPrivate;

            if (limitBytes > 0 && measured > limitBytes && !exceeded)
            {
                exceeded = 1;
                TerminateProcess(process, 1);
            }
        }

        if (WaitForSingleObject(process, kPollIntervalMs) == WAIT_OBJECT_0)
        {
            break;
        }
    }

    // The process object stays alive while we hold this handle, so one final
    // read still yields the true peak even though the process already exited.
    unsigned long long finalPeak = 0;
    unsigned long long finalPrivate = 0;
    if (ReadCounters(process, getProcessMemoryInfo, &finalPeak, &finalPrivate))
    {
        ok = 1;
        peakWorkingSet = finalPeak;
        privateUsage = finalPrivate;
    }

    printf("%llu %llu %d %d\n", peakWorkingSet, privateUsage, exceeded, ok);
    fflush(stdout);

    CloseHandle(process);
    FreeLibrary(module);
    return 0;
}
`;
