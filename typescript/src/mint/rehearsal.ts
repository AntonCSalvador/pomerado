/**
 * The minter's instruction for `rehearsal_failed`: a host ran the repaired tool once with the
 * original call's input, set to stop before its first commit step, and it failed before reaching
 * that step. The refusal's `rehearsal` names the error and the source line beside it.
 */
export const rehearsalFailedInstruction =
  "Not published: the host ran the repaired tool once on the live site with the original call's input, set to stop before its first commit step, and it failed before reaching that step. Nothing from that step on ran. rehearsal names the error and the source line it came from. Fix the source so the tool reaches its first commit step on this input, then call finish_build again with the same executionId; the host runs it again the same way. Never run the write yourself for this.";
