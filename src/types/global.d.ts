// 全局声明：主进程/渲染层/preload 通过 contextBridge 或 AMD loader 注入的全局。
// 路线甲阶段只做「名称可解析」，签名先用 any，A3 负责把 electronAPI 细化。

declare function logInfo(...args: any[]): void;
declare function logWarn(...args: any[]): void;
declare function logError(...args: any[]): void;
declare function logwarn(...args: any[]): void;
declare function logerror(...args: any[]): void;

// Monaco AMD loader 注入
declare const monaco: any;
declare function require(moduleName: string): any;

interface Window {
  logInfo: (...args: any[]) => void;
  logWarn: (...args: any[]) => void;
  logError: (...args: any[]) => void;
  logwarn: (...args: any[]) => void;
  logerror: (...args: any[]) => void;
  monaco: any;
  require: (moduleName: string) => any;
  i18n: any;
  electronAPI: any;
  electronIPC: any;
  electron: any;
  markdownAPI: any;
  turndownAPI: any;
  getElectronModule: () => any;
  __electronRequireAvailable: boolean;
  process: any;
}
