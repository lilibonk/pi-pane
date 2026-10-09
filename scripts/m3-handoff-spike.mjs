#!/usr/bin/env node
/** The historical proof stays on spike/m3-handoff; this branch uses the formal runner. */
console.error("The spike runner is retired. Run npm run m3:handoff and npm run m2:external for the formal foreground/RPC and external-access checks. Historical spike evidence remains on spike/m3-handoff.");
process.exitCode = 2;
