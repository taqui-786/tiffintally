import { describe, expect, it } from "vitest";
import { approvalGate, previewSafe, uniqueApprovalIds } from "@/components/proposal-workspace";

const proposal = { _id: "proposal-a", draftRevision: 3, sourceRevision: 2, status: "needs_review" as const, missingFields: [] };
const preview = { proposalId: "proposal-a", expectedStateRevision: 9, expectedDraftRevision: 3, sourceRevision: 2, missingFields: [], requiredAcknowledgements: [] as ("supersession" | "late_change")[] };

describe("proposal approval safety", () => {
  it("deduplicates supersession IDs without changing their exact values", () => {
    expect(uniqueApprovalIds(["approval-a", "approval-a", "approval-b"])).toEqual(["approval-a", "approval-b"]);
  });

  it("rejects a preview when any revision or the service-date context changes", () => {
    expect(previewSafe({ preview, proposal, stateRevision: 9, serviceDate: "2026-10-05", previewServiceDate: "2026-10-05" })).toBe(true);
    expect(previewSafe({ preview: { ...preview, expectedDraftRevision: 2 }, proposal, stateRevision: 9, serviceDate: "2026-10-05", previewServiceDate: "2026-10-05" })).toBe(false);
    expect(previewSafe({ preview, proposal, stateRevision: 10, serviceDate: "2026-10-05", previewServiceDate: "2026-10-05" })).toBe(false);
    expect(previewSafe({ preview, proposal, stateRevision: 9, serviceDate: "2026-10-06", previewServiceDate: "2026-10-05" })).toBe(false);
  });

  it("blocks missing fields and unacknowledged required acknowledgements", () => {
    expect(approvalGate({ preview, proposal, stateRevision: 9, serviceDate: "2026-10-05", supersessionAcknowledged: false, lateChangeAcknowledged: false }).allowed).toBe(true);
    expect(approvalGate({ preview: { ...preview, requiredAcknowledgements: ["supersession", "late_change"] }, proposal, stateRevision: 9, serviceDate: "2026-10-05", supersessionAcknowledged: false, lateChangeAcknowledged: false }).allowed).toBe(false);
    expect(approvalGate({ preview, proposal: { ...proposal, missingFields: ["customer"] }, stateRevision: 9, serviceDate: "2026-10-05", supersessionAcknowledged: true, lateChangeAcknowledged: true }).reason).toMatch(/missing/i);
    expect(approvalGate({ preview, proposal: { ...proposal, status: "approved" }, stateRevision: 9, serviceDate: "2026-10-05", supersessionAcknowledged: true, lateChangeAcknowledged: true }).reason).toMatch(/review/i);
  });
});
