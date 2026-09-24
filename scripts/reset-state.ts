import { resetState, statePath } from "../src/state";

resetState();
console.log(`Cleared fired-target state at ${statePath()}. Targets can fire again.`);
