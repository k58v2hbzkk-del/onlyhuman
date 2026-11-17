// GET /api/config — public settings the web app needs.
const L = require("./_lib");
module.exports = async (req, res) => {
  const contracts = {};
  for (const id of Object.keys(L.CHAINS)) {
    const a = L.contractAddress(id);
    if (a) contracts[id] = a;
  }
  L.send(res, 200, {
    contracts,
    defaultChainId: Number(process.env.DEFAULT_CHAIN_ID || 1983),
    turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
    gasless: !!process.env.RELAYER_KEY,
    checker: process.env.CHECKER_KEY ? new L.ethers.Wallet(process.env.CHECKER_KEY).address : "",
    qusdc: { 1990: process.env.QUSDC_1990 || "", 1983: process.env.QUSDC_1983 || "", 31337: process.env.QUSDC_31337 || "" },
  });
};
