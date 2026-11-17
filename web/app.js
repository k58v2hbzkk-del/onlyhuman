/* OnlyHuman web app — giveaways that only pay real people. No build step. */
(() => {
  const { ethers } = window;
  const C = window.OH_CONTRACTS;
  const ZERO = ethers.ZeroAddress;

  // ------------------------------------------------------------ networks
  const CHAINS = {
    1990: { name: "QIE Mainnet", short: "Mainnet", rpc: "https://rpc5mainnet.qie.digital", explorer: "https://mainnet.qie.digital" },
    1983: { name: "QIE Testnet", short: "Testnet", rpc: "https://rpc1testnet.qie.digital/", explorer: "https://testnet.qie.digital" },
    31337: { name: "Local test chain", short: "Local", rpc: "http://127.0.0.1:8545", explorer: "" },
  };
  const KNOWN_USD = { 1990: "0x3F43DA82eC9A4f5285F10FaF1F26EcA7319E5DA5" }; // official QUSDC (6 decimals)
  const GATES = [
    { name: "Anyone real", short: "Open", desc: "Wallets with real history. Bot-checked." },
    { name: "QIE ID holders", short: "QIE ID", desc: "One claim per QIE name." },
    { name: "Verified humans", short: "Verified", desc: "QIE Pass KYC only." },
  ];
  const ERC20 = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function mint(address,uint256)",
  ];

  // ------------------------------------------------------------ state
  const S = { cfg: null, account: null, walletChain: null, signer: null, browser: null, chainId: null };
  const app = document.getElementById("app");
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

  function toast(msg, bad = false, ms = 3800) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast" + (bad ? " bad" : "");
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.hidden = true), ms);
  }

  function errMsg(e) {
    const m = e?.shortMessage || e?.reason || e?.message || String(e);
    if (/user rejected|denied|ACTION_REJECTED/i.test(m)) return "You cancelled in your wallet";
    if (/insufficient funds/i.test(m)) return "Not enough QIE in your wallet for this (prize + gas)";
    try {
      const data = e?.data || e?.info?.error?.data || e?.error?.data;
      if (data) {
        const iface = new ethers.Interface(C.OnlyHuman.abi);
        const p = iface.parseError(data);
        if (p) return ({
          BadParams: "Check the numbers — something doesn't add up",
          WrongValue: "Wrong amount sent",
          AlreadyClaimed: "Already claimed",
          SoldOut: "All prizes are gone",
          DropNotActive: "This giveaway has ended",
          TooEarly: "You can refund once the giveaway ends",
          NotCreator: "Only the creator can do that",
        })[p.name] || p.name;
      }
    } catch (_) {}
    return m.length > 140 ? m.slice(0, 140) + "…" : m;
  }

  // ------------------------------------------------------------ config + chain
  async function loadConfig() {
    try {
      const r = await fetch("/api/config");
      S.cfg = await r.json();
    } catch (_) {
      S.cfg = { contracts: {}, defaultChainId: 1983, gasless: false, qusdc: {} };
    }
    const saved = Number(localGet("oh_chain"));
    S.chainId = CHAINS[saved] ? saved : S.cfg.defaultChainId || 1983;
    updateNetLabel();
  }
  function localGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function localSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  const readers = {};
  function reader(chainId = S.chainId) {
    if (!readers[chainId]) readers[chainId] = new ethers.JsonRpcProvider(CHAINS[chainId].rpc, Number(chainId), { staticNetwork: true });
    return readers[chainId];
  }
  const ohAddress = (chainId = S.chainId) => S.cfg.contracts?.[chainId] || "";
  const usdAddress = (chainId = S.chainId) => KNOWN_USD[chainId] || S.cfg.qusdc?.[chainId] || "";
  const oh = (runner, chainId = S.chainId) => new ethers.Contract(ohAddress(chainId), C.OnlyHuman.abi, runner || reader(chainId));
  const explorerTx = (chainId, h) => (CHAINS[chainId].explorer ? `${CHAINS[chainId].explorer}/tx/${h}` : "");

  function updateNetLabel() {
    $("#netLabel").textContent = CHAINS[S.chainId]?.name || "";
  }

  // ------------------------------------------------------------ wallet
  async function connect() {
    if (!window.ethereum) {
      const url = location.href.replace(/^https?:\/\//, "");
      app.insertAdjacentHTML("afterbegin", `<div class="note" style="margin-bottom:14px">
        No wallet found. Open this page inside <b>QIE Wallet</b>'s browser or
        <a href="https://metamask.app.link/dapp/${esc(url)}">MetaMask</a>.</div>`);
      throw new Error("No wallet found");
    }
    S.browser = new ethers.BrowserProvider(window.ethereum, "any");
    const accs = await S.browser.send("eth_requestAccounts", []);
    S.account = ethers.getAddress(accs[0]);
    S.walletChain = Number((await S.browser.getNetwork()).chainId);
    S.signer = await S.browser.getSigner();
    renderConnect();
    window.ethereum.on?.("accountsChanged", () => location.reload());
    window.ethereum.on?.("chainChanged", () => location.reload());
    return S.account;
  }

  async function ensureChain(chainId = S.chainId) {
    if (!S.account) await connect();
    if (S.walletChain === Number(chainId)) return;
    const hex = "0x" + Number(chainId).toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e.code === 4902 || /Unrecognized|not added/i.test(e.message || "")) {
        const c = CHAINS[chainId];
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: c.name, rpcUrls: [c.rpc], nativeCurrency: { name: "QIE", symbol: "QIE", decimals: 18 }, blockExplorerUrls: c.explorer ? [c.explorer] : [] }],
        });
      } else throw e;
    }
    S.browser = new ethers.BrowserProvider(window.ethereum, "any");
    S.walletChain = Number((await S.browser.getNetwork()).chainId);
    S.signer = await S.browser.getSigner();
  }

  function renderConnect() {
    const b = $("#connectBtn");
    b.textContent = S.account ? short(S.account) : "Connect";
  }
  $("#connectBtn").onclick = () => connect().catch((e) => toast(errMsg(e), true));

  // ------------------------------------------------------------ token helpers
  const tokenCache = {};
  async function tokenInfo(chainId, token) {
    const k = chainId + ":" + token;
    if (tokenCache[k]) return tokenCache[k];
    if (token === ZERO) return (tokenCache[k] = { symbol: "QIE", decimals: 18 });
    const t = new ethers.Contract(token, ERC20, reader(chainId));
    const [symbol, decimals] = await Promise.all([t.symbol().catch(() => "TOKEN"), t.decimals().catch(() => 18)]);
    return (tokenCache[k] = { symbol, decimals: Number(decimals) });
  }
  const fmt = (v, d, max = 2) => {
    const n = Number(ethers.formatUnits(v, d));
    return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : max });
  };

  // ------------------------------------------------------------ router
  const routes = [
    [/^#\/?$/, home],
    [/^#\/create$/, create],
    [/^#\/d\/(\d+)\/(\d+)(?:\?.*)?$/, dropPage],
    [/^#\/deploy$/, deploy],
  ];
  function route() {
    const h = location.hash || "#/";
    for (const [re, fn] of routes) {
      const m = h.match(re);
      if (m) { window.scrollTo(0, 0); return fn(...m.slice(1)); }
    }
    home();
  }
  window.addEventListener("hashchange", route);

  function needsContract() {
    if (ohAddress()) return "";
    return `<div class="note">OnlyHuman isn't live on ${esc(CHAINS[S.chainId].name)} yet. <a href="#/deploy">Deploy it</a> first.</div>`;
  }

  // ------------------------------------------------------------ pages
  async function home() {
    app.innerHTML = `
      <h1>Giveaways that only pay <em>real</em> <span class="marker">people.</span></h1>
      <p class="lead">Bots and farmers eat most giveaways. OnlyHuman checks every claimer first: one claim per real person, paid out instantly in dollars on QIE.</p>
      <div class="row">
        <a class="btn accent" href="#/create">Start a giveaway</a>
        <a class="btn ghost" href="#how">How it works</a>
      </div>
      <div class="stats" id="stats">
        <div class="stat"><b id="sDrops">–</b><span>giveaways</span></div>
        <div class="stat"><b>1%</b><span>flat fee</span></div>
        <div class="stat"><b>$0</b><span>gas for winners</span></div>
      </div>
      <div class="steps" id="how">
        <div class="step"><div><b>Lock the prize</b><span>Put QUSDC or QIE in. It sits in the contract, not with us.</span></div></div>
        <div class="step"><div><b>Pick who can claim</b><span>Anyone real, QIE ID holders, or KYC-verified humans only.</span></div></div>
        <div class="step"><div><b>Share one link</b><span>Post it on X, Telegram, Discord, anywhere. Winners claim free, with no gas.</span></div></div>
        <div class="step"><div><b>Bots get nothing</b><span>One claim per wallet and one per person. Leftovers come back to you.</span></div></div>
      </div>
      <div class="card dark">
        <b>Why creators switch</b>
        <p class="muted" style="margin:.4em 0 0">Your prize reaches your real audience instead of farm wallets. Every claimer leaves with a working QIE wallet.</p>
      </div>`;
    if (ohAddress()) {
      try { $("#sDrops").textContent = String(await oh().dropCount()); } catch (_) {}
    }
  }

  function create() {
    const hasUsd = !!usdAddress();
    const st = { token: hasUsd ? "usd" : "qie", gate: 0, hours: 24, bonus: true };
    app.innerHTML = `
      <h2>Start a <em>giveaway</em></h2>
      <p class="muted">Prize is locked in the contract until people claim it. Unclaimed money comes back to you.</p>
      ${needsContract()}
      <label>Prize in</label>
      <div class="seg two" id="tokSeg">
        <button data-v="usd" ${hasUsd ? "" : "disabled"}>QUSDC<small>${hasUsd ? "digital dollars" : "not on this network"}</small></button>
        <button data-v="qie">QIE<small>native coin</small></button>
      </div>
      <label for="total">Total prize</label>
      <input id="total" inputmode="decimal" placeholder="100" value="100" />
      <label for="winners">Number of winners</label>
      <input id="winners" inputmode="numeric" placeholder="50" value="50" />
      <label>Who can claim</label>
      <div class="seg" id="gateSeg">
        ${GATES.map((g, i) => `<button data-v="${i}">${g.short}<small>${g.desc}</small></button>`).join("")}
      </div>
      <div class="hint" id="gateHint"></div>
      <label>Verified bonus</label>
      <div class="seg two" id="bonusSeg">
        <button data-v="1">+50% for verified<small>rewards real humans</small></button>
        <button data-v="0">Same for all<small>flat share</small></button>
      </div>
      <label>Ends in</label>
      <div class="seg four" id="timeSeg">
        <button data-v="1">1 hour</button><button data-v="24">1 day</button><button data-v="72">3 days</button><button data-v="168">7 days</button>
      </div>
      <div class="card"><div class="summary" id="sum"></div></div>
      <button class="btn accent block" id="go" ${ohAddress() ? "" : "disabled"}>Lock prize & create link</button>
      <p class="hint" style="text-align:center">Network: ${esc(CHAINS[S.chainId].name)}</p>`;

    const seg = (id, key, cast) => {
      const el = $(id);
      const sync = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", String(st[key]) === b.dataset.v || (key === "bonus" && String(+st.bonus) === b.dataset.v)));
      el.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.disabled) return; st[key] = cast(b.dataset.v); sync(); calc(); };
      sync();
    };
    seg("#tokSeg", "token", String);
    seg("#gateSeg", "gate", Number);
    seg("#bonusSeg", "bonus", (v) => v === "1");
    seg("#timeSeg", "hours", Number);
    $("#total").oninput = calc;
    $("#winners").oninput = calc;

    function numbers() {
      const dec = st.token === "usd" ? 6 : 18;
      const sym = st.token === "usd" ? "QUSDC" : "QIE";
      let total, winners;
      try { total = ethers.parseUnits(($("#total").value || "0").trim(), dec); } catch (_) { total = 0n; }
      winners = BigInt(Math.max(0, parseInt($("#winners").value || "0", 10) || 0));
      // With the bonus on, size each share so the budget still covers every winner even if all are verified.
      const per = winners > 0n ? (st.bonus ? (total * 10000n) / (winners * 15000n) : total / winners) : 0n;
      const fee = (total * 100n) / 10000n;
      return { dec, sym, total, winners, per, fee };
    }
    function calc() {
      const n = numbers();
      $("#gateHint").textContent = st.gate === 2 ? "QIE Pass lookups aren't public yet, so only use this if your audience is already verified." : "";
      $("#sum").innerHTML = `
        <div><span>Each winner gets</span><b>${n.per ? fmt(n.per, n.dec) : "–"} ${n.sym}</b></div>
        ${st.bonus ? `<div><span>Verified humans get</span><b>${n.per ? fmt((n.per * 15000n) / 10000n, n.dec) : "–"} ${n.sym}</b></div>` : ""}
        <div><span>Platform fee (1%)</span><b>${fmt(n.fee, n.dec)} ${n.sym}</b></div>
        <div style="border-top:1px solid var(--line);padding-top:8px;margin-top:4px"><span><b>You pay</b></span><b>${fmt(n.total + n.fee, n.dec)} ${n.sym}</b></div>
        <div class="muted small"><span>Winners pay</span><span>$0 gas</span></div>`;
    }
    calc();

    $("#go").onclick = async () => {
      const btn = $("#go");
      const n = numbers();
      if (n.winners < 1n || n.per === 0n) return toast("Enter a prize and at least 1 winner", true);
      if (n.winners > 100000n) return toast("Max 100,000 winners per giveaway", true);
      try {
        btn.disabled = true;
        btn.innerHTML = `<span class="spin"></span> Check your wallet`;
        await ensureChain();
        const c = oh(S.signer);
        const token = st.token === "usd" ? usdAddress() : ZERO;
        const ends = BigInt(Math.floor(Date.now() / 1000) + st.hours * 3600);
        const bonus = st.bonus ? 5000 : 0;
        if (token !== ZERO) {
          const t = new ethers.Contract(token, ERC20, S.signer);
          const need = n.total + n.fee;
          const bal = await t.balanceOf(S.account);
          if (bal < need) throw new Error(`You need ${fmt(need, n.dec)} QUSDC — you have ${fmt(bal, n.dec)}`);
          const allow = await t.allowance(S.account, ohAddress());
          if (allow < need) {
            btn.innerHTML = `<span class="spin"></span> Approve QUSDC (1/2)`;
            await (await t.approve(ohAddress(), need)).wait();
          }
          btn.innerHTML = `<span class="spin"></span> Lock prize (2/2)`;
        }
        const tx = await c.createDrop(token, n.total, n.per, Number(n.winners), st.gate, bonus, ends, { value: token === ZERO ? n.total + n.fee : 0n });
        btn.innerHTML = `<span class="spin"></span> Locking the prize…`;
        const rc = await tx.wait();
        const ev = rc.logs.map((l) => { try { return c.interface.parseLog(l); } catch (_) { return null; } }).find((x) => x && x.name === "DropCreated");
        const id = ev ? ev.args.dropId.toString() : (await oh().dropCount()).toString();
        location.hash = `#/d/${S.chainId}/${id}?new=1`;
      } catch (e) {
        toast(errMsg(e), true);
        btn.disabled = false;
        btn.textContent = "Lock prize & create link";
      }
    };
  }

  async function dropPage(chainIdStr, idStr, isNew) {
    const chainId = Number(chainIdStr);
    if (!CHAINS[chainId]) return home();
    if (chainId !== S.chainId) { S.chainId = chainId; localSet("oh_chain", chainId); updateNetLabel(); }
    isNew = isNew || /new=1/.test(location.hash);
    app.innerHTML = `<p class="muted">Loading giveaway…</p>`;
    if (!ohAddress(chainId)) { app.innerHTML = needsContract(); return; }
    const id = BigInt(idStr);
    let d, tok;
    try {
      d = await oh(null, chainId).getDrop(id);
      if (d.creator === ZERO) { app.innerHTML = `<h2>Giveaway not found</h2><a class="btn" href="#/create">Start one</a>`; return; }
      tok = await tokenInfo(chainId, d.token);
    } catch (e) {
      app.innerHTML = `<h2>Couldn't load this giveaway</h2><p class="muted">${esc(errMsg(e))}</p>`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const left = Number(d.maxClaims) - Number(d.claimed);
    const ended = d.closed || Number(d.endsAt) < now;
    const soldOut = left <= 0 || d.balance === 0n;
    const pct = Math.min(100, (Number(d.claimed) / Number(d.maxClaims)) * 100);
    const link = `${location.origin}/#/d/${chainId}/${id}`;
    const per = fmt(d.amountPerClaim, tok.decimals);
    const bonusPer = Number(d.verifiedBonusBps) ? fmt(d.amountPerClaim + (d.amountPerClaim * d.verifiedBonusBps) / 10000n, tok.decimals) : null;
    const gate = GATES[Number(d.gate)];
    const isCreator = S.account && S.account.toLowerCase() === d.creator.toLowerCase();
    const xText = isNew
      ? `I'm giving away ${fmt(d.balance, tok.decimals)} ${tok.symbol} to ${Number(d.maxClaims)} real people. No bots, no farming. One claim per human, free to claim 👇`
      : `Just claimed ${per} ${tok.symbol} on OnlyHuman, a giveaway bots can't farm 👇`;
    const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(xText)}&url=${encodeURIComponent(link)}`;

    app.innerHTML = `
      ${isNew ? `<div class="card dark"><b>Your giveaway is live 🎉</b><p class="muted" style="margin:.4em 0 12px">Share this link. Only real people can claim.</p>
        <div class="copy"><input readonly value="${esc(link)}" id="lnk"/><button class="btn small" id="cp">Copy</button></div>
        <a class="btn accent block" style="margin-top:10px" target="_blank" rel="noopener" href="${xUrl}">Post it on X</a></div>` : ""}
      <span class="badge accent">${esc(gate.name)}</span>
      <div class="prize">${per} <span style="font-size:.45em">${esc(tok.symbol)}</span></div>
      <p class="muted" style="margin:0">per winner${bonusPer ? ` · <b style="color:var(--ink)">${bonusPer} ${esc(tok.symbol)}</b> if you're verified` : ""}</p>
      <div class="bar"><i id="barFill" style="width:${pct}%"></i></div>
      <div class="row muted small" style="justify-content:space-between">
        <span><b style="color:var(--ink)" id="claimedN">${Number(d.claimed)}</b> of ${Number(d.maxClaims)} claimed</span>
        <span id="cd">${ended ? "Ended" : ""}</span>
      </div>
      <div class="card" id="claimBox">
        ${ended || soldOut
          ? `<b>${soldOut ? "All prizes have been claimed" : "This giveaway has ended"}</b>`
          : `<b>Claim your share</b><p class="muted small" style="margin:.3em 0 12px">${esc(gate.desc)} ${S.cfg.gasless ? "Free to claim, no gas needed." : "You'll pay a tiny QIE gas fee."}</p>
             <div id="captcha"></div>
             <button class="btn accent block" id="claimBtn">${S.account ? "Check & claim" : "Connect wallet to claim"}</button>`}
      </div>
      <div class="summary small muted">
        <div><span>Prize pool left</span><b style="color:var(--ink)" id="poolLeft">${fmt(d.balance, tok.decimals)} ${esc(tok.symbol)}</b></div>
        <div><span>Created by</span><b style="color:var(--ink)">${short(d.creator)}</b></div>
        <div><span>Network</span><b style="color:var(--ink)">${esc(CHAINS[chainId].name)}</b></div>
      </div>
      <h3 style="margin:22px 0 8px">Recent claims</h3>
      <ul class="claims" id="claims"><li class="muted">Loading…</li></ul>
      <div id="creatorBox"></div>
      ${!isNew ? `<p style="margin-top:22px"><a class="btn ghost block" href="#/create">Start your own giveaway</a></p>` : ""}`;

    if (isNew) $("#cp").onclick = () => { navigator.clipboard?.writeText(link); toast("Link copied"); };

    // countdown
    if (!ended) {
      const tick = () => {
        const s = Number(d.endsAt) - Math.floor(Date.now() / 1000);
        const el = $("#cd");
        if (!el) return;
        if (s <= 0) return (el.textContent = "Ended");
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        el.textContent = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
        setTimeout(tick, 30000);
      };
      tick();
    }

    // captcha (Cloudflare Turnstile, optional)
    let captchaToken = "";
    if (S.cfg.turnstileSiteKey && $("#captcha")) {
      window.ohCaptcha = (t) => (captchaToken = t);
      $("#captcha").innerHTML = `<div class="cf-turnstile" data-sitekey="${esc(S.cfg.turnstileSiteKey)}" data-callback="ohCaptcha" style="margin-bottom:10px"></div>`;
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      s.async = true;
      document.head.appendChild(s);
    }

    // Already claimed with this wallet? Say so up front.
    if (S.account && $("#claimBtn")) {
      try {
        if (await oh(null, chainId).walletClaimed(id, S.account)) {
          $("#claimBox").innerHTML = `<span class="badge good">✓ You claimed this one</span>
            <p class="muted small" style="margin:.6em 0 0">One claim per person. Know someone real who'd want in? Send them the link.</p>`;
        }
      } catch (_) {}
    }

    const btn = $("#claimBtn");
    if (btn) btn.onclick = async () => {
      try {
        if (!S.account) { await connect(); btn.textContent = "Check & claim"; return; }
        btn.disabled = true;
        btn.innerHTML = `<span class="spin"></span> Checking you're human…`;
        const r = await fetch("/api/pass", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId, dropId: id.toString(), address: S.account, captcha: captchaToken }),
        });
        const p = await r.json();
        if (!p.ok) throw new Error(p.error || "Check failed");
        btn.innerHTML = `<span class="spin"></span> ${esc(p.label)} ✓ Sending prize…`;
        let hash;
        if (S.cfg.gasless) {
          const rr = await fetch("/api/relay", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ chainId, ...p }),
          });
          const j = await rr.json();
          if (!j.ok) throw new Error(j.error || "Couldn't send");
          hash = j.txHash;
          await reader(chainId).waitForTransaction(hash, 1, 120000);
        } else {
          await ensureChain(chainId);
          const tx = await oh(S.signer, chainId).claim(id, p.humanKey, p.level, p.deadline, p.pass);
          hash = tx.hash;
          await tx.wait();
        }
        const got = p.level === 2 && bonusPer ? bonusPer : per;
        const shareUrl = `https://x.com/intent/post?text=${encodeURIComponent(`Just claimed ${got} ${tok.symbol} on OnlyHuman, a giveaway bots can't farm 👇`)}&url=${encodeURIComponent(link)}`;
        $("#claimBox").innerHTML = `<div class="result"><div class="big">🎉</div>
          <h2>You got ${got} ${esc(tok.symbol)}</h2>
          <p class="muted">It's already in your wallet.${explorerTx(chainId, hash) ? ` <a href="${explorerTx(chainId, hash)}" target="_blank" rel="noopener">See transaction</a>` : ""}</p>
          <a class="btn accent block" target="_blank" rel="noopener" href="${shareUrl}">Share on X</a></div>`;
        loadClaims();
        try {
          const nd = await oh(null, chainId).getDrop(id);
          $("#claimedN").textContent = String(Number(nd.claimed));
          $("#poolLeft").textContent = `${fmt(nd.balance, tok.decimals)} ${tok.symbol}`;
          $("#barFill").style.width = Math.min(100, (Number(nd.claimed) / Number(nd.maxClaims)) * 100) + "%";
        } catch (_) {}
      } catch (e) {
        toast(errMsg(e), true, 6000);
        btn.disabled = false;
        btn.textContent = "Check & claim";
      }
    };

    async function loadClaims() {
      const ul = $("#claims");
      try {
        const c = oh(null, chainId);
        const latest = await reader(chainId).getBlockNumber();
        const from = Math.max(0, latest - 50000);
        const logs = await c.queryFilter(c.filters.Claimed(id), from, latest);
        if (!logs.length) { ul.innerHTML = `<li class="muted">No claims yet. Be the first.</li>`; return; }
        ul.innerHTML = logs.slice(-12).reverse().map((l) => {
          const lv = Number(l.args.level);
          const tag = lv === 2 ? "✓ verified" : lv === 1 ? "QIE ID" : "real wallet";
          return `<li><span>${short(l.args.claimer)} <span class="muted small">· ${tag}</span></span><b>${fmt(l.args.amount, tok.decimals)} ${esc(tok.symbol)}</b></li>`;
        }).join("");
      } catch (_) {
        ul.innerHTML = `<li class="muted">Claims will show here.</li>`;
      }
    }
    loadClaims();

    // creator controls
    if (isCreator && !d.closed) {
      const canClose = ended || soldOut || Number(d.claimed) === 0;
      $("#creatorBox").innerHTML = `<div class="card"><b>You created this</b>
        <p class="muted small">${canClose ? "You can take back whatever's left." : "You can take back unclaimed money once it ends."}</p>
        <button class="btn ghost block" id="closeBtn" ${canClose ? "" : "disabled"}>Refund ${fmt(d.balance, tok.decimals)} ${esc(tok.symbol)}</button></div>`;
      $("#closeBtn").onclick = async () => {
        try {
          await ensureChain(chainId);
          await (await oh(S.signer, chainId).closeDrop(id)).wait();
          toast("Refunded to your wallet");
          dropPage(chainIdStr, idStr);
        } catch (e) { toast(errMsg(e), true); }
      };
    }
  }

  function deploy() {
    let target = S.chainId;
    app.innerHTML = `
      <h2>Deploy <em>OnlyHuman</em></h2>
      <p class="muted">One-time setup from your phone. Open this page in your QIE Wallet browser.</p>
      <label>Network</label>
      <div class="seg two" id="netSeg">
        <button data-v="1983">Testnet<small>free test coins</small></button>
        <button data-v="1990">Mainnet<small>real QIE</small></button>
      </div>
      <div class="card">
        <div class="summary small">
          <div><span>Checker (signs claim passes)</span><b>${S.cfg.checker ? short(S.cfg.checker) : "not set"}</b></div>
          <div><span>Fees go to</span><b id="tre">your wallet</b></div>
          <div><span>Already deployed here</span><b id="already">–</b></div>
        </div>
      </div>
      ${S.cfg.checker ? "" : `<div class="note">Set <code>CHECKER_KEY</code> in Vercel first, then reload.</div>`}
      <button class="btn accent block" id="dep" ${S.cfg.checker ? "" : "disabled"}>Deploy contract</button>
      <div id="depOut"></div>
      <div id="usdBox"></div>
      <div class="card"><b>Service keys</b>
        <p class="muted small">Vercel needs two keys: <code>CHECKER_KEY</code> (signs claim passes) and <code>RELAYER_KEY</code> (pays gas so winners claim free). Generate each one here. It's created on this phone and never sent anywhere. Paste it straight into Vercel and don't share it.</p>
        <button class="btn ghost block" id="genBtn">Generate a key</button><div id="genOut"></div></div>`;
    const syncNet = () => {
      $("#netSeg").querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === target));
      $("#already").textContent = ohAddress(target) ? short(ohAddress(target)) : "no";
      $("#usdBox").innerHTML = target !== 1990 ? `
        <div class="card"><b>Test dollars</b><p class="muted small">Testnet has no QUSDC, so deploy a test dollar token and mint yourself 10,000 for demos.</p>
        <button class="btn ghost block" id="usdBtn">Deploy test dollars</button><div id="usdOut"></div></div>` : "";
      const ub = $("#usdBtn");
      if (ub) ub.onclick = deployUsd;
    };
    $("#netSeg").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; target = Number(b.dataset.v); S.chainId = target; localSet("oh_chain", target); updateNetLabel(); syncNet(); };
    syncNet();

    $("#genBtn").onclick = () => {
      const w = ethers.Wallet.createRandom();
      $("#genOut").innerHTML = `<p class="small">Address: <code>${w.address}</code></p>
        <p class="small">Private key (tap to copy):</p><p><code id="pk" style="cursor:pointer">${w.privateKey}</code></p>
        <p class="hint">For RELAYER_KEY, send this address a little QIE so it can pay claim gas.</p>`;
      $("#pk").onclick = () => { navigator.clipboard?.writeText(w.privateKey); toast("Key copied — paste it into Vercel"); };
    };

    $("#dep").onclick = async () => {
      const btn = $("#dep");
      try {
        btn.disabled = true;
        btn.innerHTML = `<span class="spin"></span> Confirm in your wallet`;
        await ensureChain(target);
        $("#tre").textContent = short(S.account);
        const f = new ethers.ContractFactory(C.OnlyHuman.abi, C.OnlyHuman.bytecode, S.signer);
        const c = await f.deploy(S.cfg.checker, S.account);
        btn.innerHTML = `<span class="spin"></span> Deploying…`;
        await c.waitForDeployment();
        const a = await c.getAddress();
        $("#depOut").innerHTML = `<div class="card dark"><b>Deployed ✓</b>
          <p class="muted small">Add this in Vercel → Settings → Environment Variables, then redeploy:</p>
          <p><code style="background:#222;color:#fff">ONLYHUMAN_${target}=${a}</code></p>
          <button class="btn small accent" id="cpA">Copy address</button></div>`;
        $("#cpA").onclick = () => { navigator.clipboard?.writeText(a); toast("Copied"); };
        btn.textContent = "Deployed";
      } catch (e) {
        toast(errMsg(e), true);
        btn.disabled = false;
        btn.textContent = "Deploy contract";
      }
    };

    async function deployUsd() {
      const b = $("#usdBtn");
      try {
        b.disabled = true;
        b.innerHTML = `<span class="spin"></span> Deploying…`;
        await ensureChain(target);
        const f = new ethers.ContractFactory(C.TestUSD.abi, C.TestUSD.bytecode, S.signer);
        const t = await f.deploy();
        await t.waitForDeployment();
        const a = await t.getAddress();
        b.innerHTML = `<span class="spin"></span> Minting 10,000…`;
        await (await t.mint(S.account, ethers.parseUnits("10000", 6))).wait();
        $("#usdOut").innerHTML = `<p class="small">Done. Add in Vercel: <code>QUSDC_${target}=${a}</code></p>`;
        b.textContent = "Done";
      } catch (e) {
        toast(errMsg(e), true);
        b.disabled = false;
        b.textContent = "Deploy test dollars";
      }
    }
  }

  // ------------------------------------------------------------ boot
  (async () => {
    await loadConfig();
    if (window.ethereum) {
      try {
        const accs = await window.ethereum.request({ method: "eth_accounts" });
        if (accs && accs[0]) await connect();
      } catch (_) {}
    }
    route();
  })();
})();
