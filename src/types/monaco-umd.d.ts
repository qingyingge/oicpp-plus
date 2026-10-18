// monaco-editor 的 ESM 类型入口（esm/vs/index.d.ts）只出模块导出，不带全局别名；
// 而渲染层是 <script> 形态、不能 import，运行时用的是 AMD loader 注入的全局 monaco。
// 这里把整个模块挂成 UMD 全局命名空间，脚本文件才能同时取到 monaco 的值和它的类型。
export * from 'monaco-editor';
export as namespace monaco;
