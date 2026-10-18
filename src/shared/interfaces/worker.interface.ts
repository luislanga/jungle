export interface WorkerSettings {
  enabled: boolean;
  shutdownDrainMs: number;
  sqsRequestTimeoutMs: number;
  outboxPollIntervalMs: number;
  pendingPollIntervalMs: number;
}
