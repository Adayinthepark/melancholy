import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Person } from "@/lib/chat";
type Node = { type: string; value?: string; url?: string; children?: Node[] };
export function MessageMarkdown({
  text,
  people = [],
  refs = {},
}: {
  text: string;
  people?: Person[];
  refs?: Record<string, string>;
}) {
  const mentions = () => (tree: Node) => {
    function visit(node: Node) {
      if (!node.children || ["link", "code", "inlineCode"].includes(node.type))
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const out: Node[] = [];
        let cursor = 0;
        const pattern =
          /<@([a-z0-9-]+)>|(^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})/g;
        for (const m of child.value.matchAll(pattern)) {
          const id = m[1] || refs[m[3]?.toLowerCase()];
          const person = people.find((p) => p.id === id);
          if (!person) continue;
          const offset = m.index! + (m[2]?.length || 0);
          out.push(
            { type: "text", value: child.value.slice(cursor, offset) },
            {
              type: "link",
              url: "/members/" + person.id,
              children: [{ type: "text", value: "@" + person.name }],
            },
          );
          cursor = m.index! + m[0].length;
        }
        out.push({ type: "text", value: child.value.slice(cursor) });
        return out;
      });
    }
    visit(tree);
  };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, mentions]}
      components={{
        a: ({ href, children, ...props }) => {
          const person = people.find((p) => href === "/members/" + p.id);
          return person ? (
            <span className="mention-name" title={"@" + person.handle}>
              {children}
            </span>
          ) : (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
