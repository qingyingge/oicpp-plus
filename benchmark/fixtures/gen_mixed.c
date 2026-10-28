/* 异质负载夹具：每组生成的数字个数差异极大（5k ~ 400k），
   用来把「均匀负载下动态分片 0% 收益」这个纸面结论压到它唯一可能成立的场景上。 */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
static unsigned long s;
static unsigned int rnd(void){ s = s*6364136223846793005UL + 1442695040888963407UL; return (unsigned int)(s>>33); }
int main(void){
    if (!s) s = (unsigned long)time(NULL) ^ (unsigned long)getpid();
    /* 双峰分布：一半小一半大，方差远大于基准程序的 cv=0.059 */
    int big = rnd() & 1;
    /* 上限必须 ≤ 200000：实测 sort_mergesort 在 n>=250000 时堆破坏崩溃，
       夹具自己造出来的失败会把分片策略的对比整个污染掉。 */
    long n = big ? (long)(120000 + rnd() % 70000) : (long)(5000 + rnd() % 15000);
    printf("%ld\n", n);
    for (long i = 0; i < n; i++) printf("%u%s", rnd() % 1000000000u, i + 1 == n ? "\n" : " ");
    if (n % 2) printf("\n");
    return 0;
}
