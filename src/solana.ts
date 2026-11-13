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

export function base58Encode(input: Uint8Array): string {
  if (input.length === 0) return "";
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros += 1;
  if (zeros === input.length) return "1".repeat(zeros);

  let digits = [0];
  for (let i = zeros; i < input.length; i += 1) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  return "1".repeat(zeros) + digits.reverse().map((digit) => ALPHABET[digit]).join("");
}
