// Portable locations for the instinct store and its side files.
// INSTINCT_DIR overrides the directory; otherwise <ZOUROBOROS_STATE_DIR>/instincts, falling back
// to the profile's state/ directory. INSTINCT_STORE_PATH still overrides the store file itself.
import { join } from "node:path";
import { paths } from "../../../../integration/profile.ts";

export function instinctsDir(): string {
  if (process.env.INSTINCT_DIR) return process.env.INSTINCT_DIR;
  return join(process.env.ZOUROBOROS_STATE_DIR || join(paths().data, "state"), "instincts");
}
export const defaultStorePath = () => join(instinctsDir(), "instincts.yaml");
