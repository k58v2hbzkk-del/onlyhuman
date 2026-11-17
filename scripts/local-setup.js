const { ethers } = require("hardhat");
async function main() {
  const [owner, checker, relayer, creator] = await ethers.getSigners();
  const oh = await (await ethers.getContractFactory("OnlyHuman")).deploy(checker.address, owner.address);
  const usd = await (await ethers.getContractFactory("MockUSD")).deploy();
  await usd.mint(creator.address, ethers.parseUnits("10000", 6));
  console.log(JSON.stringify({ oh: await oh.getAddress(), usd: await usd.getAddress() }));
}
main();
