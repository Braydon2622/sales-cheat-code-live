// Picks real (Claude) or mock components.
import { config } from "../config.js";
import { ClaudeCoach, ClaudeDetector, ClaudeGuard } from "./claude.js";
import { KeywordDetector, NoopGuard, TemplateCoach } from "./mock.js";
import type { CardGuard, Coach, Detector } from "./components.js";

export interface PipelineComponents {
  detector: Detector;
  coach: Coach;
  guard: CardGuard;
}

export function makeComponents(mock: boolean, overrides: { coachModel?: string } = {}): PipelineComponents {
  if (mock) return { detector: new KeywordDetector(), coach: new TemplateCoach(), guard: new NoopGuard() };
  return {
    detector: new ClaudeDetector(config.detectorModel),
    coach: new ClaudeCoach(overrides.coachModel ?? config.coachModel, config.coachEffort),
    guard: new ClaudeGuard(config.guardModel),
  };
}
