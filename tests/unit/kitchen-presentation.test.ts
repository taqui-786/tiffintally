import { describe, expect, it } from "vitest";
import { kitchenIdentity } from "@/lib/client/kitchen-presentation";

describe("kitchen greeting", () => {
  it("uses the authenticated profile name and normalizes whitespace", () => {
    expect(kitchenIdentity("  Taqui   Imam  ")).toEqual({ fullName: "Taqui Imam", firstName: "Taqui", initials: "TI" });
  });
  it("does not invent an identity when the session name is missing", () => {
    for (const name of [null, undefined, "", "  ", 42]) expect(kitchenIdentity(name)).toEqual({ fullName: "", firstName: "", initials: "" });
  });
  it("supports single names and Unicode initials", () => {
    expect(kitchenIdentity("Asha").initials).toBe("A");
    expect(kitchenIdentity("李 华")).toEqual({ fullName: "李 华", firstName: "李", initials: "李华" });
  });
});
