import { useEffect, useMemo, useState } from "react";
import { featureFlags } from "../config/features";
import { useMindmapEditor } from "../hooks/useMindmapEditor";
import { googleSheetsService } from "../services/googleSheets/client";
import type { GraphSheet, GraphSpreadsheet } from "../services/googleSheets/types";
import { MindmapCanvas } from "./MindmapCanvas";

type EditorShellProps = {
  appName: string;
};

const STORAGE_KEYS = {
  rememberLogin: "reactMind.auth.remember",
  spreadsheetId: "reactMind.store.selectedSpreadsheetId",
  sheetTitle: "reactMind.store.selectedSheetTitle",
};

export function EditorShell({ appName }: EditorShellProps) {
  const editor = useMindmapEditor();

  const [connection, setConnection] = useState(() => googleSheetsService.getConnectionStatus());
  const [syncStatus, setSyncStatus] = useState<string>("idle");
  const [syncError, setSyncError] = useState<string>("");

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

  const [graphLoaded, setGraphLoaded] = useState<boolean>(false);

  const refreshConnection = () => {
    setConnection(googleSheetsService.getConnectionStatus());
  };

  const selectedStore = useMemo(
    () => spreadsheets.find((item) => item.id === selectedSpreadsheetId) || null,
    [spreadsheets, selectedSpreadsheetId],
  );

  const canEditGraph = connection.authState === "authorized" && !!selectedSpreadsheetId && !!selectedSheetTitle && graphLoaded;

  const runTask = async (nextStatus: string, task: () => Promise<void>) => {
    try {
      setSyncError("");
      setSyncStatus(nextStatus);
      await task();
    } catch (error) {
      setSyncStatus("error");
      setSyncError(error instanceof Error ? error.message : "Unexpected error");
    }
  };

  const loadGraphIntoEditor = async (spreadsheetId: string, sheetTitle: string) => {
    const loaded = await googleSheetsService.loadMindmap({ spreadsheetId, sheetTitle });
    if (loaded) {
      editor.importDocument(loaded);
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
    await runTask("authorizing...", async () => {
      await googleSheetsService.authorize();
      localStorage.setItem(STORAGE_KEYS.rememberLogin, "1");
      refreshConnection();
      await refreshStores();
      setSyncStatus("authorized");
    });
  };

  const handleLogout = async () => {
    await runTask("signing out...", async () => {
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

  const handleCreateStore = async () => {
    await runTask("creating store...", async () => {
      const created = await googleSheetsService.createGraphSpreadsheet({
        name: newStoreName,
        initialGraphName: newGraphName,
      });

      setSelectedSpreadsheetId(created.id);
      localStorage.setItem(STORAGE_KEYS.spreadsheetId, created.id);
      await refreshStores();
      setSyncStatus("store created");
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

  const handleCreateGraph = async () => {
    if (!selectedSpreadsheetId) {
      setSyncError("Please select a graph store first.");
      return;
    }

    await runTask("creating graph...", async () => {
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
  };

  const handleSaveGraph = async () => {
    if (!selectedSpreadsheetId || !selectedSheetTitle) {
      setSyncError("Please select both graph store and graph sheet.");
      return;
    }

    await runTask("saving graph...", async () => {
      await googleSheetsService.saveMindmap({
        spreadsheetId: selectedSpreadsheetId,
        sheetTitle: selectedSheetTitle,
        document: {
          ...editor.document,
          title: selectedSheetTitle,
        },
        snapshot: editor.currentSnapshot || undefined,
      });
      setSyncStatus("graph saved");
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
    const shouldRestore = localStorage.getItem(STORAGE_KEYS.rememberLogin) === "1";
    if (!shouldRestore) {
      return;
    }

    runTask("restoring session...", async () => {
      await googleSheetsService.authorize({ silent: true });
      refreshConnection();
      await refreshStores();
      setSyncStatus("session restored");
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
        <h1 className="topbar__title">{appName}</h1>
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
        <aside className="panel">
          <h2>Graph Store</h2>
          <ul className="kv">
            <li>Store: {selectedStore?.name || "none"}</li>
            <li>Graph: {selectedSheetTitle || "none"}</li>
            <li>Status: {syncStatus}</li>
            <li>Remote Edit: {canEditGraph ? "enabled" : "locked"}</li>
            <li>Sheets Sync: {featureFlags.enableSheetsSync ? "on" : "off"}</li>
          </ul>

          <div className="toolbar">
            <button type="button" onClick={handleRefreshStores} disabled={connection.authState !== "authorized"}>
              Refresh Stores
            </button>

            <label className="form-label">
              New Store Name
              <input
                value={newStoreName}
                onChange={(event) => setNewStoreName(event.target.value)}
                disabled={connection.authState !== "authorized"}
              />
            </label>

            <label className="form-label">
              New Graph Name
              <input
                value={newGraphName}
                onChange={(event) => setNewGraphName(event.target.value)}
                disabled={connection.authState !== "authorized"}
              />
            </label>

            <button type="button" onClick={handleCreateStore} disabled={connection.authState !== "authorized"}>
              Create Store + Graph
            </button>

            <label className="form-label">
              Select Store
              <select
                value={selectedSpreadsheetId}
                onChange={(event) => handleStoreChange(event.target.value)}
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
              Select Graph Sheet
              <select
                value={selectedSheetTitle}
                onChange={(event) => handleSheetChange(event.target.value)}
                disabled={connection.authState !== "authorized" || !selectedSpreadsheetId}
              >
                <option value="">-- Select --</option>
                {graphSheets.map((sheet) => (
                  <option key={`${sheet.id}-${sheet.title}`} value={sheet.title}>
                    {sheet.title}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={handleCreateGraph}
              disabled={connection.authState !== "authorized" || !selectedSpreadsheetId}
            >
              Add Graph Sheet
            </button>
            <button
              type="button"
              onClick={handleSaveGraph}
              disabled={!canEditGraph || connection.authState !== "authorized"}
            >
              Save Graph
            </button>
          </div>

          {syncError ? <p className="error-text">{syncError}</p> : null}
        </aside>

        <section className="canvas canvas--content">
          <h3>Mindmap Canvas</h3>
          {!canEditGraph ? <p className="hint-text">Sign in and select a graph sheet to unlock editing.</p> : null}
          <MindmapCanvas
            nodes={editor.document.nodes}
            selectedNodeId={editor.selectedNode?.id ?? null}
            onSelectNode={editor.selectNode}
          />
        </section>

        <aside className="panel">
          <h2>Inspector</h2>
          <ul className="kv">
            <li>Selection: {editor.selectedNode?.title ?? "none"}</li>
            <li>Depth: {selectedNodeDepth}</li>
            <li>Nodes: {editor.document.nodes.length}</li>
            <li>History: {editor.historyIndex + 1}/{editor.historyCount}</li>
            <li>Shortcuts: Tab / Enter / Delete / Ctrl+Z / Ctrl+Y</li>
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
    </main>
  );
}
