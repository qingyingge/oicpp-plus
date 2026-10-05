# TS Error Baseline (132) — 2026-10-05

`TS_ERROR_BASELINE = 132` in scripts/ci-check.js.

## Distribution by file

46	src/renderer/js/main.js
43	src/main.js
43	src/renderer/js/tabs.js

## Full list

```
  src/main.js(29,9): error TS2339: Property 'isCancelledError' does not exist on type 'typeof MultiThreadDownloader'.
  src/main.js(797,17): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(847,23): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(883,19): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(1118,23): error TS2339: Property 'lspCode' does not exist on type 'Error'.
  src/main.js(1390,27): error TS2554: Expected 0 arguments, but got 2.
  src/main.js(3065,97): error TS2339: Property 'compileAndRun' does not exist on type '{}'.
  src/main.js(3239,41): error TS2345: Argument of type '({ label: string; submenu: ({ label: string; accelerator: string; click: () => void; type?: undefined; } | { accelerator?: undefined; type: string; label?: undefined; click?: undefined; } | { accelerator?: undefined; type?: undefined; label: string; click: () => void; })[]; } | { ...; } | { ...; } | { ...; })[]' is not assignable to parameter of type '(MenuItem | MenuItemConstructorOptions)[]'.
  src/main.js(3412,24): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(3722,40): error TS2554: Expected 0 arguments, but got 1.
  src/main.js(5947,38): error TS2304: Cannot find name 'decodeBufferAuto'.
  src/main.js(6512,45): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(6563,21): error TS2304: Cannot find name 'updateProgress'.
  src/main.js(6911,45): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(6961,21): error TS2304: Cannot find name 'updateProgress'.
  src/main.js(7283,35): error TS2367: This comparison appears to be unintentional because the types '"utf16" | "utf8"' and '"gb2312"' have no overlap.
  src/main.js(8064,17): error TS2740: Type '{ compileAndRun: string; }' is missing the following properties from type '{ formatCode: string; showFunctionPicker: string; markdownPreview: string; renameSymbol: string; deleteLine: string; duplicateLine: string; moveLineUp: string; moveLineDown: string; copy: string; paste: string; cut: string; compileCode: string; runCode: string; compileAndRun: string; ... 7 more ...; runAllSamples: s...': formatCode, showFunctionPicker, markdownPreview, renameSymbol, and 17 more.
  src/main.js(8156,36): error TS2554: Expected 0 arguments, but got 1.
  src/main.js(8667,25): error TS2339: Property 'C_INCLUDE_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8670,25): error TS2339: Property 'CPLUS_INCLUDE_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8673,25): error TS2551: Property 'CPATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'. Did you mean 'PATH'?
  src/main.js(8676,25): error TS2339: Property 'LIBRARY_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8680,55): error TS2339: Property 'C_INCLUDE_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8681,59): error TS2339: Property 'CPLUS_INCLUDE_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8682,53): error TS2339: Property 'LIBRARY_PATH' does not exist on type '{ PATH: string; MINGW_PREFIX: string; }'.
  src/main.js(8872,37): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(8873,37): error TS2339: Property 'path' does not exist on type 'Error'.
  src/main.js(8874,38): error TS2339: Property 'errno' does not exist on type 'Error'.
  src/main.js(8875,37): error TS2339: Property 'syscall' does not exist on type 'Error'.
  src/main.js(8878,23): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(8880,30): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(8882,30): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(9081,70): error TS2339: Property 'code' does not exist on type 'Error'.
  src/main.js(9081,89): error TS2339: Property 'errno' does not exist on type 'Error'.
  src/main.js(9081,111): error TS2339: Property 'syscall' does not exist on type 'Error'.
  src/main.js(10751,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10752,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10772,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10773,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10793,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10794,53): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(10928,25): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/main.js(11119,44): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
  src/renderer/js/main.js(136,41): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(137,40): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(138,40): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(139,40): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(141,45): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(141,81): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(155,34): error TS2339: Property 'detail' does not exist on type 'Event'.
  src/renderer/js/main.js(155,49): error TS2339: Property 'detail' does not exist on type 'Event'.
  src/renderer/js/main.js(163,26): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(164,26): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(166,43): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(167,41): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(198,26): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(202,43): error TS2339: Property 'querySelector' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(210,27): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(379,23): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(380,25): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(381,24): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(386,23): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(387,25): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(388,24): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(435,5): error TS2393: Duplicate function implementation.
  src/renderer/js/main.js(444,31): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(1201,25): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(1202,30): error TS2339: Property 'offsetHeight' does not exist on type 'Element'.
  src/renderer/js/main.js(1203,25): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(1911,39): error TS2339: Property 'files' does not exist on type 'EventTarget'.
  src/renderer/js/main.js(1926,5): error TS2393: Duplicate function implementation.
  src/renderer/js/main.js(2719,21): error TS2810: Expected 1 argument, but got 0. 'new Promise()' needs a JSDoc hint to produce a 'resolve' that can be called without arguments.
  src/renderer/js/main.js(2814,18): error TS2339: Property 'editor' does not exist on type 'OICPPApp'.
  src/renderer/js/main.js(2829,26): error TS2339: Property 'disabled' does not exist on type 'HTMLElement'.
  src/renderer/js/main.js(3069,72): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(3093,32): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(3137,29): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(3650,33): error TS2339: Property 'src' does not exist on type 'Element'.
  src/renderer/js/main.js(3715,35): error TS2339: Property 'buildTag' does not exist on type '{ version: string; buildTime: any; author: string; }'.
  src/renderer/js/main.js(3715,57): error TS2339: Property 'buildVersion' does not exist on type '{ version: string; buildTime: any; author: string; }'.
  src/renderer/js/main.js(3715,83): error TS2339: Property 'buildNo' does not exist on type '{ version: string; buildTime: any; author: string; }'.
  src/renderer/js/main.js(3859,27): error TS2339: Property 'src' does not exist on type 'HTMLElement'.
  src/renderer/js/main.js(3871,25): error TS2339: Property 'src' does not exist on type 'HTMLElement'.
  src/renderer/js/main.js(4033,22): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(4045,26): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(4050,26): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(4055,26): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(4060,26): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/main.js(4466,28): error TS2362: The left-hand side of an arithmetic operation must be of type 'any', 'number', 'bigint' or an enum type.
  src/renderer/js/tabs.js(1,7): error TS2451: Cannot redeclare block-scoped variable 'TabManager'.
  src/renderer/js/tabs.js(74,35): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(77,25): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(87,24): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(90,28): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(1951,31): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(1952,42): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(1961,38): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(1968,44): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(1969,38): error TS2339: Property 'closest' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(2879,52): error TS2353: Object literal may only specify known properties, and 'filePath' does not exist in type '{ inline?: boolean; }'.
  src/renderer/js/tabs.js(2898,25): error TS2339: Property 'filePath' does not exist on type '{ inline?: boolean; }'.
  src/renderer/js/tabs.js(2898,35): error TS2339: Property 'tabId' does not exist on type '{ inline?: boolean; }'.
  src/renderer/js/tabs.js(2898,42): error TS2339: Property 'zoom' does not exist on type '{ inline?: boolean; }'.
  src/renderer/js/tabs.js(3469,26): error TS2741: Property 'url' is missing in type '{}' but required in type '{ url: string; groupId?: string; title?: string; }'.
  src/renderer/js/tabs.js(3835,82): error TS2339: Property 'pdfBase64' does not exist on type 'object'.
  src/renderer/js/tabs.js(3835,120): error TS2339: Property 'pdfBase64' does not exist on type 'object'.
  src/renderer/js/tabs.js(3836,37): error TS2339: Property 'pdfBase64' does not exist on type 'object'.
  src/renderer/js/tabs.js(3858,45): error TS2339: Property 'groupId' does not exist on type 'object'.
  src/renderer/js/tabs.js(3858,68): error TS2339: Property 'targetGroupId' does not exist on type 'object'.
  src/renderer/js/tabs.js(3872,102): error TS2339: Property 'viewType' does not exist on type 'object'.
  src/renderer/js/tabs.js(3873,38): error TS2339: Property 'viewType' does not exist on type 'object'.
  src/renderer/js/tabs.js(3884,97): error TS2339: Property 'isTempFile' does not exist on type 'object'.
  src/renderer/js/tabs.js(4131,50): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4131,85): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4137,28): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4139,27): error TS2339: Property 'dataset' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4169,27): error TS2339: Property 'classList' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(4768,24): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4804,24): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/tabs.js(4966,24): error TS2339: Property 'style' does not exist on type 'Element'.
  src/renderer/js/tabs.js(5083,36): error TS2339: Property 'files' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(5091,45): error TS2345: Argument of type 'string | ArrayBuffer' is not assignable to parameter of type 'string'.
  src/renderer/js/tabs.js(5110,36): error TS2339: Property 'files' does not exist on type 'EventTarget'.
  src/renderer/js/tabs.js(5118,45): error TS2345: Argument of type 'string | ArrayBuffer' is not assignable to parameter of type 'string'.
  src/renderer/js/tabs.js(5164,21): error TS2304: Cannot find name 'tabData'.
  src/renderer/js/tabs.js(5165,23): error TS2304: Cannot find name 'uniqueKey'.
  src/renderer/js/tabs.js(5168,35): error TS2304: Cannot find name 'tabData'.
  src/renderer/js/tabs.js(5168,55): error TS2304: Cannot find name 'uniqueKey'.
  src/renderer/js/tabs.js(5169,75): error TS2304: Cannot find name 'uniqueKey'.
  src/renderer/js/tabs.js(5171,29): error TS2304: Cannot find name 'uniqueKey'.
  src/renderer/js/tabs.js(5174,25): error TS2304: Cannot find name 'uniqueKey'.
  src/renderer/js/tabs.js(5551,24): error TS2339: Property 'style' does not exist on type 'Element'.
```
