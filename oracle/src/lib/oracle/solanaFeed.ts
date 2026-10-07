/**
 * The Tickerz oracle program on Solana (oracle/programs/tickerz_oracle), from TypeScript with no SDK, in the same way
 * src/lib/solanaTx.ts writes memos: program addresses (PDAs), the Anchor instructions, a legacy transaction with
 * several accounts, and the feed account decoded from its bytes.
 *
 * One feed per ticker holds the newest print and the 16 before it. Only the publisher (the config's authority) may
 * write. Any program, or anyone with an RPC, reads it. Layout: the header of lib.rs.
 */
import { createHash } from "node:crypto";
import { addressBytes, base58Encode, compactU16 } from "../solanaTx";

/** The program's address. Devnet and local only until the mainnet deploy (a founder ask: the deploy costs SOL). */
export const ORACLE_PROGRAM_ID = "GNwZGzSNyEyuxgDqtZxcQPag4tAwQeagJiLQzy97AjD9";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export const RING = 16;
export const TICKER_LEN = 20;
export const FEED_SPACE = 8 + 72 + 72 * RING;

export const STATUS = { provisional: 0, final: 1, corrected: 2 } as const;
export type PrintStatus = keyof typeof STATUS;
export const CADENCE = { hour: 0, day: 1, week: 2, month: 3 } as const;
export type Cadence = keyof typeof CADENCE;
export const GRADE = { display: 0, settleable: 1 } as const;

// ---------------------------------------------------------------------------------------------------------------
// Program addresses
// ---------------------------------------------------------------------------------------------------------------

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

function mod(a: bigint) { const r = a % P; return r < 0n ? r + P : r; }
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n, x = mod(b), n = e;
  while (n > 0n) { if (n & 1n) r = (r * x) % P; x = (x * x) % P; n >>= 1n; }
  return r;
}
function modInv(a: bigint) { return modPow(mod(a), P - 2n); }

/**
 * Whether 32 bytes decode to a point on the Ed25519 curve (RFC 8032 section 5.1.3). A program address must not:
 * that is how Solana makes sure no private key exists for it.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x = u v^3 (u v^7)^((p-5)/8)
  const v3 = mod(v * v * v);
  let x = mod(u * v3 * modPow(u * v3 * v3 * v, (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === u) return true;
  if (vx2 === mod(-u)) { x = mod(x * SQRT_M1); return true; }
  return false;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress");

/** Solana's create_program_address: null when the hash lands on the curve. */
export function createProgramAddress(seeds: Uint8Array[], programId: string): Uint8Array | null {
  const program = addressBytes(programId);
  if (!program) throw new Error("bad_program_id");
  const h = createHash("sha256");
  for (const s of seeds) {
    if (s.length > 32) throw new Error("seed_too_long");
    h.update(s);
  }
  const out = new Uint8Array(h.update(program).update(PDA_MARKER).digest());
  return isOnCurve(out) ? null : out;
}

/** Solana's find_program_address: the first bump from 255 down that gives an address off the curve. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const a = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (a) return { address: base58Encode(a), bump };
  }
  throw new Error("no_program_address");
}

/** A ticker as the program keys it: upper case ASCII, zero padded to 20 bytes. */
export function tickerBytes(ticker: string): Uint8Array {
  const t = ticker.replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9.]{2,20}$/.test(t)) throw new Error("bad_ticker");
  const out = new Uint8Array(TICKER_LEN);
  out.set(Buffer.from(t, "ascii"));
  return out;
}

export const configAddress = (programId = ORACLE_PROGRAM_ID) => findProgramAddress([Buffer.from("config")], programId);
export const feedAddress = (ticker: string, programId = ORACLE_PROGRAM_ID) => findProgramAddress([Buffer.from("feed"), tickerBytes(ticker)], programId);
/** The upgradeable loader's program data account for a program: what init_config checks the upgrade authority on. */
export const programDataAddress = (programId = ORACLE_PROGRAM_ID) => findProgramAddress([addressBytes(programId)!], BPF_UPGRADEABLE_LOADER);

// ---------------------------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------------------------

/** Anchor's 8 byte discriminators: sha256("global:<name>") for an instruction, sha256("account:<Name>") for an account. */
export const ixDiscriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
export const accountDiscriminator = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

export type AccountMeta = { address: string; signer: boolean; writable: boolean };
export type Instruction = { program: string; accounts: AccountMeta[]; data: Uint8Array };

