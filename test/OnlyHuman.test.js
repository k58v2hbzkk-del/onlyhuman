const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const Gate = { Open: 0, QieId: 1, Verified: 2 };
const USD = (n) => ethers.parseUnits(String(n), 6);

describe("OnlyHuman", () => {
  let oh, usd, owner, checker, treasury, creator, alice, bob, farmer, chainId;

  async function pass(dropId, claimer, humanKey, level, signer = checker, deadline) {
    deadline = deadline ?? (await time.latest()) + 600;
    const domain = { name: "OnlyHuman", version: "1", chainId, verifyingContract: await oh.getAddress() };
    const types = {
      Claim: [
        { name: "dropId", type: "uint256" },
        { name: "claimer", type: "address" },
        { name: "humanKey", type: "bytes32" },
        { name: "level", type: "uint8" },
        { name: "deadline", type: "uint64" },
      ],
    };
    const sig = await signer.signTypedData(domain, types, { dropId, claimer, humanKey, level, deadline });
    return { deadline, sig };
  }
  const key = (s) => ethers.id(s);

  async function makeUsdDrop({ budget = 100, per = 10, max = 10, gate = Gate.Open, bonus = 0 } = {}) {
    const ends = (await time.latest()) + 86400;
    const fee = (USD(budget) * 100n) / 10000n;
    await usd.connect(creator).approve(await oh.getAddress(), USD(budget) + fee);
    await oh.connect(creator).createDrop(await usd.getAddress(), USD(budget), USD(per), max, gate, bonus, ends);
    return await oh.dropCount();
  }

  beforeEach(async () => {
    [owner, checker, treasury, creator, alice, bob, farmer] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    oh = await (await ethers.getContractFactory("OnlyHuman")).deploy(checker.address, treasury.address);
    usd = await (await ethers.getContractFactory("MockUSD")).deploy();
    await usd.mint(creator.address, USD(10000));
  });

  it("creates a QUSDC drop and takes a 1% fee", async () => {
    const id = await makeUsdDrop();
    expect(await usd.balanceOf(treasury.address)).to.equal(USD(1));
    expect(await usd.balanceOf(await oh.getAddress())).to.equal(USD(100));
    const d = await oh.getDrop(id);
    expect(d.balance).to.equal(USD(100));
    expect(d.creator).to.equal(creator.address);
  });

  it("pays a claimer with a valid pass", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await expect(oh.connect(alice).claim(id, key("alice"), 0, p.deadline, p.sig))
      .to.emit(oh, "Claimed").withArgs(id, alice.address, key("alice"), 0, USD(10));
    expect(await usd.balanceOf(alice.address)).to.equal(USD(10));
  });

  it("blocks the same wallet twice", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await oh.connect(alice).claim(id, key("alice"), 0, p.deadline, p.sig);
    const p2 = await pass(id, alice.address, key("alice-2"), 0);
    await expect(oh.connect(alice).claim(id, key("alice-2"), 0, p2.deadline, p2.sig)).to.be.revertedWithCustomError(oh, "AlreadyClaimed");
  });

  it("blocks one human using a second wallet", async () => {
    const id = await makeUsdDrop({ gate: Gate.QieId });
    const p = await pass(id, alice.address, key("alice.qie"), 1);
    await oh.connect(alice).claim(id, key("alice.qie"), 1, p.deadline, p.sig);
    const p2 = await pass(id, farmer.address, key("alice.qie"), 1);
    await expect(oh.connect(farmer).claim(id, key("alice.qie"), 1, p2.deadline, p2.sig)).to.be.revertedWithCustomError(oh, "AlreadyClaimed");
  });

  it("rejects a pass signed by anyone but the checker", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, farmer.address, key("f"), 0, farmer);
    await expect(oh.connect(farmer).claim(id, key("f"), 0, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "BadPass");
  });

  it("rejects a pass stolen by another wallet", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await expect(oh.connect(farmer).claim(id, key("alice"), 0, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "BadPass");
  });

  it("rejects a level that was not signed (can't self-upgrade to Verified)", async () => {
    const id = await makeUsdDrop({ gate: Gate.Open, bonus: 5000 });
    const p = await pass(id, alice.address, key("alice"), 0);
    await expect(oh.connect(alice).claim(id, key("alice"), 2, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "BadPass");
  });

  it("enforces the gate", async () => {
    const id = await makeUsdDrop({ gate: Gate.Verified });
    const p = await pass(id, alice.address, key("alice.qie"), 1);
    await expect(oh.connect(alice).claim(id, key("alice.qie"), 1, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "GateNotMet");
  });

  it("rejects expired passes", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0, checker, (await time.latest()) + 5);
    await time.increase(10);
    await expect(oh.connect(alice).claim(id, key("alice"), 0, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "PassExpired");
  });

  it("gives verified humans the bonus share", async () => {
    const id = await makeUsdDrop({ bonus: 5000 }); // +50%
    const p = await pass(id, alice.address, key("pass:alice"), 2);
    await oh.connect(alice).claim(id, key("pass:alice"), 2, p.deadline, p.sig);
    expect(await usd.balanceOf(alice.address)).to.equal(USD(15));
  });

  it("caps payout at what's left and stops at max claims", async () => {
    const id = await makeUsdDrop({ budget: 25, per: 10, max: 3 });
    const signers = [alice, bob, farmer];
    const got = [];
    for (const s of signers) {
      const p = await pass(id, s.address, key(s.address), 0);
      await oh.connect(s).claim(id, key(s.address), 0, p.deadline, p.sig);
      got.push(await usd.balanceOf(s.address));
    }
    expect(got).to.deep.equal([USD(10), USD(10), USD(5)]);
    const [, , , , x] = await ethers.getSigners();
    const p = await pass(id, owner.address, key("late"), 0);
    await expect(oh.connect(owner).claim(id, key("late"), 0, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "SoldOut");
  });

  it("lets the creator refund leftovers only after the drop ends", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await oh.connect(alice).claim(id, key("alice"), 0, p.deadline, p.sig);
    await expect(oh.connect(creator).closeDrop(id)).to.be.revertedWithCustomError(oh, "TooEarly");
    await expect(oh.connect(alice).closeDrop(id)).to.be.revertedWithCustomError(oh, "NotCreator");
    await time.increase(86401);
    const before = await usd.balanceOf(creator.address);
    await oh.connect(creator).closeDrop(id);
    expect((await usd.balanceOf(creator.address)) - before).to.equal(USD(90));
  });

  it("works with native QIE", async () => {
    const ends = (await time.latest()) + 3600;
    const budget = ethers.parseEther("1");
    const fee = budget / 100n;
    await expect(
      oh.connect(creator).createDrop(ethers.ZeroAddress, budget, ethers.parseEther("0.1"), 10, Gate.Open, 0, ends, { value: budget })
    ).to.be.revertedWithCustomError(oh, "WrongValue");
    await oh.connect(creator).createDrop(ethers.ZeroAddress, budget, ethers.parseEther("0.1"), 10, Gate.Open, 0, ends, { value: budget + fee });
    const id = await oh.dropCount();
    const p = await pass(id, alice.address, key("alice"), 0);
    await expect(oh.connect(alice).claim(id, key("alice"), 0, p.deadline, p.sig)).to.changeEtherBalance(alice, ethers.parseEther("0.1"));
  });

  it("gasless: a relayer submits the claim but the money goes to the claimer", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await oh.connect(bob).claimFor(id, alice.address, key("alice"), 0, p.deadline, p.sig);
    expect(await usd.balanceOf(alice.address)).to.equal(USD(10));
    expect(await usd.balanceOf(bob.address)).to.equal(0);
  });

  it("gasless: a relayer can't redirect a pass to itself", async () => {
    const id = await makeUsdDrop();
    const p = await pass(id, alice.address, key("alice"), 0);
    await expect(oh.connect(bob).claimFor(id, bob.address, key("alice"), 0, p.deadline, p.sig)).to.be.revertedWithCustomError(oh, "BadPass");
  });

  it("caps the fee at 3%", async () => {
    await expect(oh.setFee(301)).to.be.revertedWithCustomError(oh, "BadParams");
    await expect(oh.connect(alice).setFee(0)).to.be.revertedWithCustomError(oh, "OwnableUnauthorizedAccount");
  });
});
