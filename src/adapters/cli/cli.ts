#!/usr/bin/env node
import { startCliServer } from "./index";

startCliServer().catch((error) => {
  console.error("[gordian-coder] Failed to start CLI server:", error);
  process.exit(1);
});
