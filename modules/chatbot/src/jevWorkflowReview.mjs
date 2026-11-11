// Shadow observes an immutable evidence snapshot without delaying a send or
// changing a live decision. Only enforce waits for a verdict/current-state gate.
export async function reviewJevForWorkflow(reviewer, input, logger = console) {
  if (reviewer.mode !== "shadow") return reviewer.review(input);
  try {
    void Promise.resolve(reviewer.review({ ...input, isCurrent: undefined }))
      .catch(() => logger.warn?.("jev-review: background observation unavailable"));
  } catch { logger.warn?.("jev-review: background observation unavailable"); }
  return { mode: "shadow", status: "pending", action: "unavailable", confidence10: null, applied: false };
}
