export type Checkpoint = "ready" | "failed" | "pending" | "unsupported";
export type FailureChoice = "retry" | "cancel" | "proceed-without-recovery" | undefined;

// State contract only: this does not intercept tools or create a checkpoint.
export function executionDecision(checkpoint: Checkpoint, choice?: FailureChoice): "execute-protected" | "execute-unprotected" | "retry" | "cancel" | "blocked" {
  if (checkpoint === "ready") return "execute-protected";
  if (checkpoint === "pending") return "blocked";
  if (choice === "proceed-without-recovery") return "execute-unprotected";
  if (choice === "retry") return "retry";
  if (choice === "cancel") return "cancel";
  return "blocked";
}

export type RecallOrigin = { project: string; session: string; run: string; conversationRevision: number; memoryRevision: number };
export function isCurrent(origin: RecallOrigin, current: RecallOrigin): boolean {
  return origin.project === current.project && origin.session === current.session && origin.run === current.run
    && origin.conversationRevision === current.conversationRevision && origin.memoryRevision === current.memoryRevision;
}
