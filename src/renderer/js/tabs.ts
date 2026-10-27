declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;

interface TabRecord {
    element: HTMLElement;
    groupId?: string | null;
    fileName?: string | null;
    filePath?: string | null;
    tabId?: string | null;
    uniqueKey?: string | null;
    content?: string | null;
    modified?: boolean | null;
    active?: boolean | null;
    isTempFile?: boolean | null;
    isDirty?: boolean | null;
    isLoading?: boolean | null;
    isWelcome?: boolean | null;
    isPreviewTab?: boolean | null;
    viewType?: string | null;
    viewerContainer?: HTMLElement | null;
    viewerFrame?: HTMLIFrameElement | null;
    previewContainer?: HTMLElement | null;
    browserUrl?: string | null;
    pdfBase64?: string | null;
    diffMeta?: Record<string, unknown> | null;
    sourceTabKey?: string | null;
    pdfViewerReady?: boolean | null;
    pdfViewerError?: boolean | null;
    pdfViewerScale?: number | null;
    externalModified?: boolean | null;
    externalChangeType?: string | null;
    externalChangeTimestamp?: number | null;
    externalPromptDismissed?: boolean | null;
    externalPromptInProgress?: boolean | null;
    pendingExternalPrompt?: boolean | null;
    file?: string | null;
    [key: string]: unknown;
}

interface EditorGroup {
    id: string;
    element: HTMLElement;
    tabBar: HTMLElement | null;
    editorArea: HTMLElement | null;
    tabs: Map<string, TabRecord>;
    tabOrder: string[];
    activeTabKey?: string | null;
    size?: number | null;
    [key: string]: unknown;
}

interface TabDragInfo {
    tabKey?: string | null;
    sourceGroupId?: string | null;
    tabElement?: HTMLElement | null;
    startX?: number;
    startY?: number;
    uniqueKey?: string | null;
    groupId?: string | null;
}

interface TabDropInfo {
    tabBar?: HTMLElement | null;
    targetGroupId?: string | null;
    targetIndex?: number | null;
    beforeElement?: HTMLElement | null;
    groupId?: string | null;
    tabKey?: string | null;
    index?: number | null;
}

interface DropTargetArgs {
    tabBar?: HTMLElement | null;
    targetGroupId?: string | null;
    targetIndex?: number | null;
    beforeElement?: HTMLElement | null;
}

interface DropEntry {
    fileName?: string | null;
    filePath?: string | null;
    fileObject?: File | Blob | null;
    base64?: string | null;
}

interface PathLikeFile {
    name?: string;
    path?: string;
}

interface DroppedFileJson {
    type?: string;
    name?: string;
    path?: string;
    base64?: string;
    [key: string]: unknown;
}

interface FileLikeObject extends Blob {
    name?: string;
    path?: string;
}

interface PdfDropDescriptor {
    name?: string | null;
    path?: string | null;
    type?: string | null;
    base64?: string | null;
    lastModified?: number | null;
    file?: unknown;
    fileObject?: unknown;
    [key: string]: unknown;
}

interface PdfContainerOptions {
    groupId?: string | null;
    tabId?: string | null;
    filePath?: string | null;
    fileName?: string | null;
    inline?: boolean;
}

interface PdfViewerSrcOptions {
    filePath?: string | null;
    tabId?: string | null;
    zoom?: string | null;
    inline?: boolean;
}

interface PdfTabOptions {
    fileName?: string | null;
    filePath?: string | null;
    uniqueKey?: string | null;
    targetGroupId?: string | null;
    targetGroup: EditorGroup;
    isTempFile?: boolean;
    pdfBase64?: string | null;
}

interface PdfEventBusLike {
    dispatch: (...args: unknown[]) => void;
    [key: string]: unknown;
}

interface PdfViewerApplicationLike {
    eventBus: PdfEventBusLike;
    [key: string]: unknown;
}

interface BrowserTabOptions {
    url?: string | null;
    groupId?: string | null;
    title?: string | null;
}

interface MarkdownPreviewOptions {
    groupId?: string | null;
    tabId?: string | null;
    content?: string | null;
    filePath?: string | null;
}

interface PdfRequestDetail {
    requestId?: string | null;
    filePath?: string | null;
    [key: string]: unknown;
}

interface DiffFileCandidate {
    type?: string | null;
    path?: string | null;
    name?: string | null;
    [key: string]: unknown;
}

interface FileWatchEntry {
    filePath: string;
    path: string;
    watcher: { close: () => void };
    tabs: Set<string>;
    changeType?: string | null;
    timestamp?: number | null;
    lastChangeType?: string | null;
}

interface ExternalChangePayload {
    filePath?: string | null;
    content?: string | null;
    changeType?: string | null;
    timestamp?: number | null;
}

interface OpenFileOptions {
    filePath?: string | null;
    pdfBase64?: string | null;
    groupId?: string | null;
    targetGroupId?: string | null;
    viewType?: string | null;
    isTempFile?: boolean | null;
    [key: string]: unknown;
}

interface CloseTabOptions {
    uniqueKeyOverride?: string | null;
    force?: boolean;
    skipCloseConfirm?: boolean;
    skipAutoSave?: boolean;
}

interface EnsureActiveOptions {
    preferredUniqueKey?: string | null;
    triggerEditor?: boolean;
}

interface ReloadOptions {
    force?: boolean;
}

interface HTMLElement {
    _editorDnDBound?: boolean;
    _tabBarEventsBound?: boolean;
    _horizontalWheelHandlerBound?: boolean;
    _dragHandlersBound?: boolean;
    _tabEventsBound?: boolean;
    _pdfDnDBound?: boolean;
    _dragListenersBound?: boolean;
    _bound?: boolean;
}
interface Window {
    PDFViewerApplication?: PdfViewerApplicationLike;
}

class TabManager {
    tabs: Map<string, TabRecord>;
    groups: Map<string, EditorGroup>;
    groupOrder: string[];
    activeGroupId: string | null;
    activeTab: TabRecord | string | null;
    activeTabKey: string | null;
    tabOrder: string[];
    monacoEditorManager: MonacoEditorManager | null;
    editorGroupsElement: HTMLElement | null;
    welcomeContainer: HTMLElement | null;
    splitOverlay: HTMLElement | null;
    groupCounter: number;
    draggedTabInfo: TabDragInfo | null;
    draggedTab: HTMLElement | null;
    placeholder: HTMLElement | null;
    tabDragInProgress: boolean;
    lastTabDropInfo: TabDropInfo | null;
    dropHandled: boolean;
    _openingKeys: Set<string>;
    _watchedFiles: Map<string, FileWatchEntry>;
    _fileWatchListenerBound: boolean;
    _externalFileChangeUnsubscribe: (() => void) | null;
    _fileWatchCleanupBound: boolean;
    _tabContextMenu: HTMLElement | null;
    _altWheelListenerBound: boolean;
    _lastAltWheelSwitchTs: number;
    _beforeUnloadHandler: (() => void) | null;
    _isWindowsPlatform: boolean | undefined;
    _welcomeVersionLabel: string | null | undefined;

    constructor() {
        this.tabs = new Map<string, TabRecord>();
        this.groups = new Map<string, EditorGroup>();
        this.groupOrder = [];
        this.activeGroupId = null;
        this.activeTab = null;
        this.activeTabKey = null;
        this.tabOrder = [];
        this.monacoEditorManager = null;
        this.editorGroupsElement = null;
        this.welcomeContainer = null;
        this.splitOverlay = null;
        this.groupCounter = 1;
        this.draggedTabInfo = null;
        this.draggedTab = null;
        this.placeholder = null;
        this.tabDragInProgress = false;
        this.lastTabDropInfo = null;
        this.dropHandled = false;
        this._openingKeys = new Set();
        this._watchedFiles = new Map<string, FileWatchEntry>();
        this._fileWatchListenerBound = false;
        this._externalFileChangeUnsubscribe = null;
        this._fileWatchCleanupBound = false;
        this._tabContextMenu = null;
        this._altWheelListenerBound = false;
        this._lastAltWheelSwitchTs = 0;
        this._beforeUnloadHandler = null;

        if (typeof window !== 'undefined') {
            this.handlePdfViewerMessage = this.handlePdfViewerMessage.bind(this);
            window.addEventListener('message', this.handlePdfViewerMessage, false);
            this._beforeUnloadHandler = () => this.dispose();
            window.addEventListener('beforeunload', this._beforeUnloadHandler, { once: true });
        }

        this.init();
    }

    cacheDOM() {
        this.editorGroupsElement = document.getElementById('editor-groups');
        this.welcomeContainer = document.getElementById('welcome-container');
        if (!this.editorGroupsElement) {
            logError('TabManager: 未找到编辑器分组容器 #editor-groups');
        }
    }

    initializeGroups() {
        if (!this.editorGroupsElement) {
            this.cacheDOM();
        }

        const groupElements = Array.from(document.querySelectorAll('.editor-group') as NodeListOf<HTMLElement>);
        if (groupElements.length === 0 && this.editorGroupsElement) {
            const defaultGroup = document.createElement('div') as HTMLElement;
            defaultGroup.className = 'editor-group';
            defaultGroup.dataset['groupId'] = 'group-1';

            const tabBar = document.createElement('div') as HTMLElement;
            tabBar.className = 'tab-bar';
            tabBar.dataset['groupId'] = 'group-1';

            const editorArea = document.createElement('div') as HTMLElement;
            editorArea.className = 'editor-area';
            editorArea.dataset['groupId'] = 'group-1';

            defaultGroup.appendChild(tabBar);
            defaultGroup.appendChild(editorArea);
            this.editorGroupsElement.appendChild(defaultGroup);
            groupElements.push(defaultGroup);
        }

        groupElements.forEach((groupEl, index) => {
            let groupId = groupEl.dataset['groupId'];
            if (!groupId) {
                groupId = `group-${index + 1}`;
                groupEl.dataset['groupId'] = groupId;
            }
            const numericId = parseInt(groupId.replace(/[^0-9]/g, ''), 10);
            if (!Number.isNaN(numericId)) {
                this.groupCounter = Math.max(this.groupCounter, numericId);
            }

            const tabBar = groupEl.querySelector('.tab-bar') as HTMLElement | null;
            const editorArea = groupEl.querySelector('.editor-area') as HTMLElement | null;
            if (tabBar instanceof HTMLElement) {
                tabBar.dataset['groupId'] = groupId;
            }
            if (editorArea instanceof HTMLElement) {
                editorArea.dataset['groupId'] = groupId;
                this.bindEditorAreaDnD(editorArea);
            }

            const groupData: EditorGroup = {
                id: groupId,
                element: groupEl,
                tabBar,
                editorArea,
                tabs: new Map(),
                tabOrder: [],
                activeTabKey: null,
                size: 1,
            };

            this.groups.set(groupId, groupData);
            if (!this.groupOrder.includes(groupId)) {
                this.groupOrder.push(groupId);
            }

            if (tabBar) {
                this.bindTabBarEvents(tabBar);
            }
        });

        if (!this.activeGroupId && this.groupOrder.length > 0) {
            this.activeGroupId = this.groupOrder[0] as string | null;
        }

        this.ensureSplitOverlay();
        this.refreshGroupResizers();
    }

    bindEditorAreaDnD(editorArea: HTMLElement) {
        if (!editorArea || editorArea._editorDnDBound) return;
        const onDragOver = (e: DragEvent) => {
            try {
                e.preventDefault();
                e.stopPropagation();
                if (e.dataTransfer) {
                    e.dataTransfer.dropEffect = 'copy';
                }
            } catch (_) { }
        };
        const onDrop = async (e: DragEvent) => {
            try {
                e.preventDefault();
                e.stopPropagation();
                const groupId = editorArea.dataset['groupId'] || this.activeGroupId || 'group-1';
                await this.processExternalDrop(e.dataTransfer, groupId);
            } catch (err) {
                logWarn('编辑区 drop 处理失败:', err);
            }
        };
        editorArea.addEventListener('dragover', onDragOver, true);
        editorArea.addEventListener('drop', onDrop, true);
        editorArea._editorDnDBound = true;
    }

    async processExternalDrop(dataTransfer: DataTransfer | null, groupId: string) {
        if (!dataTransfer) {
            return false;
        }

        if (this.tabDragInProgress) {
            return false;
        }

        if (this.isInternalTabDrag(dataTransfer)) {
            return false;
        }

        const entries: DropEntry[] = [];
        const text = typeof dataTransfer.getData === 'function' ? dataTransfer.getData('text/plain') || '' : '';
        if (text && text.trim().startsWith('{') && text.includes('files')) {
            try {
                const parsed = JSON.parse(text);
                if (parsed && Array.isArray(parsed.files)) {
                    parsed.files.forEach((f: DroppedFileJson) => {
                        if (!f || f.type !== 'file') {
                            return;
                        }
                        const filePathRaw = typeof f.path === 'string' ? f.path : null;
                        const filePath = this.normalizeDroppedPath(filePathRaw);
                        if (!filePath) {
                            return;
                        }
                        const fileName = f.name || (filePath.split(/[\\\/]/).pop()) || 'untitled';
                        const base64 = typeof f.base64 === 'string' && f.base64.trim() ? f.base64.trim() : null;
                        entries.push({
                            fileName,
                            filePath,
                            fileObject: null,
                            base64
                        });
                    });
                }
            } catch (error) {
                logWarn('解析拖拽数据失败:', error);
            }
        }

        if (entries.length === 0) {
            const fileList = Array.from(dataTransfer.files || []);
            fileList.forEach((file: File) => {
                if (!file) {
                    return;
                }
                const fpRaw = typeof (file as PathLikeFile).path === 'string' ? (file as PathLikeFile).path : null;
                const fp = this.normalizeDroppedPath(fpRaw);
                const name = file.name || (fp && fp.split(/[\\\/]/).pop()) || 'untitled';
                entries.push({
                    fileName: name,
                    filePath: fp,
                    fileObject: file,
                    base64: null
                });
            });
        }

        if (entries.length === 0) {
            const uriList = typeof dataTransfer.getData === 'function' ? dataTransfer.getData('text/uri-list') || '' : '';
            if (uriList && uriList.trim()) {
                uriList.split(/\r?\n/).forEach((line: string) => {
                    const uri = line.trim();
                    if (!uri || uri.startsWith('#')) {
                        return;
                    }
                    if (!/^file:/i.test(uri)) {
                        return;
                    }
                    const normalizedPath = this.normalizeDroppedPath(uri);
                    const fileName = normalizedPath
                        ? normalizedPath.split(/[\\\/]/).pop()
                        : uri.split('/').pop();
                    entries.push({
                        fileName: fileName || 'untitled',
                        filePath: normalizedPath,
                        fileObject: null,
                        base64: null
                    });
                });
            }
        }

        if (entries.length === 0) {
            return false;
        }

        return this.openDropEntries(entries, groupId);
    }

    isInternalTabDrag(dataTransfer: DataTransfer) {
        try {
            const types = Array.isArray(dataTransfer.types)
                ? dataTransfer.types
                : Array.from(dataTransfer.types || []);
            return types.includes('application/oicpp-tab');
        } catch (_) {
            return false;
        }
    }

    async openDropEntries(entries: DropEntry[] | null | undefined, groupId: string | null | undefined) {
        if (!Array.isArray(entries) || entries.length === 0) {
            return false;
        }

        let opened = false;
        for (const entry of entries) {
            if (!entry || !entry.fileName) {
                continue;
            }
            const displayName = entry.fileName || window.i18n.t('panel.unknownFile');
            try {
                if (entry.fileObject && window.oicppApp?.openDroppedFile) {
                    await window.oicppApp.openDroppedFile(entry.fileObject, {
                        groupId,
                        fileName: entry.fileName,
                        filePath: entry.filePath || null,
                        base64Data: entry.base64 || null
                    });
                    opened = true;
                    continue;
                }

                const filePath = this.normalizeDroppedPath(entry.filePath);
                const isPdf = this.isPdfFile(entry.fileName);

                if (isPdf) {
                    await this.openFile(entry.fileName, '', false, {
                        filePath: filePath || null,
                        groupId,
                        viewType: 'pdf',
                        pdfBase64: entry.base64 && entry.base64.trim() ? entry.base64.trim() : null
                    });
                    opened = true;
                    continue;
                }

                if (filePath && window.electronAPI?.readFileContent) {
                    const content = await window.electronAPI.readFileContent(filePath);
                    if (typeof content === 'string') {
                        await this.openFile(entry.fileName, content, false, {
                            filePath,
                            groupId
                        });
                        opened = true;
                        continue;
                    }
                }

                if (entry.fileObject && typeof entry.fileObject.text === 'function') {
                    const content = await entry.fileObject.text();
                    await this.openFile(entry.fileName, content ?? '', false, {
                        filePath: filePath || null,
                        groupId
                    });
                    opened = true;
                    continue;
                }

                throw new Error(window.i18n.t('panel.cannotReadFile'));
            } catch (error) {
                this.showDropError(displayName, error);
            }
        }

        return opened;
    }

    showDropError(displayName: string | null | undefined, error: unknown) {
        if (!window.dialogManager?.showError) {
            return;
        }
        const name = displayName || window.i18n.t('panel.unknownFile');
        const message = (error as { message?: string })?.message || String(error || window.i18n.t('panel.unknownError'));
        window.dialogManager.showError(window.i18n.t('panel.cannotOpenFile', {name, message}));
    }

    ensureSplitOverlay() {
        if (this.splitOverlay) {
            return;
        }
        const container = this.editorGroupsElement?.parentElement;
        if (!container) {
            return;
        }
        const overlay = document.createElement('div') as HTMLElement;
        overlay.className = 'split-drop-overlay';
        const onDragOver = (event: DragEvent) => {
            if (!this.draggedTabInfo) {
                return;
            }
            event.preventDefault();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'move';
            }
        };
        const onDragLeave = (event: DragEvent) => {
            if (event.relatedTarget && overlay.contains(event.relatedTarget as Node | null)) {
                return;
            }
        };
        const onDrop = (event: DragEvent) => {
            if (!this.draggedTabInfo) {
                return;
            }
            event.preventDefault();
            const tabKey = event.dataTransfer?.getData('application/oicpp-tab') || this.draggedTabInfo.uniqueKey;
            const sourceGroupId = this.draggedTabInfo.groupId || this.activeGroupId;
            if (tabKey && sourceGroupId) {
                this.handleSplitDrop(tabKey, sourceGroupId);
            }
            this.hideSplitOverlay();
        };

        overlay.addEventListener('dragover', onDragOver);
        overlay.addEventListener('dragleave', onDragLeave);
        overlay.addEventListener('drop', onDrop);

