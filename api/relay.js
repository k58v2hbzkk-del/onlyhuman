// POST /api/relay  { chainId, dropId, claimer, humanKey, level, deadline, pass }
// Gasless claims: the OnlyHuman relayer wallet submits claimFor() and pays the gas.
// The contract only ever pays `claimer`, so the relayer can't take the prize.
const L = require("./_lib");
const { ethers } = L;

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return L.send(res, 204, {});
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only" });
  try {
    const key = process.env.RELAYER_KEY;
    if (!key) throw L.httpError(503, "Free claims are off right now — claim with your own wallet");

    const b = await L.readBody(req);
    const chainId = Number(b.chainId);
    const addr = L.contractAddress(chainId);
    if (!addr) throw L.httpError(400, "OnlyHuman isn't deployed on this network yet");
    if (!ethers.isAddress(b.claimer)) throw L.httpError(400, "Bad wallet address");

    const wallet = new ethers.Wallet(key, L.provider(chainId));
    const c = new ethers.Contract(addr, L.ABI, wallet);

    // Only relay passes our own checker signed — never spend gas on junk.
    const checker = await c.checker();
    const signedBy = ethers.verifyTypedData(
      { chainId, verifyingContract: addr, name: "OnlyHuman", version: "1" },
      L.CLAIM_TYPES,
      { dropId: BigInt(b.dropId), claimer: b.claimer, humanKey: b.humanKey, level: Number(b.level), deadline: Number(b.deadline) },
      b.pass
    );
    if (signedBy.toLowerCase() !== checker.toLowerCase()) throw L.httpError(403, "Invalid claim pass");

    const args = [BigInt(b.dropId), b.claimer, b.humanKey, Number(b.level), Number(b.deadline), b.pass];
    try {
      await c.claimFor.staticCall(...args);
    } catch (e) {
      const reason = c.interface.parseError(e.data || e.error?.data || e.info?.error?.data || "0x")?.name || "Claim rejected";
      throw L.httpError(409, friendly(reason));
    }
    const tx = await c.claimFor(...args);
    return L.send(res, 200, { ok: true, txHash: tx.hash });
  } catch (e) {
    return L.send(res, e.status || 500, { ok: false, error: e.status ? e.message : "Couldn't submit the claim — try again", detail: e.status ? undefined : String(e.message || e) });
  }
};

function friendly(name) {
  return ({
    AlreadyClaimed: "Already claimed",
    SoldOut: "All prizes have been claimed",
    DropNotActive: "This giveaway has ended",
    PassExpired: "Your pass expired — tap claim again",
    GateNotMet: "You don't meet this giveaway's requirement",
    BadPass: "Invalid claim pass",
  })[name] || name;
}
