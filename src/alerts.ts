import type { WatchItem } from "./types";

export function targetKey(item: WatchItem): string {
  return `${item.address}:${item.target.direction}:${item.target.price}`;
}

export function isHit(price: number, item: WatchItem): boolean {
  return item.target.direction === "above"
    ? price >= item.target.price
    : price <= item.target.price;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.01) return value.toFixed(6);
  return value.toPrecision(4);
}

export interface AlertOptions {
  symbol: string;
  price: number;
  target: number;
  direction: string;
  address: string;
  index: number;
  total: number;
  when: Date;
}

export function formatAlert(opts: AlertOptions): string {
  const { symbol, price, target, direction, address, index, total, when } = opts;
  const change = ((price - target) / target) * 100;
  const sign = change >= 0 ? "+" : "";
  const timestamp = when.toLocaleString("en-GB", { hour12: false });
  return [
    `🚨 TARGET HIT (${index}/${total})`,
    `${symbol}  $${formatPrice(price)}`,
    `Target: ${direction} $${formatPrice(target)}  (${sign}${change.toFixed(2)}%)`,
    `Solana · ${timestamp}`,
    `https://gmgn.ai/sol/token/${address}`,
  ].join("\n");
}
