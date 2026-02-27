import { appConfig } from "../../config/env";
import type { MindmapDocument, MindmapEdge, MindmapNode, MindmapSnapshot } from "../../domain/mindmap";
import { createEmptyMindmap } from "../../domain/mindmap";
import type {
  CreateGraphSheetInput,
  CreateGraphSpreadsheetInput,
  GoogleSheetsService,
  GraphSheet,
  GraphSpreadsheet,
  SaveMindmapInput,
  SheetsConnectionStatus,
} from "./types";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const STORE_FLAG_KEY = "reactMindGraphStore";
const STORE_FLAG_VALUE = "true";
const ROW_HEADERS = ["kind", "id", "title", "parentId", "order", "fromNodeId", "toNodeId"];

type GraphRowKind = "node" | "edge";

let authState: SheetsConnectionStatus["authState"] = "idle";
let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const getRequiredOrigins = (): string[] => {
  const configured = splitCsv(appConfig.googleAuthorizedOriginsHint);
  const currentOrigin = window.location.origin;
  return Array.from(new Set([...configured, currentOrigin]));
};

const buildOriginSetupHint = (): string => {
  const origins = getRequiredOrigins();
  const list = origins.map((origin) => `- ${origin}`).join("\n");

  return [
    "Use Google Cloud Console Web OAuth Client settings:",
    "1) Authorized JavaScript origins must include:",
    list,
    "2) Client ID must be a Web client ending with .apps.googleusercontent.com",
    "3) Do not use IAM oauthClients/* IDs in frontend config",
  ].join("\n");
};

const createConnectionStatus = (): SheetsConnectionStatus => ({
  authState,
});

const assertSheetsConfig = (): void => {
  if (!appConfig.googleClientId) {
    throw new Error("Google OAuth client id is missing. Please check VITE_GOOGLE_CLIENT_ID.");
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(appConfig.googleClientId)) {
    throw new Error(
      `Invalid frontend OAuth client id: this looks like an IAM OAuth client id.\n${buildOriginSetupHint()}`,
    );
  }

  if (!appConfig.googleClientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error(
      `Invalid Google OAuth client id for browser login.\n${buildOriginSetupHint()}`,
    );
  }
};

const loadGoogleIdentityScript = async (): Promise<void> => {
  if (window.google?.accounts.oauth2) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-google-identity="true"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Google Identity script.")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Identity script."));
    document.head.appendChild(script);
  });
};

const requestAccessToken = async (options?: { silent?: boolean }): Promise<string> => {
  await loadGoogleIdentityScript();

  return new Promise<string>((resolve, reject) => {
    const oauth2 = window.google?.accounts.oauth2;
    if (!oauth2) {
      reject(new Error("Google OAuth SDK not available."));
      return;
    }

    const tokenClient = oauth2.initTokenClient({
      client_id: appConfig.googleClientId,
      scope: appConfig.googleScopes,
      callback: (response) => {
        if (response.error || !response.access_token) {
          authState = "unauthorized";

          if (response.error === "redirect_uri_mismatch") {
            reject(new Error(`Google OAuth redirect_uri_mismatch.\n${buildOriginSetupHint()}`));
            return;
          }

          if (response.error === "origin_mismatch") {
            reject(new Error(`Google OAuth origin_mismatch.\n${buildOriginSetupHint()}`));
            return;
          }

          reject(new Error(response.error_description || response.error || "Google authorization failed."));
          return;
        }
        accessToken = response.access_token;
        accessTokenExpiresAt = Date.now() + Math.max(0, response.expires_in - 60) * 1000;
        authState = "authorized";
        resolve(response.access_token);
      },
      error_callback: () => {
        authState = "unauthorized";
        reject(new Error("Google OAuth popup was blocked or cancelled."));
      },
    });

    tokenClient.requestAccessToken({
      prompt: options?.silent ? "none" : accessToken ? "" : "consent",
    });
  });
};

const getAccessToken = async (): Promise<string> => {
  if (accessToken && Date.now() < accessTokenExpiresAt) {
    return accessToken;
  }
  return requestAccessToken();
};