        container.appendChild(overlay);
        this.splitOverlay = overlay;
    }

    showSplitOverlay(sourceGroupId: string | null | undefined) {
        if (!this.splitOverlay) return;
        const groupId = sourceGroupId || this.activeGroupId || '';
        if (!this.canSplitGroup(groupId)) {
            this.hideSplitOverlay();
            return;
        }
        this.splitOverlay.dataset['sourceGroupId'] = groupId;
        this.splitOverlay.classList.add('visible');
    }

    hideSplitOverlay() {
        if (!this.splitOverlay) return;
        this.splitOverlay.classList.remove('visible');
        delete this.splitOverlay.dataset['sourceGroupId'];
    }

    getGroupTabCount(groupId: string | null | undefined) {
        if (!groupId) {
            return 0;
        }
        const group = this.groups.get(groupId);
        if (!group) {
            return 0;
        }
        if (group.tabBar && typeof group.tabBar.querySelectorAll === 'function') {
            return group.tabBar.querySelectorAll('.tab').length;
        }
        if (group.tabs instanceof Map) {
            return group.tabs.size;
        }
        return 0;
    }

    canSplitGroup(groupId: string | null | undefined) {
        return this.getGroupTabCount(groupId) > 1;
    }

    bindTabBarEvents(tabBar: HTMLElement | null | undefined) {
        if (!tabBar || tabBar._tabBarEventsBound) {
            return;
        }
        const groupId = tabBar.dataset['groupId'] || (tabBar.closest('.editor-group') as HTMLElement | null)?.dataset['groupId'] || this.activeGroupId || 'group-1';
        tabBar.dataset['groupId'] = groupId;
        this.ensureTabBarDragHandlers(tabBar);
        if (!tabBar._horizontalWheelHandlerBound) {
            tabBar.addEventListener('wheel', (event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) {
                    return;
                }

                const deltaY = Number(event.deltaY) || 0;
                const deltaX = Number(event.deltaX) || 0;
                const scrollDelta = Math.abs(deltaY) >= 1 ? deltaY : deltaX;
                const maxScrollLeft = Math.max(0, tabBar.scrollWidth - tabBar.clientWidth);
                if (!scrollDelta || maxScrollLeft <= 0) {
                    return;
                }

                tabBar.scrollLeft += scrollDelta;
                event.preventDefault();
            }, { passive: false });
            tabBar._horizontalWheelHandlerBound = true;
        }
        tabBar._tabBarEventsBound = true;
    }

    ensureTabBarDragHandlers(tabBar: HTMLElement | null | undefined) {
        if (!tabBar || tabBar._dragHandlersBound) {
            return;
        }

        tabBar.addEventListener('dragover', (e) => {
            if (this.draggedTab && this.draggedTabInfo) {
                this.handleTabBarDragOver(e, tabBar);
            }
        });

        tabBar.addEventListener('drop', (e) => {
            if (this.draggedTab && this.draggedTabInfo) {
                this.handleTabBarDrop(e, tabBar);
            }
        });

        tabBar.addEventListener('dragleave', (e) => {
            if (this.placeholder && this.placeholder.parentNode === tabBar) {
                const rect = tabBar.getBoundingClientRect();
                const x = e.clientX;
                const y = e.clientY;

                if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
                    if (!tabBar.contains(e.relatedTarget as Node | null)) {
                    }
                }
            }
        });

        tabBar._dragHandlersBound = true;
    }

    handleTabBarDragOver(e: DragEvent, tabBar: HTMLElement) {
        if (!this.draggedTab || !this.draggedTabInfo) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        (e.dataTransfer as DataTransfer).dropEffect = 'move';

        const afterElement = this.getDragAfterElement(tabBar, e.clientX);

        if (!this.placeholder) {
            this.placeholder = document.createElement('div');
            this.placeholder.className = 'tab-placeholder';
            const baseWidth = this.draggedTab.offsetWidth || 140;
            const baseHeight = this.draggedTab.offsetHeight || 35;
            Object.assign(this.placeholder.style, {
                width: `${baseWidth}px`,
                height: `${baseHeight}px`,
                backgroundColor: '#2a2d2e',
                border: '2px dashed #0e639c',
                opacity: '0.4',
                boxSizing: 'border-box',
                display: 'inline-block'
            });
        }

        const currentParent = this.placeholder.parentNode;
        if (currentParent && currentParent !== tabBar) {
            currentParent.removeChild(this.placeholder);
        }

        if (afterElement == null) {
            if (!currentParent || currentParent !== tabBar || this.placeholder.nextSibling !== null) {
                tabBar.appendChild(this.placeholder);
            }
        } else if (afterElement !== this.placeholder) {
            const nextSibling = this.placeholder.nextSibling;
            if (nextSibling !== afterElement) {
                tabBar.insertBefore(this.placeholder, afterElement);
            }
        }

        const dropInfo = this.getDropTargetInfo(tabBar, e);
        const targetGroupId = tabBar.dataset['groupId'] || this.activeGroupId || 'group-1';
        this.lastTabDropInfo = {
            tabBar,
            targetGroupId,
            targetIndex: dropInfo.targetIndex,
            beforeElement: dropInfo.beforeElement || null
        };
    }

    handleTabBarDrop(e: DragEvent, tabBar: HTMLElement) {
        if (!this.draggedTabInfo) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();

        const targetGroupId = tabBar.dataset['groupId'] || this.activeGroupId || 'group-1';
        const { targetIndex, beforeElement } = this.getDropTargetInfo(tabBar, e);
        const applied = this.applyTabDrop({
            tabBar,
            targetGroupId,
            targetIndex,
            beforeElement: beforeElement || null
        });

        if (applied) {
            this.dropHandled = true;
        }

        this.cleanupTabDrag();
    }

    applyTabDrop({ tabBar, targetGroupId, targetIndex, beforeElement }: DropTargetArgs) {
        if (!this.draggedTabInfo || !tabBar) {
            return false;
        }

        const computed = this.getDropTargetInfo(tabBar);
        const finalIndex = typeof targetIndex === 'number' ? targetIndex : computed.targetIndex;
        const finalBefore = beforeElement || computed.beforeElement || null;

        const sameGroup = this.draggedTab && this.draggedTabInfo.groupId === targetGroupId;
        const uniqueKey = this.draggedTabInfo.uniqueKey;

        if (sameGroup) {
            this.reorderTabWithinGroup(tabBar, finalIndex, finalBefore);
        } else if (uniqueKey) {
            this.moveTabToGroup(uniqueKey, targetGroupId as string, finalIndex, finalBefore);
        } else {
            return false;
        }

        this.dropHandled = true;
        return true;
    }

    cleanupTabDrag(tabElement: HTMLElement | null = null) {
        const tab = tabElement || this.draggedTab;
        if (tab) {
            tab.classList.remove('dragging');
            tab.style.opacity = '';
        }

        if (this.placeholder && this.placeholder.parentNode) {
            this.placeholder.parentNode.removeChild(this.placeholder);
        }

        this.placeholder = null;
        this.draggedTab = null;
        this.draggedTabInfo = null;
        this.tabDragInProgress = false;
        this.hideSplitOverlay();
        this.lastTabDropInfo = null;
    }

    getPlaceholderIndex(tabBar: HTMLElement | null | undefined) {
        if (!tabBar || !this.placeholder) {
            return null;
        }
        let index = 0;
        for (const child of tabBar.children) {
            if (child === this.placeholder) {
                return index;
            }
            if (child.classList?.contains('tab') && child !== this.draggedTab) {
                index += 1;
            }
        }
        return null;
    }

    getDropTargetInfo(tabBar: HTMLElement, event: MouseEvent | null = null) {
        const allTabs = Array.from(tabBar.querySelectorAll('.tab') as NodeListOf<HTMLElement>);
        const draggedTab = this.draggedTab;
        const otherTabs = draggedTab ? allTabs.filter((tab) => tab !== draggedTab) : allTabs.slice();

        let targetIndex = this.getPlaceholderIndex(tabBar);

        if (targetIndex == null && event && typeof event.clientX === 'number') {
            const afterElement = this.getDragAfterElement(tabBar, event.clientX);
            if (afterElement) {
                const idx = otherTabs.indexOf(afterElement as HTMLElement);
                targetIndex = idx >= 0 ? idx : otherTabs.length;
            } else {
                targetIndex = otherTabs.length;
            }
        }

        if (targetIndex == null) {
            targetIndex = otherTabs.length;
        }

        if (targetIndex < 0) targetIndex = 0;
        if (targetIndex > otherTabs.length) targetIndex = otherTabs.length;

        const beforeElement = otherTabs[targetIndex] || null;
        return { targetIndex, beforeElement };
    }

    reorderTabWithinGroup(tabBar: HTMLElement, targetIndex: number | null, beforeElement: HTMLElement | null = null) {
        if (!this.draggedTab) {
            return;
        }

        let referenceNode = null;
        if (beforeElement && beforeElement.parentNode === tabBar) {
            referenceNode = beforeElement;
        } else if (this.placeholder && this.placeholder.parentNode === tabBar) {
            referenceNode = this.placeholder;
        } else if (typeof targetIndex === 'number') {
            const otherTabs = Array.from(tabBar.querySelectorAll('.tab')).filter((tab) => tab !== this.draggedTab);
            referenceNode = otherTabs[targetIndex] || null;
        }

        if (referenceNode === this.draggedTab) {
            referenceNode = this.draggedTab.nextSibling;
        }

        if (referenceNode) {
            tabBar.insertBefore(this.draggedTab, referenceNode);
        } else {
            tabBar.appendChild(this.draggedTab);
        }

        const groupId = tabBar.dataset['groupId'];
        const uniqueKey = this.draggedTab.dataset['uniqueKey'];
        if (uniqueKey) {
            const tabData = this.tabs.get(uniqueKey);
            if (tabData) {
                tabData.groupId = groupId;
            }
        }
        this.draggedTab.dataset['groupId'] = groupId;
        this.syncGroupTabs(groupId);
    }

    moveTabToGroup(uniqueKey: string, targetGroupId: string, dropIndex: number | null = null, beforeElement: HTMLElement | null = null) {
        if (!uniqueKey) {
            return;
        }
        const tabData = this.tabs.get(uniqueKey);
        if (!tabData) {
            return;
        }

        const sourceGroupId = tabData.groupId;
        let fallbackKey = null;
        if (sourceGroupId) {
            fallbackKey = this.getFallbackTabKeyWithinGroup(sourceGroupId, uniqueKey);
            const sourceGroup = this.groups.get(sourceGroupId);
            if (sourceGroup && sourceGroup.activeTabKey === uniqueKey) {
                sourceGroup.activeTabKey = null;
            }
        }
        if (sourceGroupId === targetGroupId && sourceGroupId) {
            const targetGroup = this.groups.get(targetGroupId);
            if (targetGroup?.tabBar) {
                this.draggedTab = tabData.element;
                const fallbackIndex = dropIndex ?? Array.from(targetGroup.tabBar.querySelectorAll('.tab')).length;
                this.reorderTabWithinGroup(targetGroup.tabBar, fallbackIndex, beforeElement || null);
            }
            return;
        }

        let targetGroup: EditorGroup | null | undefined = this.groups.get(targetGroupId);
        if (!targetGroup) {
            targetGroup = this.createGroup({ afterGroupId: sourceGroupId });
            targetGroupId = targetGroup?.id as string;
        }
        if (!targetGroup || !targetGroup.tabBar) {
            return;
        }

        const tabElement = tabData.element;
        if (tabElement) {
            tabElement.dataset['groupId'] = targetGroupId;
            let referenceNode = null;
            if (beforeElement && beforeElement.parentNode === targetGroup.tabBar) {
                referenceNode = beforeElement;
            } else if (this.placeholder && this.placeholder.parentNode === targetGroup.tabBar) {
                referenceNode = this.placeholder;
            } else if (dropIndex != null && dropIndex >= 0) {
                const targetTabs = Array.from(targetGroup.tabBar.querySelectorAll('.tab')).filter((tab) => tab !== tabElement);
                referenceNode = targetTabs[dropIndex] || null;
            }

            if (referenceNode === tabElement) {
                referenceNode = tabElement.nextSibling;
            }

            if (referenceNode) {
                targetGroup.tabBar.insertBefore(tabElement, referenceNode);
            } else {
                targetGroup.tabBar.appendChild(tabElement);
            }
        }

        if (sourceGroupId) {
            const sourceGroup = this.groups.get(sourceGroupId);
            sourceGroup?.tabs?.delete(uniqueKey);
            this.syncGroupTabs(sourceGroupId);
            this.ensureGroupHasActiveTab(sourceGroupId, { preferredUniqueKey: fallbackKey });
            this.handleGroupBecameEmpty(sourceGroupId);
        }

        targetGroup.tabs.set(uniqueKey, tabData);
        tabData.groupId = targetGroupId;

        if (tabData.viewType === 'pdf' && tabData.viewerContainer) {
            const newGroup = this.groups.get(targetGroupId);
            const targetArea = newGroup?.editorArea;
            if (targetArea) {
                targetArea.appendChild(tabData.viewerContainer);
                tabData.viewerContainer.dataset['groupId'] = targetGroupId;
                tabData.viewerContainer.style.display = 'none';
            }
        } else if (tabData.viewType === 'markdown-preview' && tabData.previewContainer) {
            const newGroup = this.groups.get(targetGroupId);
            const targetArea = newGroup?.editorArea;
            if (targetArea) {
                targetArea.appendChild(tabData.previewContainer);
                tabData.previewContainer.dataset['groupId'] = targetGroupId;
                tabData.previewContainer.style.display = 'none';
            }
        } else if (tabData.viewType === 'browser') {
            const newGroup = this.groups.get(targetGroupId);
            const targetArea = newGroup?.editorArea;
            if (targetArea && window.browserManager) {
                const container = window.browserManager.moveContainerToGroup(uniqueKey, targetGroupId);
                if (container) {
                    // appendChild 会自动从旧父节点移除，保留 iframe 内容
                    targetArea.appendChild(container);
                    container.style.display = 'none';
                }
            }
        } else if (this.monacoEditorManager && tabData.tabId) {
            this.monacoEditorManager.moveEditorToGroup(tabData.tabId, targetGroupId);
        }

        this.activeGroupId = targetGroupId;
        targetGroup.activeTabKey = uniqueKey;
        this.activeTabKey = uniqueKey;
        this.activeTab = tabData;

        this.syncGroupTabs(targetGroupId);

        this.activateTabByUniqueKey(uniqueKey).catch(logError);
    }

    syncGroupTabs(groupId: string | null | undefined) {
        const group = this.groups.get(groupId as string);
        if (!group || !group.tabBar) {
            return;
        }
        const newMap = new Map<string, TabRecord>();
        const tabElements = Array.from(group.tabBar.querySelectorAll('.tab') as NodeListOf<HTMLElement>);
        tabElements.forEach((tabElement: HTMLElement) => {
            const key = tabElement.dataset['uniqueKey'];
            if (!key) return;
            const tabData = this.tabs.get(key);
            if (tabData) {
                tabData.element = tabElement;
                tabData.groupId = groupId;
                newMap.set(key, tabData);
            }
        });
        group.tabs = newMap;
        group.tabOrder = Array.from(newMap.keys());
        this.updateGlobalTabOrder();
    }

    updateGlobalTabOrder() {
        const orderedNames: string[] = [];
        if (Array.isArray(this.groupOrder)) {
            this.groupOrder.forEach((groupId) => {
                const group = this.groups.get(groupId);
                if (!group || !Array.isArray(group.tabOrder)) {
                    return;
                }
                group.tabOrder.forEach((key) => {
                    const tabData = this.tabs.get(key);
                    if (tabData) {
                        orderedNames.push(tabData.fileName as string);
                    }
                });
            });
        }
        this.tabOrder = orderedNames;
    }

    getFallbackTabKeyWithinGroup(groupId: string | null | undefined, removedKey: string | null = null) {
        const group = this.groups.get(groupId as string);
        if (!group?.tabBar) {
            return null;
        }
        const tabs = Array.from(group.tabBar.querySelectorAll('.tab') as NodeListOf<HTMLElement>);
        if (tabs.length === 0) {
            return null;
        }
        if (removedKey) {
            const removedIndex = tabs.findIndex((tab: HTMLElement) => tab.dataset['uniqueKey'] === removedKey);
            if (removedIndex !== -1) {
                const right = tabs[removedIndex + 1];
                if (right?.dataset['uniqueKey'] && right.dataset['uniqueKey'] !== removedKey) {
                    return right.dataset['uniqueKey'];
                }
                const left = tabs[removedIndex - 1];
                if (left?.dataset['uniqueKey'] && left.dataset['uniqueKey'] !== removedKey) {
                    return left.dataset['uniqueKey'];
                }
            }
        }
        const first = tabs[0];
        if (first?.dataset['uniqueKey'] && first.dataset['uniqueKey'] !== removedKey) {
            return first.dataset['uniqueKey'];
        }
        if (tabs[1]?.dataset['uniqueKey'] && tabs[1]?.dataset['uniqueKey'] !== removedKey) {
            return tabs[1]?.dataset['uniqueKey'];
        }
        return null;
    }

    ensureGroupHasActiveTab(groupId: string, options: EnsureActiveOptions = {}) {
        const group = this.groups.get(groupId);
        if (!group?.tabBar) {
            return;
        }

        const { preferredUniqueKey = null, triggerEditor = true } = options;

        if (!group.tabs || group.tabs.size === 0) {
            group.activeTabKey = null;
            group.tabBar.querySelectorAll('.tab').forEach((tab: Element) => tab.classList.remove('active'));
            return;
        }

        let candidateKey = null;
        if (preferredUniqueKey && group.tabs.has(preferredUniqueKey)) {
            candidateKey = preferredUniqueKey;
        } else if (group.activeTabKey && group.tabs.has(group.activeTabKey)) {
            candidateKey = group.activeTabKey;
        } else {
            const firstTab = group.tabBar.querySelector('.tab') as HTMLElement | null;
            candidateKey = firstTab?.dataset['uniqueKey'] || Array.from(group.tabs.keys())[0];
        }

        if (!candidateKey) {
            group.activeTabKey = null;
            group.tabBar.querySelectorAll('.tab').forEach((tab: Element) => tab.classList.remove('active'));
            return;
        }

        group.activeTabKey = candidateKey;
        group.tabBar.querySelectorAll('.tab').forEach((tab: Element) => {
            tab.classList.toggle('active', (tab as HTMLElement).dataset['uniqueKey'] === candidateKey);
        });

        if (!triggerEditor) {
            return;
        }

        const tabData = this.tabs.get(candidateKey);
        // 非 Monaco 视图必须通过 TabManager 自己恢复。特别是浏览器标签
        // 被拖到新分组后，原分组的剩余浏览器标签不能交给 Monaco
        // switchTab，否则其容器会保持隐藏，造成空白分屏。
        if (tabData?.viewType === 'pdf' ||
            tabData?.viewType === 'markdown-preview' ||
            tabData?.viewType === 'browser') {
            this.activateTabByUniqueKey(candidateKey).catch(logError);
            return;
        }
        const tabId = tabData?.tabId;
        if (tabId && this.monacoEditorManager && typeof this.monacoEditorManager.switchTab === 'function') {
            const currentActive = this.monacoEditorManager.groupActiveTab?.get?.(groupId);
            if (currentActive !== tabId) {
                this.monacoEditorManager.switchTab(tabId);
            }
        }
    }

    handleSplitDrop(uniqueKey: string, sourceGroupId: string) {
        const tabKey = uniqueKey || this.draggedTabInfo?.uniqueKey;
        if (!tabKey) return;
        const sourceGroup = this.groups.get(sourceGroupId) || this.groups.get(this.activeGroupId as string);
        if (!sourceGroup) return;
        if (!this.canSplitGroup(sourceGroup.id)) {
            return;
        }

        const originalSize = sourceGroup.size || 1;
        const newSize = Math.max(originalSize / 2, 1);
        sourceGroup.size = newSize;
        const newGroup = this.createGroup({ afterGroupId: sourceGroup.id, size: newSize });
        this.updateGroupLayout();

        if (newGroup) {
            this.moveTabToGroup(tabKey, newGroup.id, 0, null);
        }
    }

    splitActiveTabToNewGroup() {
        const uniqueKey = this.activeTabKey || null;
        const groupId = this.activeGroupId || null;
        if (!uniqueKey || !groupId) {
            return false;
        }
        if (!this.canSplitGroup(groupId)) {
            return false;
        }
        this.handleSplitDrop(uniqueKey, groupId);
        return true;
    }

    createGroup({ afterGroupId = null, size = 1 }: { afterGroupId?: string | null; size?: number | null } = {}) {
        if (!this.editorGroupsElement) {
            return null;
        }
        const groupId = `group-${++this.groupCounter}`;
        const groupElement = document.createElement('div');
        groupElement.className = 'editor-group';
        groupElement.dataset['groupId'] = groupId;

        const tabBar = document.createElement('div');
        tabBar.className = 'tab-bar';
        tabBar.dataset['groupId'] = groupId;

        const editorArea = document.createElement('div');
        editorArea.className = 'editor-area';
        editorArea.dataset['groupId'] = groupId;

        groupElement.appendChild(tabBar);
        groupElement.appendChild(editorArea);

        this.bindEditorAreaDnD(editorArea);

        if (afterGroupId && this.groups.has(afterGroupId)) {
            const afterGroup = this.groups.get(afterGroupId);
            if (afterGroup?.element?.parentNode === this.editorGroupsElement) {
                this.editorGroupsElement.insertBefore(groupElement, afterGroup.element.nextSibling);
            } else {
                this.editorGroupsElement.appendChild(groupElement);
            }
            const insertIndex = this.groupOrder.indexOf(afterGroupId) + 1;
            this.groupOrder.splice(insertIndex, 0, groupId);
        } else {
            this.editorGroupsElement.appendChild(groupElement);
            this.groupOrder.push(groupId);
        }

        const groupData: EditorGroup = {
            id: groupId,
            element: groupElement,
            tabBar,
            editorArea,
            tabs: new Map(),
            tabOrder: [],
            activeTabKey: null,
            size: size || 1
        };

        this.groups.set(groupId, groupData);
        this.bindTabBarEvents(tabBar);

        if (this.monacoEditorManager) {
            this.monacoEditorManager.registerGroup(groupId, editorArea);
        }

        this.updateGroupLayout();
        this.refreshGroupResizers();

        return groupData;
    }

    updateGroupLayout() {
        const totalSize = this.groupOrder.reduce((sum, id) => {
            const group = this.groups.get(id);
            return sum + (group?.size || 1);
        }, 0);
        if (totalSize <= 0) {
            return;
        }
        this.groupOrder.forEach((id) => {
            const group = this.groups.get(id);
            if (!group) return;
            const weight = group.size || 1;
            group.element.style.flex = `${weight} 1 0`;
        });
    }

    handleGroupBecameEmpty(groupId: string) {
        const group = this.groups.get(groupId);
        if (!group) {
            return;
        }
        const hasTabs = group.tabBar && group.tabBar.querySelector('.tab') as HTMLElement | null;
        if (hasTabs) {
            return;
        }
        if (this.groups.size <= 1) {
            return;
        }

        const wasActiveGroup = this.activeGroupId === groupId;

        if (group.element && group.element.parentNode === this.editorGroupsElement) {
            (this.editorGroupsElement as HTMLElement).removeChild(group.element);
        }
        this.groups.delete(groupId);
        this.groupOrder = this.groupOrder.filter((id) => id !== groupId);

        if (this.monacoEditorManager) {
            this.monacoEditorManager.unregisterGroup(groupId);
        }

        if (wasActiveGroup) {
            this.activeGroupId = this.groupOrder[0] || null;
            const firstGroup = this.groups.get(this.activeGroupId as string);
            if (firstGroup && firstGroup.activeTabKey) {
                this.activeTabKey = firstGroup.activeTabKey;
                this.activeTab = this.tabs.get(firstGroup.activeTabKey) || null;
            }
        }

        if (this.groups.size === 1) {
            const remainingId = this.groupOrder[0];
            const remainingGroup = this.groups.get(remainingId as string);
            if (remainingGroup) {
                remainingGroup.size = 1;
            }
        }

        this.updateGroupLayout();
        this.refreshGroupResizers();

        if (wasActiveGroup && this.activeTabKey) {
            this.activateTabByUniqueKey(this.activeTabKey).catch(logError);
        }
        window.requestAnimationFrame?.(() => window.dispatchEvent(new Event('resize')));
    }

    refreshGroupResizers() {
        if (!this.editorGroupsElement) return;
        const oldResizers = Array.from(this.editorGroupsElement.querySelectorAll('.editor-group-resizer'));
        oldResizers.forEach(r => r.parentNode && r.parentNode.removeChild(r));

        if (!this.groupOrder || this.groupOrder.length <= 1) return;

        for (let i = 0; i < this.groupOrder.length - 1; i++) {
            const leftId = this.groupOrder[i];
            const rightId = this.groupOrder[i + 1];
            const leftGroup = this.groups.get(leftId as string);
            const rightGroup = this.groups.get(rightId as string);
            if (!leftGroup?.element || !rightGroup?.element) continue;

            const resizer = document.createElement('div');
            resizer.className = 'editor-group-resizer';
            resizer.dataset['leftGroupId'] = leftId;
            resizer.dataset['rightGroupId'] = rightId;
            this.bindResizerEvents(resizer);
            this.editorGroupsElement.insertBefore(resizer, rightGroup.element);
        }
    }

    bindResizerEvents(resizer: HTMLElement) {
        if (!resizer || resizer._bound) return;
        const onMouseDown = (e: MouseEvent) => {
            try {
                e.preventDefault();
                e.stopPropagation();
                const leftId = resizer.dataset['leftGroupId'];
                const rightId = resizer.dataset['rightGroupId'];
                const leftGroup = this.groups.get(leftId as string);
                const rightGroup = this.groups.get(rightId as string);
                if (!leftGroup?.element || !rightGroup?.element) return;

                const leftEl = leftGroup.element;
                const rightEl = rightGroup.element;
                const leftStart = leftEl.getBoundingClientRect().width;
                const rightStart = rightEl.getBoundingClientRect().width;
                const totalPx = leftStart + rightStart;
                const startX = e.clientX;
                const minPx = 160;
                const leftSize0 = leftGroup.size || 1;
                const rightSize0 = rightGroup.size || 1;
                const sumSize0 = leftSize0 + rightSize0;

                const onMouseMove = (ev: MouseEvent) => {
                    let delta = ev.clientX - startX;
                    let newLeft = leftStart + delta;
                    let newRight = rightStart - delta;
                    if (newLeft < minPx) {
                        newLeft = minPx;
                        newRight = totalPx - newLeft;
                    }
                    if (newRight < minPx) {
                        newRight = minPx;
                        newLeft = totalPx - newRight;
                    }
                    if (newLeft < minPx || newRight < minPx) return;

                    const leftRatio = newLeft / (newLeft + newRight);
                    const rightRatio = 1 - leftRatio;
                    leftGroup.size = sumSize0 * leftRatio;
                    rightGroup.size = sumSize0 * rightRatio;
                    this.updateGroupLayout();
                };

                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove, true);
                    document.removeEventListener('mouseup', onMouseUp, true);
                    resizer.classList.remove('dragging');
                    document.body.style.cursor = '';
                    document.body.style.userSelect = '';
                };

                document.addEventListener('mousemove', onMouseMove, true);
                document.addEventListener('mouseup', onMouseUp, true);
                resizer.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            } catch (err) { logWarn('分隔条拖拽初始化失败:', err); }
        };
        resizer.addEventListener('mousedown', onMouseDown);
        resizer._bound = true;
    }

    findUniqueKeyByFileName(fileName: string | null | undefined) {
        for (const [uniqueKey, tabData] of this.tabs.entries()) {
            if (tabData.fileName === fileName) {
                return uniqueKey;
            }
        }
        return null;
    }

    getTabByFileName(fileName: string | null | undefined) {
        const matchingTabs: Array<{ uniqueKey: string; tabData: TabRecord }> = [];
        for (const [uniqueKey, tabData] of this.tabs) {
            if (tabData.fileName === fileName) {
                matchingTabs.push({ uniqueKey, tabData });
            }
        }

        if (matchingTabs.length === 0) {
            return null;
        }

        if (matchingTabs.length === 1) {
            return (matchingTabs[0] as (typeof matchingTabs)[number]).tabData;
        }


        if (this.activeTab === fileName) {
            const activeMatch = matchingTabs.find(item => item.tabData.active);
            if (activeMatch) {
                return activeMatch.tabData;
            }
        }

        if (window.sidebarManager && window.sidebarManager.panels && window.sidebarManager.panels.files) {
            const fileExplorer = window.sidebarManager.panels.files;
            if (fileExplorer.selectedFile && fileExplorer.selectedFile.name === fileName) {
                const contextPath = fileExplorer.selectedFile.path;
                const contextMatch = matchingTabs.find(item => item.uniqueKey === contextPath);
                if (contextMatch) {
                    return contextMatch.tabData;
                }
            }
        }

        const activeMatch = matchingTabs.find(item =>
            item.tabData.element && item.tabData.element.classList.contains('active')
        );
        if (activeMatch) {
            return activeMatch.tabData;
        }

        return (matchingTabs[0] as (typeof matchingTabs)[number]).tabData;
    }

    async activateTabByUniqueKey(uniqueKey: string | null | undefined): Promise<boolean> {
        const tabData = this.tabs.get(uniqueKey as string);
        if (!tabData) {
            logError('未找到uniqueKey对应的标签页:', uniqueKey);
            return false;
        }
        this.saveCurrentEditorContent();

        this.activeTab = tabData;
        this.activeTabKey = uniqueKey as string | null;
        this.activeGroupId = tabData.groupId as string | null;

        const group = this.groups.get(tabData.groupId as string);
        if (group?.tabBar) {
            group.tabBar.querySelectorAll('.tab').forEach((tab: Element) => tab.classList.remove('active'));
            if (tabData.element && tabData.element.parentNode === group.tabBar) {
                tabData.element.classList.add('active');
            } else {
                const targetTab = group.tabBar.querySelector(`[data-unique-key="${uniqueKey}"]`) as HTMLElement | null;
                if (targetTab) {
                    targetTab.classList.add('active');
                    tabData.element = targetTab;
                } else {
                    logError('无法在目标分组中找到对应的DOM元素:', uniqueKey);
                }
            }
            group.activeTabKey = uniqueKey;
        }

        // 通知其它模块（例如对拍器）当前激活文件已变化。
        // 注意：uniqueKey在多数情况下就是文件路径；部分视图（如pdf）也会走这里。
        try {
            const filePath = tabData.filePath || tabData.uniqueKey || uniqueKey || '';
            window.dispatchEvent(new CustomEvent('oicpp:active-file-changed', {
                detail: {
                    filePath,
                    viewType: tabData.viewType || 'code',
                    uniqueKey
                }
            }));
        } catch (_) { }

        if (tabData.viewType === 'wysiwyg') {
            tabData.viewType = 'code';
            if (tabData.element) {
                tabData.element.dataset['viewType'] = 'code';
            }
        }

        if (tabData.viewType === 'pdf') {
            this.hideGroupViewContainers(tabData.groupId);
            if (!tabData.viewerContainer || !tabData.viewerContainer.parentElement) {
                tabData.viewerContainer = this.createPdfViewerContainer({
                    groupId: tabData.groupId,
                    tabId: tabData.tabId || this.generatePdfTabId(tabData.uniqueKey),
                    filePath: tabData.filePath,
                    fileName: tabData.fileName
                });
                tabData.viewerFrame = (tabData.viewerContainer?.querySelector('.pdf-viewer-frame') as HTMLIFrameElement | null) || null;
            } else if (tabData.viewerContainer.dataset['groupId'] !== tabData.groupId) {
                const targetGroup = this.groups.get(tabData.groupId as string);
                if (targetGroup?.editorArea) {
                    targetGroup.editorArea.appendChild(tabData.viewerContainer);
                    tabData.viewerContainer.dataset['groupId'] = tabData.groupId as string;
                }
            }
            if (tabData.viewerContainer) {
                tabData.viewerContainer.style.display = 'flex';
                tabData.viewerContainer.classList.add('active');
                this.focusPdfViewer(tabData);
            }
            if (this.monacoEditorManager && tabData.groupId) {
                try {
                    this.monacoEditorManager.groupActiveTab.set(tabData.groupId, null);
                } catch (err) {
                    logWarn('切换到PDF视图时更新编辑器状态失败:', err);
                }
            }
        } else if (tabData.viewType === 'markdown-preview') {
            this.hideGroupViewContainers(tabData.groupId);
            if (!tabData.previewContainer || !tabData.previewContainer.parentElement) {
                tabData.previewContainer = this.createMarkdownPreviewContainer({
                    groupId: tabData.groupId,
                    tabId: tabData.tabId,
                    content: tabData.content,
                    filePath: tabData.filePath
                });
            } else if (tabData.previewContainer.dataset['groupId'] !== tabData.groupId) {
                const targetGroup = this.groups.get(tabData.groupId as string);
                if (targetGroup?.editorArea) {
                    targetGroup.editorArea.appendChild(tabData.previewContainer);
                    tabData.previewContainer.dataset['groupId'] = tabData.groupId as string;
                }
            }
            if (tabData.previewContainer) {
                tabData.previewContainer.style.display = 'block';
                tabData.previewContainer.style.width = '100%';
                tabData.previewContainer.style.left = '0';
                tabData.previewContainer.style.position = 'relative';
            }
            if (this.monacoEditorManager && tabData.groupId) {
                this.monacoEditorManager.groupActiveTab.set(tabData.groupId, null);
            }
        } else if (tabData.viewType === 'browser') {
            this.hideGroupViewContainers(tabData.groupId);
            if (!window.browserManager) {
                logError('BrowserManager 未初始化');
                return false;
            }
            const targetGroup = this.groups.get(tabData.groupId as string);
            const state = window.browserManager.getBrowserState(uniqueKey as string);
            let container = state?.container;
            if (!container) {
                // 创建新的浏览器容器
                container = window.browserManager.getOrCreateContainer({
                    groupId: tabData.groupId as string,
                    uniqueKey: uniqueKey as string,
                    url: tabData.browserUrl || 'about:blank'
                });
                if (targetGroup?.editorArea) {
                    targetGroup.editorArea.appendChild(container);
                }
            } else if (container.dataset['groupId'] !== tabData.groupId) {
                container.dataset['groupId'] = tabData.groupId as string;
                if (targetGroup?.editorArea && container.parentNode !== targetGroup.editorArea) {
                    targetGroup.editorArea.appendChild(container);
                }
            }
            window.browserManager.showBrowserContainer(uniqueKey as string);
            window.browserManager.focusBrowserTab(uniqueKey as string);
            if (this.monacoEditorManager && tabData.groupId) {
                this.monacoEditorManager.groupActiveTab.set(tabData.groupId, null);
            }
        } else if (tabData.viewType === 'diff' && this.monacoEditorManager) {
            this.hideGroupViewContainers(tabData.groupId);
            if (tabData.tabId) {
                await this.monacoEditorManager.showDiffEditor(tabData.tabId, {
                    groupId: tabData.groupId,
                    ...(tabData.diffMeta as Record<string, unknown> || {}),
                    label: tabData.fileName
                });
            }
        } else if (this.monacoEditorManager) {
            this.hideGroupViewContainers(tabData.groupId);
            const expectedTabId = this.monacoEditorManager.generateTabId(tabData.fileName, tabData.filePath || tabData.uniqueKey || null);
            const actualTabId = tabData.tabId || expectedTabId;
            const editorExists = this.monacoEditorManager.editors && this.monacoEditorManager.editors.has(actualTabId);
            if (editorExists) {
                await this.monacoEditorManager.switchTab(actualTabId);
                logInfo('编辑器已存在，切换到:', tabData.fileName, 'tabId:', actualTabId);
            } else {
                logInfo('编辑器不存在，重新加载文件:', tabData.fileName, '期望tabId:', expectedTabId);
                this.loadFileContentToEditor(tabData.fileName, tabData);
            }
        } else {
            this.hideGroupViewContainers(tabData.groupId);
            this.loadFileContentToEditor(tabData.fileName, tabData);
        }

        for (const [key, tab] of this.tabs) {
            tab.active = (key === uniqueKey);
        }

        if (this.welcomeContainer) {
            this.welcomeContainer.style.display = 'none';
        }
        if (this.editorGroupsElement) {
            this.editorGroupsElement.style.display = 'flex';
        }

        if (window.sidebarManager) {
            try {
                if (typeof window.sidebarManager.showForEditor === 'function') {
                    window.sidebarManager.showForEditor();
                } else if (typeof window.sidebarManager.enableResize === 'function') {
                    window.sidebarManager.enableResize();
                }
            } catch (e) {
                logWarn('恢复侧边栏状态失败:', e);
            }
        }

        if (tabData.externalModified) {
            const forcePrompt = !!tabData.pendingExternalPrompt || !tabData.externalPromptDismissed;
            this.maybePromptExternalReload(tabData, { force: forcePrompt }).catch(logWarn);
        }

        return true;
    }

    closeTabByUniqueKey(uniqueKey: string, options: CloseTabOptions = {}) {
        const tabData = this.tabs.get(uniqueKey);
        if (!tabData) {
            logError('标签页不存在 (uniqueKey):', uniqueKey);
            return;
        }
        return this.closeTab(tabData.fileName, {
            ...options,
            uniqueKeyOverride: uniqueKey
        });
    }

    setTabElementUniqueKey(tabElement: HTMLElement | null | undefined, uniqueKey: string | null | undefined) {
        if (tabElement) {
            tabElement.dataset['uniqueKey'] = uniqueKey as string;
        }
    }

    attachTabEventHandlers(tabElement: HTMLElement | null | undefined) {
        if (!tabElement || tabElement._tabEventsBound) {
            return;
        }

        const getUniqueKey = () => tabElement.dataset['uniqueKey'];

        tabElement.addEventListener('click', (e) => {
            if ((e.target as Element).classList.contains('tab-close')) {
                return;
            }
            const uniqueKey = getUniqueKey();
            if (uniqueKey) {
                this.activateTabByUniqueKey(uniqueKey).catch(logError);
            }
        });

        const closeBtn = tabElement.querySelector('.tab-close') as HTMLElement | null;
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const uniqueKey = getUniqueKey();
                if (uniqueKey) {
                    this.closeTabByUniqueKey(uniqueKey);
                }
            });
        }

        tabElement.addEventListener('mouseup', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                const uniqueKey = getUniqueKey();
                if (uniqueKey) {
                    this.closeTabByUniqueKey(uniqueKey);
                }
            }
        });

        tabElement._tabEventsBound = true;
    }

    init() {
        this.cacheDOM();
        this.initializeGroups();
        this.setupEventListeners();
        this.initializeTabs();

        this.initializeEditorManagerReference();
        this.bindExternalFileWatcher();

        // 欢迎页文案全部由 t() 写入 innerHTML（无 data-i18n），语言切换需整体重建
        document.addEventListener('i18n-language-changed', () => {
            setTimeout(() => this.refreshWelcomeTranslations(), 0);
        });
    }

    /**
     * 语言切换后重渲染欢迎页。整页文案都来自 t()，所以重建 innerHTML 是完整做法；
     * 随后必须重跑最近文件列表，否则刚异步填入的内容会被清空。
     */
    refreshWelcomeTranslations(): void {
        const container = document.getElementById('welcome-container');
        if (!container || container.style.display === 'none') {
            return;
        }
        try {
            container.innerHTML = this.getWelcomePageContent();
            if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
                window.uiIcons.hydrate(container);
            }
            this.setupWelcomeEventListeners(container);
            this.loadRecentFiles(container);
        } catch (_) { }
    }

    initializeEditorManagerReference() {
        this.tryGetEditorManagerReference();

        if (!this.monacoEditorManager) {
            let retryCount = 0;
            const maxRetries = 20; // 最多重试20次
            const retryInterval = 200; // 每200ms重试一次

            const retryTimer = setInterval(() => {
                retryCount++;
                logInfo(`TabManager: 第${retryCount}次尝试获取编辑器管理器引用`);

                this.tryGetEditorManagerReference();

                if (this.monacoEditorManager || retryCount >= maxRetries) {
                    clearInterval(retryTimer);
                    if (!this.monacoEditorManager) {
                        logError('TabManager: 无法获取编辑器管理器引用，updateSettings功能将不可用');
                    }
                }
            }, retryInterval);
        }
    }

    tryGetEditorManagerReference() {
        if (window.editorManager) {
            this.monacoEditorManager = window.editorManager;
            logInfo('TabManager: 从全局变量获取到编辑器管理器引用');
            this.registerGroupsWithEditorManager();
            return true;
        }

        if (window.oicppApp && window.oicppApp.editorManager) {
            this.monacoEditorManager = window.oicppApp.editorManager;
            logInfo('TabManager: 从oicppApp获取到编辑器管理器引用');
            this.registerGroupsWithEditorManager();
            return true;
        }

        return false;
    }

    registerGroupsWithEditorManager() {
        if (!this.monacoEditorManager) return;
        for (const groupId of this.groupOrder) {
            const group = this.groups.get(groupId);
            if (group && group.editorArea) {
                this.monacoEditorManager.registerGroup(groupId, group.editorArea);
            }
        }
    }

    bindExternalFileWatcher() {
        if (this._fileWatchListenerBound) {
            return;
        }
        if (window.electronAPI?.onExternalFileChange) {
            try {
                const unsubscribe = window.electronAPI.onExternalFileChange((payload) => {
                    this.handleExternalFileChange(payload as ExternalChangePayload);
                });
                if (typeof unsubscribe === 'function') {
                    this._externalFileChangeUnsubscribe = unsubscribe;
                }
                this._fileWatchListenerBound = true;
            } catch (error) {
                logWarn('TabManager: 绑定外部文件变更监听失败:', error);
            }
        }

        if (!this._fileWatchCleanupBound && typeof window !== 'undefined') {
            const beforeUnloadHandler = () => {
                try { this.disposeAllFileWatchers(); } catch (_) { }
                if (this._externalFileChangeUnsubscribe) {
                    try { this._externalFileChangeUnsubscribe(); } catch (_) { }
                    this._externalFileChangeUnsubscribe = null;
                }
            };
            window.addEventListener('beforeunload', beforeUnloadHandler, { once: true });
            this._fileWatchCleanupBound = true;
        }
    }

    normalizeWatchKey(filePath: string | null | undefined) {
        if (!filePath || typeof filePath !== 'string') {
            return '';
        }
        let normalized = filePath.replace(/\\/g, '/');
        if (this.isWindowsPlatform()) {
            normalized = normalized.toLowerCase();
        }
        return normalized;
    }

    async registerFileWatchForTab(tabData: TabRecord | null | undefined) {
        try {
            if (!tabData || tabData.viewType === 'pdf') {
                return;
            }
            const filePath = tabData.filePath;
            const tabId = tabData.tabId;
            const isCloudPath = (p: string | null | undefined) => {
                if (window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function') {
                    return window.oicppApp.isCloudFilePath(p);
                }
                return typeof p === 'string' && /^cloud:/i.test(p);
            };
            if (!filePath || !tabId || !window.electronAPI?.watchFile) {
                return;
            }
            if (isCloudPath(filePath)) {
                return;
            }
            const key = this.normalizeWatchKey(filePath);
            if (!key) {
                return;
            }

            let entry = this._watchedFiles.get(key);
            if (!entry) {
                entry = { filePath, path: filePath, tabs: new Set(), watcher: { close: () => {} }, lastChangeType: null };
                this._watchedFiles.set(key, entry);
                try {
                    const result = await window.electronAPI.watchFile(filePath);
                    if (result && result.success === false) {
                        this._watchedFiles.delete(key);
                        logWarn('TabManager: 主进程拒绝监听文件', { filePath, error: result.error });
                        return;
                    }
                } catch (error) {
                    this._watchedFiles.delete(key);
                    logWarn('TabManager: 注册文件监听失败:', error);
                    return;
                }
            }

            entry.path = filePath;
            entry.tabs.add(tabId);
        } catch (error) {
            logWarn('TabManager: 注册文件监听时发生异常:', error);
        }
    }

    async unregisterFileWatchForTab(tabData: TabRecord | null | undefined) {
        try {
            if (!tabData) {
                return;
            }
            const filePath = tabData.filePath;
            const tabId = tabData.tabId;
            if (!filePath || !tabId) {
                return;
            }
            const key = this.normalizeWatchKey(filePath);
            if (!key) {
                return;
            }
            const entry = this._watchedFiles.get(key);
            if (!entry) {
                return;
            }
            entry.tabs.delete(tabId);
            if (entry.tabs.size === 0) {
                this._watchedFiles.delete(key);
                if (window.electronAPI?.unwatchFile) {
                    try {
                        await window.electronAPI.unwatchFile(entry.path);
                    } catch (error) {
                        logWarn('TabManager: 取消文件监听失败:', error);
                    }
                }
            }
        } catch (error) {
            logWarn('TabManager: 取消文件监听时发生异常:', error);
        }
    }

    disposeAllFileWatchers() {
        if (!this._watchedFiles || this._watchedFiles.size === 0) {
            return;
        }
        const entries = Array.from(this._watchedFiles.values());
        this._watchedFiles.clear();
        if (window.electronAPI?.unwatchFile) {
            entries.forEach((entry) => {
                if (!entry?.path) return;
                window.electronAPI.unwatchFile(entry.path).catch(() => { });
            });
        }
    }

    getTabDataByTabId(tabId: string | null | undefined) {
        if (!tabId) {
            return null;
        }
        for (const tabData of this.tabs.values()) {
            if (tabData && tabData.tabId === tabId) {
                return tabData;
            }
        }
        return null;
    }

    handleTabFileWatchRebind(oldPath: string | null | undefined, newPath: string | null | undefined, tabData: TabRecord | null | undefined) {
        if (!tabData || tabData.viewType === 'pdf') {
            return;
        }
        try {
            if (oldPath && oldPath !== newPath) {
                const oldKey = this.normalizeWatchKey(oldPath);
                if (oldKey) {
                    const oldEntry = this._watchedFiles.get(oldKey);
                    if (oldEntry) {
                        oldEntry.tabs.delete(tabData.tabId as string);
                        if (oldEntry.tabs.size === 0) {
                            this._watchedFiles.delete(oldKey);
                            if (window.electronAPI?.unwatchFile) {
                                window.electronAPI.unwatchFile(oldEntry.path).catch(() => { });
                            }
                        }
                    }
                }
            }
            if (newPath && oldPath !== newPath) {
                Promise.resolve(this.registerFileWatchForTab(tabData)).catch((error) => {
                    logWarn('TabManager: 重新绑定文件监听失败:', error);
                });
            }
        } catch (error) {
            logWarn('TabManager: 处理文件监听重绑定失败:', error);
        }
    }

    handleExternalFileChange(payload: ExternalChangePayload = {}) {
        try {
            const key = this.normalizeWatchKey(payload.filePath);
            if (!key) {
                return;
            }
            const entry = this._watchedFiles.get(key);
            if (!entry) {
                return;
            }

            const tabIds = Array.from(entry.tabs);
            const affectedTabs: TabRecord[] = [];
            for (const tabId of tabIds) {
                const tabData = this.getTabDataByTabId(tabId);
                if (tabData) {
                    affectedTabs.push(tabData);
                } else {
                    entry.tabs.delete(tabId);
                }
            }

            if (affectedTabs.length === 0) {
                if (entry.tabs.size === 0) {
                    this._watchedFiles.delete(key);
                    if (window.electronAPI?.unwatchFile) {
                        window.electronAPI.unwatchFile(entry.path).catch(() => { });
                    }
                }
                return;
            }

            const changeType = payload.changeType || 'modified';
            const timestamp = payload.timestamp || Date.now();
            entry.lastChangeType = changeType;

            affectedTabs.forEach((tabData) => {
                tabData.externalModified = true;
                tabData.externalChangeType = changeType;
                tabData.externalChangeTimestamp = timestamp;
                tabData.externalPromptDismissed = false;
                tabData.pendingExternalPrompt = true;
            });

            this.refreshTabLabels();

            const activeTabData = affectedTabs.find(tab => tab.uniqueKey === this.activeTabKey);
            if (activeTabData) {
                this.maybePromptExternalReload(activeTabData, { force: true });
            }
        } catch (error) {
            logWarn('TabManager: 处理外部文件变更时发生异常:', error);
        }
    }

    triggerFileExplorerRefresh() {
        try {
            const sidebar = window.sidebarManager || null;
            let fileExplorer: FileExplorer | null = null;
            if (sidebar?.getPanelManager) {
                try {
                    fileExplorer = sidebar.getPanelManager('files') || null;
                } catch (_) { }
            }
            if (!fileExplorer && sidebar?.panels?.files) {
                fileExplorer = sidebar.panels.files;
            }
            if (!fileExplorer && window.fileExplorer) {
                fileExplorer = window.fileExplorer as FileExplorer;
            }
            if (fileExplorer?.refresh) {
                fileExplorer.refresh();
            }
        } catch (error) {
            logWarn('TabManager: 刷新文件管理器失败:', error);
        }
    }

    async maybePromptExternalReload(tabData: TabRecord | null | undefined, options: ReloadOptions = {}) {
        if (!tabData || tabData.viewType === 'pdf') {
            return;
        }
        if (!tabData.externalModified) {
            return;
        }
        if (tabData.externalPromptInProgress) {
            return;
        }

        const forcePrompt = !!options.force;
        if (!forcePrompt && tabData.externalPromptDismissed) {
            return;
        }

        tabData.pendingExternalPrompt = false;
        tabData.externalPromptInProgress = true;

        const changeType = tabData.externalChangeType || 'modified';
        const fileDisplay = tabData.fileName || tabData.filePath || window.i18n.t('panel.unknownFile');
        const hasLocalChanges = !!tabData.modified;
        const shouldSuggestClose = changeType === 'deleted' || changeType === 'renamed';
        let message = '';

        if (changeType === 'deleted') {
            message = window.i18n.t('tabs.externalChangeDeleted', { file: fileDisplay });
        } else if (changeType === 'renamed') {
            message = window.i18n.t('tabs.externalChangeRenamed', { file: fileDisplay });
        } else {
            message = window.i18n.t('tabs.externalChangeModified', { file: fileDisplay });
        }

        if (shouldSuggestClose) {
            message += window.i18n.t('tabs.externalChangeCloseHint');
            message += window.i18n.t('tabs.externalChangeCloseNoSave');
        } else if (hasLocalChanges) {
            message += window.i18n.t('tabs.externalChangeReloadOverwrite');
        } else {
            message += window.i18n.t('tabs.externalChangeReloadPrompt');
        }

        let shouldReload = false;
        let shouldCloseTab = false;
        try {
            if (window.dialogManager?.showConfirmDialog) {
                const result = await window.dialogManager.showConfirmDialog(window.i18n.t('tabs.externalChangeTitle'), message);
                if (shouldSuggestClose) {
                    shouldCloseTab = !!result;
                } else {
                    shouldReload = !!result;
                }
            } else {
                if (shouldSuggestClose) {
                    shouldCloseTab = window.confirm(message);
                } else {
                    shouldReload = window.confirm(message);
                }
            }
        } catch (error) {
            logWarn('TabManager: 弹出外部修改对话框失败:', error);
        }

        if (shouldSuggestClose) {
            tabData.pendingExternalPrompt = false;
            tabData.externalPromptInProgress = false;
            if (shouldCloseTab) {
                tabData.externalModified = false;
                tabData.externalPromptDismissed = false;
                const uniqueKey = tabData.uniqueKey || null;
                try {
                    if (uniqueKey && typeof this.closeTabByUniqueKey === 'function') {
                        this.closeTabByUniqueKey(uniqueKey, { skipAutoSave: true });
                    } else if (tabData.fileName) {
                        this.closeTab(tabData.fileName, { skipAutoSave: true });
                    }
                } catch (closeError) {
                    logWarn('TabManager: 外部变更关闭标签页失败:', closeError);
                }
                this.triggerFileExplorerRefresh();
            } else {
                tabData.externalPromptDismissed = true;
                this.refreshTabLabels();
            }
            return;
        }

        if (shouldReload) {
            const success = await this.reloadTabFromDisk(tabData);
            if (!success) {
                tabData.externalModified = true;
                tabData.externalPromptDismissed = false;
            }
        } else {
            tabData.externalPromptDismissed = true;
        }

        tabData.externalPromptInProgress = false;
        this.refreshTabLabels();
    }

    async reloadTabFromDisk(tabData: TabRecord | null | undefined) {
        if (!tabData || tabData.viewType === 'pdf' || !tabData.filePath) {
            return false;
        }
        try {
            if (!window.electronAPI?.readFileContent) {
                throw new Error(window.i18n.t('tabs.readFileUnavailable'));
            }
            const content = await window.electronAPI.readFileContent(tabData.filePath);
            const editorManager = this.monacoEditorManager || window.monacoEditorManager || window.editorManager;
            let editor: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null = null;
            if (editorManager?.editors instanceof Map && tabData.tabId) {
                editor = editorManager.editors.get(tabData.tabId) || null;
            }
            if (!editor && editorManager?.currentEditor) {
                const currentPath = editorManager.currentEditor.getFilePath ? editorManager.currentEditor.getFilePath() : editorManager.currentEditor.filePath;
                if (this.normalizeWatchKey(currentPath) === this.normalizeWatchKey(tabData.filePath)) {
                    editor = editorManager.currentEditor;
                }
            }

            if (editor && 'onDidChangeModelContent' in editor) {
                const model = editor.getModel();
                const viewState = editor.saveViewState();
                if (model) {
                    model.setValue(content);
                }
                if (viewState) {
                    editor.restoreViewState(viewState);
                }
                editor.layout();
            }

            tabData.content = content;
            tabData.modified = false;
            tabData.externalModified = false;
            tabData.externalChangeType = null;
            tabData.externalPromptDismissed = false;
            tabData.pendingExternalPrompt = false;
            if (typeof this.markTabAsSavedByUniqueKey === 'function') {
                this.markTabAsSavedByUniqueKey(tabData.uniqueKey);
            }
            this.refreshTabLabels();
            return true;
        } catch (error) {
            logError('重新加载文件失败:', error);
            if (window.dialogManager?.showError) {
                window.dialogManager.showError(window.i18n.t('tabs.reloadFailed', { error: (error as { message?: string })?.message || String(error) }));
            }
            return false;
        }
    }

    setupEventListeners() {
        const tabs = document.querySelectorAll('.tab') as NodeListOf<HTMLElement>;
        tabs.forEach((tab: HTMLElement) => {
            tab.addEventListener('click', (e) => {
                if (e.target instanceof Element && e.target.classList.contains('tab-close')) {
                    return;
                }
                if (tab instanceof HTMLElement) {
                    this.activateTab(tab.dataset['file']).catch(logError);
                }
            });
        });

        const closeBtns = document.querySelectorAll('.tab-close') as NodeListOf<HTMLElement>;
        closeBtns.forEach((btn: HTMLElement) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const tab = e.target instanceof Element ? e.target.closest('.tab') : null;
                if (tab instanceof HTMLElement) {
                    this.closeTab(tab.dataset['file']);
                }
            });
        });


        document.addEventListener('mouseup', (e) => {
            const tab = e.target instanceof Element ? e.target.closest('.tab') : null;
            if (e.button === 1 && tab instanceof HTMLElement) {
                this.closeTab(tab.dataset['file']);
            }
        });

        if (!this._altWheelListenerBound) {
            document.addEventListener('wheel', (e) => {
                this.handleAltWheelTabSwitch(e);
            }, { capture: true, passive: false });
            this._altWheelListenerBound = true;
        }

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey) {
                switch (e.key) {
                    case 'Tab':
                        e.preventDefault();
                        this.switchToNextTab();
                        break;
                    case 'w':
                        e.preventDefault();
                        try {
                            const active = this.getActiveTabData();
                            const mgr = window.monacoEditorManager || window.editorManager;
                            const ed = mgr?.currentEditor;
                            const content = ed?.getValue?.();
                            const filePath = ed?.getFilePath ? ed.getFilePath() : (active?.filePath || null);
                            if (content != null) {
                                if (filePath && window.electronAPI?.saveFile) {
                                    window.electronAPI.saveFile(filePath, content)
                                        .then(() => {
                                            const uniq = (filePath || '').replace(/\\/g, '/');
                                            if (uniq && this.markTabAsSavedByUniqueKey) this.markTabAsSavedByUniqueKey(uniq);
                                            else if (active?.fileName) this.markTabAsSaved(active.fileName);
                                        })
                                        .catch((e) => { logError('关闭前保存失败:', e); });
                                } else if (window.electronAPI?.saveAsFile) {
                                    window.electronAPI.saveAsFile(content)
                                        .then((newPath) => {
                                            if (newPath) {
                                                const uniq = newPath.replace(/\\/g, '/');
                                                if (uniq && this.markTabAsSavedByUniqueKey) this.markTabAsSavedByUniqueKey(uniq);
                                            }
                                        })
                                        .catch((e) => { logError('关闭前另存为失败:', e); });
                                }
                            }
                        } catch (_) { }
                        this.closeActiveTab();
                        break;
                    case '=':
                    case '+':
                        if (this.tryHandlePdfShortcut('zoom-in')) {
                            e.preventDefault();
                        }
                        break;
                    case '-':
                    case '_':
                        if (this.tryHandlePdfShortcut('zoom-out')) {
                            e.preventDefault();
                        }
                        break;
                    case '0':
                        if (this.tryHandlePdfShortcut('zoom-reset')) {
                            e.preventDefault();
                        }
                        break;
                    case 'm':
                        if (this.splitActiveTabToNewGroup()) {
                            e.preventDefault();
                        }
                        break;
                    case 't':
                        e.preventDefault();
                        if (window.oicppApp && typeof window.oicppApp.openTemplateSettings === 'function') {
                            window.oicppApp.openTemplateSettings();
                        }
                        break;
                }
            }
        });
    }

    initializeTabs() {
        this.tabs.clear();
        this.tabOrder = [];
        this.groups.forEach((group) => {
            group.tabs = group.tabs || new Map();
            const tabElements = group.tabBar ? Array.from(group.tabBar.querySelectorAll('.tab') as NodeListOf<HTMLElement>) : [];
            tabElements.forEach((tabEl: HTMLElement) => {
                const labelEl = tabEl.querySelector('.tab-label') as HTMLElement | null;
                const labelText = labelEl?.querySelector?.('.tab-label-text')?.textContent || labelEl?.textContent || '';
                const fileName = tabEl.dataset['file'] || labelText.trim() || 'untitled';
                const uniqueKey = tabEl.dataset['uniqueKey'] || tabEl.dataset['filePath'] || fileName;
                const tabData = {
                    element: tabEl,
                    fileName,
                    modified: tabEl.classList.contains('modified') || false,
                    content: '',
                    active: tabEl.classList.contains('active'),
                    filePath: tabEl.dataset['filePath'] || null,
                    tabId: tabEl.dataset['tabId'] || null,
                    uniqueKey,
                    groupId: group.id,
                    isTempFile: false,
                    isDirty: false,
                    externalModified: false,
                    externalChangeType: null,
                    externalPromptDismissed: false,
                    externalPromptInProgress: false,
                    pendingExternalPrompt: false,
                    externalChangeTimestamp: null
                };
                this.tabs.set(uniqueKey, tabData);
                group.tabs.set(uniqueKey, tabData);
                this.setTabElementUniqueKey(tabEl, uniqueKey);
                tabEl.dataset['groupId'] = group.id;

                if (!tabEl.draggable) {
                    tabEl.draggable = true;
                }

                this.attachTabEventHandlers(tabEl);
                this.addTabDragListeners(tabEl);
                if (tabData.filePath) {
                    Promise.resolve(this.registerFileWatchForTab(tabData)).catch(() => { });
                }
                if (tabData.active) {
                    this.activeTab = tabData;
                    this.activeTabKey = uniqueKey;
                    group.activeTabKey = uniqueKey;
                    this.activeGroupId = group.id;
                }
            });
            group.tabOrder = Array.from(group.tabs.keys());
        });

        this.updateGlobalTabOrder();
    }

    async activateTab(fileName: string | null | undefined) {
        const uniqueKey = this.findUniqueKeyByFileName(fileName);
        if (uniqueKey) {
            await this.activateTabByUniqueKey(uniqueKey);
            return;
        }
        logError('activateTab: 无法根据文件名找到标签页', fileName);
    }

    isDiscardCloseInProgress() {
        try {
            return !!window.__oicppDiscardClose;
        } catch (_) {
            return false;
        }
    }

    saveCurrentEditorContent() {
        if (this.isDiscardCloseInProgress()) return;
        if (!this.activeTab) return;

        const currentTabKey = this.activeTabKey || this.findUniqueKeyByFileName(this.activeTab as string);
        const currentTab = currentTabKey ? this.tabs.get(currentTabKey) : this.getTabByFileName(this.activeTab as string);
        if (!currentTab) return;
        // 磁盘上的版本比编辑器新（外部改过）。这时自动保存会不经确认覆盖掉外部改动，
        // 而该跳过的保存后面还会在「外部已修改」提示里让用户选一次（#442）。
        if (currentTab.externalModified) {
            logInfo('文件已被外部修改，跳过切标签前的自动保存:', currentTab.filePath);
            return;
        }

        const content = this.getTabContentForSave(currentTab);
        if (typeof content === 'string') {
            // 内容与上次记录一致时跳过保存链：避免无改动切标签触发 saveFile IPC、
            // 主进程写盘比对、file-saved 广播与样例测试器刷新
            if (content === currentTab.content) return;

            const isCloudPath = (p: string | null | undefined) => {
                if (window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function') {
                    return window.oicppApp.isCloudFilePath(p);
                }
                return typeof p === 'string' && /^cloud:/i.test(p);
            };
            if (currentTab.filePath && window.electronAPI?.saveFile && !isCloudPath(currentTab.filePath)) {
                window.electronAPI.saveFile(currentTab.filePath, content)
                    .then(() => { logInfo('文件自动保存成功:', currentTab.filePath); })
                    .catch((e) => { logError('自动保存失败:', e); });
            }

            currentTab.content = content;
        }
    }

    getCurrentEditorContent() {
        const activeKey = this.activeTabKey || this.findUniqueKeyByFileName(this.activeTab as string);
        const tabData = activeKey ? this.tabs.get(activeKey) : this.getTabByFileName(this.activeTab as string);
        if (!tabData) return null;
        const content = this.getTabContentForSave(tabData);
        return typeof content === 'string' ? content : null;
    }

    getTabContentForSave(tabData: TabRecord | null | undefined) {
        if (!tabData) return null;
        if (tabData.viewType === 'pdf' || tabData.viewType === 'markdown-preview') {
            return null;
        }
        const editorMgr = this.monacoEditorManager || window.monacoEditorManager || window.editorManager;
        let editor = null;
        if (tabData.tabId && editorMgr?.editors?.get) {
            editor = editorMgr.editors.get(tabData.tabId) || null;
        }
        if (!editor && editorMgr?.currentEditor && tabData.filePath && editorMgr.currentEditor.filePath === tabData.filePath) {
            editor = editorMgr.currentEditor;
        }
        try {
            const value = editor?.getValue?.();
            if (typeof value === 'string') return value;
        } catch (error) {
            logError('获取编辑器内容失败:', error);
        }
        return typeof tabData.content === 'string' ? tabData.content : null;
    }



    loadFileContentToEditor(fileName: string | null | undefined, tab: TabRecord) {
        logInfo('加载文件内容到编辑器:', fileName);

        if (tab.isLoading) {
            logInfo('文件正在加载中，跳过重复调用:', fileName);
            return;
        }

        if (tab.filePath && window.electronAPI) {
            logInfo('从文件系统重新读取文件:', tab.filePath);
            tab.isLoading = true; // 设置加载标志
            const requestedPath = tab.filePath;
            const requestedKey = tab.uniqueKey || null;
            // await 期间可能已切换 tab / 关闭 tab：写入目标是 await 之后重新读取的 currentEditor，
            // 守卫必须同时锚定「tab 身份」和「目标编辑器身份」，否则 A 的内容会写进 B 的编辑器，
            // 并用 tab.modified = false 吞掉 B 的未保存改动
            const targetEditor = this.monacoEditorManager?.currentEditor || null;
            const isSameTab = () => (requestedKey
                ? this.tabs.get(requestedKey) === tab
                : tab.filePath === requestedPath);
            const isStillTarget = () => isSameTab() && this.monacoEditorManager?.currentEditor === targetEditor;

            window.electronAPI.readFileContent(requestedPath)
                .then((content) => {
                    if (!isSameTab()) {
                        logWarn('文件读取返回时标签页已失效，丢弃结果:', requestedPath);
                        return;
                    }
                    if (!isStillTarget()) {
                        // 目标编辑器已切走：只回填 tab 缓存，等切回该 tab 时再由 switchTab 载入
                        tab.content = content;
                        logWarn('文件读取返回时已切换编辑器，仅更新缓存:', requestedPath);
                        return;
                    }
                    logInfo('文件内容读取成功，直接设置到当前编辑器');
                    this.setEditorContent(content, true); // 标记为已保存
                    tab.content = content;
                    tab.modified = false; // 从文件系统加载的内容标记为未修改

                })
                .catch((error) => {
                    logError('读取文件失败:', error);
                    logWarn('[TabReadFileErrorSuppressed]', '无法读取文件: ' + error);
                    if (isStillTarget() && tab.content !== undefined) {
                        this.setEditorContent(tab.content);
                    }
                })
                .finally(() => {
                    tab.isLoading = false; // 清除加载标志
                });
        } else {
            const content = tab.content || this.getDefaultContentForFile(fileName as string);
            this.setEditorContent(content, !tab.modified); // 根据修改状态决定是否标记为已保存
            logInfo('使用缓存或默认内容');
        }
    }

    setEditorContent(content: string | null | undefined, markAsSaved = false) {
        if (this.monacoEditorManager && this.monacoEditorManager.currentEditor) {
            this.monacoEditorManager.currentEditor.setValue(content ?? '');
            logInfo('编辑器内容已更新，保存状态:', markAsSaved);
        } else {
            logWarn('编辑器管理器或当前编辑器不可用');
        }
    }

    getDefaultContentForFile(fileName: string) {
        const ext = (fileName.split('.').pop() as string).toLowerCase();

        if (ext === 'cpp' || ext === 'cc' || ext === 'cxx') {
            return '';
        } else if (ext === 'c') {
            return '';
        } else if (ext === 'h' || ext === 'hpp') {
            const guard = fileName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase() + '_';
            return `#ifndef ${guard}
#define ${guard}


#endif // ${guard}`;
        }

        return `// ${window.i18n.t('message.newFile')}\n`;
    }

    closeTab(fileName: string | null | undefined, options: CloseTabOptions = {}) {
        logInfo('关闭标签页:', fileName);
        const explicitKey = options.uniqueKeyOverride;
        let tabData = null;
        if (explicitKey && this.tabs.has(explicitKey)) {
            tabData = this.tabs.get(explicitKey);
        }
        if (!tabData) {
            tabData = this.getTabByFileName(fileName);
        }
        if (!tabData) {
            logError('标签页不存在:', fileName);
            return;
        }

        if (!options.force && !options.skipCloseConfirm && tabData.viewType !== 'pdf' && (tabData.modified || tabData.isTempFile)) {
            // 不在这里转义：DialogManager.formatMessage 会对整条正文转义，
            // 两边都做就会把 a&b 显示成 a&amp;b。
            const displayName = tabData.fileName || fileName || window.i18n.t('panel.unknownFile');
            const message = tabData.isTempFile
                ? window.i18n.t('tabs.tempFileUnsaved', { name: displayName })
                : window.i18n.t('tabs.tabUnsaved', { name: displayName });

            const proceedSave = async () => {
                try {
                    const path = tabData.filePath || (explicitKey && typeof explicitKey === 'string' ? explicitKey : null);
                    const content = this.getTabContentForSave(tabData);
                    const isCloudPath = (p: string | null | undefined) => {
                        if (window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function') {
                            return window.oicppApp.isCloudFilePath(p);
                        }
                        return typeof p === 'string' && /^cloud:/i.test(p);
                    };

                    // 用户点的是「保存并关闭」，每条走不通的分支都必须说清楚为什么没关掉，
                    // 静默 return 等于让用户以为已经保存了。
                    if (tabData.isTempFile) {
                        if (!window.electronAPI?.saveAsFile) {
                            throw new Error(window.i18n.t('dialog.saveApiUnavailable'));
                        }
                        // 用户在系统另存为框里主动取消：不算失败，保持标签页打开即可。
                        const savedPath = await window.electronAPI.saveAsFile(content as string);
                        if (!savedPath) return;
                    } else if (path && typeof content === 'string') {
                        if (isCloudPath(path)) {
                            if (!(window.oicppApp && typeof window.oicppApp.saveCloudFileToServer === 'function')) {
                                throw new Error(window.i18n.t('dialog.saveApiUnavailable'));
                            }
                            const ok = await window.oicppApp.saveCloudFileToServer(path, content);
                            if (!ok) throw new Error(window.i18n.t('dialog.cloudSaveFailed'));
                        } else if (window.electronAPI?.saveFile) {
                            // 落盘走 invoke：主进程 handler 失败会 reject，交给下面的 catch，
                            // 不能再去看 result.success —— save-file 成功时返回的是 true。
                            await window.electronAPI.saveFile(path, content);
                        } else {
                            throw new Error(window.i18n.t('dialog.saveApiUnavailable'));
                        }
                    } else if (path) {
                        throw new Error(window.i18n.t('dialog.saveContentUnavailable'));
                    } else {
                        throw new Error(window.i18n.t('dialog.saveTargetUnknown'));
                    }
                } catch (e) {
                    const errorText = (e as Error)?.message || String(e);
                    logWarn('关闭前保存失败:', e);
                    try {
                        if (window.dialogManager?.showConfirmDialog) {
                            await window.dialogManager.showConfirmDialog(window.i18n.t('dialog.saveFailedTitle'), errorText);
                        } else if (window.dialogManager?.showError) {
                            window.dialogManager.showError(errorText);
                        }
                    } catch (_) { }
                    return;
                }
                this.closeTab(fileName, { ...options, skipCloseConfirm: true, skipAutoSave: true });
            };
            const proceedDiscard = () => this.closeTab(fileName, { ...options, skipCloseConfirm: true, skipAutoSave: true });

            try {
                if (window.dialogManager?.showActionDialog) {
                    window.dialogManager.showActionDialog(tabData.isTempFile ? window.i18n.t('tabs.confirmDiscardTemp') : window.i18n.t('tabs.confirmCloseTab'), message, [
                        { id: 'save', label: window.i18n.t('dialog.save'), className: 'dialog-btn-confirm' },
                        { id: 'discard', label: window.i18n.t('dialog.discard'), className: 'dialog-btn-cancel' },
                        { id: 'cancel', label: window.i18n.t('dialog.cancel') }
                    ])
                        .then((result: unknown) => {
                            if (result === 'save') {
                                proceedSave();
                                return;
                            }
                            else if (result === 'discard') proceedDiscard();
                        })
                        .catch((e: unknown) => logWarn('关闭标签页确认弹窗失败:', e));
                } else if (window.dialogManager?.showConfirmDialog) {
                    window.dialogManager.showConfirmDialog(window.i18n.t('tabs.confirmCloseTab'), message)
                        .then((result: unknown) => {
                            if (result) proceedSave();
                        })
                        .catch((e: unknown) => logWarn('关闭标签页确认弹窗失败:', e));
                } else {
                    const result = window.confirm(window.i18n.t('tabs.fileUnsavedConfirm', { name: tabData.fileName || fileName }));
                    if (result) proceedSave();
                }
            } catch (e) {
                logWarn('关闭标签页确认异常:', e);
            }
            return;
        }

        Promise.resolve(this.unregisterFileWatchForTab(tabData)).catch((error) => {
            try { logWarn('TabManager: 移除文件监听失败:', error); } catch (_) { }
        });

        const groupId = tabData.groupId;
        const uniqueKey = explicitKey
            || tabData.uniqueKey
            || this.findUniqueKeyByFileName(fileName)
            || null;
        let fallbackKey = null;
        let relatedGroup = null;
        let shouldTriggerFallback = false;
        if (groupId && uniqueKey) {
            relatedGroup = this.groups.get(groupId) || null;
            fallbackKey = this.getFallbackTabKeyWithinGroup(groupId, uniqueKey);
            if (relatedGroup && relatedGroup.activeTabKey === uniqueKey) {
                relatedGroup.activeTabKey = null;
                shouldTriggerFallback = true;
            } else if (tabData.element?.classList.contains('active')) {
                shouldTriggerFallback = true;
            }
        }

        if (!options.skipAutoSave && !this.isDiscardCloseInProgress() && !tabData.isTempFile && tabData.viewType !== 'pdf') {
            try {
                const path = tabData.filePath || (uniqueKey && uniqueKey.includes('/') ? uniqueKey : null);
                const content = this.getTabContentForSave(tabData);
                const isCloudPath = (p: string | null | undefined) => {
                    if (window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function') {
                        return window.oicppApp.isCloudFilePath(p);
                    }
                    return typeof p === 'string' && /^cloud:/i.test(p);
                };
                if (path && typeof content === 'string' && window.electronAPI?.saveFile && !isCloudPath(path)) {
                        window.electronAPI.saveFile(path, content)
                            .then(() => {
                                if (this.markTabAsSavedByUniqueKey) {
                                    this.markTabAsSavedByUniqueKey(path.replace(/\\/g, '/'));
                                } else if (fileName) {
                                    this.markTabAsSaved(fileName);
                                }
                            })
                            .catch(e => logWarn('关闭前自动保存失败:', e));
                }
            } catch (e) { logWarn('关闭前自动保存异常:', e); }
        }

        let tabId = tabData.tabId;
        if (!tabId && uniqueKey) {
            try {
                if (this.monacoEditorManager && this.monacoEditorManager.generateTabId) {
                    const fname = tabData.fileName || fileName || uniqueKey.split('/').pop();
                    tabId = this.monacoEditorManager.generateTabId(fname, uniqueKey);
                } else {
                    tabId = uniqueKey.replace(/[\\/:]/g, '_');
                }
            } catch (_) {
                tabId = uniqueKey.replace(/[\\/:]/g, '_');
            }
        }

        if (tabData.viewType === 'pdf') {
            if (tabData.viewerContainer && tabData.viewerContainer.parentNode) {
                tabData.viewerContainer.parentNode.removeChild(tabData.viewerContainer);
            }
            tabData.viewerContainer = null;
        } else if (tabData.viewType === 'markdown-preview') {
            if (tabData.previewContainer && tabData.previewContainer.parentNode) {
                tabData.previewContainer.parentNode.removeChild(tabData.previewContainer);
            }
            tabData.previewContainer = null;
        } else if (tabData.viewType === 'browser') {
            // 清理浏览器标签页
            if (window.browserManager && typeof window.browserManager.destroyBrowserTab === 'function') {
                window.browserManager.destroyBrowserTab(uniqueKey as string);
            }
        } else if (tabId && window.monacoEditorManager) {
            window.monacoEditorManager.cleanupEditor(tabId);
        }

        if (tabData.isTempFile && tabData.filePath && window.electronAPI?.deleteTempFile) {
            window.electronAPI.deleteTempFile(tabData.filePath).catch((err) => logWarn('删除临时文件失败:', err));
        }

        if (tabData.element && tabData.element.parentNode) {
            tabData.element.parentNode.removeChild(tabData.element);
        }

        if (uniqueKey) {
            this.tabs.delete(uniqueKey);
        }

        if (groupId && uniqueKey) {
            relatedGroup?.tabs?.delete(uniqueKey);
            this.syncGroupTabs(groupId);
            this.ensureGroupHasActiveTab(groupId, {
                preferredUniqueKey: fallbackKey,
                triggerEditor: shouldTriggerFallback
            });
            this.handleGroupBecameEmpty(groupId);
        }

        if (this.activeTab === fileName || this.activeTabKey === uniqueKey) {
            this.activeTab = null;
            this.activeTabKey = null;

            const remainingTabs = Array.from(this.tabs.keys());
            if (remainingTabs.length > 0) {
                const nextUniqueKey = remainingTabs[0] as string;
                const firstTabData = this.tabs.get(nextUniqueKey);
                if (firstTabData) {
                    this.activateTabByUniqueKey(nextUniqueKey).catch(logError);
                }
            } else {
                this.showEmptyState();
            }
        }

        this.refreshTabLabels();
    }

    // activeTab 在多数激活路径（activateTab / activateTabByUniqueKey / 分组切换等）里
    // 被赋成整个 TabRecord，少数路径赋 fileName 字符串。直接把它传给
    // getTabByFileName 会因 `tabData.fileName === fileName` 永远失配而查不到 tab，
    // 这里统一归一化，避免每个调用点各自判断。
    getActiveTabData() {
        if (this.activeTab && typeof this.activeTab === 'object') {
            return this.activeTab;
        }
        if (typeof this.activeTab === 'string') {
            const byName = this.getTabByFileName(this.activeTab);
            if (byName) return byName;
        }
        if (this.activeTabKey) {
            return this.tabs.get(this.activeTabKey) || null;
        }
        return null;
    }

    closeActiveTab() {
        const tabData = this.getActiveTabData();
        if (!tabData) return;
        this.closeTab(tabData.fileName, { uniqueKeyOverride: tabData.uniqueKey });
    }

    createNewTab() {
        this.createNewCppFile();
    }

    generateNewFileName() {
        let counter = 1;
        let fileName = `untitled-${counter}.cpp`;

        // this.tabs 的 key 是 uniqueKey（磁盘文件为完整路径），只比 key 会漏掉
        // 已打开的同名磁盘文件，导致新建 tab 与其并存
        const nameTaken = (name: string) => [...this.tabs.values()]
            .some((tabData) => tabData?.fileName === name || tabData?.uniqueKey === name);

        while (this.tabs.has(fileName) || nameTaken(fileName)) {
            counter++;
            fileName = `untitled-${counter}.cpp`;
        }

        return fileName;
    }

    dispose() {
        if (typeof window === 'undefined') return;
        if (this.handlePdfViewerMessage) {
            window.removeEventListener('message', this.handlePdfViewerMessage, false);
        }
        if (this._beforeUnloadHandler) {
            window.removeEventListener('beforeunload', this._beforeUnloadHandler);
            this._beforeUnloadHandler = null;
        }
    }

    isPdfFile(fileName = '') {
        if (!fileName || typeof fileName !== 'string') {
            return false;
        }
        const parts = fileName.split('.');
        if (parts.length < 2) {
            return false;
        }
        return (parts.pop() as string).toLowerCase() === 'pdf';
    }

    isLikelyFileObject(candidate: FileLikeObject | null | undefined) {
        if (!candidate || typeof candidate !== 'object') {
            return false;
        }

        if (typeof File !== 'undefined' && candidate instanceof File) {
            return true;
        }

        const hasArrayBuffer = typeof candidate.arrayBuffer === 'function';
        const hasText = typeof candidate.text === 'function';
        const hasStream = typeof candidate.stream === 'function';
        const hasName = typeof candidate.name === 'string';
        const hasSize = typeof candidate.size === 'number';
        const hasPath = typeof candidate.path === 'string';
        const hasType = typeof candidate.type === 'string';

        if (hasName && (hasArrayBuffer || hasText || hasStream)) {
            return true;
        }

        if (hasName && hasSize && hasType) {
            return true;
        }

        if (hasPath && hasName) {
            return true;
        }

        return false;
    }

    base64ToUint8Array(base64: string | null | undefined) {
        if (!base64 || typeof base64 !== 'string') {
            return null;
        }
        try {
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i += 1) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
        } catch (error) {
            logWarn('解析 Base64 数据失败', error);
            return null;
        }
    }

    isWindowsPlatform() {
        if (this._isWindowsPlatform !== undefined) {
            return this._isWindowsPlatform;
        }
        try {
            const platform = (window.process?.platform || navigator?.platform || '').toLowerCase();
            this._isWindowsPlatform = platform.includes('win');
        } catch (_) {
            this._isWindowsPlatform = false;
        }
        return this._isWindowsPlatform;
    }

    getWorkspaceRootPath() {
        try {
            return window.sidebarManager?.panels?.files?.workspacePath || '';
        } catch (_) {
            return '';
        }
    }

    normalizePathSlashes(pathCandidate: string | null | undefined) {
        if (!pathCandidate || typeof pathCandidate !== 'string') {
            return '';
        }
        return pathCandidate.replace(/\\/g, '/');
    }

    isPathInsideWorkspace(filePath: string | null | undefined, workspacePath: string | null | undefined) {
        if (!filePath || !workspacePath) {
            return false;
        }
        const normalizedFile = this.normalizePathSlashes(filePath);
        let normalizedWorkspace = this.normalizePathSlashes(workspacePath);
        normalizedWorkspace = normalizedWorkspace.replace(/\/+$/g, '');
        if (!normalizedWorkspace) {
            return false;
        }
        if (this.isWindowsPlatform()) {
            const fileLower = normalizedFile.toLowerCase();
            const workspaceLower = normalizedWorkspace.toLowerCase();
            return fileLower === workspaceLower || fileLower.startsWith(`${workspaceLower}/`);
        }
        return normalizedFile === normalizedWorkspace || normalizedFile.startsWith(`${normalizedWorkspace}/`);
    }

    computeDisplayDirectory(filePath: string | null | undefined, workspacePath: string | null | undefined) {
        try {
            const normalizedFile = this.normalizePathSlashes(filePath);
            const workspaceNormalized = workspacePath ? this.normalizePathSlashes(workspacePath).replace(/\/+$/g, '') : '';
            const lastSlashIndex = normalizedFile.lastIndexOf('/');
            const directoryPart = lastSlashIndex >= 0 ? normalizedFile.slice(0, lastSlashIndex) : '';

            if (!directoryPart) {
                return '';
            }

            if (workspaceNormalized && this.isPathInsideWorkspace(normalizedFile, workspaceNormalized)) {
                let relative = normalizedFile.slice(workspaceNormalized.length);
                if (relative.startsWith('/')) {
                    relative = relative.slice(1);
                }
                const relativeDirEnd = relative.lastIndexOf('/');
                let relativeDir = relativeDirEnd >= 0 ? relative.slice(0, relativeDirEnd) : '';
                if (!relativeDir) {
                    const workspaceName = workspaceNormalized.split('/').pop();
                    return workspaceName || '.';
                }
                return relativeDir;
            }

            return directoryPart;
        } catch (err) {
            logWarn('计算标签路径失败:', err);
            return '';
        }
    }

    refreshTabLabels() {
        try {
            if (!this.tabs || this.tabs.size === 0) {
                return;
            }

            const workspacePath = this.getWorkspaceRootPath();
            const normalizedWorkspace = workspacePath ? this.normalizePathSlashes(workspacePath).replace(/\/+$/g, '') : '';
            const groupedByName: Map<string, TabRecord[]> = new Map();

            for (const [, tabData] of this.tabs.entries()) {
                if (!tabData || !tabData.element) {
                    continue;
                }
                const baseName = tabData.fileName || 'untitled';
                if (!groupedByName.has(baseName)) {
                    groupedByName.set(baseName, []);
                }
                (groupedByName.get(baseName) as TabRecord[]).push(tabData);
            }

            for (const tabsWithSameName of groupedByName.values()) {
                const hasDuplicates = tabsWithSameName.length > 1;
                tabsWithSameName.forEach((tabData) => {
                    const labelElement = tabData.element?.querySelector?.('.tab-label');
                    if (!labelElement) {
                        return;
                    }

                    const filePath = tabData.filePath || (tabData.uniqueKey && tabData.uniqueKey.includes('/') ? tabData.uniqueKey : null);
                    const normalizedFile = filePath ? this.normalizePathSlashes(filePath) : '';
                    const outsideWorkspace = normalizedFile && (!normalizedWorkspace || !this.isPathInsideWorkspace(normalizedFile, normalizedWorkspace));
                    const shouldAppendPath = normalizedFile && (hasDuplicates || outsideWorkspace);

                    let baseLabel = tabData.fileName || 'untitled';
                    if (shouldAppendPath) {
                        const dirText = this.computeDisplayDirectory(normalizedFile, normalizedWorkspace);
                        if (dirText) {
                            baseLabel = `${tabData.fileName} — ${dirText}`;
                        }
                    }

                    const prefixSvgs = [];
                    if (tabData.modified && window.uiIcons && typeof window.uiIcons.svg === 'function') {
                        prefixSvgs.push(window.uiIcons.svg('dot'));
                    }
                    if (tabData.externalModified && window.uiIcons && typeof window.uiIcons.svg === 'function') {
                        prefixSvgs.push(window.uiIcons.svg(tabData.externalChangeType === 'deleted' ? 'warning' : 'refresh'));
                    }

                    const textSpan = document.createElement('span');
                    textSpan.className = 'tab-label-text';
                    textSpan.textContent = baseLabel;

                    if (prefixSvgs.length) {
                        const prefixSpan = document.createElement('span');
                        prefixSpan.className = 'tab-label-prefixes';
                        prefixSpan.innerHTML = prefixSvgs.join('');
                        labelElement.replaceChildren(prefixSpan, textSpan);
                    } else {
                        labelElement.replaceChildren(textSpan);
                    }
                });
            }
        } catch (err) {
            logWarn('刷新标签标题失败:', err);
        }
    }

    normalizeDroppedPath(candidate: string | null | undefined) {
        if (!candidate) {
            return '';
        }
        let normalized = typeof candidate === 'string' ? candidate : String(candidate);
        normalized = normalized.trim();
        if (!normalized) {
            return '';
        }

        if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith('\'') && normalized.endsWith('\''))) {
            normalized = normalized.slice(1, -1);
        }

        if (/^file:\/\//i.test(normalized)) {
            try {
                const fileUrl = new URL(normalized);
                if (fileUrl.protocol.toLowerCase() === 'file:') {
                    const isWindows = this.isWindowsPlatform();
                    const host = fileUrl.hostname || '';
                    let pathname = decodeURIComponent(fileUrl.pathname || '');
                    if (host) {
                        if (isWindows) {
                            pathname = `\\\\${host}${pathname.replace(/\//g, '\\')}`;
                        } else {
                            pathname = `//${host}${pathname}`;
                        }
                    } else if (isWindows && pathname.startsWith('/')) {
                        pathname = pathname.slice(1);
                    }
                    normalized = pathname || '';
                }
            } catch (error) {
                logWarn('解析 file:// 路径失败，使用原值', error);
            }
        }

        normalized = normalized.replace(/\u0000/g, '');
        return normalized;
    }

    buildFileObjectFromDescriptor(descriptor: PdfDropDescriptor | null | undefined, fallbackName = 'untitled') {
        if (!descriptor || typeof descriptor.base64 !== 'string' || !descriptor.base64.trim()) {
            return null;
        }
        const bytes = this.base64ToUint8Array(descriptor.base64.trim());
        if (!bytes) {
            return null;
        }
        const fileName = fallbackName || descriptor.name || 'untitled';
        const fileType = typeof descriptor.type === 'string' && descriptor.type
            ? descriptor.type
            : 'application/pdf';
        const lastModified = typeof descriptor.lastModified === 'number' && Number.isFinite(descriptor.lastModified)
            ? descriptor.lastModified
            : Date.now();
        try {
            if (typeof File === 'function') {
                return new File([bytes], fileName, { type: fileType, lastModified });
            }
        } catch (error) {
            logWarn('使用 File 构建文件对象失败，尝试退回 Blob', error);
        }
        try {
            const blob = new Blob([bytes], { type: fileType });
            return Object.assign(blob, {
                name: fileName,
                lastModified,
                size: bytes.length
            });
        } catch (error) {
            logWarn('构建 Blob 文件对象失败', error);
            return null;
        }
    }

    buildFileUrl(filePath: string | null | undefined) {
        if (!filePath || typeof filePath !== 'string') {
            return '';
        }
        let normalized = filePath.replace(/\\/g, '/');
        if (!normalized.startsWith('/')) {
            normalized = `/${normalized}`;
        }
        const url = `file://${normalized}`;
        try {
            return encodeURI(url);
        } catch (err) {
            logWarn('构建文件URL失败，使用未编码路径:', err);
            return url;
        }
    }

    generatePdfTabId(uniqueKey: string | null | undefined) {
        try {
            if (!uniqueKey) {
                return `pdf-${Date.now().toString(36)}`;
            }
            const normalized = uniqueKey.replace(/\\/g, '/');
            let hash = 0;
            for (let i = 0; i < normalized.length; i += 1) {
                hash = ((hash << 5) - hash) + normalized.charCodeAt(i);
                hash |= 0;
            }
            return `pdf-${Math.abs(hash).toString(36)}`;
        } catch (err) {
            logWarn('生成PDF标签ID失败，使用时间戳兜底:', err);
            return `pdf-${Date.now().toString(36)}`;
        }
    }

    createPdfViewerContainer({ groupId, tabId, filePath, fileName, inline = false }: PdfContainerOptions) {
        const group = this.groups.get(groupId as string);
        const editorArea = group?.editorArea;
        if (!editorArea) {
            logError('创建PDF查看器失败：未找到目标编辑区域', groupId);
            return null;
        }

        const container = document.createElement('div');
        container.className = 'pdf-viewer-container';
        container.dataset['tabId'] = tabId as string;
        container.dataset['groupId'] = groupId as string;
        container.dataset['filePath'] = filePath || '';
        container.style.display = 'none';
        if (!container.style.position) {
            container.style.position = 'relative';
        }

        const loader = document.createElement('div');
        loader.className = 'pdf-viewer-loading';
        loader.innerHTML = '<div class="spinner"></div><div>' + (window.i18n?.t?.('pdfViewer.loading')) + '</div>';

        const iframe = document.createElement('iframe');
        iframe.className = 'pdf-viewer-frame';
        iframe.dataset['tabId'] = tabId as string;
        iframe.setAttribute('loading', 'lazy');
        iframe.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-popups allow-downloads');
        iframe.title = fileName ? `${fileName} (${window.i18n.t('pdfViewer.loading')})` : window.i18n.t('pdfViewer.loading');

        const viewerSrc = this.buildPdfViewerSrc({ filePath, tabId, inline });
        if (viewerSrc) {
            iframe.src = viewerSrc;
        } else {
            loader.innerHTML = '<div class="spinner"></div><div>' + (window.i18n?.t?.('pdfViewer.notFound')) + '</div>';
        }

        iframe.addEventListener('load', () => {
            loader.style.display = 'none';
            this.handlePdfViewerLoaded(tabId);
        });

        container.appendChild(loader);
        container.appendChild(iframe);
        this.attachPdfDropHandlers(container, groupId as string);
        editorArea.appendChild(container);
        return container;
    }

    /**
     * @param {{ filePath?: string, tabId?: string, zoom?: string, inline?: boolean }} opts
     */
    buildPdfViewerSrc({ filePath, tabId, zoom, inline = false }: PdfViewerSrcOptions = {}) {
        if (!filePath && !inline) {
            return '';
        }
        try {
            const baseUrl = window.location?.href || document.baseURI;
            const viewerUrl = new URL('./pdf-viewer.html', baseUrl);
            if (inline) {
                viewerUrl.searchParams.set('file', 'inline');
            } else {
                const fileUrl = this.buildFileUrl(filePath);
                viewerUrl.searchParams.set('file', fileUrl);
            }
            if (tabId) {
                viewerUrl.searchParams.set('tabId', tabId as string);
            }
            viewerUrl.searchParams.set('zoom', (zoom as string) || 'page-width');
            viewerUrl.searchParams.set('disableFullscreen', 'true');
            const theme = this.getCurrentTheme();
            if (theme) {
                viewerUrl.searchParams.set('theme', theme);
            }
            return viewerUrl.href;
        } catch (err) {
            logWarn('构建 PDF 查看地址失败:', err);
            return '';
        }
    }

    attachPdfDropHandlers(viewerContainer: HTMLElement | null | undefined, groupId: string | null | undefined) {
        if (!viewerContainer || viewerContainer._pdfDnDBound) {
            return;
        }

        if (!viewerContainer.style.position || viewerContainer.style.position === 'static') {
            viewerContainer.style.position = 'relative';
        }

        let overlay = viewerContainer.querySelector('.pdf-drop-overlay') as HTMLElement | null;
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'pdf-drop-overlay';
            const message = document.createElement('div');
            message.className = 'pdf-drop-message';
            message.textContent = window.i18n.t('pdfViewer.dragToOpen');
            overlay.appendChild(message);
            viewerContainer.appendChild(overlay);
        }

        let hoverCounter = 0;

        const isTabDrag = (event: DragEvent | null | undefined) => {
            try {
                const rawTypes = event?.dataTransfer?.types;
                const types = Array.isArray(rawTypes) ? rawTypes : Array.from(rawTypes || []);
                return types.includes('application/oicpp-tab');
            } catch (_) {
                return false;
            }
        };

        const showOverlay = (event: DragEvent | null | undefined) => {
            if (isTabDrag(event)) {
                return;
            }
            hoverCounter += 1;
            if (event?.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
            overlay.classList.add('visible');
        };

        const hideOverlay = () => {
            hoverCounter = 0;
            overlay.classList.remove('visible');
        };

        const decrementHover = (event: DragEvent | null | undefined) => {
            if (event && event.relatedTarget && viewerContainer.contains(event.relatedTarget as Node)) {
                return;
            }
            hoverCounter = Math.max(hoverCounter - 1, 0);
            if (hoverCounter === 0) {
                overlay.classList.remove('visible');
            }
        };

        viewerContainer.addEventListener('dragenter', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showOverlay(event);
        });

        viewerContainer.addEventListener('dragover', (event) => {
            if (isTabDrag(event)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
            overlay.classList.add('visible');
        });

        viewerContainer.addEventListener('dragleave', (event) => {
            event.stopPropagation();
            decrementHover(event);
        });

        viewerContainer.addEventListener('drop', async (event) => {
            if (isTabDrag(event)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            hideOverlay();
            try {
                await this.processExternalDrop(event.dataTransfer, groupId as string);
            } catch (error) {
                logWarn('PDF 容器 drop 处理失败:', error);
            }
        });

        overlay.addEventListener('dragover', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
        });

        overlay.addEventListener('dragleave', (event) => {
            event.stopPropagation();
            if (event.relatedTarget && overlay.contains(event.relatedTarget as Node)) {
                return;
            }
            decrementHover(event);
        });

        overlay.addEventListener('drop', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            hideOverlay();
            try {
                await this.processExternalDrop(event.dataTransfer, groupId as string);
            } catch (error) {
                logWarn('PDF 覆盖层 drop 处理失败:', error);
            }
        });

        const frame = viewerContainer.querySelector('.pdf-viewer-frame') as HTMLElement | null;
        if (frame) {
            frame.addEventListener('dragenter', (event) => {
                event.preventDefault();
                event.stopPropagation();
                showOverlay(event);
            });
            frame.addEventListener('dragover', (event) => {
                if (isTabDrag(event)) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'copy';
                }
                overlay.classList.add('visible');
            });
            frame.addEventListener('dragleave', (event) => {
                event.stopPropagation();
                decrementHover(event);
            });
            frame.addEventListener('drop', async (event) => {
                if (isTabDrag(event)) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                hideOverlay();
                try {
                    await this.processExternalDrop(event.dataTransfer, groupId as string);
                } catch (error) {
                    logWarn('PDF 框架 drop 处理失败:', error);
                }
            });
        }

        viewerContainer._pdfDnDBound = true;
    }

    getCurrentTheme() {
        try {
            const body = document.body;
            if (!body) {
                return null;
            }
            const dataTheme = body.getAttribute('data-theme') || body.dataset?.['theme'];
            if (dataTheme) {
                return dataTheme;
            }
            if (body.classList.contains('theme-light') || body.classList.contains('light-theme')) {
                return 'light';
            }
            if (body.classList.contains('theme-dark') || body.classList.contains('dark-theme')) {
                return 'dark';
            }
        } catch (err) {
            logWarn('检测主题失败:', err);
        }
        return null;
    }

    handlePdfViewerLoaded(tabId: string | null | undefined) {
        if (!tabId) {
            return;
        }
        let targetTab: TabRecord | null = null;
        for (const tabData of this.tabs.values()) {
            if (tabData.tabId === tabId) {
                targetTab = tabData;
                break;
            }
        }
        if (!targetTab || targetTab.viewType !== 'pdf') {
            return;
        }
        targetTab.pdfViewerReady = true;
        const frame = (targetTab.viewerFrame || targetTab.viewerContainer?.querySelector('.pdf-viewer-frame')) as HTMLIFrameElement | null;
        if (frame) {
            try {
                frame.focus();
                frame.contentWindow?.focus();
            } catch (err) {
                logWarn('激活 PDF 查看器焦点失败:', err);
            }
            targetTab.viewerFrame = frame;
        }
        if (this.activeTabKey === targetTab.uniqueKey) {
            this.focusPdfViewer(targetTab);
        }
    }

    focusPdfViewer(tabData: TabRecord | null | undefined) {
        if (!tabData || tabData.viewType !== 'pdf') {
            return;
        }
        const frame = (tabData.viewerFrame || tabData.viewerContainer?.querySelector('.pdf-viewer-frame')) as HTMLIFrameElement | null;
        if (frame) {
            try {
                frame.focus();
                frame.contentWindow?.focus();
            } catch (err) {
                logWarn('设置 PDF 查看器焦点失败:', err);
            }
            tabData.viewerFrame = frame;
        }
    }

    tryHandlePdfShortcut(action: string | null | undefined) {
        if (!action) {
            return false;
        }
        const activeKey = this.activeTabKey;
        if (!activeKey) {
            return false;
        }
        const tabData = this.tabs.get(activeKey);
        if (!tabData || tabData.viewType !== 'pdf') {
            return false;
        }
        const frame = (tabData.viewerFrame || tabData.viewerContainer?.querySelector('.pdf-viewer-frame')) as HTMLIFrameElement | null;
        if (!frame) {
            return false;
        }
        try {
            const viewerWindow = frame.contentWindow;
            if (!viewerWindow) {
                return false;
            }
            const app = viewerWindow.PDFViewerApplication;
            if (!app) {
                return false;
            }
            switch (action) {
                case 'zoom-in':
                    app.eventBus.dispatch('zoomIn', { source: 'oicpp-tabs' });
                    return true;
                case 'zoom-out':
                    app.eventBus.dispatch('zoomOut', { source: 'oicpp-tabs' });
                    return true;
                case 'zoom-reset':
                    app.eventBus.dispatch('zoomReset', { source: 'oicpp-tabs' });
                    return true;
                default:
                    return false;
            }
        } catch (err) {
            logWarn('转发 PDF 快捷键失败:', err);
            return false;
        }
    }

    async handlePdfViewerMessage(event: MessageEvent) {
        if (!event || !event.data) {
            return;
        }
        // PDF viewer 是应用自身资源内嵌的同源 iframe；拒绝任何跨源来源，
        // 防止任意第三方页面伪造 postMessage 数据注入 PDF 标签页状态。
        if (typeof event.origin === 'string' && window.location?.origin
            && event.origin !== window.location.origin) {
            return;
        }
        const { source, tabId, type, detail } = event.data;
        if (source !== 'oicpp-pdf-viewer' || !tabId) {
            return;
        }
        let targetTab = null;
        for (const tabData of this.tabs.values()) {
            if (tabData.viewType === 'pdf' && tabData.tabId === tabId) {
                targetTab = tabData;
                break;
            }
        }
        if (!targetTab) {
            return;
        }
        try {
            switch (type) {
                case 'ready': {
                    targetTab.pdfViewerReady = true;
                    targetTab.pdfViewerError = null;
                    if (detail && typeof detail.scale === 'number' && Number.isFinite(detail.scale)) {
                        targetTab.pdfViewerScale = detail.scale;
                    }
                    const loader = targetTab.viewerContainer?.querySelector('.pdf-viewer-loading') as HTMLElement | null;
                    if (loader) {
                        loader.style.display = 'none';
                    }
                    const errorBox = targetTab.viewerContainer?.querySelector('.pdf-viewer-error') as HTMLElement | null;
                    if (errorBox) {
                        errorBox.style.display = 'none';
                        errorBox.innerHTML = '';
                    }
                    if (this.activeTabKey === targetTab.uniqueKey) {
                        this.focusPdfViewer(targetTab);
                    }
                    break;
                }
                case 'zoom-changed': {
                    if (detail && typeof detail.scale === 'number' && Number.isFinite(detail.scale)) {
                        targetTab.pdfViewerScale = detail.scale;
                    }
                    break;
                }
                case 'error': {
                    const message = detail?.message || window.i18n.t('panel.unknownError');
                    targetTab.pdfViewerError = message;
                    const loader = targetTab.viewerContainer?.querySelector('.pdf-viewer-loading') as HTMLElement | null;
                    if (loader) {
                        loader.style.display = 'none';
                    }
                    const existingError = targetTab.viewerContainer?.querySelector('.pdf-viewer-error');
                    if (existingError && existingError.parentNode) {
                        existingError.parentNode.removeChild(existingError);
                    }
                    logError('PDF 查看器错误:', message);
                    break;
                }
                case 'external-drop': {
                    const files = Array.isArray(detail?.files) ? detail.files : [];
                    if (files.length > 0) {
                        const groupId = targetTab.groupId || this.activeGroupId || 'group-1';
                        const entries = files.map((descriptor: PdfDropDescriptor | null) => {
                            if (!descriptor) {
                                return null;
                            }
                            const fileName = descriptor.name
                                || (typeof descriptor.path === 'string' && descriptor.path.split(/[\\\/]/).pop())
                                || 'untitled';
                            const candidate = (descriptor.file ?? descriptor.fileObject ?? descriptor) as FileLikeObject;
                            let fileObject = this.isLikelyFileObject(candidate) ? candidate : null;
                            if (!fileObject) {
                                fileObject = this.buildFileObjectFromDescriptor(descriptor, fileName);
                            }
                            const derivedPath = typeof descriptor.path === 'string'
                                ? descriptor.path
                                : (fileObject && typeof fileObject.path === 'string' ? fileObject.path : null);
                            const base64 = typeof descriptor.base64 === 'string' && descriptor.base64.trim()
                                ? descriptor.base64.trim()
                                : null;
                            const finalName = fileName || fileObject?.name || (derivedPath && derivedPath.split(/[\\\/]/).pop()) || 'untitled';
                            return {
                                fileName: finalName,
                                filePath: derivedPath,
                                fileObject,
                                base64
                            };
                        }).filter(Boolean);
                        if (entries.length > 0) {
                            await this.openDropEntries(entries, groupId);
                        }
                    }
                    break;
                }
                case 'request-file': {
                    this.respondToPdfFileRequest(targetTab, detail, tabId).catch(logError);
                    break;
                }
                default:
                    break;
            }
        } catch (err) {
            logWarn('处理 PDF 查看器消息失败', err);
        }
    }

    async respondToPdfFileRequest(tabData: TabRecord | null | undefined, detail: PdfRequestDetail | null | undefined, tabId: string | null | undefined) {
        if (!tabData || !tabData.viewerContainer) {
            return;
        }
        const requestId = detail?.requestId;
        if (!requestId) {
            return;
        }

        const frame = (tabData.viewerFrame || tabData.viewerContainer.querySelector('.pdf-viewer-frame')) as HTMLIFrameElement | null;
        const targetWindow = frame?.contentWindow;
        if (!targetWindow) {
            return;
        }

        const postResponse = (payload: Record<string, unknown>) => {
            try {
                targetWindow.postMessage({
                    source: 'oicpp-tabs',
                    tabId,
                    type: 'file-data',
                    requestId,
                    ...payload
                }, '*');
            } catch (error) {
                logWarn('向 PDF 查看器发送文件响应失败:', error);
            }
        };

        const filePath = tabData.filePath || detail?.filePath;
        if (!filePath) {
            if (tabData.pdfBase64) {
                postResponse({ base64: tabData.pdfBase64, filePath: null });
            } else {
                postResponse({ error: window.i18n.t('pdfViewer.cannotDeterminePath') });
            }
            return;
        }

        if (!window.electronAPI?.readFileBuffer) {
            postResponse({ error: window.i18n.t('pdfViewer.cannotReadBinary') });
            return;
        }

        try {
            const base64 = await window.electronAPI.readFileBuffer(filePath);
            if (!base64) {
                postResponse({ error: window.i18n.t('pdfViewer.noData') });
                return;
            }
            postResponse({ base64, filePath });
        } catch (error) {
            logError('读取 PDF 文件失败:', error);
            postResponse({ error: (error as Error)?.message || String(error) });
        }
    }

    hideGroupViewContainers(groupId: string | null | undefined) {
        const group = this.groups.get(groupId as string);
        const editorArea = group?.editorArea;
        if (!editorArea) {
            return;
        }
        const panes = editorArea.querySelectorAll('.monaco-editor-container, .pdf-viewer-container, .markdown-preview-container, .browser-container') as NodeListOf<HTMLElement>;
        panes.forEach((pane) => {
            pane.style.display = 'none';
            pane.classList.remove('active');
        });
        // 隐藏该分组的全部浏览器容器
        if (window.browserManager && typeof window.browserManager.hideGroupBrowserContainers === 'function') {
            window.browserManager.hideGroupBrowserContainers(groupId as string);
        }
    }

    async openPdfTab({ fileName, filePath, uniqueKey, targetGroupId, targetGroup, isTempFile = false, pdfBase64 = null }: PdfTabOptions) {
        if (!filePath && !pdfBase64) {
            logError('打开PDF失败：缺少文件路径或数据');
            this._openingKeys.delete(uniqueKey as string);
            return;
        }

        const tabId = this.generatePdfTabId(uniqueKey);
        const tabElement = this.createTabElement(fileName, tabId);

        tabElement.dataset['groupId'] = targetGroupId as string;
        tabElement.dataset['viewType'] = 'pdf';
        tabElement.classList.add('tab-type-pdf');
        this.addTabDragListeners(tabElement);

        const viewerContainer = this.createPdfViewerContainer({
            groupId: targetGroupId,
            tabId,
            filePath,
            fileName,
            inline: !!pdfBase64
        });
        if (!viewerContainer) {
            logError('创建 PDF 查看器容器失败');
            this._openingKeys.delete(uniqueKey as string);
            return;
        }

        const viewerFrame = (viewerContainer.querySelector('.pdf-viewer-frame') || null) as HTMLIFrameElement | null;

        const tabData: TabRecord = {
            element: tabElement,
            fileName,
            modified: false,
            content: null,
            active: true,
            filePath,
            tabId,
            uniqueKey,
            groupId: targetGroupId,
            viewType: 'pdf',
            isTempFile,
            pdfBase64
        };

        this.tabs.set(uniqueKey as string, tabData);
        targetGroup.tabs.set(uniqueKey as string, tabData);
        if (targetGroup.tabBar) {
            this.bindTabBarEvents(targetGroup.tabBar);
            targetGroup.tabBar.appendChild(tabElement);
        }
        targetGroup.activeTabKey = uniqueKey;

        this.activeTab = fileName as string | null;
        this.activeTabKey = uniqueKey as string | null;
        this.activeGroupId = targetGroupId as string | null;

        this.setTabElementUniqueKey(tabElement, uniqueKey);

        this.syncGroupTabs(targetGroupId);

        tabElement.classList.add('active');
        viewerContainer.style.display = 'flex';
        viewerContainer.classList.add('active');
        tabData.viewerContainer = viewerContainer;
        tabData.viewerFrame = viewerFrame;
        tabData.pdfBase64 = pdfBase64;

        await this.registerFileWatchForTab(tabData);
        await this.activateTabByUniqueKey(uniqueKey);
    }

    /**
     * 打开内置浏览器标签页
     * @param {object} options
     * @param {string} [options.url] - 要打开的 URL
     * @param {string} [options.groupId] - 目标分组 ID
     * @param {string} [options.title] - 标签标题
     */
    async openBrowserTab(options: BrowserTabOptions = {}) {
        const url = options.url || '';
        const targetGroupId = options.groupId || this.activeGroupId || this.groupOrder[0] || 'group-1';
        const title = options.title || window.i18n.t('browser.newTab');

        const uniqueKey = `browser:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        if (this.tabs.has(uniqueKey)) {
            await this.activateTabByUniqueKey(uniqueKey);
            return;
        }
        if (this._openingKeys.has(uniqueKey)) {
            return;
        }
        this._openingKeys.add(uniqueKey);

        try {
            let targetGroup: EditorGroup | null | undefined = this.groups.get(targetGroupId);
            if (!targetGroup) {
                targetGroup = this.createGroup({ afterGroupId: this.activeGroupId });
                if (!targetGroup) {
                    logError('无法创建目标分组，放弃打开浏览器标签页');
                    return;
                }
            }

            // 创建标签元素
            const tabElement = this.createTabElement(title, uniqueKey);
            tabElement.dataset['groupId'] = targetGroupId;
            tabElement.dataset['viewType'] = 'browser';
            tabElement.classList.add('tab-type-browser');

            // 添加浏览器图标
            const iconSpan = document.createElement('span');
            iconSpan.className = 'tab-icon-browser';
            iconSpan.innerHTML = [
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
                '<circle cx="12" cy="12" r="10"/>',
                '<ellipse cx="12" cy="12" rx="4" ry="10" transform="rotate(0)"/>',
                '<path d="M2 12h20"/>',
                '</svg>'
            ].join('');
            const label = tabElement.querySelector('.tab-label');
            if (label && label.parentNode) {
                label.parentNode.insertBefore(iconSpan, label);
            }

            this.addTabDragListeners(tabElement);

            const tabData: TabRecord = {
                element: tabElement,
                fileName: title,
                modified: false,
                content: null,
                active: true,
                filePath: null,
                tabId: uniqueKey,
                uniqueKey,
                groupId: targetGroupId,
                viewType: 'browser',
                isTempFile: false,
                browserUrl: url
            };

            this.tabs.set(uniqueKey, tabData);
            targetGroup.tabs.set(uniqueKey, tabData);

            if (targetGroup.tabBar) {
                this.bindTabBarEvents(targetGroup.tabBar);
                targetGroup.tabBar.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                targetGroup.tabBar.appendChild(tabElement);
            }
            targetGroup.activeTabKey = uniqueKey;

            this.activeTab = title;
            this.activeTabKey = uniqueKey;
            this.activeGroupId = targetGroupId;
            tabElement.classList.add('active');

            this.setTabElementUniqueKey(tabElement, uniqueKey);
            this.syncGroupTabs(targetGroupId);

            // 创建浏览器容器并添加到编辑区
            if (window.browserManager) {
                const container = window.browserManager.getOrCreateContainer({
                    groupId: targetGroupId,
                    uniqueKey,
                    url
                });
                if (container && targetGroup.editorArea) {
                    targetGroup.editorArea.appendChild(container);
                }
            }

            await this.activateTabByUniqueKey(uniqueKey);
            this.refreshTabLabels();
        } finally {
            this._openingKeys.delete(uniqueKey);
        }
    }

    createMarkdownPreviewContainer(options: MarkdownPreviewOptions): HTMLElement | null {
        const { groupId, tabId, content, filePath } = options;
        const group = this.groups.get(groupId as string);
        if (!group || !group.editorArea) return null;

        let container = group.editorArea.querySelector(`.markdown-preview-container[data-tab-id="${tabId}"]`) as HTMLElement | null;
        if (!container) {
            container = document.createElement('div');
            container.className = 'markdown-preview-container markdown-body';
            container.dataset['tabId'] = tabId as string;
            container.dataset['groupId'] = groupId as string;
            container.style.display = 'none';
            container.style.overflow = 'auto';
            container.style.backgroundColor = 'transparent';
            container.style.width = '100%';
            container.style.height = '100%';
            group.editorArea.appendChild(container);
        }

        this.updateMarkdownPreview(container, content, filePath);
        return container;
    }

    updateMarkdownPreview(container: HTMLElement | null | undefined, content: string | null | undefined, filePath: string | null | undefined) {
        if (window.markdownAPI) {
            (container as HTMLElement).innerHTML = window.markdownAPI.render(content || '', filePath as string);
        } else {
            (container as HTMLElement).textContent = window.i18n.t('tabs.markdownApiUnavailable');
        }
    }

    // Markdown 预览每次按键都要全量重新渲染，开销较重；
    // 合并为停手后渲染一次，避免连续输入时反复触发 markdown-it + highlight
    debouncedUpdateMarkdownPreview(editor: monaco.editor.IStandaloneCodeEditor, timerKey: '_markdownLiveTimer' | '_markdownPreviewSyncTimer', container: HTMLElement | null | undefined, filePath: string | null | undefined) {
        if (!container) return;
        const pending = editor[timerKey];
        if (pending) {
            clearTimeout(pending);
        }
        editor[timerKey] = setTimeout(() => {
            editor[timerKey] = null;
            if (!container.isConnected) return;
            this.updateMarkdownPreview(container, editor.getValue(), filePath);
        }, 250);
    }

    setupMarkdownLiveUpdate(tabId: string | null | undefined, previewContainer: HTMLElement | null | undefined, filePath: string | null | undefined) {
        if (!this.monacoEditorManager) return;
        const editor = tabId ? this.monacoEditorManager.editors.get(tabId) : null;
        if (editor && 'onDidChangeModelContent' in editor && !editor._markdownListenerAttached) {
            editor.onDidChangeModelContent(() => {
                this.debouncedUpdateMarkdownPreview(editor, '_markdownLiveTimer', previewContainer, filePath);
            });
            editor._markdownListenerAttached = true;

            editor.onDidScrollChange((e) => {
                if (!previewContainer || previewContainer.style.display === 'none') return;
                // monaco 的 IScrollEvent 不带视口高度（旧代码读 e.viewHeight 恒为 undefined，
                // 算出 NaN 后整条同步被丢掉），改用编辑器布局高度求滚动比例
                const scrollable = e.scrollHeight - editor.getLayoutInfo().height;
                if (scrollable > 0) {
                    const percentage = e.scrollTop / scrollable;
                    previewContainer.scrollTop = percentage * (previewContainer.scrollHeight - previewContainer.clientHeight);
                }
            });
        }
    }

    isMarkdownTab(tabData: TabRecord | null | undefined) {
        if (!tabData) return false;
        const filePath = String(tabData.filePath || '').toLowerCase();
        const fileName = String(tabData.fileName || '').toLowerCase();
        return filePath.endsWith('.md') || fileName.endsWith('.md');
    }

    resolveMarkdownSourceTabForPreviewToggle(initialTabData: TabRecord | null = null) {
        const normalizePath = (p: string | null | undefined) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const isValidSourceTab = (tab: TabRecord | null | undefined) => !!tab && tab.viewType !== 'markdown-preview' && this.isMarkdownTab(tab);

        let tabData: TabRecord | null | undefined = initialTabData;
        if (tabData?.viewType === 'markdown-preview' && tabData.sourceTabKey) {
            const sourceTab = this.tabs.get(tabData.sourceTabKey);
            if (isValidSourceTab(sourceTab)) {
                return sourceTab;
            }
        }
        if (isValidSourceTab(tabData)) {
            return tabData;
        }

        const mm = this.monacoEditorManager || window.monacoEditorManager;
        const currentPath = normalizePath(mm?.currentEditor?.filePath || mm?.currentFilePath || '');
        const currentName = String(mm?.currentEditor?.fileName || mm?.currentFileName || '').toLowerCase();

        if (currentPath) {
            for (const tab of this.tabs.values()) {
                if (!isValidSourceTab(tab)) continue;
                if (normalizePath(tab.filePath) === currentPath) {
                    return tab;
                }
            }
        }

        if (currentName && currentName.endsWith('.md')) {
            for (const tab of this.tabs.values()) {
                if (!isValidSourceTab(tab)) continue;
                if (String(tab.fileName || '').toLowerCase() === currentName) {
                    return tab;
                }
            }
        }

        const activeGroup = this.groups.get(this.activeGroupId || '');
        if (activeGroup?.activeTabKey) {
            const activeGroupTab = this.tabs.get(activeGroup.activeTabKey);
            if (isValidSourceTab(activeGroupTab)) {
                return activeGroupTab;
            }
        }

        for (const tab of this.tabs.values()) {
            if (isValidSourceTab(tab)) {
                return tab;
            }
        }

        return null;
    }

    toggleMarkdownSplitView() {
        const initialTabData = this.activeTabKey ? this.tabs.get(this.activeTabKey) : null;
        const tabData = this.resolveMarkdownSourceTabForPreviewToggle(initialTabData);
        if (!tabData) return;

        this.activeTabKey = tabData.uniqueKey as string | null;
        this.activeTab = tabData;
        this.activeGroupId = tabData.groupId || this.activeGroupId;

        const previewUniqueKey = `${tabData.uniqueKey}::preview`;
        const existingPreviewTab = this.tabs.get(previewUniqueKey);

        if (existingPreviewTab) {
            const previewGroup = this.groups.get(existingPreviewTab.groupId as string);
            const hasValidGroup = !!previewGroup;
            const hasValidElement = !!(existingPreviewTab.element && existingPreviewTab.element.isConnected);

            if (!hasValidGroup || !hasValidElement) {
                try {
                    if (existingPreviewTab.previewContainer?.parentNode) {
                        existingPreviewTab.previewContainer.parentNode.removeChild(existingPreviewTab.previewContainer);
                    }
                } catch (_) { }
                this.tabs.delete(previewUniqueKey);
            } else {
                this.closeTabByUniqueKey(previewUniqueKey);
                return;
            }
        }

        this.openMarkdownPreviewInNewGroup(tabData);
    }

    async openMarkdownPreviewInNewGroup(sourceTabData: TabRecord) {
        const sourceGroupId = sourceTabData.groupId;
        const sourceGroup = this.groups.get(sourceGroupId as string);
        if (!sourceGroup) return;

        const newGroup = this.createGroup({ afterGroupId: sourceGroupId });
        if (!newGroup) return;

        const previewUniqueKey = `${sourceTabData.uniqueKey}::preview`;
        const previewFileName = window.i18n.t('tabs.previewSuffix', { name: sourceTabData.fileName });
        const previewTabId = `preview-${sourceTabData.tabId}`;

        let content = sourceTabData.content || '';
        if (this.monacoEditorManager) {
            const editor = sourceTabData.tabId ? this.monacoEditorManager.editors.get(sourceTabData.tabId) : null;
            if (editor && 'onDidChangeModelContent' in editor) {
                content = editor.getValue();
            }
        }

        const tabElement = this.createTabElement(previewFileName, previewTabId);
        tabElement.dataset['viewType'] = 'markdown-preview';
        tabElement.dataset['groupId'] = newGroup.id;
        this.addTabDragListeners(tabElement);

        const previewTabData: TabRecord = {
            element: tabElement,
            fileName: previewFileName,
            modified: false,
            content: content,
            active: true,
            filePath: sourceTabData.filePath,
            tabId: previewTabId,
            uniqueKey: previewUniqueKey,
            groupId: newGroup.id,
            viewType: 'markdown-preview',
            isTempFile: false,
            isPreviewTab: true,
            sourceTabKey: sourceTabData.uniqueKey
        };

        this.tabs.set(previewUniqueKey, previewTabData);
        newGroup.tabs.set(previewUniqueKey, previewTabData);

        if (newGroup.tabBar) {
            newGroup.tabBar.appendChild(tabElement);
        }
        newGroup.activeTabKey = previewUniqueKey;

        tabElement.classList.add('active');
        this.setTabElementUniqueKey(tabElement, previewUniqueKey);

        previewTabData.previewContainer = this.createMarkdownPreviewContainer({
            groupId: newGroup.id,
            tabId: previewTabId,
            content: content,
            filePath: sourceTabData.filePath
        });

        if (previewTabData.previewContainer) {
            previewTabData.previewContainer.style.display = 'block';
            previewTabData.previewContainer.style.width = '100%';
        }

        this.setupMarkdownPreviewSync(sourceTabData.tabId, previewTabData);

        this.syncGroupTabs(newGroup.id);
        this.refreshTabLabels();

        this.activateTabByUniqueKey(previewUniqueKey).catch(logError);
    }

    setupMarkdownPreviewSync(sourceTabId: string | null | undefined, previewTabData: TabRecord) {
        if (!this.monacoEditorManager) return;
        const editor = sourceTabId ? this.monacoEditorManager.editors.get(sourceTabId) : null;
        if (editor && 'onDidChangeModelContent' in editor && !editor._markdownPreviewSyncAttached) {
            editor.onDidChangeModelContent(() => {
                if (previewTabData.previewContainer) {
                    this.debouncedUpdateMarkdownPreview(editor, '_markdownPreviewSyncTimer', previewTabData.previewContainer, previewTabData.filePath);
                }
            });
            editor._markdownPreviewSyncAttached = true;

            editor.onDidScrollChange((e) => {
                const container = previewTabData.previewContainer;
                if (!container || container.style.display === 'none') return;
                // 同上：视口高度取自身 clientHeight，旧代码读的是 previewTabData['clientHeight']（恒 undefined）
                const scrollable = e.scrollHeight - editor.getLayoutInfo().height;
                if (scrollable > 0) {
                    const percentage = e.scrollTop / scrollable;
                    container.scrollTop = percentage * (container.scrollHeight - container.clientHeight);
                }
            });
        }
    }

    async openFile(fileName: string, content: string | null = '', isNew = false, filePath: string | OpenFileOptions | null = null) {
        if (this.tabs && typeof this.tabs.has === 'function' && this.tabs.has('Welcome')) {
            try {
                this.closeWelcomePage();
            } catch (e) {
                logWarn('关闭欢迎页面失败:', e);
            }
        }
        let openOptions: OpenFileOptions = {};
        let pdfBase64: string | null = null;
        if (filePath && typeof filePath === 'object' && !Array.isArray(filePath)) {
            openOptions = filePath;
            filePath = openOptions.filePath || null;
        }
        if (openOptions && typeof openOptions === 'object' && typeof openOptions.pdfBase64 === 'string' && openOptions.pdfBase64.trim()) {
            pdfBase64 = openOptions.pdfBase64.trim();
        }

        let uniqueKey = fileName;
        if (filePath && typeof filePath === 'string' && !isNew) {
            uniqueKey = filePath.replace(/\\/g, '/');
        }

        if (this.tabs.has(uniqueKey)) {
            await this.activateTabByUniqueKey(uniqueKey);
            this.refreshTabLabels();
            return;
        }
        if (this._openingKeys.has(uniqueKey)) {
            return;
        }
        this._openingKeys.add(uniqueKey);

        try {
            let tabId: string;
            let targetGroupId = this.activeGroupId || this.groupOrder[0] || 'group-1';
            if (openOptions && typeof openOptions === 'object') {
                targetGroupId = openOptions.groupId || openOptions.targetGroupId || targetGroupId;
            }

            // If the active group is a markdown preview group, open regular files in the source code group by default.
            if (!openOptions?.groupId && !openOptions?.targetGroupId && this.activeTabKey) {
                const activeTabData = this.tabs.get(this.activeTabKey);
                if (activeTabData?.viewType === 'markdown-preview' && activeTabData.sourceTabKey) {
                    const sourceTab = this.tabs.get(activeTabData.sourceTabKey);
                    if (sourceTab?.groupId && this.groups.has(sourceTab.groupId)) {
                        targetGroupId = sourceTab.groupId;
                    }
                }
            }

            const requestedViewType = (openOptions && typeof openOptions === 'object' && openOptions.viewType)
                ? String(openOptions.viewType).toLowerCase()
                : null;
            const isPdf = requestedViewType === 'pdf' || (this.isPdfFile(fileName) && !isNew);
            const isMarkdown = fileName.toLowerCase().endsWith('.md');
            let initialViewType = 'code';
            const explicitMarkdownSplit = requestedViewType === 'markdown-split' || requestedViewType === 'markdown-preview';

            if (isMarkdown) {
                initialViewType = explicitMarkdownSplit ? 'markdown-split' : 'code';
            }

            const isTempFile = !!(openOptions && typeof openOptions === 'object' && openOptions.isTempFile);
            let targetGroup: EditorGroup | null | undefined = this.groups.get(targetGroupId);
            if (!targetGroup) {
                targetGroup = this.createGroup({ afterGroupId: this.activeGroupId });
                targetGroupId = targetGroup?.id || targetGroupId;
            }
            if (!targetGroup) {
                logError('无法创建或找到目标分组，放弃打开文件:', targetGroupId);
                return;
            }

            if (isPdf) {
                const effectiveFilePath = typeof filePath === 'string' && filePath.trim() ? filePath : null;
                if (!effectiveFilePath && !pdfBase64) {
                    logError('打开PDF失败：缺少文件路径或数据');
                    return;
                }
                await this.openPdfTab({
                    fileName,
                    filePath: effectiveFilePath,
                    uniqueKey,
                    targetGroupId,
                    targetGroup,
                    isTempFile,
                    pdfBase64
                });
                return;
            }

            if (isMarkdown && initialViewType !== 'markdown-split') {
                try {
                    const previewUniqueKey = `${uniqueKey}::preview`;
                    if (this.tabs.has(previewUniqueKey)) {
                        this.closeTabByUniqueKey(previewUniqueKey, { force: true });
                    }
                } catch (e) {
                    logWarn('清理遗留 Markdown 预览标签失败:', e);
                }
            }

            const codeFilePath: string | null = typeof filePath === 'string' ? filePath : null;
            if (this.monacoEditorManager) {
                tabId = this.monacoEditorManager.generateTabId(fileName, codeFilePath);
                if (codeFilePath) {
                    this.monacoEditorManager.currentFilePath = codeFilePath;
                    this.monacoEditorManager.currentFileName = fileName;
                }
                await this.monacoEditorManager.createNewEditor(tabId, fileName, content ?? '', codeFilePath, { groupId: targetGroupId });
            } else {
                tabId = `fallback-${Date.now()}`;
            }

            const tabElement = this.createTabElement(fileName, tabId);
            tabElement.dataset['viewType'] = initialViewType;

            tabElement.dataset['groupId'] = targetGroupId;
            this.addTabDragListeners(tabElement);

            const tabData: TabRecord = {
                element: tabElement,
                fileName: fileName,
                modified: isNew,
                content: content,
                active: true,
                filePath: codeFilePath,
                tabId: tabId,
                uniqueKey: uniqueKey,
                groupId: targetGroupId,
                viewType: initialViewType,
                isTempFile,
                externalModified: false,
                externalChangeType: null,
                externalPromptDismissed: false,
                externalPromptInProgress: false,
                pendingExternalPrompt: false,
                externalChangeTimestamp: null
            };
            this.tabs.set(uniqueKey, tabData);

            if (targetGroup) {
                targetGroup.tabs.set(uniqueKey, tabData);
                if (targetGroup.tabBar) {
                    this.bindTabBarEvents(targetGroup.tabBar);
                    targetGroup.tabBar.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                    targetGroup.tabBar.appendChild(tabElement);
                }
                targetGroup.activeTabKey = uniqueKey;
            }

            this.activeTab = fileName;
            this.activeTabKey = uniqueKey;
            this.activeGroupId = targetGroupId;
            tabElement.classList.add('active');

            this.setTabElementUniqueKey(tabElement, uniqueKey);

            this.syncGroupTabs(targetGroupId);

            if (tabData.filePath) {
                await this.registerFileWatchForTab(tabData);
            }

            await this.activateTabByUniqueKey(uniqueKey);
            this.refreshTabLabels();

            if (initialViewType === 'markdown-split') {
                tabData.viewType = 'code';
                tabElement.dataset['viewType'] = 'code';
                setTimeout(() => {
                    this.openMarkdownPreviewInNewGroup(tabData);
                }, 100);
            }
        } finally {
            this._openingKeys.delete(uniqueKey);
        }
    }

    async openDiff(files: DiffFileCandidate[] | null | undefined) {
        const candidates = Array.isArray(files) ? files.filter(f => f && f.type === 'file' && f.path) : [];
        if (candidates.length !== 2) {
            logWarn('openDiff 需要正好两个有效文件');
            return;
        }

        if (!this.monacoEditorManager) {
            logError('打开对比失败: 未初始化编辑器管理器');
            return;
        }

        const [original, modified] = candidates as [DiffFileCandidate, DiffFileCandidate];
        const normalizePath = (p: string | null | undefined) => (typeof p === 'string' ? p.replace(/\\/g, '/') : '');
        const originalPath = normalizePath(original.path);
        const modifiedPath = normalizePath(modified.path);
        const uniqueKey = `diff:${originalPath}::${modifiedPath}`;

        if (this.tabs.has(uniqueKey)) {
            await this.activateTabByUniqueKey(uniqueKey);
            this.refreshTabLabels();
            return;
        }
        if (this._openingKeys.has(uniqueKey)) {
            return;
        }
        this._openingKeys.add(uniqueKey);

        try {
            const label = `${original.name || window.i18n.t('tabs.originalFile')} vs ${modified.name || window.i18n.t('tabs.newFile')}`;
            let targetGroupId = this.activeGroupId || this.groupOrder[0] || 'group-1';
            let targetGroup = this.groups.get(targetGroupId) as EditorGroup | null | undefined;
            if (!targetGroup) {
                targetGroup = this.createGroup({ afterGroupId: this.activeGroupId });
                targetGroupId = targetGroup?.id || targetGroupId;
            }

            const readContent = async (file: DiffFileCandidate | null | undefined) => {
                if (window.electronAPI?.readFileContent && file?.path) {
                    try {
                        return await window.electronAPI.readFileContent(file.path as string);
                    } catch (error) {
                        logWarn('读取文件内容失败:', error);
                    }
                }
                return '';
            };

            const [originalContent, modifiedContent] = await Promise.all([
                readContent(original),
                readContent(modified)
            ]);

            const tabId = this.monacoEditorManager.generateTabId(label, uniqueKey);
            const tabElement = this.createTabElement(label, tabId);
            tabElement.dataset['viewType'] = 'diff';
            tabElement.dataset['groupId'] = targetGroupId;
            tabElement.classList.add('tab-type-diff');
            this.addTabDragListeners(tabElement);

            const tabData: TabRecord = {
                element: tabElement,
                fileName: label,
                modified: false,
                content: modifiedContent,
                active: true,
                filePath: modified.path,
                tabId,
                uniqueKey,
                groupId: targetGroupId,
                viewType: 'diff',
                diffMeta: {
                    originalPath,
                    modifiedPath,
                    originalName: original.name,
                    modifiedName: modified.name,
                    originalContent,
                    modifiedContent
                }
            };

            this.tabs.set(uniqueKey, tabData);

            if (targetGroup) {
                targetGroup.tabs.set(uniqueKey, tabData);
                if (targetGroup.tabBar) {
                    this.bindTabBarEvents(targetGroup.tabBar);
                    targetGroup.tabBar.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                    targetGroup.tabBar.appendChild(tabElement);
                }
                targetGroup.activeTabKey = uniqueKey;
            }

            this.activeTab = label;
            this.activeTabKey = uniqueKey;
            this.activeGroupId = targetGroupId;
            tabElement.classList.add('active');

            this.setTabElementUniqueKey(tabElement, uniqueKey);

            this.syncGroupTabs(targetGroupId);

            await this.monacoEditorManager.createDiffEditor(tabId, {
                groupId: targetGroupId,
                originalPath,
                modifiedPath,
                originalContent,
                modifiedContent,
                label
            });

            await this.activateTabByUniqueKey(uniqueKey);
            this.refreshTabLabels();
        } catch (error) {
            logError('打开文件对比失败:', error);
            try {
                logWarn('[TabOpenCompareErrorSuppressed]', (error as { message?: string })?.message || '打开文件对比失败');
            } catch (e) {
                logWarn('显示错误提示失败:', e);
            }
        } finally {
            this._openingKeys.delete(uniqueKey);
        }
    }

    syncTabDOMWithMap(fileName: string | null | undefined, filePath: string | null | undefined) {
        logInfo(`同步标签页DOM: ${fileName}`);

        const allTabs = document.querySelectorAll('.tab');
        for (const tabElRaw of allTabs) {
            if (!(tabElRaw instanceof HTMLElement)) continue;
            const tabEl = tabElRaw;
            const tabLabel = tabEl.querySelector('.tab-label');
            const datasetFileName = typeof tabEl.dataset?.['file'] === 'string' ? tabEl.dataset['file'] : '';
            const labelText = tabLabel?.querySelector?.('.tab-label-text')?.textContent || tabLabel?.textContent || '';
            const strippedLabel = (labelText.split(' — ')[0] as string).trim();
            const candidateName = datasetFileName || strippedLabel;

            if (candidateName === fileName) {
                if (!tabEl.dataset['tabId'] && this.monacoEditorManager && this.monacoEditorManager.generateTabId) {
                    const tabId = this.monacoEditorManager.generateTabId(fileName, filePath);
                    tabEl.dataset['tabId'] = tabId;
                    logInfo(`为标签页 ${fileName} 设置 tabId: ${tabId}`);
                }
                break;
            }
        }
    }

    createTabElement(fileName: string | null | undefined, tabId: string | null | undefined) {
        const tab = document.createElement('div');
        tab.className = 'tab';
        tab.dataset['file'] = fileName as string;
        tab.dataset['tabId'] = tabId as string;
        tab.draggable = true;  // 启用拖拽

        const label = document.createElement('span');
        label.className = 'tab-label';
        const labelText = document.createElement('span');
        labelText.className = 'tab-label-text';
        labelText.textContent = fileName as string;
        label.appendChild(labelText);

        const closeBtn = document.createElement('span');
        closeBtn.className = 'tab-close';
        closeBtn.textContent = '×';

        tab.appendChild(label);
        tab.appendChild(closeBtn);

        tab.addEventListener('click', (e) => {
            if (e.target instanceof Element && e.target.classList.contains('tab-close')) {
                return;
            }
            const uniqueKey = tab.dataset['uniqueKey'];
            logInfo('标签页点击:', fileName, 'DOM uniqueKey:', uniqueKey);
            if (uniqueKey && this.tabs.has(uniqueKey)) {
                this.activateTabByUniqueKey(uniqueKey).catch(logError);
            } else {
                this.activateTab(fileName).catch(logError);
            }
        });

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const uniqueKey = tab.dataset['uniqueKey'];
            logInfo('关闭标签页:', fileName, 'DOM uniqueKey:', uniqueKey);
            if (uniqueKey && this.tabs.has(uniqueKey)) {
                this.closeTabByUniqueKey(uniqueKey);
            } else {
                this.closeTab(fileName);
            }
        });

        tab.addEventListener('mouseup', (e) => {
            if (e.button === 1) {
                e.preventDefault();
                const uniqueKey = tab.dataset['uniqueKey'];
                logInfo('中键关闭标签页:', fileName, 'DOM uniqueKey:', uniqueKey);
                if (uniqueKey && this.tabs.has(uniqueKey)) {
                    this.closeTabByUniqueKey(uniqueKey);
                } else {
                    this.closeTab(fileName);
                }
            }
        });

        tab.addEventListener('contextmenu', (e) => {
            this.showTabContextMenu(e, tab);
        });


        return tab;
    }

    showTabContextMenu(event: MouseEvent, tabElement: HTMLElement | null | undefined) {
        if (!event || !tabElement) return;
        event.preventDefault();
        event.stopPropagation();

        this.hideTabContextMenu();

        const uniqueKey = tabElement.dataset['uniqueKey'];
        const tabData = uniqueKey ? this.tabs.get(uniqueKey) : null;
        if (!uniqueKey || !tabData) return;

        const menu = document.createElement('div');
        menu.className = 'context-menu tab-context-menu';
        menu.style.position = 'fixed';
        menu.style.zIndex = '10000';

        const filePath = this.getTabFilePath(tabData, uniqueKey);
        const menuItems = [
            {
                label: window.i18n.t('tabs.openInExplorer'),
                action: () => {
                    if (!filePath) {
                        window.oicppApp?.showMessage?.(window.i18n.t('tabs.openInExplorerUnavailable'), 'warning');
                        return;
                    }
                    this.openInSystemExplorer(filePath);
                }
            },
            { label: '---' },
            {
                label: window.i18n.t('tabs.closeThisTab'),
                action: () => this.closeTabByUniqueKey(uniqueKey)
            },
            {
                label: window.i18n.t('tabs.closeOtherTabs'),
                action: () => this.closeOtherTabsByUniqueKey(uniqueKey)
            },
            {
                label: window.i18n.t('tabs.closeTabsToRight'),
                action: () => this.closeTabsToRightByUniqueKey(uniqueKey)
            }
        ];

        menuItems.forEach((menuItem) => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            if (menuItem.label === '---') {
                item.setAttribute('data-separator', 'true');
            } else {
                item.textContent = menuItem.label;
                item.addEventListener('click', () => {
                    menuItem.action?.();
                    this.hideTabContextMenu();
                });
            }
            menu.appendChild(item);
        });

        document.body.appendChild(menu);
        this._tabContextMenu = menu;

        const menuRect = menu.getBoundingClientRect();
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        let left = event.clientX;
        let top = event.clientY;

        if (left + menuRect.width > windowWidth) {
            left = windowWidth - menuRect.width - 10;
        }
        if (top + menuRect.height > windowHeight) {
            top = windowHeight - menuRect.height - 10;
        }
        menu.style.left = `${Math.max(0, left)}px`;
        menu.style.top = `${Math.max(0, top)}px`;

        const hideMenu = (e: Event) => {
            if (!menu.contains(e.target as Node)) {
                this.hideTabContextMenu();
                document.removeEventListener('click', hideMenu);
                document.removeEventListener('contextmenu', hideMenu, true);
            }
        };
        document.addEventListener('click', hideMenu);
        document.addEventListener('contextmenu', hideMenu, true);
    }

    hideTabContextMenu() {
        if (this._tabContextMenu) {
            this._tabContextMenu.remove();
            this._tabContextMenu = null;
        }
    }

    getTabFilePath(tabData: TabRecord | null | undefined, uniqueKey: string | null | undefined) {
        if (!tabData && !uniqueKey) return null;
        const raw = tabData?.filePath || tabData?.uniqueKey || uniqueKey || '';
        if (typeof raw !== 'string' || !raw.trim()) return null;
        if (raw.includes('/') || raw.includes('\\')) {
            return raw;
        }
        return null;
    }

    openInSystemExplorer(filePath: string | null | undefined) {
        try {
            if (!filePath) return;
            if (window.electronAPI?.openPath) {
                window.electronAPI.openPath(filePath, { reveal: true });
            } else if (window.electronAPI?.showItemInFolder) {
                window.electronAPI.showItemInFolder(filePath);
            } else if (window.electron?.shell?.showItemInFolder) {
                window.electron.shell.showItemInFolder(filePath);
            } else if (window.electron?.shell?.openPath) {
                window.electron.shell.openPath(filePath);
            }
        } catch (error) {
            logWarn('打开资源管理器失败:', error);
        }
    }

    closeOtherTabsByUniqueKey(uniqueKey: string | null | undefined) {
        if (!uniqueKey) return;
        const tabData = this.tabs.get(uniqueKey);
        if (!tabData) return;
        const groupId = tabData.groupId || this.activeGroupId;
        const group = groupId ? this.groups.get(groupId) : null;
        let tabsToClose: string[] = [];
        if (group && Array.isArray(group.tabOrder)) {
            tabsToClose = group.tabOrder.filter(key => key !== uniqueKey);
        } else {
            tabsToClose = Array.from(this.tabs.keys()).filter(key => key !== uniqueKey);
        }

        const modifiedTabs = tabsToClose.filter(key => this.tabs.get(key)?.modified);
        if (modifiedTabs.length > 0) {
            const result = confirm(window.i18n.t('tabs.closeOtherConfirm', { count: modifiedTabs.length }));
            if (!result) return;
        }

        tabsToClose.forEach(key => {
            this.closeTabByUniqueKey(key, { skipCloseConfirm: true });
        });
    }

    closeTabsToRightByUniqueKey(uniqueKey: string | null | undefined) {
        if (!uniqueKey) return;
        const tabData = this.tabs.get(uniqueKey);
        if (!tabData) return;
        const groupId = tabData.groupId || this.activeGroupId;
        const group = groupId ? this.groups.get(groupId) : null;
        if (!group || !Array.isArray(group.tabOrder)) return;
        const index = group.tabOrder.indexOf(uniqueKey);
        if (index === -1) return;
        const tabsToClose = group.tabOrder.slice(index + 1);
        if (!tabsToClose.length) return;

        const modifiedTabs = tabsToClose.filter(key => this.tabs.get(key)?.modified);
        if (modifiedTabs.length > 0) {
            const result = confirm(window.i18n.t('tabs.closeRightConfirm', { count: modifiedTabs.length }));
            if (!result) return;
        }

        tabsToClose.forEach(key => {
            this.closeTabByUniqueKey(key, { skipCloseConfirm: true });
        });
    }

    addTabDragListeners(tab: HTMLElement) {
        if (!tab || tab._dragListenersBound) {
            return;
        }

        if (!tab.draggable) {
            tab.draggable = true;
        }

        const ensureTabBar = () => {
            const parent = tab.parentNode as HTMLElement | null;
            if (parent) {
                this.bindTabBarEvents(parent);
            }
            return parent;
        };

        const tabBar = ensureTabBar();

        const forwardDragHover = (event: DragEvent) => {
            if (!event) {
                return;
            }
            const hostBar = ensureTabBar();
            if (!hostBar || !this.draggedTab) {
                return;
            }
            this.handleTabBarDragOver(event, hostBar);
            event.stopPropagation();
        };

        tab.addEventListener('dragstart', (e) => {
            this.draggedTab = tab;
            const uniqueKey = tab.dataset['uniqueKey'];
            const groupId = tab.dataset['groupId'] || tab.parentElement?.dataset['groupId'] || (tab.closest('.editor-group') as HTMLElement | null)?.dataset['groupId'] || this.activeGroupId;
            this.draggedTabInfo = { uniqueKey, groupId };
            this.dropHandled = false;
            this.lastTabDropInfo = null;

            tab.classList.add('dragging');
            tab.style.opacity = '0.5';
            this.tabDragInProgress = true;

            (e.dataTransfer as DataTransfer).effectAllowed = 'move';
            if (uniqueKey) {
                (e.dataTransfer as DataTransfer).setData('application/oicpp-tab', uniqueKey);
            }
            (e.dataTransfer as DataTransfer).setData('text/plain', uniqueKey || '');

            try {
                const rect = tab.getBoundingClientRect();
                const canvas = document.createElement('canvas');
                canvas.width = rect.width;
                canvas.height = rect.height;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

                ctx.fillStyle = getComputedStyle(tab).backgroundColor || '#2d2d30';
                ctx.fillRect(0, 0, canvas.width, canvas.height);

                ctx.fillStyle = getComputedStyle(tab).color || '#cccccc';
                ctx.font = getComputedStyle(tab).font || '13px "Segoe UI", sans-serif';
                const label = tab.querySelector('.tab-label');
                if (label) {
                    ctx.fillText(label.textContent as string, 10, canvas.height / 2 + 5);
                }

                const dataUrl = canvas.toDataURL('image/png');
                if (dataUrl && dataUrl.startsWith('data:')) {
                    const img = new Image();
                    img.onload = () => {
                        (e.dataTransfer as DataTransfer).setDragImage(img, rect.width / 2, rect.height / 2);
                    };
                    img.src = dataUrl;
                } else {
                    throw new Error('Failed to generate drag image data URL');
                }
            } catch (err) {
                const dragImage = new Image();
                dragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=';
                (e.dataTransfer as DataTransfer).setDragImage(dragImage, 0, 0);
            }

            if (this.canSplitGroup(groupId)) {
                this.showSplitOverlay(groupId);
            } else {
                this.hideSplitOverlay();
            }

        });
        tab.addEventListener('dragend', (e) => {
            const shouldFallback = !this.dropHandled && this.lastTabDropInfo && this.draggedTabInfo;
            if (shouldFallback) {
                const fallbackInfo = { ...this.lastTabDropInfo };
                const applied = this.applyTabDrop(fallbackInfo);
            }

            this.cleanupTabDrag(tab);
            this.dropHandled = false;
        });

        tab.addEventListener('dragenter', (event) => {
            event.preventDefault();
            forwardDragHover(event);
        });
        tab.addEventListener('dragover', (event) => {
            event.preventDefault();
            forwardDragHover(event);
        });
        tab.addEventListener('drop', (event) => {
            const hostBar = ensureTabBar();
            if (!hostBar) {
                return;
            }
            this.handleTabBarDrop(event, hostBar);
            event.stopPropagation();
        });

        tab._dragListenersBound = true;
    }

    getDragAfterElement(container: HTMLElement | null | undefined, x: number) {
        const draggableElements = [...(container as HTMLElement).querySelectorAll('.tab:not(.dragging):not(.tab-placeholder)')];

        return draggableElements.reduce<{ offset?: number; element?: Element }>((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = x - box.left - box.width / 2;

            if (offset < 0 && offset > (closest.offset || Number.NEGATIVE_INFINITY)) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, {}).element || null;
    }

    reorderTabs(draggedTab: HTMLElement, targetTab: HTMLElement) {
        const tabBar = draggedTab.parentNode as HTMLElement;
        const draggedIndex = Array.from(tabBar.children).indexOf(draggedTab);
        const targetIndex = Array.from(tabBar.children).indexOf(targetTab);

        if (draggedIndex < targetIndex) {
            tabBar.insertBefore(draggedTab, targetTab.nextSibling);
        } else {
            tabBar.insertBefore(draggedTab, targetTab);
        }

        const groupId = tabBar?.dataset?.['groupId'] || null;
        this.syncTabOrder(groupId);
    }


    syncTabOrder(groupId: string | null = null) {
        if (groupId) {
            this.syncGroupTabs(groupId);
        } else {
            this.groups.forEach((_, id) => this.syncGroupTabs(id));
        }
    }

    createEditorPane(fileName: string | null | undefined, content: string | null = '') {
        return null;
    }

    async switchToNextTab() {
        if (this.tabOrder.length <= 1) return;

        const currentIndex = this.tabOrder.indexOf(this.activeTab as string);
        const nextIndex = (currentIndex + 1) % this.tabOrder.length;
        const nextTab = this.tabOrder[nextIndex];

        await this.activateTab(nextTab);
    }

    async switchToPreviousTab() {
        if (this.tabOrder.length <= 1) return;

        const currentIndex = this.tabOrder.indexOf(this.activeTab as string);
        const prevIndex = (currentIndex - 1 + this.tabOrder.length) % this.tabOrder.length;
        const prevTab = this.tabOrder[prevIndex];

        await this.activateTab(prevTab);
    }

    isAltWheelTabSwitchTarget(target: EventTarget | null) {
        if (!(target instanceof Element)) {
            return false;
        }

        if (target.closest('input, textarea, select, [contenteditable="true"]')) {
            return false;
        }

        if (target.closest('.dialog-overlay, .quick-open-overlay, .menu-dropdown, .global-settings, .integrated-terminal-panel, .sidebar')) {
            return false;
        }

        return Boolean(target.closest('#editor-groups, .editor-groups, .editor-group, .editor-area, .tab-bar, .tab, .monaco-editor, .monaco-editor-container'));
    }

    handleAltWheelTabSwitch(event: WheelEvent) {
        if (!event?.altKey) {
            return;
        }

        if (!this.isAltWheelTabSwitchTarget(event.target)) {
            return;
        }

        if (Math.abs(Number(event.deltaY) || 0) < 1) {
            return;
        }

        const now = Date.now();
        if (now - this._lastAltWheelSwitchTs < 80) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        this._lastAltWheelSwitchTs = now;

        event.preventDefault();
        event.stopPropagation();

        if (event.deltaY > 0) {
            this.switchToNextTab().catch((error) => {
                logWarn('Alt+滚轮切换到下一个标签失败:', error);
            });
            return;
        }

        this.switchToPreviousTab().catch((error) => {
            logWarn('Alt+滚轮切换到上一个标签失败:', error);
        });
    }

    markTabAsModified(fileName: string | null | undefined) {
        const tabData = this.getTabByFileName(fileName);
        if (tabData && !tabData.modified) {
            tabData.modified = true;
            this.refreshTabLabels();
        }
    }

    markTabAsModifiedByUniqueKey(uniqueKey: string) {
        const tabData = this.tabs.get(uniqueKey);
        if (tabData && !tabData.modified) {
            tabData.modified = true;
            this.refreshTabLabels();
        }
    }

    markTabAsSaved(fileName: string | null | undefined) {
        const tabData = this.getTabByFileName(fileName);
        if (tabData && tabData.modified) {
            tabData.modified = false;
            this.refreshTabLabels();
        }
    }

    markTabAsSavedByUniqueKey(uniqueKey: string | null | undefined) {
        const tabData = this.tabs.get(uniqueKey as string);
        if (tabData && tabData.modified) {
            tabData.modified = false;
            this.refreshTabLabels();
        }
    }

    getActiveTab() {
        return this.activeTab;
    }

    getTabCount() {
        return this.tabs.size;
    }

    getAllTabs() {
        return Array.from(this.tabs.keys());
    }

    getModifiedTabs() {
        return Array.from(this.tabs.values())
            .filter(tab => tab.modified)
            .map(tab => tab.fileName);
    }

    async autoSaveModifiedTabs() {
        if (this.isDiscardCloseInProgress()) {
            return 0;
        }
        if (!window.electronAPI || typeof window.electronAPI.saveFile !== 'function') {
            logWarn('[TabManager][自动保存] saveFile API 不可用，跳过自动保存');
            return 0;
        }

        if (!this.monacoEditorManager) {
            this.tryGetEditorManagerReference();
        }

        const modifiedEntries = Array.from(this.tabs.entries()).filter(([, tabData]) => {
            return tabData && tabData.modified && !tabData.isTempFile && tabData.viewType !== 'pdf';
        });

        if (modifiedEntries.length === 0) {
            return 0;
        }

        let savedCount = 0;

        for (const [uniqueKey, tabData] of modifiedEntries) {
            const filePath = tabData.filePath;
            if (!filePath || typeof filePath !== 'string') {
                continue;
            }
            if ((window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function' && window.oicppApp.isCloudFilePath(filePath)) || /^cloud:/i.test(filePath)) {
                continue;
            }

            const content = this.getTabContentForSave(tabData);
            if (typeof content !== 'string') {
                continue;
            }

            try {
                await window.electronAPI.saveFile(filePath, content);
                if (typeof this.markTabAsSavedByUniqueKey === 'function') {
                    this.markTabAsSavedByUniqueKey(uniqueKey);
                } else if (typeof this.markTabAsSaved === 'function') {
                    this.markTabAsSaved(tabData.fileName);
                }
                savedCount += 1;
            } catch (error) {
                logError('[TabManager][自动保存] 保存失败:', { filePath, error });
            }
        }

        return savedCount;
    }

    closeAllTabs() {
        const modifiedTabs = this.getModifiedTabs();
        if (modifiedTabs.length > 0) {
            const result = confirm(window.i18n.t('tabs.closeAllConfirm', { count: modifiedTabs.length }));
            if (!result) return;
        }

        // this.tabs 的 key 是 uniqueKey（磁盘文件即完整路径），不是 fileName，
        // 直接把 key 当 fileName 传给 closeTab 会让 getTabByFileName 全部落空
        const tabsToClose = [...this.tabs.keys()];
        tabsToClose.forEach(uniqueKey => {
            const tabData = this.tabs.get(uniqueKey);
            this.closeTab(tabData?.fileName || uniqueKey, { skipCloseConfirm: true, uniqueKeyOverride: uniqueKey });
        });
    }

    closeOtherTabs() {
        if (!this.activeTab) return;

        // 同样按 uniqueKey 比对，不能拿 key 与 fileName（this.activeTab）混比，
        // 否则当前 tab 也在待关列表内
        const currentKey = this.tabs.has(this.activeTabKey as string)
            ? this.activeTabKey
            : [...this.tabs.entries()].find(([, tabData]) => tabData?.fileName === this.activeTab)?.[0];
        const tabsToClose = [...this.tabs.keys()].filter(uniqueKey => uniqueKey !== currentKey);

        const modifiedTabs = tabsToClose.filter(uniqueKey => this.tabs.get(uniqueKey)?.modified);
        if (modifiedTabs.length > 0) {
            const result = confirm(window.i18n.t('tabs.closeOtherConfirm', { count: modifiedTabs.length }));
            if (!result) return;
        }

        tabsToClose.forEach(uniqueKey => {
            const tabData = this.tabs.get(uniqueKey);
            this.closeTab(tabData?.fileName || uniqueKey, { skipCloseConfirm: true, uniqueKeyOverride: uniqueKey });
        });
    }

    showWelcomePage() {
        logInfo('显示欢迎页面');

        const welcomeContainer = document.getElementById('welcome-container');
        const editorArea = document.querySelector('.editor-area');

        if (!welcomeContainer) {
            logError('欢迎页面容器未找到');
            return;
        }

        if (editorArea instanceof HTMLElement) {
            editorArea.style.display = 'none';
        }
        welcomeContainer.style.display = 'block';

        if (window.sidebarManager) {
            try {
                if (typeof window.sidebarManager.hideForWelcome === 'function') {
                    window.sidebarManager.hideForWelcome();
                } else if (typeof window.sidebarManager.disableResize === 'function') {
                    window.sidebarManager.disableResize();
                }
            } catch (e) { logWarn('隐藏侧边栏(欢迎页)失败:', e); }
        }

        welcomeContainer.innerHTML = this.getWelcomePageContent();

        if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
            window.uiIcons.hydrate(welcomeContainer);
        }

        this.setupWelcomeEventListeners(welcomeContainer);

        const welcomeTab = {
            fileName: 'Welcome',
            content: this.getWelcomePageContent(),
            modified: false,
            isWelcome: true
        };

        this.tabs.set('Welcome', welcomeTab as unknown as TabRecord);
        this.activeTab = 'Welcome';
    }

    showWelcomeContent() {
        const editorArea = document.querySelector('.editor-area');
        if (editorArea instanceof HTMLElement) {
            editorArea.style.display = 'none';
        }

        let welcomeContainer = document.getElementById('welcome-container');
        if (!welcomeContainer) {
            welcomeContainer = document.createElement('div');
            welcomeContainer.id = 'welcome-container';
            welcomeContainer.innerHTML = this.getWelcomePageContent();

            if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
                window.uiIcons.hydrate(welcomeContainer);
            }

            const editorTerminalContainer = document.querySelector('.editor-terminal-container');
            if (editorTerminalContainer) {
                editorTerminalContainer.appendChild(welcomeContainer);
            } else {
                logError('未找到编辑器容器');
                return;
            }

            this.setupWelcomeEventListeners(welcomeContainer);
        }

        if (window.sidebarManager) {
            try {
                if (typeof window.sidebarManager.hideForWelcome === 'function') {
                    window.sidebarManager.hideForWelcome();
                } else if (typeof window.sidebarManager.disableResize === 'function') {
                    window.sidebarManager.disableResize();
                }
            } catch (e) { logWarn('隐藏侧边栏(欢迎页)失败:', e); }
        }

        welcomeContainer.style.display = 'block';
    }

    setupWelcomeEventListeners(container: HTMLElement) {
        const actions = container.querySelectorAll('.welcome-action');
        actions.forEach(action => {
            action.addEventListener('click', (e) => {
                e.preventDefault();
                const actionType = (e.currentTarget as HTMLElement).dataset['action'];
                this.handleWelcomeAction(actionType);
            });
        });

        this.loadRecentFiles(container);
        this.updateWelcomeLogo(container);
    }

    async updateWelcomeLogo(container: HTMLElement) {
        const img = container.querySelector('.welcome-logo-image') as HTMLImageElement | null;
        if (!img) return;

        let logoPath = '';
        if (window.electronAPI && typeof window.electronAPI.getUserIconPath === 'function') {
            try {
                logoPath = await window.electronAPI.getUserIconPath();
            } catch (_) {
                logoPath = '';
            }
        }

        if (logoPath) {
            const normalized = String(logoPath).replace(/\\/g, '/');
            const encoded = encodeURI(normalized);
            const prefix = encoded.startsWith('/') ? 'file://' : 'file:///';
            img.src = `${prefix}${encoded}`;
        } else {
            img.src = '../../oicpp-plus.ico';
        }
    }

    async loadRecentFiles(container: HTMLElement) {
        try {
            const recentFiles = await window.electronAPI.getRecentFiles();
            const recentContainer = container.querySelector('#welcome-recent') as HTMLElement | null;

            if (!recentContainer) return;

            if (!recentFiles || recentFiles.length === 0) {
                recentContainer.innerHTML = `
                    <div class="welcome-recent-item">
                        <span class="icon" data-ui-icon="file" aria-hidden="true"></span>
                        <span>${window.i18n.t('welcome.noRecentFiles')}</span>
                    </div>
                `;
                if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
                    window.uiIcons.hydrate(recentContainer);
                }
                return;
            }

            const limitedRecent = recentFiles.slice(0, 5);
            recentContainer.innerHTML = limitedRecent.map(file => `
                <div class="welcome-recent-item" data-path="${file.path}">
                    <span class="icon" data-ui-icon="folder" aria-hidden="true"></span>
                    <div class="file-info">
                        <span class="file-name">${file.name}</span>
                        <span class="file-path">${file.path}</span>
                    </div>
                </div>
            `).join('');

            if (window.uiIcons && typeof window.uiIcons.hydrate === 'function') {
                window.uiIcons.hydrate(recentContainer);
            }

            const recentItems = recentContainer.querySelectorAll('.welcome-recent-item[data-path]');
            recentItems.forEach(item => {
                item.addEventListener('click', async (e) => {
                    const filePath = (e.currentTarget as HTMLElement).dataset['path'];
                    if (filePath) {
                        const success = await window.electronAPI.openRecentFile(filePath);
                        if (!success) {
                            logWarn('[RecentFileOpenErrorSuppressed]', '无法打开文件，文件可能已被删除或移动。');
                        }
                    }
                });
            });
        } catch (error) {
            logError('加载最近文件失败:', error);
        }
    }

    handleWelcomeAction(actionType: string | undefined) {
        logInfo('欢迎页面操作:', actionType);

        switch (actionType) {
            case 'new-file':
                this.createNewCppFile();
                break;
            case 'open-file':
                if (window.oicppApp && window.oicppApp.openFile) {
                    window.oicppApp.openFile();
                }
                break;
            case 'open-folder':
                if (window.oicppApp && window.oicppApp.openFolder) {
                    window.oicppApp.openFolder();
                }
                break;
            case 'open-template':
                logInfo('从模板创建功能待实现');
                break;
            default:
                logInfo('未知的欢迎页面操作:', actionType);
        }
    }

    closeWelcomePage() {
        logInfo('关闭欢迎页面');

        const welcomeContainer = document.getElementById('welcome-container');
        const editorArea = document.querySelector('.editor-area');

        if (welcomeContainer) {
            welcomeContainer.style.display = 'none';
        }

        if (editorArea instanceof HTMLElement) {
            editorArea.style.display = 'block';
        }

        if (window.sidebarManager) {
            try {
                if (typeof window.sidebarManager.showForEditor === 'function') {
                    window.sidebarManager.showForEditor();
                } else if (typeof window.sidebarManager.enableResize === 'function') {
                    window.sidebarManager.enableResize();
                }
            } catch (e) { logWarn('恢复侧边栏(退出欢迎页)失败:', e); }
        }

        // 两条身份都要认：displayWelcomePage 走 activateTabByUniqueKey，key 是 'Welcome'；
        // showWelcomePage 只把字符串 'Welcome' 赋给 activeTab，key 仍是启动时的 null。
        const welcomeWasActive = this.activeTabKey === 'Welcome' || this.activeTab === 'Welcome';

        this.tabs.delete('Welcome');

        // createNewCppFile 这类调用点在没有任何欢迎页时也会进来：
        // 无条件清 activeTab 会把当前文件的身份一起抹掉，而 activeTabKey 又留着不动，
        // 于是 key 悬空指向已删除的 'Welcome'（和 6ddac59 修的是同一类身份错位）。
        if (welcomeWasActive) {
            this.activeTab = null;
            this.activeTabKey = null;
        }
    }



    getSelectedText() {
        const activeTab = this.getTabByFileName(this.activeTab as string | null);
        if (activeTab && this.monacoEditorManager) {
            return this.monacoEditorManager.getSelectedText(activeTab.fileName);
        }
        return '';
    }

    insertText(text: string) {
        const activeTab = this.getTabByFileName(this.activeTab as string | null);
        if (activeTab && this.monacoEditorManager) {
            this.monacoEditorManager.insertText(activeTab.fileName, text);
        }
    }

    getAllFileNames() {
        return Array.from(this.tabs.values()).map(tabData => tabData.fileName);
    }

    getUnsavedFiles() {
        const unsavedFiles = [];
        for (const [uniqueKey, tabData] of this.tabs.entries()) {
            if (tabData.modified) {
                unsavedFiles.push(tabData.fileName);
            }
        }
        return unsavedFiles;
    }

    async saveFile(fileName: string | null | undefined): Promise<boolean> {
        const tab = this.getTabByFileName(fileName);
        if (!tab) return false;
        const uniqueKey = tab.uniqueKey || this.findUniqueKeyByFileName(fileName as string);
        try {
            // 原先是先落 modified=false 再叫 monaco 保存：磁盘写失败界面照样显示「已保存」，
            // 关掉窗口就没了。现在等真实结果，成功才标记。
            const result = await this.monacoEditorManager?.saveFile?.(fileName);
            if (result && result.success === false) {
                throw new Error(String(result.error || window.i18n.t('dialog.saveWriteFailed')));
            }
            if (uniqueKey) {
                this.markTabAsSavedByUniqueKey(uniqueKey);
            } else {
                this.markTabAsSaved(fileName as string);
            }
            return true;
        } catch (error) {
            logError('保存文件失败:', error);
            return false;
        }
    }

    async saveAllFiles(): Promise<{ success: boolean; failures: Array<{ fileName?: string | null; error?: string }> }> {
        const _t = (key: string, params?: Record<string, unknown>) => window.i18n?.t?.(key, params) || key;
        const failures: Array<{ fileName?: string | null; error?: string }> = [];
        if (this.isDiscardCloseInProgress()) {
            return { success: true, failures };
        }
        const isCloudPath = (p: unknown): boolean => {
            if (window.oicppApp && typeof window.oicppApp.isCloudFilePath === 'function') {
                return !!window.oicppApp.isCloudFilePath(p);
            }
            return typeof p === 'string' && /^cloud:/i.test(p);
        };

        // 按 uniqueKey 遍历、按 filePath 保存，两者不是一一对应：同一文件开在多个
        // 分栏（或存在残留 tab）时会对同一文件并发发起 N 次保存，产生多余的 IPC
        // 往返、file-saved 事件与重复的 clangd 分析。先按 filePath 归并。
        const byFilePath = new Map();
        const tasks: Array<Promise<void>> = [];
        for (const [uniqueKey, tab] of this.tabs.entries()) {
            if (!tab || tab.viewType === 'pdf' || tab.viewType === 'markdown-preview') {
                continue;
            }
            try {
                const filePath = tab.filePath;
                const content = this.getTabContentForSave(tab);
                if (typeof content !== 'string') continue;

                // 未命名标签原先是静默 continue：用户选了「保存并退出」却什么都没落盘。
                if (!filePath) {
                    if (typeof window.electronAPI?.saveAsFile !== 'function') {
                        failures.push({ fileName: tab.fileName, error: _t('dialog.saveApiUnavailable') });
                        continue;
                    }
                    tasks.push((async () => {
                        try {
                            // save-as-file 的主进程 handler 自己已经落盘并广播 file-saved，
                            // 这里再补一次 saveFile 等于同一个文件写两遍。
                            const savedPath = await window.electronAPI.saveAsFile(content);
                            if (!savedPath) {
                                failures.push({ fileName: tab.fileName, error: _t('dialog.saveNoLocation') });
                                return;
                            }
                            const newPath = String(savedPath);
                            try { this.updateTabPathBySource(null, newPath, null, uniqueKey); } catch (_) { }
                            // 换绑后条目已经迁到以新路径为 key，再按旧的 uniqueKey 标记
                            // 就是空转，标签会一直挂着未保存的小圆点。
                            this.markTabAsSavedByUniqueKey(newPath.replace(/\\/g, '/'));
                        } catch (e) {
                            failures.push({ fileName: tab.fileName, error: (e as Error)?.message || String(e) });
                        }
                    })());
                    continue;
                }

                if (isCloudPath(filePath)) {
                    tasks.push((async () => {
                        try {
                            if (window.oicppApp && typeof window.oicppApp.saveCloudFileToServer === 'function') {
                                const ok = await window.oicppApp.saveCloudFileToServer(filePath, content);
                                if (!ok) throw new Error(_t('dialog.cloudSaveFailed'));
                                this.markTabAsSavedByUniqueKey(uniqueKey);
                            } else {
                                throw new Error(_t('dialog.saveApiUnavailable'));
                            }
                        } catch (e) {
                            failures.push({ fileName: tab.fileName, error: (e as Error)?.message || String(e) });
                        }
                    })());
                    continue;
                }

                if (!byFilePath.has(filePath)) {
                    byFilePath.set(filePath, { content, uniqueKeys: [] });
                } else {
                    // 同一文件被打开多次：内容取首个可用的，标记时覆盖全部 uniqueKey
                    (window.logWarn || console.warn)('同一文件存在多个标签页，只保存一次:', filePath);
                }
                byFilePath.get(filePath).uniqueKeys.push(uniqueKey);
            } catch (e) {
                failures.push({ fileName: tab?.fileName, error: (e as Error)?.message || String(e) });
                (window.logWarn || console.warn)('保存标签失败:', tab?.fileName, e);
            }
        }

        const hasSaveApi = typeof window.electronAPI?.saveFile === 'function';
        for (const [filePath, { content, uniqueKeys }] of byFilePath.entries()) {
            if (!hasSaveApi) {
                // 原先这里直接标记已保存：桥不可用时界面显示干净、磁盘却是旧的，
                // 关闭后改动就没了。标记去掉，改成如实上报。
                failures.push({
                    fileName: String(filePath).split('/').pop(),
                    error: _t('dialog.saveApiUnavailable')
                });
                continue;
            }
            tasks.push(
                window.electronAPI.saveFile(filePath, content).then((result: unknown) => {
                    if (result && typeof result === 'object' && (result as Record<string, unknown>)['success'] === false) {
                        throw new Error(String((result as Record<string, unknown>)['error'] || _t('dialog.saveWriteFailed')));
                    }
                    uniqueKeys.forEach((key: string) => this.markTabAsSavedByUniqueKey(key));
                }).catch((e: unknown) => {
                    failures.push({ fileName: String(filePath).split('/').pop(), error: (e as Error)?.message || String(e) });
                    (window.logWarn || console.warn)('保存文件失败:', filePath, e);
                })
            );
        }
        try { await Promise.allSettled(tasks); } catch (_) { }
        return { success: failures.length === 0, failures };
    }

    openFileDialog() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.cpp,.h,.txt,.in,.out,.ans,.py';
        input.style.display = 'none';

        document.body.appendChild(input);
        input.click();

        input.addEventListener('change', (e) => {
            const inputEl = e.target as HTMLInputElement;
            const files = inputEl.files;
            if (files && files.length > 0) {
                const file = files[0] as File;
                const fileName = file.name;

                const reader = new FileReader();
                reader.onload = (re) => {
                    const content = re.target?.result as string | null;
                    this.openFile(fileName, content);
                };
                reader.readAsText(file);
            }

            document.body.removeChild(input);
        });
    }

    openFolderDialog() {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.style.display = 'none';

        document.body.appendChild(input);
        input.click();

        input.addEventListener('change', (e) => {
            const inputEl = e.target as HTMLInputElement;
            const files: FileList | File[] = inputEl.files || [];
            const fileNames = Array.from(files).map(file => file.webkitRelativePath.split('/').pop());

            fileNames.forEach(fileName => {
                const file = Array.from(files).find(f => f.webkitRelativePath.endsWith(fileName as string));
                const reader = new FileReader();
                reader.onload = (re) => {
                    const content = re.target?.result as string | null;
                    this.openFile(fileName as string, content);
                };
                reader.readAsText(file as File);
            });

            document.body.removeChild(input);
        });
    }

    createFileFromTemplate(templateName: string) {
        let content = '';
        switch (templateName) {
            case 'cpp':
                content = `#include <iostream>
using namespace std;

int main() {
    cout << "Hello, World!" << endl;
    return 0;
}
`;
                break;
            case 'header':
                content = `#ifndef _TEMPLATE_H
#define _TEMPLATE_H

void hello();

#endif
`;
                break;
            case 'source':
                content = `#include "template.h"
#include <iostream>
using namespace std;

void hello() {
    cout << "Hello from template!" << endl;
}
`;
                break;
            default:
                break;
        }

        const fileName = this.generateNewFileName();
        // 下面那段 tabId 推导是死代码（tabData/uniqueKey 恒为 null），而且函数到头
        // 也没打开文件：模板点了没反应。直接开新标签。
        this.openFile(fileName, content, true);
    }

    displayWelcomePage() {
        if (this.tabs.has('Welcome')) {
            this.activateTab('Welcome');
            return;
        }

        const welcomeTab = {
            fileName: 'Welcome',
            content: this.getWelcomePageContent(),
            modified: false,
            isWelcome: true
        };

        this.tabs.set('Welcome', welcomeTab as unknown as TabRecord);

        this.updateTabsUI();

        this.activateTab('Welcome');
    }

    // 欢迎页原先把版本号硬编码成 '1.5.4 (v49)'，发版后不会变。
    // build-info.json 由主进程 require，渲染层读不到，这里在首次需要时取一次并缓存。
    getBuildVersionLabel() {
        if (this._welcomeVersionLabel) return this._welcomeVersionLabel;
        const fallback = '1.6.0-beta1-plus1';
        this._welcomeVersionLabel = fallback;
        if (window.electronAPI?.getBuildInfo) {
            Promise.resolve(window.electronAPI.getBuildInfo())
                .then((info) => {
                    const version = typeof info?.version === 'string' ? info.version.trim() : '';
                    const tag = info?.buildTag || info?.buildVersion || info?.buildNo;
                    if (!version) return;
                    let label = version;
                    if (!/\(v[^)]+\)/i.test(label) && typeof tag === 'string' && tag.trim()) {
                        const normalizedTag = tag.trim().startsWith('v') ? tag.trim() : `v${tag.trim()}`;
                        label = `${label} (${normalizedTag})`;
                    }
                    this._welcomeVersionLabel = label;
                    // 已渲染的欢迎页同步刷新
                    document.querySelectorAll('.welcome-version').forEach((el) => {
                        el.textContent = `${window.i18n?.t?.('app.version')} ${label}`;
                    });
                })
                .catch(() => { });
        }
        return this._welcomeVersionLabel;
    }

    getWelcomePageContent() {
        const t = (key: string, params?: Record<string, unknown>) => window.i18n?.t?.(key, params) || key;
        return `
            <div class="welcome-page">
                <div class="welcome-header">
                    <img class="welcome-logo-image" alt="OICPP-Plus Logo">
                    <div class="welcome-logo">OICPP-Plus</div>
                    <div class="welcome-subtitle">${t('welcome.subtitle')}</div>
                    <div class="welcome-version">${t('app.version')} ${this.getBuildVersionLabel()}</div>
                </div>
                
                <div class="welcome-content">
                    <div class="welcome-section">
                        <h3>${t('welcome.getStarted')}</h3>
                        <div class="welcome-actions">
                            <a href="#" class="welcome-action" data-action="open-folder">
                                <span class="icon" data-ui-icon="folder" aria-hidden="true"></span>
                                <span>${t('welcome.openFolder')}</span>
                                <span class="shortcut">Ctrl+K</span>
                            </a>
                        </div>
                    </div>
                    
                    <div class="welcome-section">
                        <h3>${t('welcome.recentFiles')}</h3>
                        <div class="welcome-recent" id="welcome-recent">
                            <div class="welcome-recent-item">
                                <span class="icon" data-ui-icon="file" aria-hidden="true"></span>
                                <span>${t('welcome.noRecentFiles')}</span>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="welcome-footer">
                    <p>${t('welcome.footer')}</p>
                    <p>${t('app.version')} ${this.getBuildVersionLabel()}, Copyright (C) 2025 mywwzh. Modified by qingyingge.</p>
                </div>
            </div>
        `;
    }

    updateTabsUI() {
        this.groups.forEach((group) => {
            if (!group?.tabBar) {
                return;
            }
            group.tabBar.innerHTML = '';
            group.tabs?.forEach((tab) => {
                if (tab?.element instanceof Element) {
                    (group.tabBar as HTMLElement).appendChild(tab.element);
                    tab.element.dataset['groupId'] = group.id;
                }
            });
        });
    }

    updateTabTitle(oldName: string, newName: string) {
        const tab = this.getTabByFileName(oldName);
        if (!tab) {
            return;
        }

        const uniqueKey = this.findUniqueKeyByFileName(oldName);
        const usesFileNameKey = !tab.filePath && uniqueKey === oldName;
        const newUniqueKey = usesFileNameKey ? newName : uniqueKey;

        if (uniqueKey) {
            this.tabs.delete(uniqueKey);
        }

        tab.fileName = newName;

        if (tab.element) {
            tab.element.dataset['file'] = newName;
            if (usesFileNameKey && newUniqueKey) {
                tab.element.dataset['uniqueKey'] = newUniqueKey;
            }
        }

        if (newUniqueKey) {
            tab.uniqueKey = newUniqueKey;
            this.tabs.set(newUniqueKey, tab);
        }

        const index = this.tabOrder.indexOf(oldName);
        if (index !== -1) {
            this.tabOrder[index] = newName;
        }

        if (this.activeTab === oldName) {
            this.activeTab = newName;
        }

        if (usesFileNameKey && this.activeTabKey === uniqueKey) {
            this.activeTabKey = newUniqueKey;
        }

        if (usesFileNameKey && tab.groupId) {
            const group = this.groups.get(tab.groupId);
            if (group && group.tabs) {
                group.tabs.delete(uniqueKey as string);
                if (newUniqueKey) {
                    group.tabs.set(newUniqueKey, tab);
                }
                if (group.activeTabKey === uniqueKey) {
                    group.activeTabKey = newUniqueKey;
                }
            }
        }

        this.refreshTabLabels();
        logInfo('标签页标题已更新:', oldName, '->', newName);
    }

    closeTabByFileName(fileName: string | null | undefined, options: CloseTabOptions = {}) {
        const tab = this.getTabByFileName(fileName);
        if (tab) {
            this.closeTab(fileName, options);
            logInfo('已关闭标签页:', fileName);
        }
    }

    updateTabPath(fileName: string | null | undefined, newPath: string | null | undefined) {
        const tab = this.getTabByFileName(fileName);
        if (tab) {
            tab.filePath = newPath;
            logInfo('标签页路径已更新:', fileName, '->', newPath);
            this.refreshTabLabels();
        }
    }


    updateTabPathBySource(oldPath: string | null | undefined, newPath: string | null | undefined, newFileName: string | null = null, targetUniqueKey: string | null | undefined = null) {
        try {
            if (!newPath) return;
            const norm = (p: string | null | undefined) => String(p).replace(/\\/g, '/');
            const oldKey = oldPath ? norm(oldPath) : '';
            const newKey = norm(newPath);

            let tabData: TabRecord | null = null;
            let actualOldKey = oldKey;
            if (targetUniqueKey) {
                // 调用方点名要改哪一个标签：批量保存未命名标签时只有调用方知道是谁，
                // 靠激活标签兜底会把 N 个未命名标签全绑到同一个 tab 上。
                const targetKey = norm(targetUniqueKey);
                const pinned = this.tabs.get(targetKey) || null;
                if (pinned) {
                    tabData = pinned;
                    actualOldKey = targetKey;
                }
            }
            if (!tabData && oldKey) {
                tabData = this.tabs.get(oldKey) || null;
                if (!tabData) {
                    for (const [k, v] of this.tabs.entries()) {
                        if (norm(v.filePath || '') === oldKey) { tabData = v; actualOldKey = k; break; }
                    }
                }
            }
            if (!tabData && !oldKey && !targetUniqueKey) {
                // 未命名标签「另存为」后没有旧路径可查，按当前激活标签定位，
                // 否则新路径永远绑不上，后续保存与编译会写到旧位置或静默跳过。
                // 只在压根没给 oldPath 时才兜底：给了却查不到说明调用方递错了路径，
                // 这时改激活标签会把不相干的 tab 悄悄改名。
                const activeKey = this.activeTabKey
                    || (typeof this.activeTab === 'string' ? this.findUniqueKeyByFileName(this.activeTab) : this.activeTab?.uniqueKey)
                    || '';
                if (activeKey && this.tabs.has(activeKey)) {
                    tabData = this.tabs.get(activeKey) || null;
                    actualOldKey = activeKey;
                }
            }
            if (!tabData) {
                logWarn('未找到需要更新路径的标签页，oldPath=', oldPath);
                return;
            }

            if (!newFileName || typeof newFileName !== 'string') {
                newFileName = newKey.split('/').pop() || tabData.fileName || null;
            }

            if (this.tabs.has(newKey) && newKey !== actualOldKey) {
                const dup = this.tabs.get(newKey);
                if (dup?.modified) {
                    // 重名 tab 有未保存内容：不能静默丢弃，至少要留下痕迹
                    logWarn('重命名目标已存在且该标签页有未保存内容，重命名后的内容将覆盖它:', newFileName || newKey);
                }
                try {
                    const editorManager = this.monacoEditorManager || window.monacoEditorManager || window.editorManager;
                    if (dup?.tabId && typeof editorManager?.cleanupEditor === 'function') {
                        editorManager.cleanupEditor(dup.tabId);
                    }
                    if (dup && dup.element && dup.element.parentNode) {
                        dup.element.parentNode.removeChild(dup.element);
                    }
                } catch (e) { logWarn('清理重名标签页失败:', e); }
                this.tabs.delete(newKey);
            }

            this.tabs.delete(actualOldKey);
            const previousPath = tabData.filePath;
            const previousFileName = tabData.fileName;
            tabData.filePath = newPath;
            tabData.uniqueKey = newKey;
            if (newFileName && typeof newFileName === 'string') {
                tabData.fileName = newFileName;
            }
            this.tabs.set(newKey, tabData);

            // group.tabs 的 key 与 group.activeTabKey 都以 uniqueKey 为准，必须同步迁移，
            // 否则分组内找不到该 tab
            try {
                for (const group of this.groups.values()) {
                    if (!(group.tabs instanceof Map)) continue;
                    if (group.tabs.has(actualOldKey)) {
                        group.tabs.delete(actualOldKey);
                        group.tabs.set(newKey, tabData);
                    }
                    if (group.activeTabKey === actualOldKey) {
                        group.activeTabKey = newKey;
                    }
                    // tabOrder 存的也是 uniqueKey，漏掉它会让分组内的顺序指向已删除的 key
                    if (Array.isArray(group.tabOrder)) {
                        const idx = group.tabOrder.indexOf(actualOldKey);
                        if (idx !== -1) group.tabOrder[idx] = newKey;
                    }
                }
            } catch (e) { logWarn('同步分组结构失败:', e); }

            try {
                let tabEl = tabData.element as HTMLElement | null;
                if (!tabEl && tabData.tabId) {
                    tabEl = document.querySelector(`.tab[data-tab-id="${tabData.tabId}"]`);
                }
                if (tabEl) {
                    tabEl.dataset['uniqueKey'] = newKey;
                    if (newFileName && typeof newFileName === 'string') {
                        tabEl.dataset['file'] = newFileName;
                    }
                    tabData.element = tabEl;
                }
            } catch (e) { logWarn('更新标签 DOM uniqueKey 失败:', e); }

            try {
                if (tabData.groupId) this.syncGroupTabs(tabData.groupId);
            } catch (e) { logWarn('同步分组标签失败:', e); }

            if (newFileName && typeof newFileName === 'string') {
                const tabOrderIndex = this.tabOrder.indexOf(previousFileName as string);
                if (tabOrderIndex !== -1) {
                    this.tabOrder[tabOrderIndex] = newFileName;
                }
            }

            // activeTabKey 必须跟着迁移：它悬空指向已删除的 key 时，
            // 依赖它的自动保存/编译路径会静默 return
            if (this.activeTabKey === actualOldKey || this.activeTabKey === newKey) {
                this.activeTabKey = newKey;
                this.activeTab = tabData;
            }

            try {
                // The manager can be injected on TabManager or exposed only globally,
                // depending on initialization order. Keep the active editor in sync in
                // both cases so subsequent saves and compiles use the renamed file.
                const editorManager = this.monacoEditorManager || window.monacoEditorManager || window.editorManager;
                if (editorManager && tabData.tabId) {
                    if (typeof editorManager.updateTabFilePath === 'function') {
                        editorManager.updateTabFilePath(tabData.tabId, newPath);
                    } else {
                        const mm = editorManager;
                        try { mm.tabIdToFilePath && mm.tabIdToFilePath.set(tabData.tabId, newPath); } catch (_) { }
                        try { const ed = mm.editors && mm.editors.get(tabData.tabId); if (ed) ed.filePath = newPath; } catch (_) { }
                    }
                }
            } catch (e) { logWarn('同步 Monaco 文件路径失败:', e); }

            logInfo('标签页路径已重新绑定:', { oldPath, newPath, tabId: tabData.tabId, uniqueKey: newKey });
            this.refreshTabLabels();
            this.handleTabFileWatchRebind(previousPath, newPath, tabData);
        } catch (err) {
            logError('updateTabPathBySource 失败:', err);
        }
    }



    /**
     * 目录被重命名或剪切后，它下面每一个已打开的标签都要换到新路径。
     * 只更新目录自身的话，子文件的 tab 会继续指向已经不存在的旧位置，
     * 保存写回旧路径、文件监视也全部失联。
     */
    updateTabPathsUnderDirectory(oldDir: string | null | undefined, newDir: string | null | undefined) {
        const norm = (p: string | null | undefined) => String(p ?? '').replace(/\\/g, '/');
        const oldPrefix = norm(oldDir).replace(/\/+$/, '') + '/';
        const newPrefix = norm(newDir).replace(/\/+$/, '') + '/';
        const entries = Array.from(this.tabs.entries());
        for (const [, tab] of entries) {
            const oldPath = norm(tab.filePath || '');
            if (!oldPath.startsWith(oldPrefix)) continue;
            const newPath = newPrefix + oldPath.slice(oldPrefix.length);
            this.updateTabPathBySource(oldPath, newPath, newPath.split('/').pop() || null);
        }
    }

    setFilePath(fileName: string | null | undefined, filePath: string | null | undefined) {
        const tab = this.getTabByFileName(fileName);
        if (tab) {
            tab.filePath = filePath;
            logInfo('文件路径已设置:', fileName, '->', filePath);
            this.refreshTabLabels();
        }
    }

    async createNewCppFile() {
        this.closeWelcomePage();

        if (window.sidebar && window.sidebar.panels && window.sidebar.panels.files) {
            const fileExplorer = window.sidebar.panels.files;
            if (fileExplorer && fileExplorer.createNewFile) {
                await fileExplorer.createNewFile();
                return;
            }
        }

        logError('TabManager: 文件管理器不可用，无法创建新文件');
        if (window.dialogManager) {
            try { logError('[DialogError]', { message: '请先打开一个工作区文件夹', from: 'TabManager.createNewCppFile' }); } catch (_) { }
            window.dialogManager.showError(window.i18n.t('fileExplorer.openWorkspaceFirst'));
        }
    }

    updateAllEditorsSettings(settings: Record<string, unknown>) {
        if (!this.monacoEditorManager) {
            this.tryGetEditorManagerReference();
        }

        if (this.monacoEditorManager) {
            if (typeof this.monacoEditorManager.updateAllEditorsSettings === 'function') {
                try {
                    this.monacoEditorManager.updateAllEditorsSettings(settings);
                } catch (error) {
                    logError('TabManager: 通过 monacoEditorManager.updateAllEditorsSettings 更新设置失败:', error);
                }
            }
            else if (typeof this.monacoEditorManager.updateSettings === 'function') {
                try {
                    this.monacoEditorManager.updateSettings(settings);
                } catch (error) {
                    logError('TabManager: 通过 monacoEditorManager.updateSettings 更新设置失败:', error);
                }
            }
            else {
                logWarn('TabManager: monacoEditorManager 不支持 updateSettings 或 updateAllEditorsSettings 方法');
            }
        } else {
            logWarn('TabManager: monacoEditorManager 仍然不可用，无法更新编辑器设置');
            setTimeout(() => {
                if (this.tryGetEditorManagerReference()) {
                    logInfo('TabManager: 延迟重试成功，重新调用updateAllEditorsSettings');
                    this.updateAllEditorsSettings(settings);
                }
            }, 500);
        }


    }

    getCurrentTab() {
        return this.activeTab;
    }

    showEmptyState() {
        const welcomeContainer = document.getElementById('welcome-container');
        if (welcomeContainer) {
            welcomeContainer.style.display = 'none';
        }

        const editorArea = document.querySelector('.editor-area');
        if (editorArea instanceof HTMLElement) {
            editorArea.style.display = 'block';
            editorArea.innerHTML = '';
        }

        if (this.monacoEditorManager) {
            this.monacoEditorManager.currentEditor = null;
            this.monacoEditorManager.currentFilePath = null;
            this.monacoEditorManager.currentFileName = null;
        }

        if (window.sidebarManager && window.sidebarManager.enableResize) {
            window.sidebarManager.enableResize();
        }
    }
}

let tabManager;
document.addEventListener('DOMContentLoaded', () => {
    tabManager = new TabManager();
    window.tabManager = tabManager;
    logInfo('标签页管理器已初始化');
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TabManager;
}
