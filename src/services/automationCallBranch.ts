export function callUsesFailedBranch(call: { status: string; voicemailDetected?: boolean } | null, outcome: string) {
  return !call || call.status === "failed" || call.status === "cancelled" || outcome === "missed" || Boolean(call.voicemailDetected);
}