const authFetch = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const token = await getAccessToken();

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google API request failed (${response.status}): ${text}`);
  }

  if (response.status === 204) {
    return null as T;
  }

  return (await response.json()) as T;
};

const sheetsFetch = async <T>(spreadsheetId: string, path: string, init?: RequestInit): Promise<T> => {
  return authFetch<T>(`${SHEETS_API_BASE}/${spreadsheetId}${path}`, init);
};

const driveFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  return authFetch<T>(`${DRIVE_API_BASE}${path}`, init);
};

const toSheetTitle = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Graph name is required.");
  }
  return trimmed.slice(0, 80);
};

const sanitizeStoreName = (name: string): string => {
  const trimmed = name.trim();
  return trimmed || "React Mind Graph Store";
};

const parseNodes = (rows: string[][]): MindmapNode[] => {
  return rows
    .filter((row) => row[0] === "node" && row[1])
    .map((row) => ({
      id: row[1],
      title: row[2] || "Untitled",
      parentId: row[3] || null,
      order: Number(row[4] || 0),
    }));
};

const parseEdges = (rows: string[][]): MindmapEdge[] => {
  return rows
    .filter((row) => row[0] === "edge" && row[1] && row[5] && row[6])
    .map((row) => ({
      id: row[1],
      fromNodeId: row[5],
      toNodeId: row[6],
    }));
};

const ensureRootNode = (document: MindmapDocument): MindmapDocument => {
  if (document.nodes.some((node) => node.id === "root")) {
    return document;
  }

  return {
    ...document,
    nodes: [
      {
        id: "root",
        title: document.title,
        parentId: null,
        order: 0,
      },
      ...document.nodes,
    ],
  };
};

const buildGraphRows = (document: MindmapDocument): string[][] => {
  const nodeRows = document.nodes.map((node) => [
    "node" satisfies GraphRowKind,
    node.id,
    node.title,
    node.parentId || "",
    String(node.order),
    "",
    "",
  ]);

  const edgeRows = document.edges.map((edge) => [
    "edge" satisfies GraphRowKind,
    edge.id,
    "",
    "",
    "",
    edge.fromNodeId,
    edge.toNodeId,
  ]);

  return [ROW_HEADERS, ...nodeRows, ...edgeRows];
};

const buildHistoryPayload = (snapshot?: MindmapSnapshot): string => {
  if (!snapshot) {
    return "";
  }

  return JSON.stringify({
    id: snapshot.id,
    createdAtIso: snapshot.createdAtIso,
    source: snapshot.source,
    nodeCount: snapshot.nodes.length,
    edgeCount: snapshot.edges.length,
  });
};

const setSpreadsheetAppProperties = async (spreadsheetId: string): Promise<void> => {
  await driveFetch(`/files/${spreadsheetId}?fields=id`, {
    method: "PATCH",
    body: JSON.stringify({
      appProperties: {
        [STORE_FLAG_KEY]: STORE_FLAG_VALUE,
      },
    }),
  });
};

const initializeGraphSheet = async (spreadsheetId: string, sheetTitle: string): Promise<void> => {
  const title = toSheetTitle(sheetTitle);
  const document = createEmptyMindmap(spreadsheetId, title);
  await sheetsFetch<{ clearedRanges?: string[] }>(spreadsheetId, `/values/${encodeURIComponent(title)}!A:G:clear`, {
    method: "POST",
    body: JSON.stringify({}),
  });

  await sheetsFetch<{ updatedCells?: number }>(spreadsheetId, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        {
          range: `${title}!A1:G`,
          majorDimension: "ROWS",
          values: buildGraphRows(document),
        },
      ],
    }),
  });

  await sheetsFetch<{ updatedCells?: number }>(spreadsheetId, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: [
        {
          range: "Meta!A1:B4",
          majorDimension: "ROWS",
          values: [
            ["projectId", appConfig.googleProjectId],
            ["app", "react-mind"],
            ["updatedAtIso", new Date().toISOString()],
            ["activeGraph", title],
          ],
        },
      ],
    }),
  });
};

export const googleSheetsService: GoogleSheetsService = {
  getConnectionStatus() {
    return createConnectionStatus();
  },

  async authorize(options) {
    assertSheetsConfig();
    await requestAccessToken(options);
  },

  async logout() {
    const currentToken = accessToken;

    accessToken = null;
    accessTokenExpiresAt = 0;
    authState = "unauthorized";

    if (currentToken && window.google?.accounts?.oauth2) {
      await new Promise<void>((resolve) => {
        window.google?.accounts.oauth2.revoke(currentToken, () => resolve());
      });
    }
  },

  async listGraphSpreadsheets() {
    assertSheetsConfig();

    const q = encodeURIComponent(
      `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and appProperties has { key='${STORE_FLAG_KEY}' and value='${STORE_FLAG_VALUE}' }`,
    );

    const response = await driveFetch<{
      files?: Array<{ id: string; name: string; modifiedTime?: string }>;
    }>(`/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=100`);

    return (response.files || []).map((file) => ({
      id: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime,
    })) as GraphSpreadsheet[];
  },

  async createGraphSpreadsheet(input: CreateGraphSpreadsheetInput) {
    assertSheetsConfig();

    const response = await driveFetch<{ id: string; name: string; modifiedTime?: string }>(
      "/files?fields=id,name,modifiedTime",
      {
        method: "POST",
        body: JSON.stringify({
          name: sanitizeStoreName(input.name),
          mimeType: "application/vnd.google-apps.spreadsheet",
          appProperties: {
            [STORE_FLAG_KEY]: STORE_FLAG_VALUE,
          },
        }),
      },
    );

    const spreadsheetId = response.id;

    await sheetsFetch<{ replies?: unknown[] }>(spreadsheetId, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: "Meta",
              },
            },
          },
          {
            updateSheetProperties: {
              properties: {
                sheetId: 0,
                title: toSheetTitle(input.initialGraphName || "Graph 1"),
              },
              fields: "title",
            },
          },
        ],
      }),
    });

    await setSpreadsheetAppProperties(spreadsheetId);
    await initializeGraphSheet(spreadsheetId, input.initialGraphName || "Graph 1");

    return {
      id: spreadsheetId,
      name: response.name,
      modifiedTime: response.modifiedTime,
    };
  },

  async listGraphSheets(spreadsheetId: string) {
    assertSheetsConfig();
    if (!spreadsheetId) {
      return [];
    }

    const metadata = await sheetsFetch<{
      sheets?: Array<{ properties?: { sheetId?: number; title?: string } }>;
    }>(spreadsheetId, "?fields=sheets.properties(sheetId,title)");

    return (metadata.sheets || [])
      .map((sheet) => ({
        id: sheet.properties?.sheetId || -1,
        title: sheet.properties?.title || "",
      }))
      .filter((sheet) => sheet.title && sheet.title !== "Meta") as GraphSheet[];
  },

  async createGraphSheet(input: CreateGraphSheetInput) {
    assertSheetsConfig();

    const title = toSheetTitle(input.sheetTitle);
    const result = await sheetsFetch<{
      replies?: Array<{ addSheet?: { properties?: { sheetId?: number; title?: string } } }>;
    }>(input.spreadsheetId, ":batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title,
              },
            },
          },
        ],
      }),
    });

    await initializeGraphSheet(input.spreadsheetId, title);

    const sheet = result.replies?.[0]?.addSheet?.properties;
    return {
      id: sheet?.sheetId || -1,
      title: sheet?.title || title,
    };
  },

  async loadMindmap({ spreadsheetId, sheetTitle }) {
    assertSheetsConfig();

    const title = toSheetTitle(sheetTitle);
    const encodedRange = encodeURIComponent(`${title}!A1:G`);
    const result = await sheetsFetch<{ values?: string[][] }>(spreadsheetId, `/values/${encodedRange}`);

    const rows = result.values || [];
    if (rows.length <= 1) {
      return createEmptyMindmap(spreadsheetId, title);
    }

    const dataRows = rows.slice(1);
    const nodes = parseNodes(dataRows);
    const edges = parseEdges(dataRows);

    if (nodes.length === 0) {
      return createEmptyMindmap(spreadsheetId, title);
    }

    return ensureRootNode({
      id: spreadsheetId,
      title,
      nodes,
      edges,
      updatedAtIso: new Date().toISOString(),
    });
  },

  async saveMindmap({ spreadsheetId, sheetTitle, document, snapshot }: SaveMindmapInput) {
    assertSheetsConfig();

    const title = toSheetTitle(sheetTitle);
    const normalized = ensureRootNode({
      ...document,
      title,
    });

    await sheetsFetch<{ clearedRanges?: string[] }>(spreadsheetId, `/values/${encodeURIComponent(`${title}!A:G`)}:clear`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    await sheetsFetch<{ updatedCells?: number }>(spreadsheetId, "/values:batchUpdate", {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: [
          {
            range: `${title}!A1:G`,
            majorDimension: "ROWS",
            values: buildGraphRows(normalized),
          },
          {
            range: "Meta!A1:B5",
            majorDimension: "ROWS",
            values: [
              ["projectId", appConfig.googleProjectId],
              ["app", "react-mind"],
              ["updatedAtIso", new Date().toISOString()],
              ["activeGraph", title],
              ["lastSave", buildHistoryPayload(snapshot)],
            ],
          },
        ],
      }),
    });

    await setSpreadsheetAppProperties(spreadsheetId);
  },
};
