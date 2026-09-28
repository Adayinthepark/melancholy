import type { Person } from "./chat";
const code =
  /(`{3,}[^\n]*\n[\s\S]*?(?:\n`{3,}|$)|~~~[^\n]*\n[\s\S]*?(?:\n~~~|$)|`+[^`\n]*`+)/g;
export function proseOnly(text: string) {
  return text
    .split(code)
    .map((part, i) => (i % 2 ? " " : part))
    .join("");
}
// Duplicate display names fall back to the unique username while composing.
// Rendered messages always show the current display name from the stable ID.
export function mentionLabel(person: Person, people: Person[]) {
  const name = person.name.toLowerCase();
  return people.some(
    (p) =>
      p.id !== person.id &&
      (p.name.toLowerCase() === name || p.handle.toLowerCase() === name),
  )
    ? person.handle
    : person.name;
}
export function encodeMentions(text: string, people: Person[]) {
  const names = new Map<string, string>();
  for (const p of people) {
    const label = mentionLabel(p, people).toLowerCase();
    names.set(label, p.id);
  }
  for (const p of people) names.set(p.handle.toLowerCase(), p.id);
  if (!names.size) return text;
  const escaped = [...names.keys()]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    "(^|[\\s(])@(" + escaped.join("|") + ")(?![\\p{L}\\p{N}_-])",
    "giu",
  );
  return text
    .split(code)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            pattern,
            (_, prefix, name) =>
              prefix + "<@" + names.get(name.toLowerCase()) + ">",
          ),
    )
    .join("");
}
export function mentionText(
  text: string,
  people: Person[],
  refs: Record<string, string> = {},
) {
  return text
    .split(code)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(
            /<@([a-z0-9-]+)>|(^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})/g,
            (all, id, prefix, handle) => {
              const p = people.find(
                (p) => p.id === (id || refs[handle?.toLowerCase()]),
              );
              return p ? (prefix || "") + "@" + mentionLabel(p, people) : all;
            },
          ),
    )
    .join("");
}
