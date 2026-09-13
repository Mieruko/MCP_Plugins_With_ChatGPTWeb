/** Presentation and collaboration mode; independent of approval and tool profiles. */
export type ExperienceMode = "basic" | "advanced";

export interface WriterLease {
  sessionId: string;
  acquiredAt: string;
}

export function defaultExperience(): ExperienceMode {
  return process.env.WORKBENCH_EXPERIENCE === "advanced" ? "advanced" : "basic";
}
