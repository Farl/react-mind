import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { LayoutMode } from "../domain/mindmap";
import { isLayoutMode } from "../domain/mindmap";
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

function InspectorTitle({
  nodeId,
  title,
  onCommit,
}: {
  nodeId: string;
  title: string;
  onCommit: (id: string, title: string) => void;
}) {
  const [draft, setDraft] = useState(title);

  useEffect(() => {
    setDraft(title);
  }, [title]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== title) {
      onCommit(nodeId, trimmed);
    } else {
      setDraft(title);
    }
  };

  return (
    <input
      type="text"
      className="inspector-title"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

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
  const [layoutMode] = useState<LayoutMode>(() => {
    const stored = localStorage.getItem("reactMind.layoutMode");
    return isLayoutMode(stored) ? stored : "balanced";
  });
  const [selectedTheme, setSelectedTheme] = useState<string>(
    () => localStorage.getItem("reactMind.theme") || "classic",
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const prevSelectedCountRef = useRef(0);

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

  useEffect(() => {
    document.body.dataset.theme = selectedTheme === "classic" ? "" : selectedTheme;
    localStorage.setItem("reactMind.theme", selectedTheme);
  }, [selectedTheme]);

  // Auto-open inspector on mobile when selection goes from empty → non-empty
  useEffect(() => {
    const prev = prevSelectedCountRef.current;
    const curr = editor.selectedNodeIds.length;
    prevSelectedCountRef.current = curr;
    if (prev === 0 && curr > 0) {
      setInspectorOpen(true);
    }
  }, [editor.selectedNodeIds]);

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
  const isLastRoot = (() => {
    if (!editor.selectedNode) return false;
    if (editor.selectedNode.parentId !== null) return false;
    return editor.document.nodes.filter((n) => n.parentId === null).length <= 1;
  })();
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

  const handleDeleteSelected = () => {
    if (editor.selectedNodeIds.length > 1) {
      editor.deleteMultipleNodes(editor.selectedNodeIds);
    } else if (editor.selectedNode) {
      editor.deleteNode(editor.selectedNode.id);
    }
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

      if (!canEditGraph || editor.selectedNodeIds.length === 0) {
        return;
      }

      if (event.key === "Tab") {
        event.preventDefault();
        if (editor.selectedNode) editor.addChildNode(editor.selectedNode.id);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        if (editor.selectedNode && editor.selectedNode.parentId !== null) {
          editor.addSiblingNode(editor.selectedNode.id);
        }
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        handleDeleteSelected();
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
                <button type="button" onClick={() => openFileModal("export")}>
                  Export...
                </button>
              </div>
            </details>

            <details className="menu-item" data-menu-key="edit" onToggle={handleMenuToggle("edit")}>
              <summary>Edit</summary>
              <div className="menu-dropdown__panel">
                <button
                  type="button"
                  onClick={() => {
                    const firstRoot = editor.document.nodes.find((n) => n.parentId === null);
                    editor.addChildNode(editor.selectedNode?.id ?? firstRoot?.id ?? "");
                    closeAllMenus();
                  }}
                >
                  Add Child
                </button>
                <button
                  type="button"
                  onClick={() => {
                    editor.addRootNode();
                    closeAllMenus();
                  }}
                >
                  New Root Topic
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleRename();
                    closeAllMenus();
                  }}
                  disabled={!editor.selectedNode}
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleDeleteSelected();
                    closeAllMenus();
                  }}
                  disabled={editor.selectedNodeIds.length === 0 || isLastRoot}
                >
                  Delete
                </button>
                <hr className="menu-dropdown__divider" />
                <button type="button" onClick={editor.undo} disabled={editor.historyIndex <= 0}>
                  Undo
                </button>
                <button
                  type="button"
                  onClick={editor.redo}
                  disabled={editor.historyIndex >= editor.historyCount - 1}
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

      {connection.authState !== "authorized" ? (
        <section className="canvas canvas--state">
          <div className="auth-state-card">
            {isAuthPending ? (
              <>
                <span className="saving-spinner" aria-label="signing in" />
                <p className="hint-text">Signing in to Google…</p>
              </>
            ) : (
              <>
                <h3>Sign in required</h3>
                <p>Please sign in with Google to load graph stores and open the canvas.</p>
                <button type="button" onClick={handleConnect} className="topbar__btn topbar__btn--primary">
                  Sign In Google
                </button>
              </>
            )}
          </div>
        </section>
      ) : (
      <section className="layout">
        <section className="canvas canvas--content">
          <div className="canvas-shell">
            <div className="canvas-shell__head">
              {!canEditGraph ? (
                <p className="hint-text">Select a graph sheet to enable editing.</p>
              ) : null}
            </div>

            <div className="canvas-shell__body">
              <div className="canvas-overlay">
                <div className="palette-row">
                  {(
                    [
                      { value: "classic", color: "#6366f1", title: "Classic" },
                      { value: "ocean", color: "#0ea5e9", title: "Ocean" },
                      { value: "forest", color: "#16a34a", title: "Forest" },
                      { value: "sunset", color: "#e11d48", title: "Sunset" },
                      { value: "minimal", color: "#9ca3af", title: "Minimal" },
                    ] as const
                  ).map(({ value, color, title }) => (
                    <button
                      key={value}
                      type="button"
                      title={title}
                      className={`palette-swatch${selectedTheme === value ? " palette-swatch--active" : ""}`}
                      style={{ background: color }}
                      onClick={() => setSelectedTheme(value)}
                    />
                  ))}
                </div>
                <span className="canvas-overlay__sep" />
                <span className="canvas-overlay__hint" title="Tab=child  Enter=sibling  Del/Backspace=delete  Arrows=navigate  Ctrl+Z/Y=undo/redo  Dbl-click=rename/new root">
                  <span className="material-symbols-rounded">keyboard</span>
                </span>
              </div>
              <MindmapCanvas
                nodes={editor.document.nodes}
                selectedNodeIds={editor.selectedNodeIds}
                collapsedNodeIds={editor.collapsedNodeIds}
                editable={canEditGraph}
                layoutMode={layoutMode}
                onSelectNode={editor.selectNode}
                onToggleNodeSelection={editor.toggleNodeSelection}
                onSelectNodes={editor.selectNodes}
                onRenameNode={editor.renameNode}
                onToggleCollapse={editor.toggleNodeCollapsed}
                onMoveNode={editor.moveNode}
                onMoveRootNode={editor.moveRootNode}
                onAddRootNode={(x, y) => editor.addRootNode(x, y)}
              />
              <button
                type="button"
                className="inspector-toggle"
                aria-label="Open inspector"
                onClick={() => setInspectorOpen(true)}
              >
                <span className="material-symbols-rounded">tune</span>
              </button>
            </div>

            {connection.authState === "authorized" ? (
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
                          disabled={!selectedSpreadsheetId}
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
                    disabled={!selectedSpreadsheetId}
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
                  <span className="status-chip" title="Cloud sync">
                    <span className="material-symbols-rounded" aria-hidden="true">
                      {canEditGraph ? "cloud_done" : "cloud_off"}
                    </span>
                    {canEditGraph ? "Synced" : "Local"}
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
            ) : null}
          </div>
        </section>

        <aside className={`panel${inspectorOpen ? " panel--open" : ""}`}>
          <div className="panel__header">
            <h2>Inspector</h2>
            <button
              type="button"
              className="panel__close"
              aria-label="Close inspector"
              onClick={() => setInspectorOpen(false)}
            >
              <span className="material-symbols-rounded">close</span>
            </button>
          </div>

          {editor.selectedNodes.length > 1 ? (() => {
            const nodes = editor.selectedNodes;
            const commonRadius = nodes.every((n) => (n.borderRadius ?? 8) === (nodes[0].borderRadius ?? 8)) ? (nodes[0].borderRadius ?? 8) : null;
            const commonBg = nodes.every((n) => (n.bgColor ?? "") === (nodes[0].bgColor ?? "")) ? (nodes[0].bgColor ?? "") : null;
            const commonBorderW = nodes.every((n) => (n.borderWidth ?? 1) === (nodes[0].borderWidth ?? 1)) ? (nodes[0].borderWidth ?? 1) : null;
            const commonBorderC = nodes.every((n) => (n.borderColor ?? "") === (nodes[0].borderColor ?? "")) ? (nodes[0].borderColor ?? "") : null;
            const commonText = nodes.every((n) => (n.textColor ?? "") === (nodes[0].textColor ?? "")) ? (nodes[0].textColor ?? "") : null;
            const applyStyle = (style: Parameters<typeof editor.updateMultipleNodeStyles>[1]) =>
              editor.updateMultipleNodeStyles(editor.selectedNodeIds, style);

            return (
              <div className="inspector-node">
                <p style={{ fontWeight: 600, fontSize: 14, margin: "0 0 8px" }}>
                  {nodes.length} nodes selected
                </p>

                <div className="inspector-row">
                  <label className="inspector-label">Radius</label>
                  <div className="layout-mode-btns">
                    {(
                      [
                        { value: 0, icon: "crop_square", title: "Sharp" },
                        { value: 8, icon: "rounded_corner", title: "Rounded" },
                        { value: 999, icon: "circle", title: "Pill" },
                      ] as const
                    ).map(({ value, icon, title }) => (
                      <button
                        key={value}
                        type="button"
                        title={title}
                        className={`layout-mode-btn${commonRadius === value ? " layout-mode-btn--active" : ""}`}
                        onClick={() => applyStyle({ borderRadius: value === 8 ? undefined : value })}
                      >
                        <span className="material-symbols-rounded">{icon}</span>
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    value={commonRadius ?? ""}
                    placeholder="-"
                    style={{ width: 52 }}
                    onChange={(e) => applyStyle({ borderRadius: Number(e.target.value) === 8 ? undefined : Number(e.target.value) })}
                  />
                </div>

                <div className="inspector-row">
                  <label className="inspector-label">Fill</label>
                  <button
                    type="button"
                    className={`inspector-preset-btn${commonBg === "transparent" ? " inspector-preset-btn--active" : ""}`}
                    title="No fill (transparent)"
                    onClick={() => applyStyle({ bgColor: "transparent" })}
                  >
                    <span className="material-symbols-rounded">block</span>
                  </button>
                  <input
                    type="color"
                    value={commonBg && commonBg !== "transparent" ? commonBg : "#ffffff"}
                    onChange={(e) => applyStyle({ bgColor: e.target.value })}
                  />
                  <button type="button" className="inspector-clear" title="Reset to theme default" onClick={() => applyStyle({ bgColor: undefined })}>
                    <span className="material-symbols-rounded">restart_alt</span>
                  </button>
                </div>

                <div className="inspector-row">
                  <label className="inspector-label">Border</label>
                  <button
                    type="button"
                    className={`inspector-preset-btn${commonBorderW === 0 ? " inspector-preset-btn--active" : ""}`}
                    title="No border"
                    onClick={() => applyStyle({ borderWidth: 0, borderColor: undefined })}
                  >
                    <span className="material-symbols-rounded">block</span>
                  </button>
                  <input
                    type="number"
                    min={0}
                    max={16}
                    value={commonBorderW ?? ""}
                    placeholder="-"
                    style={{ width: 52 }}
                    onChange={(e) => applyStyle({ borderWidth: Number(e.target.value) })}
                  />
                  <input
                    type="color"
                    value={commonBorderC || "#6b7280"}
                    onChange={(e) => applyStyle({ borderColor: e.target.value })}
                  />
                  <button type="button" className="inspector-clear" title="Reset to default" onClick={() => applyStyle({ borderWidth: undefined, borderColor: undefined })}>
                    <span className="material-symbols-rounded">restart_alt</span>
                  </button>
                </div>

                <div className="inspector-row">
                  <label className="inspector-label">Text</label>
                  <input
                    type="color"
                    value={commonText || "#111827"}
                    onChange={(e) => applyStyle({ textColor: e.target.value })}
                  />
                  <button type="button" className="inspector-clear" title="Reset to default" onClick={() => applyStyle({ textColor: undefined })}>
                    <span className="material-symbols-rounded">restart_alt</span>
                  </button>
                </div>

                <div className="inspector-row">
                  <label className="inspector-label">Layout</label>
                  <div className="layout-mode-btns">
                    {(
                      [
                        { value: "", icon: "remove", title: "Inherit" },
                        { value: "balanced", icon: "hub", title: "Balanced" },
                        { value: "right", icon: "east", title: "Right" },
                        { value: "left", icon: "west", title: "Left" },
                        { value: "down", icon: "south", title: "Down" },
                        { value: "up", icon: "north", title: "Up" },
                      ] as const
                    ).map(({ value, icon, title }) => (
                      <button
                        key={value}
                        type="button"
                        title={title}
                        className="layout-mode-btn"
                        onClick={() => applyStyle({ nodeLayout: (value as LayoutMode) || undefined })}
                      >
                        <span className="material-symbols-rounded">{icon}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })() : editor.selectedNode ? (
            <div className="inspector-node">
              <InspectorTitle
                key={editor.selectedNode.id}
                nodeId={editor.selectedNode.id}
                title={editor.selectedNode.title}
                onCommit={editor.renameNode}
              />

              <div className="inspector-row">
                <label className="inspector-label">Radius</label>
                <div className="layout-mode-btns">
                  {(
                    [
                      { value: 0, icon: "crop_square", title: "Sharp" },
                      { value: 8, icon: "rounded_corner", title: "Rounded" },
                      { value: 999, icon: "circle", title: "Pill" },
                    ] as const
                  ).map(({ value, icon, title }) => (
                    <button
                      key={value}
                      type="button"
                      title={title}
                      className={`layout-mode-btn${(editor.selectedNode?.borderRadius ?? 8) === value ? " layout-mode-btn--active" : ""}`}
                      onClick={() =>
                        editor.selectedNode &&
                        editor.updateNodeStyle(editor.selectedNode.id, {
                          borderRadius: value === 8 ? undefined : value,
                        })
                      }
                    >
                      <span className="material-symbols-rounded">{icon}</span>
                    </button>
                  ))}
                </div>
                <input
                  type="number"
                  min={0}
                  max={999}
                  value={editor.selectedNode.borderRadius ?? 8}
                  style={{ width: 52 }}
                  onChange={(e) =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, {
                      borderRadius: Number(e.target.value) === 8 ? undefined : Number(e.target.value),
                    })
                  }
                />
              </div>

              <div className="inspector-row">
                <label className="inspector-label">Fill</label>
                <button
                  type="button"
                  className={`inspector-preset-btn${editor.selectedNode.bgColor === "transparent" ? " inspector-preset-btn--active" : ""}`}
                  title="No fill (transparent)"
                  onClick={() =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { bgColor: "transparent" })
                  }
                >
                  <span className="material-symbols-rounded">block</span>
                </button>
                <input
                  type="color"
                  value={editor.selectedNode.bgColor && editor.selectedNode.bgColor !== "transparent" ? editor.selectedNode.bgColor : "#ffffff"}
                  onChange={(e) =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { bgColor: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="inspector-clear"
                  title="Reset to theme default"
                  onClick={() =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { bgColor: undefined })
                  }
                >
                  <span className="material-symbols-rounded">restart_alt</span>
                </button>
              </div>

              <div className="inspector-row">
                <label className="inspector-label">Border</label>
                <button
                  type="button"
                  className={`inspector-preset-btn${(editor.selectedNode.borderWidth ?? 1) === 0 ? " inspector-preset-btn--active" : ""}`}
                  title="No border"
                  onClick={() =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { borderWidth: 0, borderColor: undefined })
                  }
                >
                  <span className="material-symbols-rounded">block</span>
                </button>
                <input
                  type="number"
                  min={0}
                  max={16}
                  value={editor.selectedNode.borderWidth ?? 1}
                  style={{ width: 52 }}
                  onChange={(e) =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { borderWidth: Number(e.target.value) })
                  }
                />
                <input
                  type="color"
                  value={editor.selectedNode.borderColor || "#6b7280"}
                  onChange={(e) =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { borderColor: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="inspector-clear"
                  title="Reset to default"
                  onClick={() =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { borderWidth: undefined, borderColor: undefined })
                  }
                >
                  <span className="material-symbols-rounded">restart_alt</span>
                </button>
              </div>

              <div className="inspector-row">
                <label className="inspector-label">Text</label>
                <input
                  type="color"
                  value={editor.selectedNode.textColor || "#111827"}
                  onChange={(e) =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { textColor: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="inspector-clear"
                  title="Reset to default"
                  onClick={() =>
                    editor.selectedNode &&
                    editor.updateNodeStyle(editor.selectedNode.id, { textColor: undefined })
                  }
                >
                  <span className="material-symbols-rounded">restart_alt</span>
                </button>
              </div>

              <div className="inspector-row">
                <label className="inspector-label">Layout</label>
                <div className="layout-mode-btns">
                  {(
                    [
                      { value: "", icon: "remove", title: "Inherit" },
                      { value: "balanced", icon: "hub", title: "Balanced" },
                      { value: "right", icon: "east", title: "Right" },
                      { value: "left", icon: "west", title: "Left" },
                      { value: "down", icon: "south", title: "Down" },
                      { value: "up", icon: "north", title: "Up" },
                    ] as const
                  ).map(({ value, icon, title }) => (
                    <button
                      key={value}
                      type="button"
                      title={title}
                      className={`layout-mode-btn${(editor.selectedNode?.nodeLayout || "") === value ? " layout-mode-btn--active" : ""}`}
                      onClick={() =>
                        editor.selectedNode &&
                        editor.updateNodeStyle(editor.selectedNode.id, {
                          nodeLayout: (value as LayoutMode) || undefined,
                        })
                      }
                    >
                      <span className="material-symbols-rounded">{icon}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="inspector-empty">Select a node to inspect</div>
          )}
        </aside>
      </section>
      )}

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
