export type Direction = "above" | "below";

export interface Target {
  price: number;
  direction: Direction;
}

export interface WatchItem {
  address: string;
  symbol?: string;
  target: Target;
  pings: number;
}

export interface AppConfig {
  gmgnApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  pollIntervalMs: number;
  pingCount: number;
  pingDelayMs: number;
  solanaRpcUrl: string;
  posTopWallets: number;
}

export interface FiredRecord {
  firedAt: string;
  price: number;
}

export type FiredState = Record<string, FiredRecord>;

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  price: number;
  liquidity: number;
}
