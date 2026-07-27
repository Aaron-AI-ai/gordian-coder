// Single source of truth for the version. Imported from package.json so a
// `npm version` bump is the only place to change it; `bun build` inlines the
// value into every bundle (no runtime file read).
import pkg from "../package.json";

export const VERSION: string = pkg.version;
