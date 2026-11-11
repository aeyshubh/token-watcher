import { lpStatePath, resetLpState } from "../src/lp-state";

resetLpState();
console.log(`Cleared LP tracker state at ${lpStatePath()}. Positions will be re-detected.`);
