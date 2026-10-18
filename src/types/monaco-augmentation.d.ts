// monaco-editor 模块增强：代码挂载的自定义属性（monaco 公共 API 之外）。
// 必须是模块文件（export {};）+ 指向声明模块（editor.api）+ 嵌套 namespace 作用域——
// IStandaloneCodeEditor/ITextModel 在 editor 命名空间内，ILink/CodeLens/InlayHint 在 languages 命名空间内；
// 顶层 interface 不合并（tsgo 实测），script d.ts 里的 declare module 会被整体替换（非合并）。
export {};

declare module 'monaco-editor/editor/editor.api' {
  namespace editor {
    interface ITextModel {
      __oicppFilePath?: string | null;
      __oicppLspUri?: string;
      __oicppLspCompletionFallbackUntil?: number;
    }
    interface IStandaloneCodeEditor {
      filePath?: string | null;
      fileName?: string;
      getFilePath?: () => string | null;
      onDidType?: (listener: (text: string) => void) => IDisposable;
      __markdownPreviewContextKey?: { set: (value: boolean) => void };
      // 自定义运行时属性
      highlightLine?: (line: number) => void;
      clearExecHighlight?: () => void;
      __breakpointDecos?: string[];
      __isDiffEditor?: boolean;
      getModifiedEditor?: () => IStandaloneCodeEditor;
      __diffMeta?: DiffEditorMeta;
      // 预处理器行装饰相关
      __unifiedPreprocessorEnabled?: boolean;
      __unifiedPreprocessorColor?: string;
      __preprocessorLineDecorations?: string[];
      __preprocessorColorListener?: IDisposable;
      // 选择守卫相关
      __selectionGuard?: { line: number; column: number; length: number };
      __cursorPositionListener?: IDisposable;
      __mouseDownListener?: IDisposable;
      __blurListener?: IDisposable;
      // Ctrl+Click 导航相关
      __ctrlClickNavigationListener?: IDisposable;
      // 键盘快捷键相关
      __enhancedCompletionRegistered?: boolean;
      // Markdown 预览同步（tabs.ts 挂载在编辑器实例上）
      _markdownLiveTimer?: ReturnType<typeof setTimeout> | null;
      _markdownPreviewSyncTimer?: ReturnType<typeof setTimeout> | null;
      _markdownListenerAttached?: boolean;
      _markdownPreviewSyncAttached?: boolean;
      // 字体缩放相关
      hasWheelZoomListener?: boolean;
      hasGlobalWheelZoomListener?: boolean;
    }
    interface IStandaloneDiffEditor {
      __isDiffEditor?: boolean;
      __diffMeta?: { originalPath?: string; modifiedPath?: string; label?: string };
      filePath?: string | null;
      fileName?: string;
      getValue?: () => string;
      setValue?: (val: string) => void;
      // Diff 编辑器特有属性
      modifiedModel?: editor.ITextModel;
      originalModel?: editor.ITextModel;
      getModifiedEditor?: () => IStandaloneCodeEditor;
      getOriginalEditor?: () => IStandaloneCodeEditor;
    }

    // Diff 编辑器创建选项
    interface CreateDiffEditorOptions {
      groupId?: string | null;
      targetGroupId?: string;
      originalPath?: string;
      modifiedPath?: string;
      label?: string | null;
      originalContent?: string;
      modifiedContent?: string;
      originalFileName?: string;
      modifiedFileName?: string;
      fontSize?: number;
      lineHeight?: number;
      fontFamily?: string;
      tabSize?: number;
      wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
      folding?: boolean;
      stickyScroll?: boolean;
      fontLigatures?: boolean;
      quickSuggestions?: boolean | monaco.editor.IQuickSuggestionsOptions;
      suggestOnTriggerCharacters?: boolean;
      wordBasedSuggestions?: 'off' | 'matchingDocuments' | 'matchingDocumentsAndGlobal';
      tabCompletion?: 'on' | 'off' | 'onlySnippets';
      acceptSuggestionOnEnter?: 'on' | 'smart' | 'off';
      parameterHints?: { enabled: boolean; cycle: boolean };
      formatterIndentStyle?: string;
      clangFormatRaw?: string;
      clangFormatStyle?: string;
      clangFormat?: string;
      clangFormatSettings?: Record<string, unknown>;
      skipLine?: boolean;
      skipTypedef?: boolean;
      baseDir?: string;
      filePath?: string;
      cacheKey?: string;
      useCache?: boolean;
      allowWorkspaceScan?: boolean;
      viewType?: string;
      isTempFile?: boolean;
      isPreviewTab?: boolean;
      sourceTabKey?: string;
      pdfBase64?: string;
      browserUrl?: string;
      diffMeta?: DiffEditorMeta;
      externalModified?: boolean;
      externalPromptInProgress?: boolean;
      externalPromptDismissed?: boolean;
      pendingExternalPrompt?: boolean;
      externalChangeType?: string;
      modified?: boolean;
      uniqueKey?: string;
      uniqueKeyOverride?: string;
      force?: boolean;
      skipCloseConfirm?: boolean;
      skipAutoSave?: boolean;
      previewContainer?: HTMLElement;
      viewerContainer?: HTMLElement;
      viewerFrame?: HTMLIFrameElement;
      tabId?: string;
      tabKey?: string;
      sourceGroupId?: string;
      tabElement?: HTMLElement;
      startX?: number;
      startY?: number;
      isDirty?: boolean;
      element?: HTMLElement;
      groupId?: string | null;
      content?: string;
      active?: boolean;
      externalChangeTimestamp?: number;
    }

