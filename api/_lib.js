// Shared helpers for the OnlyHuman checker + relayer (Vercel serverless functions).
const { ethers } = require("ethers");

const CHAINS = {
  1990: { name: "QIE Mainnet", rpc: process.env.RPC_MAINNET || "https://rpc5mainnet.qie.digital", explorer: "https://mainnet.qie.digital" },
  1983: { name: "QIE Testnet", rpc: process.env.RPC_TESTNET || "https://rpc2testnet.qie.digital", explorer: "https://testnet.qie.digital" },
  31337: { name: "Local", rpc: process.env.RPC_LOCAL || "http://127.0.0.1:8545", explorer: "" },
};

// Contract address per chain comes from env so redeploys don't need code changes.
function contractAddress(chainId) {
  return process.env[`ONLYHUMAN_${chainId}`] || "";
}

const ABI = [
  "function getDrop(uint256) view returns (tuple(address creator,address token,uint128 amountPerClaim,uint128 balance,uint32 maxClaims,uint32 claimed,uint16 verifiedBonusBps,uint8 gate,uint64 endsAt,bool closed))",
  "function walletClaimed(uint256,address) view returns (bool)",
  "function humanClaimed(uint256,bytes32) view returns (bool)",
  "function checker() view returns (address)",
  "function claimFor(uint256 dropId,address claimer,bytes32 humanKey,uint8 level,uint64 deadline,bytes pass) returns (uint256)",
  "error AlreadyClaimed()", "error SoldOut()", "error DropNotActive()", "error PassExpired()",
  "error GateNotMet()", "error BadPass()", "error TransferFailed()",
];

const LEVEL = { OPEN: 0, QIE_ID: 1, VERIFIED: 2 };

const CLAIM_TYPES = {
  Claim: [
    { name: "dropId", type: "uint256" },
    { name: "claimer", type: "address" },
    { name: "humanKey", type: "bytes32" },
    { name: "level", type: "uint8" },
    { name: "deadline", type: "uint64" },
  ],
};

function provider(chainId) {
  const c = CHAINS[chainId];
  if (!c) throw httpError(400, "Unsupported chain");
  return new ethers.JsonRpcProvider(c.rpc, Number(chainId), { staticNetwork: true });
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// ---------------------------------------------------------------- bot checks

/** Tier 0 — the wallet must look like a real person's wallet, not a fresh farm wallet. */
async function walletHistory(chainId, addr) {
  const p = provider(chainId);
  const [nonce, balance] = await Promise.all([p.getTransactionCount(addr), p.getBalance(addr)]);
  return { txCount: nonce, balance };
}

function openRule() {
  return { minTx: Number(process.env.OPEN_MIN_TX ?? 1) };
}

/** Cloudflare Turnstile (free) — blocks scripted claim bots. Skipped if not configured. */
async function verifyCaptcha(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret, response: token, remoteip: ip || "" }),
  });
  const j = await r.json().catch(() => ({}));
  return !!j.success;
}

// ---------------------------------------------------------------- QIE ID

/**
 * Reverse-resolve the wallet's primary QIE ID (e.g. "tajudeen.qie").
 * Order: 1) on-chain registry if QIE_ID_REGISTRY is set, 2) QIE's public MCP lookup.
 * Returns the name or null. Never guesses.
 */
async function primaryQieId(chainId, addr) {
  const reg = process.env[`QIE_ID_REGISTRY_${chainId}`];
  if (reg) {
    try {
      const fn = process.env.QIE_ID_REVERSE_FN || "function nameOf(address) view returns (string)";
      const c = new ethers.Contract(reg, [fn], provider(chainId));
      const name = await c[ethers.Fragment.from(fn).name](addr);
      if (name && name.length) return name.toLowerCase();
    } catch (_) { /* fall through */ }
  }
  if (chainId === 31337 && process.env.LOCAL_QIE_IDS) {
    // test hook: "0xabc=alice.qie,0xdef=bob.qie"
    const m = Object.fromEntries(process.env.LOCAL_QIE_IDS.split(",").map((kv) => kv.split("=")));
    return m[addr.toLowerCase()] || null;
  }
  return mcpReverseLookup(chainId, addr);
}

const MCP_URL = process.env.QIE_MCP_URL || "https://mcp.qie.digital/mcp";

async function mcpCall(method, params, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const sid = r.headers.get("mcp-session-id") || sessionId;
  const text = await r.text();
  // Streamable HTTP may answer as SSE ("data: {...}") or plain JSON.
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const json = JSON.parse(line ? line.slice(5) : text);
  return { json, sid };
}

async function mcpReverseLookup(chainId, addr) {
  if (process.env.QIE_MCP_DISABLED) return null;
  try {
    const init = await mcpCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "onlyhuman-checker", version: "1.0.0" },
    });
    const sid = init.sid;
    const list = await mcpCall("tools/list", {}, sid);
    const tool = (list.json.result?.tools || []).find((t) => /reverse/i.test(t.name));
    if (!tool) return null;
    const props = Object.keys(tool.inputSchema?.properties || {});
    const args = {};
    for (const k of props) {
      if (/addr/i.test(k)) args[k] = addr;
      else if (/chain|network/i.test(k)) args[k] = Number(chainId);
    }
    const out = await mcpCall("tools/call", { name: tool.name, arguments: args }, sid);
    const blob = JSON.stringify(out.json.result || {});
    if (/unresolved|not found/i.test(blob)) return null;
    const m = blob.match(/([a-z0-9-]{1,63}\.qie)\b/i);
    return m ? m[1].toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- QIE Pass

/**
 * QIE Pass (KYC) status. No public lookup is documented yet, so this only
 * works when QIE_PASS_API is configured: GET {api}?address=0x.. -> { verified, id }.
 * Until then nobody reaches level 2 and Verified-only drops stay locked.
 */
async function qiePassStatus(chainId, addr) {
  const api = process.env.QIE_PASS_API;
  if (!api) return null;
  try {
    const r = await fetch(`${api}?address=${addr}&chainId=${chainId}`);
    const j = await r.json();
    return j && j.verified ? { id: String(j.id || addr).toLowerCase() } : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ethers, CHAINS, ABI, LEVEL, CLAIM_TYPES,
  contractAddress, provider, httpError, send, readBody,
  walletHistory, openRule, verifyCaptcha, primaryQieId, qiePassStatus,
};
