/** Presentation only: never infer a person's name from their account ID or email. */
export function kitchenIdentity(name: unknown) {
  const fullName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  const words = fullName.split(" ").filter(Boolean);
  return {
    fullName,
    firstName: words[0] ?? "",
    initials: words.length ? [words[0], ...(words.length > 1 ? [words.at(-1)!] : [])].map((word) => Array.from(word)[0]).join("").toLocaleUpperCase() : "",
  };
}
