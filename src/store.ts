import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseWatchItem } from "./config";
import type { WatchItem } from "./types";

export const WATCHLIST_PATH = resolve(process.cwd(), "config/watchlist.json");

export class WatchStore {
  private items: WatchItem[] = [];

  constructor(private readonly filePath: string = WATCHLIST_PATH) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.filePath)) {
      this.items = [];
      return;
    }
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("config/watchlist.json must be a JSON array");
    }
    this.items = parsed.map((item, index) => parseWatchItem(item, index));
  }

  list(): WatchItem[] {
    return this.items.map((item) => ({ ...item, target: { ...item.target } }));
  }

  count(): number {
    return this.items.length;
  }

  add(item: WatchItem): void {
    const index = this.items.findIndex((existing) => existing.address === item.address);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
    this.persist();
  }

  remove(address: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.address !== address);
    const changed = this.items.length !== before;
    if (changed) this.persist();
    return changed;
  }

  clear(): number {
    const count = this.items.length;
    this.items = [];
    this.persist();
    return count;
  }

  private persist(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.items, null, 2)}\n`, "utf8");
  }
}
