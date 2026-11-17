# OnlyHuman

**Giveaways that only pay real people.** Built on QIE for QIE Hackathon 3.0.

Bots and farmers eat most online giveaways. OnlyHuman checks every claimer before paying:
one claim per wallet **and** one claim per person, with prizes paid instantly in QUSDC or QIE.
Winners claim free (no gas), and every claim brings a new real user onto QIE.

## How it works
1. **Creator locks the prize** in the `OnlyHuman` contract (QUSDC, any ERC-20 or native QIE). 1% fee, hard-capped at 3%.
2. **Creator picks the gate:** Anyone real (bot-checked wallet), QIE ID holders (one claim per name), or Verified humans (QIE Pass).
3. **Claimer taps "Check & claim".** The checker service finds their strongest proof of humanity (QIE Pass → QIE ID → wallet history) and signs a 10-minute EIP-712 pass bound to *that wallet, that giveaway, that person*.
4. **The relayer submits `claimFor()` and pays the gas.** The contract only ever pays the wallet the pass was signed for.
5. Verified humans can get a bonus share (+50% by default). Creators refund leftovers when the giveaway ends.

## QIE integrations
- **QIE Mainnet** — contract deployed on chain 1990
- **QUSDC** — `0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5` (6 decimals), the default prize currency
- **QIE ID** — reverse-resolves the claimer's primary name (registry or QIE's public MCP lookup); the name becomes the one-claim-per-person key
- **QIE Pass** — Verified tier and bonus share (plugs in via `QIE_PASS_API` once a public lookup is available)
- **QIE Wallet** — mobile-first app, works in QIE Wallet's browser, auto-adds the QIE network

## Layout
```
contracts/OnlyHuman.sol    escrow + gates + gasless claims
test/OnlyHuman.test.js     16 tests
api/pass.js                human checks → signed claim pass
api/relay.js               gasless claim relayer
api/config.js              public settings for the app
web/                       the app (home, create, giveaway page, phone deploy page)
```

## Run it
```
npm install
npx hardhat test
```

## Deploy (phone-friendly)
1. Import this repo into **Vercel** (free).
2. Open `/#/deploy`, generate `CHECKER_KEY` and `RELAYER_KEY`, and add them as Vercel environment variables. Redeploy.
3. In QIE Wallet's browser, open `/#/deploy` and tap **Deploy contract**. Add the address it shows as `ONLYHUMAN_1990` (mainnet) or `ONLYHUMAN_1983` (testnet). Redeploy.
4. Send the relayer address a little QIE for claim gas.

| Variable | What it is |
|---|---|
| `CHECKER_KEY` | private key that signs claim passes |
| `RELAYER_KEY` | private key that pays gas for free claims (optional) |
| `ONLYHUMAN_1990` / `ONLYHUMAN_1983` | deployed contract address per network |
| `DEFAULT_CHAIN_ID` | `1990` mainnet or `1983` testnet |
| `QUSDC_1983` | test dollar token on testnet (deploy from `/#/deploy`) |
| `OPEN_MIN_TX` | min wallet transactions for "Anyone real" (default 1) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` | free Cloudflare captcha (optional) |
| `QIE_ID_REGISTRY_1990` | QIE ID registry for on-chain lookups (optional; falls back to QIE's MCP) |
| `QIE_PASS_API` | QIE Pass status lookup (when available) |

Built by [@Tajudeen](https://x.com/Tajudeen).
