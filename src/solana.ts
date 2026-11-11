const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ALPHABET_MAP = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) ALPHABET_MAP.set(ALPHABET[i], i);

export function isBase58(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

export function base58Decode(input: string): Uint8Array {
  if (!input) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = ALPHABET_MAP.get(ch);
    if (value === undefined) throw new Error(`Invalid base58 character "${ch}"`);
    let carry = value;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < input.length && input[i] === "1"; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
