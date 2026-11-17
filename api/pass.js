// POST /api/pass  { chainId, dropId, address, captcha }
// Runs the human checks for this wallet and, if it clears the drop's gate,
// returns a short-lived signed claim pass the contract will accept.
const L = require("./_lib");
const { ethers } = L;

const GATE_NAMES = ["Open", "QIE ID holders", "Verified humans"];

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return L.send(res, 204, {});
  if (req.method !== "POST") return L.send(res, 405, { error: "POST only" });
  try {
    const checkerKey = process.env.CHECKER_KEY;
    if (!checkerKey) throw L.httpError(500, "Checker not configured");

    const body = await L.readBody(req);
    const chainId = Number(body.chainId);
    const dropId = BigInt(body.dropId);
    if (!ethers.isAddress(body.address)) throw L.httpError(400, "Bad wallet address");
    const address = ethers.getAddress(body.address);

    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (!(await L.verifyCaptcha(body.captcha, ip))) throw L.httpError(403, "Captcha failed — try again");

    const addr = L.contractAddress(chainId);
    if (!addr) throw L.httpError(400, "OnlyHuman isn't deployed on this network yet");
    const c = new ethers.Contract(addr, L.ABI, L.provider(chainId));

    const d = await c.getDrop(dropId);
    if (d.creator === ethers.ZeroAddress) throw L.httpError(404, "Giveaway not found");
    const now = Math.floor(Date.now() / 1000);
    if (d.closed || Number(d.endsAt) < now) throw L.httpError(410, "This giveaway has ended");
    if (Number(d.claimed) >= Number(d.maxClaims) || d.balance === 0n) throw L.httpError(410, "All prizes have been claimed");
    if (await c.walletClaimed(dropId, address)) throw L.httpError(409, "This wallet already claimed");

    // Find the strongest proof of humanity this wallet has.
    const gate = Number(d.gate);
    let level, humanKey, label, name = null;

    const pass = await L.qiePassStatus(chainId, address);
    if (pass) {
      level = L.LEVEL.VERIFIED;
      humanKey = ethers.id(`pass:${pass.id}`);
      label = "Verified human (QIE Pass)";
    } else {
      name = await L.primaryQieId(chainId, address);
      if (name) {
        level = L.LEVEL.QIE_ID;
        humanKey = ethers.id(`qieid:${name}`);
        label = `QIE ID holder (${name})`;
      } else {
        const h = await L.walletHistory(chainId, address);
        const { minTx } = L.openRule();
        if (gate === L.LEVEL.OPEN && h.txCount < minTx) {
          throw L.httpError(403, `This wallet is brand new. Make at least ${minTx} transaction${minTx > 1 ? "s" : ""} on QIE or get a QIE ID, then try again.`);
        }
        level = L.LEVEL.OPEN;
        humanKey = ethers.id(`wallet:${address.toLowerCase()}`);
        label = "Real wallet (history check)";
      }
    }

    if (level < gate) {
      const fix = gate === L.LEVEL.QIE_ID
        ? "Get a QIE ID at id.qie.digital, set it as your primary name, then come back."
        : "Complete QIE Pass verification, then come back.";
      throw L.httpError(403, `This giveaway is for ${GATE_NAMES[gate]} only. ${fix}`);
    }
    if (await c.humanClaimed(dropId, humanKey)) {
      throw L.httpError(409, name ? `${name} already claimed this giveaway from another wallet` : "You already claimed this giveaway");
    }

    const deadline = now + 10 * 60;
    const network = { chainId, verifyingContract: addr, name: "OnlyHuman", version: "1" };
    const signer = new ethers.Wallet(checkerKey);
    const sig = await signer.signTypedData(network, L.CLAIM_TYPES, {
      dropId, claimer: address, humanKey, level, deadline,
    });

    return L.send(res, 200, { ok: true, dropId: dropId.toString(), claimer: address, humanKey, level, deadline, pass: sig, label, name });
  } catch (e) {
    return L.send(res, e.status || 500, { ok: false, error: e.status ? e.message : "Something went wrong — try again" , detail: e.status ? undefined : String(e.message || e) });
  }
};
