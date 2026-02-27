type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
};

type OverridableTokenClientConfig = {
  prompt?: "" | "none" | "consent" | "select_account";
};

type TokenClient = {
  callback: (response: TokenResponse) => void;
  requestAccessToken: (overrideConfig?: OverridableTokenClientConfig) => void;
};

type TokenClientConfig = {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type: string }) => void;
};

type GoogleAccounts = {
  oauth2: {
    initTokenClient: (config: TokenClientConfig) => TokenClient;
    revoke: (token: string, done?: () => void) => void;
  };
};

declare global {
  interface Window {
    google?: {
      accounts: GoogleAccounts;
    };
  }
}

export {};
