// Runtime configuration.
// The API key normally comes from the shell environment (ANTHROPIC_API_KEY).
// A local .env file is optional; any NON-EMPTY value in it overrides the shell.
// Empty values are ignored so a blank line copied from .env.example can't
// wipe out a key set in the shell. .env is gitignored and never committed.
import { existsSync, readFileSync } from "node:fs";
import { parse } from "dotenv";

if (existsSync(".env")) {
  for (const [key, value] of Object.entries(parse(readFileSync(".env")))) {
    if (value) process.env[key] = value;
  }
}

export const config = {
  detectorModel: process.env.DETECTOR_MODEL ?? "claude-haiku-5-5",
  coachModel: process.env.COACH_MODEL ?? "claude-sonnet-5-5",
  coachEffort: (process.env.COACH_EFFORT ?? "low") as "low" | "medium" | "high",
  guardModel: process.env.GUARD_MODEL ?? "claude-haiku-5-5",
  /** How many prior lines of the call the detector and coach see. */
  contextLines: 8,
};

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
