export type FeatureFlags = {
  enableSheetsSync: boolean;
  enableHistoryPanel: boolean;
  enableImportExport: boolean;
};

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) {
    return fallback;
  }
  return raw.toLowerCase() === "true";
};

export const featureFlags: FeatureFlags = {
  enableSheetsSync: parseBool(import.meta.env.VITE_FEATURE_SHEETS_SYNC, false),
  enableHistoryPanel: parseBool(import.meta.env.VITE_FEATURE_HISTORY_PANEL, true),
  enableImportExport: parseBool(import.meta.env.VITE_FEATURE_IMPORT_EXPORT, true),
};
