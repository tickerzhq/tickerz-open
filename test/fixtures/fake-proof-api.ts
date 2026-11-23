// Loaded with --import ahead of scripts/verify-proof.ts by test/proof.property.test.ts: the proof endpoint answers
// from FAKE_PROOF_JSON (the seal's JSON) and FAKE_PROOF_OTS (the .ots file, base64) instead of the network.
export {};

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.searchParams.get("format") === "ots") return new Response(new Uint8Array(Buffer.from(process.env.FAKE_PROOF_OTS ?? "", "base64")));
  return new Response(process.env.FAKE_PROOF_JSON ?? "", { headers: { "content-type": "application/json" } });
}) as typeof fetch;
