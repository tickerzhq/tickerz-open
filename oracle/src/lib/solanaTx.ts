/**
 * The few Solana pieces Tickerz needs, with no SDK: base58, a keypair from its secret, and a legacy transaction that
 * carries one SPL Memo instruction. A memo is the whole record: the program writes the text into the transaction's
 * log, it moves no money and creates no account, so the only cost is the network fee.
 *
 * Signing uses Node's own Ed25519 (node:crypto). The byte layout is Solana's legacy wire format, checked once against
 * @solana/kit 5.5.1's decoder on Oct 6 2026; the tests pin those bytes (src/lib/__tests__/solanaRecord.test.ts).
 */
import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";

export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/** Solana mainnet's genesis hash, as CAIP-2 names the chain (the Actions spec's X-Blockchain-Ids). */
export const SOLANA_MAINNET_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const LAMPORTS_PER_SOL = 1_000_000_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = B58_INDEX.get(c);
    if (v === undefined) throw new Error("not_base58");
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of text) {
    if (c !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

/** A Solana address (32 bytes, base58) as bytes, or null when it is not one. */
export function addressBytes(address: unknown): Uint8Array | null {
  if (typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  try {
    const b = base58Decode(address);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export const isSignature = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s) && base58Decode(s).length === 64;

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export type Keypair = { address: string; publicKey: Uint8Array; privateKey: KeyObject };

/**
 * A keypair from its secret: base58 of the 64 bytes (seed then public key, as wallets export it) or the JSON array
 * solana-keygen writes. The public half is derived from the seed and must match the stored one. Throws a short reason,
 * never the secret.
 */
export function keypairFromSecret(secret: string): Keypair {
  const s = secret.trim();
  let bytes: Uint8Array;
  try {
    bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : base58Decode(s);
  } catch {
    throw new Error("solana_key_unreadable");
  }
  if (bytes.length !== 64) throw new Error("solana_key_length");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(bytes.subarray(0, 32))]), format: "der", type: "pkcs8" });
  const publicKey = new Uint8Array(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32));
  if (!Buffer.from(publicKey).equals(Buffer.from(bytes.subarray(32)))) throw new Error("solana_key_inconsistent");
  return { address: base58Encode(publicKey), publicKey, privateKey };
}

/** Solana's compact-u16 length prefix. */
export function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const low = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return [...b]; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return [...b]; };

export type MemoTx = {
  /** The fee payer and the memo's one signer. */
  payer: string;
  memo: string;
  /** A recent blockhash, base58. */
  blockhash: string;
  /** Compute budget: both or neither. Priority price in micro-lamports per compute unit. */
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
};

/**
 * The legacy message of a memo transaction. Accounts: the payer (signer, writable), then the read-only programs.
 * Instructions: the optional compute budget pair, then the memo with the payer as its signer.
 */
export function memoMessage(tx: MemoTx): Uint8Array {
  const payer = addressBytes(tx.payer);
  if (!payer) throw new Error("bad_payer");
  const blockhash = addressBytes(tx.blockhash);
  if (!blockhash) throw new Error("bad_blockhash");
  const memo = Buffer.from(tx.memo, "utf8");
  if (memo.length === 0 || memo.length > 566) throw new Error("bad_memo_length");
  const budget = tx.computeUnitLimit != null && tx.computeUnitPriceMicroLamports != null;
  const programs = budget ? [COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM] : [MEMO_PROGRAM];
  const keys = [payer, ...programs.map((p) => addressBytes(p)!)];
  const memoIndex = keys.length - 1;
  const ix: { program: number; accounts: number[]; data: number[] }[] = [];
  if (budget) {
    ix.push({ program: 1, accounts: [], data: [2, ...u32le(tx.computeUnitLimit!)] });
    ix.push({ program: 1, accounts: [], data: [3, ...u64le(tx.computeUnitPriceMicroLamports!)] });
  }
  ix.push({ program: memoIndex, accounts: [0], data: [...memo] });
  const out: number[] = [1, 0, programs.length, ...compactU16(keys.length)];
  for (const k of keys) out.push(...k);
  out.push(...blockhash, ...compactU16(ix.length));
  for (const i of ix) out.push(i.program, ...compactU16(i.accounts.length), ...i.accounts, ...compactU16(i.data.length), ...i.data);
  return Uint8Array.from(out);
}

/** The wire transaction: the signatures (64 zero bytes where one is still to come), then the message. */
export function wireTransaction(message: Uint8Array, signatures: (Uint8Array | null)[]): Uint8Array {
  const sigs = signatures.map((s) => s ?? new Uint8Array(64));
  return Uint8Array.from([...compactU16(sigs.length), ...sigs.flatMap((s) => [...s]), ...message]);
}

export const signBytes = (key: KeyObject, message: Uint8Array): Uint8Array => new Uint8Array(edSign(null, message, key));