const i64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function bytes32(hex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("bad_hash");
  return Buffer.from(hex, "hex");
}

export function initConfigIx(payer: string, authority: string, programId = ORACLE_PROGRAM_ID): Instruction {
  const auth = addressBytes(authority);
  if (!auth) throw new Error("bad_authority");
  return {
    program: programId,
    accounts: [
      { address: configAddress(programId).address, signer: false, writable: true },
      { address: payer, signer: true, writable: true },
      { address: programId, signer: false, writable: false },
      { address: programDataAddress(programId).address, signer: false, writable: false },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: Buffer.concat([ixDiscriminator("init_config"), auth]),
  };
}

export type FeedSpec = { ticker: string; decimals: number; cadence: Cadence; settleable: boolean; ruleHash: string; ruleVersion: number };

export function createFeedIx(authority: string, f: FeedSpec, programId = ORACLE_PROGRAM_ID): Instruction {
  if (!Number.isInteger(f.decimals) || f.decimals < 0 || f.decimals > 12) throw new Error("bad_decimals");
  return {
    program: programId,
    accounts: [
      { address: configAddress(programId).address, signer: false, writable: false },
      { address: feedAddress(f.ticker, programId).address, signer: false, writable: true },
      { address: authority, signer: true, writable: true },
      { address: SYSTEM_PROGRAM, signer: false, writable: false },
    ],
    data: Buffer.concat([
      ixDiscriminator("create_feed"), tickerBytes(f.ticker), Uint8Array.of(f.decimals, CADENCE[f.cadence], f.settleable ? 1 : 0),
      bytes32(f.ruleHash), u32le(f.ruleVersion),
    ]),
  };
}

const publishAccounts = (authority: string, ticker: string, programId: string): AccountMeta[] => [
  { address: configAddress(programId).address, signer: false, writable: false },
  { address: feedAddress(ticker, programId).address, signer: false, writable: true },
  { address: authority, signer: true, writable: false },
];

export type PrintIx = { ticker: string; periodStart: number; value: bigint; status: PrintStatus; reportHash: string };

export function publishIx(authority: string, p: PrintIx, programId = ORACLE_PROGRAM_ID): Instruction {
  return {
    program: programId,
    accounts: publishAccounts(authority, p.ticker, programId),
    data: Buffer.concat([ixDiscriminator("publish"), i64le(BigInt(p.periodStart)), i64le(p.value), Uint8Array.of(STATUS[p.status]), bytes32(p.reportHash)]),
  };
}

export function setRuleIx(authority: string, ticker: string, ruleHash: string, ruleVersion: number, settleable: boolean, programId = ORACLE_PROGRAM_ID): Instruction {
  return {
    program: programId,
    accounts: publishAccounts(authority, ticker, programId),
    data: Buffer.concat([ixDiscriminator("set_rule"), bytes32(ruleHash), u32le(ruleVersion), Uint8Array.of(settleable ? 1 : 0)]),
  };
}

/**
 * A legacy message for any instructions. Accounts in Solana's order: the payer, other writable signers, read-only
 * signers, writable non-signers, read-only non-signers (programs last among those).
 */
export function legacyMessage(payer: string, instructions: Instruction[], blockhash: string): Uint8Array {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (address: string, signer: boolean, writable: boolean) => {
    const m = metas.get(address) ?? { signer: false, writable: false };
    metas.set(address, { signer: m.signer || signer, writable: m.writable || writable });
  };
  add(payer, true, true);
  for (const ix of instructions) {
    for (const a of ix.accounts) add(a.address, a.signer, a.writable);
    add(ix.program, false, false);
  }
  const rank = (a: string) => {
    if (a === payer) return 0;
    const m = metas.get(a)!;
    return m.signer ? (m.writable ? 1 : 2) : (m.writable ? 3 : 4);
  };
  const order = [...metas.keys()].sort((a, b) => rank(a) - rank(b));
  const index = new Map(order.map((a, i) => [a, i]));
  const keyBytes = order.map((a) => { const b = addressBytes(a); if (!b) throw new Error("bad_address"); return b; });
  const hash = addressBytes(blockhash);
  if (!hash) throw new Error("bad_blockhash");
  const numSigners = order.filter((a) => metas.get(a)!.signer).length;
  const roSigners = order.filter((a) => metas.get(a)!.signer && !metas.get(a)!.writable).length;
  const roUnsigned = order.filter((a) => !metas.get(a)!.signer && !metas.get(a)!.writable).length;
  const out: number[] = [numSigners, roSigners, roUnsigned, ...compactU16(order.length)];
  for (const k of keyBytes) out.push(...k);
  out.push(...hash, ...compactU16(instructions.length));
  for (const ix of instructions) {
    out.push(index.get(ix.program)!, ...compactU16(ix.accounts.length), ...ix.accounts.map((a) => index.get(a.address)!));
    out.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}

/** The signer addresses a message needs, in order: what wireTransaction's signature list must follow. */
export function messageSigners(message: Uint8Array): string[] {
  const n = message[0];
  let off = 3;
  let len = 0, shift = 0;
  for (;;) { const b = message[off++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  return Array.from({ length: Math.min(n, len) }, (_, i) => base58Encode(message.subarray(off + 32 * i, off + 32 * (i + 1))));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a feed
// ---------------------------------------------------------------------------------------------------------------

export type FeedPrint = { periodStart: number; value: bigint; publishedAt: number; seq: bigint; reportHash: string; status: PrintStatus };
export type FeedState = {
  ticker: string; ruleHash: string; decimals: number; cadence: Cadence; settleable: boolean; ruleVersion: number; seq: bigint;
  /** Newest first. */
  prints: FeedPrint[];
};

const STATUS_NAME = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [v, k])) as Record<number, PrintStatus>;
const CADENCE_NAME = Object.fromEntries(Object.entries(CADENCE).map(([k, v]) => [v, k])) as Record<number, Cadence>;

/** A feed account's data, as getAccountInfo returns it (base64 decoded). Throws on anything that is not a feed. */
export function decodeFeed(data: Uint8Array): FeedState {
  if (data.length < FEED_SPACE) throw new Error("not_a_feed");
  const b = Buffer.from(data);
  if (!b.subarray(0, 8).equals(accountDiscriminator("Feed"))) throw new Error("not_a_feed");
  const d = b.subarray(8);
  const tick = d.subarray(0, 20);
  const end = tick.indexOf(0);
  const head = d[55], count = d[56];
  const prints: FeedPrint[] = [];
  for (let i = 0; i < count; i++) {
    const o = 72 + 72 * ((head + RING - i) % RING);
    prints.push({
      periodStart: Number(d.readBigInt64LE(o)), value: d.readBigInt64LE(o + 8), publishedAt: Number(d.readBigInt64LE(o + 16)),
      seq: d.readBigUInt64LE(o + 24), reportHash: d.subarray(o + 32, o + 64).toString("hex"), status: STATUS_NAME[d[o + 64]] ?? "provisional",
    });
  }
  return {
    ticker: tick.subarray(0, end < 0 ? 20 : end).toString("ascii"), ruleHash: d.subarray(20, 52).toString("hex"), decimals: d[52],
    cadence: CADENCE_NAME[d[53]] ?? "day", settleable: d[54] === 1, ruleVersion: d.readUInt32LE(60), seq: d.readBigUInt64LE(64), prints,
  };
}

/** The print a market settles on for a period: the newest final or corrected one, on a settleable feed. */
export function settledPrint(feed: FeedState, periodStart: number): FeedPrint | null {
  if (!feed.settleable) return null;
  return feed.prints.find((p) => p.periodStart === periodStart && p.status !== "provisional") ?? null;
}

/** A period key ("2026-10-06", "2026-10-06T13", "2026-W40" is not used: weeks key on their last day) as the UTC second it starts. */
export function periodStartOf(period: string, cadence: Cadence): number {
  if (cadence === "month") {
    const m = /^(\d{4})-(\d{2})(?:-01)?$/.exec(period);
    if (!m) throw new Error("bad_period");
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) / 1000;
  }
  if (cadence === "hour") {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})(?::00(?::00)?Z?)?$/.exec(period);
    if (!m) throw new Error("bad_period");
    return Date.parse(`${m[1]}T${m[2]}:00:00Z`) / 1000;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) throw new Error("bad_period");
  const t = Date.parse(`${period}T00:00:00Z`) / 1000;
  // A week is keyed by the Saturday it ends on (the Labor Department's way): it starts six days before.
  return cadence === "week" ? t - 6 * 86_400 : t;
}
