const { ethers } = require("hardhat");
async function main(){
  const [o,c,t,cr,a]=await ethers.getSigners();
  const F=await ethers.getContractFactory("OnlyHuman");
  const oh=await F.deploy(c.address,t.address); const r=await oh.deploymentTransaction().wait();
  console.log("deploy gas", r.gasUsed.toString());
  const ends=Math.floor(Date.now()/1000)+86400*30;
  const b=ethers.parseEther("1");
  const tx=await oh.connect(cr).createDrop(ethers.ZeroAddress,b,ethers.parseEther("0.1"),10,0,0,ends,{value:b+b/100n});
  console.log("createDrop gas",(await tx.wait()).gasUsed.toString());
  const net=await ethers.provider.getNetwork();
  const sig=await c.signTypedData({name:"OnlyHuman",version:"1",chainId:net.chainId,verifyingContract:await oh.getAddress()},
   {Claim:[{name:"dropId",type:"uint256"},{name:"claimer",type:"address"},{name:"humanKey",type:"bytes32"},{name:"level",type:"uint8"},{name:"deadline",type:"uint64"}]},
   {dropId:1,claimer:a.address,humanKey:ethers.id("a"),level:0,deadline:ends});
  const t2=await oh.connect(a).claim(1,ethers.id("a"),0,ends,sig);
  console.log("claim gas",(await t2.wait()).gasUsed.toString());
}
main();
