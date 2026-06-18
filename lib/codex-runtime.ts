/**
 * Shared runtime helpers for isolated Codex imp profiles.
 */
import {
  existsSync,
  mkdirSync,
  symlinkSync,
} from "fs";
import type { ImpConfig } from "./isolated.ts";

export interface PreparedCodexHome {
  /** Env vars to merge into the spawned Codex process. */
  extraEnv: Record<string, string>;
  hooksEnabled: boolean;
}

export function prepareIsolatedCodexHome(
  _config: ImpConfig,
  isolatedHome: string,
  realHome = process.env.HOME!,
): PreparedCodexHome {
  mkdirSync(isolatedHome, { recursive: true });

  const authSrc = `${realHome}/.codex/auth.json`;
  const authDst = `${isolatedHome}/auth.json`;
  if (existsSync(authSrc) && !existsSync(authDst)) {
    symlinkSync(authSrc, authDst);
  }

  return { extraEnv: {}, hooksEnabled: false };
}
