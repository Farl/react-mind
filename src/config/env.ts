type AppConfig = {
  appName: string;
  environment: string;
  googleProjectId: string;
  googleClientId: string;
  googleApiKey: string;
  googleScopes: string;
  googleAuthorizedOriginsHint: string;
};

const readEnv = (name: string, fallback = ""): string => {
  const value = import.meta.env[name];
  if (typeof value !== "string") {
    return fallback;
  }
  return value;
};

export const appConfig: AppConfig = {
  appName: readEnv("VITE_APP_NAME", "React Mind"),
  environment: readEnv("MODE", "development"),
  googleProjectId: readEnv("VITE_GOOGLE_PROJECT_ID"),
  googleClientId: readEnv("VITE_GOOGLE_CLIENT_ID"),
  googleApiKey: readEnv("VITE_GOOGLE_API_KEY"),
  googleAuthorizedOriginsHint: readEnv(
    "VITE_GOOGLE_AUTHORIZED_ORIGINS_HINT",
    "http://localhost:5173,http://127.0.0.1:5173",
  ),
  googleScopes: readEnv(
    "VITE_GOOGLE_SCOPES",
    "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
  ),
};
