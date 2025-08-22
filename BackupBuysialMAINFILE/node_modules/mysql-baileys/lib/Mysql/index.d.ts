import { MySQLConfig, sqlData, AuthenticationState } from '../Types';
export declare const useMySQLAuthState: (config: MySQLConfig) => Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
    clear: () => Promise<void>;
    removeCreds: () => Promise<void>;
    query: (sql: string, values: string[]) => Promise<sqlData>;
}>;
