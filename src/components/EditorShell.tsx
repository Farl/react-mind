import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { useMindmapEditor } from "../hooks/useMindmapEditor";
import { googleSheetsService } from "../services/googleSheets/client";
import type { GraphSheet, GraphSpreadsheet } from "../services/googleSheets/types";
import { createDocumentSignature, downloadTextFile, toXmindPasteText } from "../utils/mindmapExport";
import { AppModal } from "./AppModal";
import { AppToastStack } from "./AppToastStack";
import { MindmapCanvas } from "./MindmapCanvas";

type EditorShellProps = {
  appName: string;
};

const STORAGE_KEYS = {
  rememberLogin: "reactMind.auth.remember",
  spreadsheetId: "reactMind.store.selectedSpreadsheetId",
  sheetTitle: "reactMind.store.selectedSheetTitle",
};

const AUTOSAVE_DELAY_MS = 800;
const TOAST_DURATION_MS = 4000;

export function EditorShell({ appName }: EditorShellProps) {
  type FileModalType = "open" | "newStore" | "newGraph" | "export";

  const editor = useMindmapEditor();

  const [connection, setConnection] = useState(() => googleSheetsService.getConnectionStatus());
  const [syncStatus, setSyncStatus] = useState<string>("idle");
  const [syncError, setSyncError] = useState<string>("");
  const [isAutoSaving, setIsAutoSaving] = useState<boolean>(false);
  const [isAuthPending, setIsAuthPending] = useState<boolean>(false);

  const [spreadsheets, setSpreadsheets] = useState<GraphSpreadsheet[]>([]);
  const [graphSheets, setGraphSheets] = useState<GraphSheet[]>([]);

  const [selectedSpreadsheetId, setSelectedSpreadsheetId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.spreadsheetId) || "",
  );
  const [selectedSheetTitle, setSelectedSheetTitle] = useState<string>(
    () => localStorage.getItem(STORAGE_KEYS.sheetTitle) || "",
  );

  const [newStoreName, setNewStoreName] = useState<string>("React Mind Graph Store");
  const [newGraphName, setNewGraphName] = useState<string>("Graph 1");
  const [isCreatingStore, setIsCreatingStore] = useState<boolean>(false);
  const [isCreatingGraph, setIsCreatingGraph] = useState<boolean>(false);
  const [exportMessage, setExportMessage] = useState<string>("");
  const [toasts, setToasts] = useState<Array<{ id: number; tone: "info" | "error"; message: string }>>([]);
  const [openTarget, setOpenTarget] = useState<string>("");
  const [activeFileModal, setActiveFileModal] = useState<FileModalType | null>(null);

  const parseSpreadsheetId = (input: string): string => {
    const trimmed = input.trim();
    if (!trimmed) {
      return "";
    }

    const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match?.[1]) {
      return match[1];
    }

    return trimmed;
  };

  const [graphLoaded, setGraphLoaded] = useState<boolean>(false);
  const [hasSyncConflict, setHasSyncConflict] = useState<boolean>(false);
  const menuBarRef = useRef<HTMLElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef<boolean>(false);
  const saveQueuedRef = useRef<boolean>(false);
  const lastSavedSignatureRef = useRef<string>("");
  const remoteUpdatedAtRef = useRef<string>("");
  const autosaveVersionRef = useRef<number>(0);
  const [saveTrigger, setSaveTrigger] = useState<number>(0);
  const restoreAttemptedRef = useRef<boolean>(false);
  const pendingTaskCountRef = useRef<number>(0);
  const createStoreInFlightRef = useRef<boolean>(false);
  const createGraphInFlightRef = useRef<boolean>(false);
  const toastIdRef = useRef<number>(0);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const [isTaskPending, setIsTaskPending] = useState<boolean>(false);

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: "info" | "error") => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }

      const id = toastIdRef.current + 1;
      toastIdRef.current = id;
      setToasts((current) => [...current, { id, tone, message: trimmed }]);

      const timer = window.setTimeout(() => {
        dismissToast(id);
      }, TOAST_DURATION_MS);
      toastTimersRef.current.set(id, timer);
    },
    [dismissToast],
  );

  const beginTask = () => {
    pendingTaskCountRef.current += 1;
    setIsTaskPending(true);
  };

  const endTask = () => {
    pendingTaskCountRef.current = Math.max(0, pendingTaskCountRef.current - 1);
    setIsTaskPending(pendingTaskCountRef.current > 0);
  };

  useEffect(() => {
    return () => {
      toastTimersRef.current.forEach((timer) => {
        window.clearTimeout(timer);
      });
      toastTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!syncError) {
      return;
    }

    pushToast(syncError, "error");
    setSyncError("");
  }, [syncError, pushToast]);

  useEffect(() => {
    if (!exportMessage) {
      return;
    }

    pushToast(exportMessage, "info");
    setExportMessage("");
  }, [exportMessage, pushToast]);

  const invalidateAutosavePipeline = () => {
    autosaveVersionRef.current += 1;
    saveInFlightRef.current = false;
    saveQueuedRef.current = false;
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    setIsAutoSaving(false);
  };

  const closeAllMenus = () => {
    const menuRoot = menuBarRef.current;
    if (!menuRoot) {
      return;
    }

    const openMenus = menuRoot.querySelectorAll("details.menu-item[open]");
    openMenus.forEach((item) => {
      item.removeAttribute("open");
    });
  };

  const openFileModal = (modal: FileModalType) => {
    closeAllMenus();
    setActiveFileModal(modal);
  };

  const handleMenuToggle =
    (menuKey: string) =>
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const openedMenu = event.currentTarget;
      if (!openedMenu.open) {
        return;
      }

      const menuRoot = menuBarRef.current;
      if (!menuRoot) {
        return;
      }

      const openedMenus = menuRoot.querySelectorAll("details.menu-item[open]");
      openedMenus.forEach((item) => {
        const element = item as HTMLDetailsElement;
        if (element.dataset.menuKey !== menuKey) {
          element.removeAttribute("open");
        }
      });
    };

  const refreshConnection = () => {
    setConnection(googleSheetsService.getConnectionStatus());
  };

  const selectedStoreName = useMemo(() => {
    if (!selectedSpreadsheetId) {
      return "none";
    }

    const selectedStore = spreadsheets.find((store) => store.id === selectedSpreadsheetId);
    return selectedStore?.name || selectedSpreadsheetId;
  }, [spreadsheets, selectedSpreadsheetId]);

  const canEditGraph = connection.authState === "authorized" && !!selectedSpreadsheetId && !!selectedSheetTitle && graphLoaded;
  const isSyncBusy = isTaskPending || isAutoSaving || isAuthPending;
  const syncLabel = (() => {
    if (hasSyncConflict) {
      return "Conflict";
    }

    if (syncStatus === "auto-saving..." || isSyncBusy) {
      return "Saving";
    }

    if (syncStatus === "auto-saved") {
      return "Synced";
    }

    if (syncStatus === "error") {
      return "Error";
    }

    return "Idle";
  })();

  const isSyncConflictError = (message: string): boolean => message.startsWith("SYNC_CONFLICT:");

  const runTask = async (nextStatus: string, task: () => Promise<void>): Promise<boolean> => {
    beginTask();
    try {
      setSyncError("");
      setSyncStatus(nextStatus);
      await task();
      return true;
    } catch (error) {
      setSyncStatus("error");
      setSyncError(error instanceof Error ? error.message : "Unexpected error");
      return false;
    } finally {
      endTask();
    }
  };

  const runWithInFlightGuard = async (
    inFlightRef: MutableRefObject<boolean>,
    setBusy: (next: boolean) => void,
    task: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (inFlightRef.current) {
      return false;
    }

    inFlightRef.current = true;
    setBusy(true);
    try {
      return await task();
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const loadGraphIntoEditor = async (spreadsheetId: string, sheetTitle: string) => {
    const loaded = await googleSheetsService.loadMindmap({ spreadsheetId, sheetTitle });
    invalidateAutosavePipeline();
    setHasSyncConflict(false);

    if (loaded) {
      editor.importDocument(loaded);
      lastSavedSignatureRef.current = createDocumentSignature(loaded);
      remoteUpdatedAtRef.current = loaded.updatedAtIso || "";
    } else {
      lastSavedSignatureRef.current = "";
      remoteUpdatedAtRef.current = "";
    }
    setGraphLoaded(true);
  };

  const refreshStores = async () => {
    const stores = await googleSheetsService.listGraphSpreadsheets();
    setSpreadsheets(stores);

    const nextSpreadsheetId =
      selectedSpreadsheetId && stores.some((store) => store.id === selectedSpreadsheetId)
        ? selectedSpreadsheetId
        : stores[0]?.id || "";

    setSelectedSpreadsheetId(nextSpreadsheetId);
    localStorage.setItem(STORAGE_KEYS.spreadsheetId, nextSpreadsheetId);

    if (!nextSpreadsheetId) {
      setGraphSheets([]);
      setSelectedSheetTitle("");
      localStorage.removeItem(STORAGE_KEYS.sheetTitle);
      setGraphLoaded(false);
      return;
    }

    const sheets = await googleSheetsService.listGraphSheets(nextSpreadsheetId);
    setGraphSheets(sheets);

    const nextSheetTitle =
      selectedSheetTitle && sheets.some((sheet) => sheet.title === selectedSheetTitle)
        ? selectedSheetTitle
        : sheets[0]?.title || "";

    setSelectedSheetTitle(nextSheetTitle);
    if (nextSheetTitle) {
      localStorage.setItem(STORAGE_KEYS.sheetTitle, nextSheetTitle);
      await loadGraphIntoEditor(nextSpreadsheetId, nextSheetTitle);
    } else {
      setGraphLoaded(false);
      localStorage.removeItem(STORAGE_KEYS.sheetTitle);
    }
  };

  const handleConnect = async () => {
    setIsAuthPending(true);
    try {
      const succeeded = await runTask("authorizing...", async () => {
        await googleSheetsService.authorize();
        localStorage.setItem(STORAGE_KEYS.rememberLogin, "1");
        refreshConnection();
        await refreshStores();
      });

      if (succeeded) {
        setSyncStatus("authorized");
      }
    } finally {
      setIsAuthPending(false);
    }
  };

  const handleLogout = async () => {
    await runTask("signing out...", async () => {
      invalidateAutosavePipeline();
      await googleSheetsService.logout();
      localStorage.removeItem(STORAGE_KEYS.rememberLogin);
      refreshConnection();
      setSpreadsheets([]);
      setGraphSheets([]);
      setSelectedSpreadsheetId("");
      setSelectedSheetTitle("");
      setGraphLoaded(false);
      localStorage.removeItem(STORAGE_KEYS.spreadsheetId);
      localStorage.removeItem(STORAGE_KEYS.sheetTitle);
      setSyncStatus("signed out");
    });
  };

  const handleRefreshStores = async () => {
    await runTask("loading stores...", async () => {
      await refreshStores();
      setSyncStatus("stores loaded");
    });
  };

  const handleCreateStore = async (): Promise<boolean> => {
    return runWithInFlightGuard(createStoreInFlightRef, setIsCreatingStore, async () => {
      return runTask("creating store...", async () => {
        const created = await googleSheetsService.createGraphSpreadsheet({
          name: newStoreName,
          initialGraphName: newGraphName,
        });

        setSelectedSpreadsheetId(created.id);
        localStorage.setItem(STORAGE_KEYS.spreadsheetId, created.id);
        await refreshStores();
        setSyncStatus("store created");
      });
    });
  };

  const handleStoreChange = async (spreadsheetId: string) => {
    setSelectedSpreadsheetId(spreadsheetId);
    setSelectedSheetTitle("");
    localStorage.setItem(STORAGE_KEYS.spreadsheetId, spreadsheetId);
    localStorage.removeItem(STORAGE_KEYS.sheetTitle);

    await runTask("loading graphs...", async () => {
      const sheets = spreadsheetId ? await googleSheetsService.listGraphSheets(spreadsheetId) : [];
      setGraphSheets(sheets);

      const nextSheetTitle = sheets[0]?.title || "";
      setSelectedSheetTitle(nextSheetTitle);

      if (spreadsheetId && nextSheetTitle) {
        localStorage.setItem(STORAGE_KEYS.sheetTitle, nextSheetTitle);
        await loadGraphIntoEditor(spreadsheetId, nextSheetTitle);
      } else {
        setGraphLoaded(false);
      }

      setSyncStatus("graphs loaded");
    });
  };

  const handleSheetChange = async (sheetTitle: string) => {
    setSelectedSheetTitle(sheetTitle);
    if (sheetTitle) {
      localStorage.setItem(STORAGE_KEYS.sheetTitle, sheetTitle);
    } else {
      localStorage.removeItem(STORAGE_KEYS.sheetTitle);
    }

    await runTask("loading graph...", async () => {
      if (!selectedSpreadsheetId || !sheetTitle) {
        setGraphLoaded(false);
        return;
      }

      await loadGraphIntoEditor(selectedSpreadsheetId, sheetTitle);
      setSyncStatus("graph loaded");
    });
  };

  const handleCreateGraph = async (): Promise<boolean> => {
    if (!selectedSpreadsheetId) {
      setSyncError("Please select a graph store first.");
      return false;
    }

    return runWithInFlightGuard(createGraphInFlightRef, setIsCreatingGraph, async () => {
      return runTask("creating graph...", async () => {
        const created = await googleSheetsService.createGraphSheet({
          spreadsheetId: selectedSpreadsheetId,
          sheetTitle: newGraphName,
        });

        const sheets = await googleSheetsService.listGraphSheets(selectedSpreadsheetId);
        setGraphSheets(sheets);
        setSelectedSheetTitle(created.title);
        localStorage.setItem(STORAGE_KEYS.sheetTitle, created.title);
        await loadGraphIntoEditor(selectedSpreadsheetId, created.title);
        setSyncStatus("graph created");
      });
    });
  };

  const handleOpenByTarget = async (): Promise<boolean> => {
    if (connection.authState !== "authorized") {
      setSyncError("Please sign in first.");
      return false;
    }

    const spreadsheetId = parseSpreadsheetId(openTarget);
    if (!spreadsheetId) {
      setSyncError("Please input a spreadsheet URL or ID.");
      return false;
    }

    setSyncError("");
    return runTask("opening spreadsheet...", async () => {
      const sheets = await googleSheetsService.listGraphSheets(spreadsheetId);
      if (sheets.length === 0) {
        throw new Error("No graph sheets found in this spreadsheet.");
      }

      setSpreadsheets((current) => {
        if (current.some((item) => item.id === spreadsheetId)) {
          return current;
        }
        return [{ id: spreadsheetId, name: spreadsheetId }, ...current];
      });

      setSelectedSpreadsheetId(spreadsheetId);
      localStorage.setItem(STORAGE_KEYS.spreadsheetId, spreadsheetId);

      setGraphSheets(sheets);
      const firstSheetTitle = sheets[0]?.title || "";
      setSelectedSheetTitle(firstSheetTitle);
      localStorage.setItem(STORAGE_KEYS.sheetTitle, firstSheetTitle);

      await loadGraphIntoEditor(spreadsheetId, firstSheetTitle);
      setSyncStatus("spreadsheet opened");
    });
  };

  const handleReloadRemote = async () => {
    if (!selectedSpreadsheetId || !selectedSheetTitle) {
      return;
    }

    await runTask("reloading remote graph...", async () => {
      await loadGraphIntoEditor(selectedSpreadsheetId, selectedSheetTitle);
      setSyncStatus("remote graph loaded");
      setSyncError("");
      setHasSyncConflict(false);
    });
  };

  const handleRename = () => {
    if (!editor.selectedNode || !canEditGraph) {
      return;
    }

    const nextTitle = window.prompt("Rename node", editor.selectedNode.title);
    if (nextTitle === null) {
      return;
    }
    editor.renameNode(editor.selectedNode.id, nextTitle);
  };

  const handleCopyXmindOutline = async () => {
    if (!canEditGraph) {
      return;
    }

    const text = toXmindPasteText(editor.document);
    if (!text.trim()) {
      setExportMessage("No nodes to export.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setExportMessage("Outline copied. Paste directly into XMind.");
    } catch {
      setExportMessage("Clipboard unavailable. Use download instead.");
    }
  };

  const handleDownloadOutline = () => {
    if (!canEditGraph) {
      return;
    }

    const text = toXmindPasteText(editor.document);
    downloadTextFile(`${selectedSheetTitle || "mindmap"}-xmind-outline.txt`, text);
    setExportMessage("Outline downloaded.");
  };

  const handleDownloadJson = () => {
    if (!canEditGraph) {
      return;
    }

    const payload = JSON.stringify(
      {
        exportedAtIso: new Date().toISOString(),
        spreadsheetId: selectedSpreadsheetId,
        sheetTitle: selectedSheetTitle,
        document: editor.document,
      },
      null,
      2,
    );

    downloadTextFile(`${selectedSheetTitle || "mindmap"}.json`, payload, "application/json;charset=utf-8");
    setExportMessage("JSON backup downloaded.");
  };

  const selectedNodeDepth =
    editor.selectedNode?.parentId === null
      ? 0
      : (() => {
          let depth = 0;
          let cursor = editor.selectedNode?.parentId ?? null;
          while (cursor) {
            const parent = editor.document.nodes.find((node) => node.id === cursor);
            cursor = parent?.parentId ?? null;
            depth += 1;
          }
          return depth;
        })();

  useEffect(() => {
    if (connection.authState !== "authorized" || !selectedSpreadsheetId || !selectedSheetTitle || !graphLoaded) {
      invalidateAutosavePipeline();
    }
  }, [connection.authState, selectedSpreadsheetId, selectedSheetTitle, graphLoaded]);

  useEffect(() => {
    if (!canEditGraph || !selectedSpreadsheetId || !selectedSheetTitle) {
      setIsAutoSaving(false);
      return;
    }

    if (hasSyncConflict) {
      setIsAutoSaving(false);
      setSyncStatus("conflict detected");
      return;
    }

    const documentForSave = {
      ...editor.document,
      title: selectedSheetTitle,
    };

    const signature = createDocumentSignature(documentForSave);
    if (signature === lastSavedSignatureRef.current) {
      setIsAutoSaving(false);
      return;
    }

    if (saveInFlightRef.current) {
      saveQueuedRef.current = true;
      setSyncStatus("auto-saving...");
      setIsAutoSaving(true);
      return;
    }

    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    setSyncStatus("auto-saving...");
    setIsAutoSaving(true);

    const requestVersion = autosaveVersionRef.current + 1;
    autosaveVersionRef.current = requestVersion;

    autosaveTimerRef.current = window.setTimeout(async () => {
      saveInFlightRef.current = true;
      let conflictDetected = false;
      try {
        const saveResult = await googleSheetsService.saveMindmap({
          spreadsheetId: selectedSpreadsheetId,
          sheetTitle: selectedSheetTitle,
          document: documentForSave,
          snapshot: editor.currentSnapshot || undefined,
          expectedRemoteUpdatedAtIso: remoteUpdatedAtRef.current || undefined,
        });

        if (requestVersion !== autosaveVersionRef.current) {
          return;
        }

        lastSavedSignatureRef.current = signature;
        remoteUpdatedAtRef.current = saveResult.updatedAtIso || remoteUpdatedAtRef.current;
        setHasSyncConflict(false);
        setSyncStatus("auto-saved");
      } catch (error) {
        if (requestVersion !== autosaveVersionRef.current) {
          return;
        }

        const message = error instanceof Error ? error.message : "Unexpected error";
        if (isSyncConflictError(message)) {
          conflictDetected = true;
          setHasSyncConflict(true);
          saveQueuedRef.current = false;
          setSyncError("Remote graph changed. Please reload remote before continuing edits.");
          setSyncStatus("conflict detected");
        } else {
          setSyncError(message);
          setSyncStatus("error");
        }
      } finally {
        saveInFlightRef.current = false;
        const shouldRunQueuedSave = saveQueuedRef.current;
        saveQueuedRef.current = false;
        setIsAutoSaving(false);

        if (shouldRunQueuedSave && !conflictDetected) {
          setSaveTrigger((value) => value + 1);
        }
      }
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [
    canEditGraph,
    selectedSpreadsheetId,
    selectedSheetTitle,
    hasSyncConflict,
    saveTrigger,
    editor.document,
    editor.currentSnapshot,
  ]);

  useEffect(() => {
    const handleDocumentPointerDown = (event: PointerEvent) => {
      const menuRoot = menuBarRef.current;
      if (!menuRoot) {
        return;
      }

      const target = event.target as Node | null;
      if (target && menuRoot.contains(target)) {
        return;
      }

      closeAllMenus();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      closeAllMenus();
    };

    window.addEventListener("pointerdown", handleDocumentPointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handleDocumentPointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, []);

  useEffect(() => {
    if (restoreAttemptedRef.current) {
      return;
    }
    restoreAttemptedRef.current = true;

    const shouldRestore = localStorage.getItem(STORAGE_KEYS.rememberLogin) === "1";
    if (!shouldRestore) {
      return;
    }

    runTask("restoring session...", async () => {
      setIsAuthPending(true);
      try {
        await googleSheetsService.authorize({ silent: true });
        refreshConnection();
        await refreshStores();
        setSyncStatus("session restored");
      } finally {
        setIsAuthPending(false);
      }
    });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        return;
      }

      if (!editor.selectedNode || !canEditGraph) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        editor.addChildNode(editor.selectedNode.id);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (editor.selectedNode.parentId !== null) {
          editor.addSiblingNode(editor.selectedNode.id);
        }
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        editor.deleteNode(editor.selectedNode.id);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        editor.selectPrevSiblingNode();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        editor.selectNextSiblingNode();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        editor.selectParentNode();
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        editor.selectFirstChildNode();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        editor.undo();
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        editor.redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [editor, canEditGraph]);

  return (
    <main className="app">
      <header className="topbar">
        <div className="topbar__left">
          <h1 className="topbar__title">{appName}</h1>
          <span className="topbar__workspace" aria-label="Current spreadsheet">
            {selectedStoreName === "none" ? "No Spreadsheet" : selectedStoreName}
          </span>
          <nav ref={menuBarRef} className="menu-bar" aria-label="App menu">
            <details className="menu-item" data-menu-key="file" onToggle={handleMenuToggle("file")}>
              <summary>File</summary>
              <div className="menu-dropdown__panel">
                <button type="button" onClick={() => openFileModal("open")} disabled={connection.authState !== "authorized"}>
                  Open...
                </button>
                <button type="button" onClick={() => openFileModal("newStore")} disabled={connection.authState !== "authorized"}>
                  New Store...
                </button>
                <hr className="menu-dropdown__divider" />
                <button type="button" onClick={() => openFileModal("export")} disabled={!canEditGraph}>
                  Export...
                </button>
              </div>
            </details>

            <details className="menu-item" data-menu-key="edit" onToggle={handleMenuToggle("edit")}>
              <summary>Edit</summary>
              <div className="menu-dropdown__panel">
                <button
                  type="button"
                  onClick={() => editor.addChildNode(editor.selectedNode?.id ?? "root")}
                  disabled={!canEditGraph}
                >
                  Add Child
                </button>
                <button type="button" onClick={handleRename} disabled={!editor.selectedNode || !canEditGraph}>
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => editor.selectedNode && editor.deleteNode(editor.selectedNode.id)}
                  disabled={!editor.selectedNode || editor.selectedNode.id === "root" || !canEditGraph}
                >
                  Delete
                </button>
                <hr className="menu-dropdown__divider" />
                <button type="button" onClick={editor.undo} disabled={editor.historyIndex <= 0 || !canEditGraph}>
                  Undo
                </button>
                <button
                  type="button"
                  onClick={editor.redo}
                  disabled={editor.historyIndex >= editor.historyCount - 1 || !canEditGraph}
                >
                  Redo
                </button>
              </div>
            </details>
          </nav>
        </div>
        <div className="topbar__actions">
          <span className="status-pill status-pill--muted">{connection.authState}</span>
          {connection.authState === "authorized" ? (
            <button type="button" onClick={handleLogout} className="topbar__btn">
              Sign Out
            </button>
          ) : (
            <button type="button" onClick={handleConnect} className="topbar__btn topbar__btn--primary">
              Sign In Google
            </button>
          )}
        </div>
      </header>

      <section className="layout">
        {isAuthPending ? (
          <section className="canvas canvas--state">
            <div className="auth-state-card">
              <span className="saving-spinner saving-spinner--lg" aria-label="authorizing" />
              <h3>Signing in...</h3>
              <p>Completing Google authorization and restoring your graph workspace.</p>
            </div>
          </section>
        ) : connection.authState !== "authorized" ? (
          <section className="canvas canvas--state">
            <div className="auth-state-card">
              <h3>Sign in required</h3>
              <p>Please sign in with Google to load graph stores and open the canvas.</p>
              <button type="button" onClick={handleConnect} className="topbar__btn topbar__btn--primary">
                Sign In Google
              </button>
            </div>
          </section>
        ) : (
          <section className="canvas canvas--content">
            <div className="canvas-shell">
              <div className="canvas-shell__head">
                {!canEditGraph ? <p className="hint-text">Select a graph sheet to unlock editing.</p> : null}
              </div>

              <div className="canvas-shell__body">
                <MindmapCanvas
                  nodes={editor.document.nodes}
                  selectedNodeId={editor.selectedNode?.id ?? null}
                  collapsedNodeIds={editor.collapsedNodeIds}
                  editable={canEditGraph}
                  onSelectNode={editor.selectNode}
                  onRenameNode={editor.renameNode}
                  onToggleCollapse={editor.toggleNodeCollapsed}
                  onMoveNode={editor.moveNode}
                />
              </div>

              <footer className="sheet-footer">
                <div className="sheet-tabs" aria-label="Graph sheets tabs">
                  <div className="sheet-tabs__list">
                    {graphSheets.length === 0 ? (
                      <span className="sheet-tabs__empty">No graph sheets</span>
                    ) : (
                      graphSheets.map((sheet) => (
                        <button
                          key={`${sheet.id}-${sheet.title}`}
                          type="button"
                          className={`sheet-tab${sheet.title === selectedSheetTitle ? " sheet-tab--active" : ""}`}
                          onClick={() => void handleSheetChange(sheet.title)}
                          disabled={connection.authState !== "authorized" || !selectedSpreadsheetId}
                          aria-current={sheet.title === selectedSheetTitle ? "page" : undefined}
                        >
                          {sheet.title}
                        </button>
                      ))
                    )}
                  </div>

                  <button
                    type="button"
                    className="sheet-tab sheet-tab--add"
                    onClick={() => openFileModal("newGraph")}
                    disabled={connection.authState !== "authorized" || !selectedSpreadsheetId}
                    aria-label="Add graph sheet"
                    title="Add graph sheet"
                  >
                    +
                  </button>
                </div>

                <div className="sheet-status" aria-label="Sync status">
                  <span className={`status-chip${syncLabel === "Error" || syncLabel === "Conflict" ? " status-chip--warn" : ""}`} title="Sync status">
                    <span className="material-symbols-rounded" aria-hidden="true">
                      {syncLabel === "Error" || syncLabel === "Conflict" ? "warning" : "sync"}
                    </span>
                    {syncLabel}
                    {isSyncBusy ? <span className="saving-spinner" aria-label="saving" /> : null}
                  </span>
                  <span className="status-chip" title="Editing availability">
                    <span className="material-symbols-rounded" aria-hidden="true">
                      {canEditGraph ? "lock_open" : "lock"}
                    </span>
                    {canEditGraph ? "Editable" : "Locked"}
                  </span>
                  {hasSyncConflict ? (
                    <span className="status-chip status-chip--warn" title="Conflict detected">
                      <span className="material-symbols-rounded" aria-hidden="true">report_problem</span>
                      Reload needed
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="status-chip status-chip--action"
                    onClick={handleReloadRemote}
                    disabled={!selectedSpreadsheetId || !selectedSheetTitle}
                    title="Reload latest graph from remote"
                  >
                    <span className="material-symbols-rounded" aria-hidden="true">refresh</span>
                    Reload Remote
                  </button>
                </div>
              </footer>
            </div>
          </section>
        )}

        <aside className="panel">
          <h2>Inspector</h2>
          <ul className="kv">
            <li>Selection: {editor.selectedNode?.title ?? "none"}</li>
            <li>Depth: {selectedNodeDepth}</li>
            <li>Nodes: {editor.document.nodes.length}</li>
            <li>History: {editor.historyIndex + 1}/{editor.historyCount}</li>
            <li>Shortcuts: Tab / Enter / Delete / Arrows / Ctrl+Z / Ctrl+Y</li>
          </ul>

          <div className="toolbar">
            <button
              type="button"
              onClick={() => editor.addChildNode(editor.selectedNode?.id ?? "root")}
              disabled={!canEditGraph}
            >
              Add Child
            </button>
            <button type="button" onClick={handleRename} disabled={!editor.selectedNode || !canEditGraph}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => editor.selectedNode && editor.deleteNode(editor.selectedNode.id)}
              disabled={!editor.selectedNode || editor.selectedNode.id === "root" || !canEditGraph}
            >
              Delete
            </button>
            <button type="button" onClick={editor.undo} disabled={editor.historyIndex <= 0 || !canEditGraph}>
              Undo
            </button>
            <button
              type="button"
              onClick={editor.redo}
              disabled={editor.historyIndex >= editor.historyCount - 1 || !canEditGraph}
            >
              Redo
            </button>
          </div>
        </aside>
      </section>

      <AppModal
        isOpen={activeFileModal === "open"}
        title="Open Spreadsheet"
        onClose={() => setActiveFileModal(null)}
        footer={
          <>
            <button type="button" onClick={() => setActiveFileModal(null)}>
              Close
            </button>
          </>
        }
      >
        <div className="toolbar">
          <button type="button" onClick={handleRefreshStores} disabled={connection.authState !== "authorized"}>
            Refresh Stores
          </button>

          <label className="form-label">
            Select Store
            <select
              value={selectedSpreadsheetId}
              onChange={(event) => void handleStoreChange(event.target.value)}
              disabled={connection.authState !== "authorized"}
            >
              <option value="">-- Select --</option>
              {spreadsheets.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          </label>

          <label className="form-label">
            Open by URL / ID
            <input
              value={openTarget}
              onChange={(event) => setOpenTarget(event.target.value)}
              placeholder="https://docs.google.com/... or spreadsheet id"
              disabled={connection.authState !== "authorized"}
            />
          </label>

          <button
            type="button"
            onClick={async () => {
              const succeeded = await handleOpenByTarget();
              if (succeeded) {
                setActiveFileModal(null);
              }
            }}
            disabled={connection.authState !== "authorized"}
          >
            Open Spreadsheet
          </button>
        </div>
      </AppModal>

      <AppModal
        isOpen={activeFileModal === "newStore"}
        title="New Store"
        onClose={() => {
          if (!isCreatingStore) {
            setActiveFileModal(null);
          }
        }}
        footer={
          <>
            <button type="button" onClick={() => setActiveFileModal(null)} disabled={isCreatingStore}>
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const succeeded = await handleCreateStore();
                if (succeeded) {
                  setActiveFileModal(null);
                }
              }}
              disabled={connection.authState !== "authorized" || isCreatingStore}
            >
              Create
            </button>
          </>
        }
      >
        <label className="form-label">
          Store Name
          <input
            value={newStoreName}
            onChange={(event) => setNewStoreName(event.target.value)}
            disabled={connection.authState !== "authorized" || isCreatingStore}
          />
        </label>

        <label className="form-label">
          Initial Graph Name
          <input
            value={newGraphName}
            onChange={(event) => setNewGraphName(event.target.value)}
            disabled={connection.authState !== "authorized" || isCreatingStore}
          />
        </label>
      </AppModal>

      <AppModal
        isOpen={activeFileModal === "newGraph"}
        title="New Graph Sheet"
        onClose={() => {
          if (!isCreatingGraph) {
            setActiveFileModal(null);
          }
        }}
        footer={
          <>
            <button type="button" onClick={() => setActiveFileModal(null)} disabled={isCreatingGraph}>
              Cancel
            </button>
            <button
              type="button"
              onClick={async () => {
                const succeeded = await handleCreateGraph();
                if (succeeded) {
                  setActiveFileModal(null);
                }
              }}
              disabled={connection.authState !== "authorized" || !selectedSpreadsheetId || isCreatingGraph}
            >
              Create
            </button>
          </>
        }
      >
        <p className="hint-text">Store: {selectedStoreName}</p>
        <label className="form-label">
          Graph Sheet Name
          <input
            value={newGraphName}
            onChange={(event) => setNewGraphName(event.target.value)}
            disabled={connection.authState !== "authorized" || !selectedSpreadsheetId || isCreatingGraph}
          />
        </label>
      </AppModal>

      <AppModal
        isOpen={activeFileModal === "export"}
        title="Export"
        onClose={() => setActiveFileModal(null)}
        footer={
          <>
            <button type="button" onClick={() => setActiveFileModal(null)}>
              Close
            </button>
          </>
        }
      >
        <div className="toolbar">
          <button type="button" onClick={handleCopyXmindOutline} disabled={!canEditGraph}>
            Copy Outline (XMind Paste)
          </button>
          <button type="button" onClick={handleDownloadOutline} disabled={!canEditGraph}>
            Download Outline (.txt)
          </button>
          <button type="button" onClick={handleDownloadJson} disabled={!canEditGraph}>
            Download JSON
          </button>
        </div>
      </AppModal>

      <AppToastStack toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}
