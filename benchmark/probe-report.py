import json, statistics as st, sys, collections, glob, os

# probe-report.py — 汇总带计时探针的 fallback worker 日志
#   用法: GLOB='/tmp/pb1_%s_*.jsonl' python3 benchmark/probe-report.py Sort Graph Range
GLOB = os.environ.get('GLOB', '/tmp/pb1_%s_*.jsonl')


def med(src, k):
    v = [r[k] for r in src if k in r]
    return st.median(v) if v else float('nan')


def f(v):
    return "%8.2f" % v


for sc in sys.argv[1:] or ['Sort', 'Graph', 'Range']:
    rows = []
    for fn in sorted(glob.glob(GLOB % sc)):
        rows += [json.loads(l) for l in open(fn)]
    if not rows:
        print('=== %s  无数据 (%s)' % (sc, GLOB % sc))
        continue
    ch = [r for r in rows if r.get('tag') == 'child']
    pr = [r for r in rows if r.get('tag') == 'pair']
    byexe = collections.defaultdict(list)
    for r in ch:
        byexe[os.path.basename(r.get('exe', '?'))].append(r)
    print('=== %s  pairs=%d children=%d  in=%dB' % (sc, len(pr), len(ch), med(pr, 'inBytes')))
    print('   pair=%s judge=%s gen=%s' % (f(med(pr, 'pairMs')), f(med(pr, 'judgeMs')), f(med(pr, 'genMs'))))
    for exe, rs in sorted(byexe.items()):
        print('   %-16s n=%-3d spawn=%s exit=%s close=%s cbOut=%s chunks=%s bytesOut=%s concat=%s concatB=%s writeCall=%s drains=%s stdinFin=%s gc=%s' % (
            exe, len(rs), f(med(rs, 'spawnMs')), f(med(rs, 'exitMs')), f(med(rs, 'closeMs')),
            f(med(rs, 'cbOutMs')), f(med(rs, 'chunksOut')), f(med(rs, 'bytesOut')),
            f(med(rs, 'concatOutMs')), f(med(rs, 'concatOutBytes')), f(med(rs, 'writeCallMs')),
            f(med(rs, 'drains')), f(med(rs, 'stdinFinishMs')), f(med(rs, 'gcMs'))))