    // Diff 元数据接口
    interface DiffEditorMeta {
      originalPath?: string;
      modifiedPath?: string;
      label?: string;
      originalFileName?: string;
      modifiedFileName?: string;
      originalContent?: string;
      modifiedContent?: string;
      groupId?: string;
      targetGroupId?: string;
      fontSize?: number;
      lineHeight?: number;
      fontFamily?: string;
      tabSize?: number;
      wordWrap?: 'off' | 'on' | 'wordWrapColumn' | 'bounded';
      folding?: boolean;
      stickyScroll?: boolean;
      fontLigatures?: boolean;
      quickSuggestions?: boolean | monaco.editor.IQuickSuggestionsOptions;
      suggestOnTriggerCharacters?: boolean;
      wordBasedSuggestions?: 'off' | 'matchingDocuments' | 'matchingDocumentsAndGlobal';
      tabCompletion?: 'on' | 'off' | 'onlySnippets';
      acceptSuggestionOnEnter?: 'on' | 'smart' | 'off';
      parameterHints?: { enabled: boolean; cycle: boolean };
      formatterIndentStyle?: string;
      clangFormatRaw?: string;
      clangFormatStyle?: string;
      clangFormat?: string;
      clangFormatSettings?: Record<string, unknown>;
      skipLine?: boolean;
      skipTypedef?: boolean;
      baseDir?: string;
      filePath?: string;
      cacheKey?: string;
      useCache?: boolean;
      allowWorkspaceScan?: boolean;
      viewType?: string;
      isTempFile?: boolean;
      isPreviewTab?: boolean;
      sourceTabKey?: string;
      pdfBase64?: string;
      browserUrl?: string;
      diffMeta?: DiffEditorMeta;
      externalModified?: boolean;
      viewType?: string;
      externalPromptInProgress?: boolean;
      externalPromptDismissed?: boolean;
      pendingExternalPrompt?: boolean;
      externalChangeType?: string;
      modified?: boolean;
      uniqueKey?: string;
      uniqueKeyOverride?: string;
      force?: boolean;
      skipCloseConfirm?: boolean;
      skipAutoSave?: boolean;
      previewContainer?: HTMLElement;
      viewerContainer?: HTMLElement;
      viewerFrame?: HTMLIFrameElement;
      tabId?: string;
      tabKey?: string;
      sourceGroupId?: string;
      tabElement?: HTMLElement;
      startX?: number;
      startY?: number;
      isDirty?: boolean;
      element?: HTMLElement;
      fileName?: string;
      groupId?: string;
      content?: string;
      active?: boolean;
      viewType?: string;
      isTempFile?: boolean;
      externalChangeTimestamp?: number;
    }
  }
  namespace languages {
    interface CompletionItem {
      __oicppLspItem?: unknown;
    }
    interface ILink {
      __oicppLspDocumentLink?: unknown;
    }
    interface CodeLens {
      __oicppLspCodeLens?: unknown;
    }
    class InlayHint {
      __oicppLspInlayHint?: unknown;
    }
    // AMD 运行时可能不存在的 API：代码用 typeof 守卫防御（registerWorkspaceSymbolProvider 在 0.57 chunks 中不存在）
    const registerWorkspaceSymbolProvider: ((provider: unknown) => IDisposable) | undefined;
  }
}
