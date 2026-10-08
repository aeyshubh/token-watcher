import { resetScoutState, scoutStatePath } from "../src/scout-state";

resetScoutState();
console.log(`Cleared scout fired state at ${scoutStatePath()}. Pools can alert again.`);
