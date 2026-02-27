import type { MindmapDocument, MindmapSnapshot } from "../../domain/mindmap";

export type SheetsAuthState = "idle" | "authorized" | "unauthorized";

export type SheetsConnectionStatus = {
  authState: SheetsAuthState;
};

export type GraphSpreadsheet = {
  id: string;
  name: string;
  modifiedTime?: string;
};

export type GraphSheet = {
  id: number;
  title: string;
};

export type LoadMindmapInput = {
  spreadsheetId: string;
  sheetTitle: string;
};

export type SaveMindmapInput = {
  spreadsheetId: string;
  sheetTitle: string;
  document: MindmapDocument;
  snapshot?: MindmapSnapshot;
};

export type CreateGraphSpreadsheetInput = {
  name: string;
  initialGraphName?: string;
};

export type CreateGraphSheetInput = {
  spreadsheetId: string;
  sheetTitle: string;
};

export interface GoogleSheetsService {
  getConnectionStatus: () => SheetsConnectionStatus;
  authorize: (options?: { silent?: boolean }) => Promise<void>;
  logout: () => Promise<void>;
  listGraphSpreadsheets: () => Promise<GraphSpreadsheet[]>;
  createGraphSpreadsheet: (input: CreateGraphSpreadsheetInput) => Promise<GraphSpreadsheet>;
  listGraphSheets: (spreadsheetId: string) => Promise<GraphSheet[]>;
  createGraphSheet: (input: CreateGraphSheetInput) => Promise<GraphSheet>;
  loadMindmap: (input: LoadMindmapInput) => Promise<MindmapDocument | null>;
  saveMindmap: (input: SaveMindmapInput) => Promise<void>;
}
