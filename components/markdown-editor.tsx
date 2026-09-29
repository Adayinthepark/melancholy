"use client";
import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  undo,
  redo,
} from "@codemirror/commands";
import { markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListChecks,
  Link,
  Code,
  Quote,
  Undo2,
  Redo2,
} from "lucide-react";
import { Button } from "./ui/button";

export default function MarkdownEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          markdownLanguage,
          history(),
          keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(
            HighlightStyle.define([
              { tag: tags.heading, fontWeight: "600" },
              { tag: tags.strong, fontWeight: "700" },
              { tag: tags.emphasis, fontStyle: "italic" },
              { tag: tags.strikethrough, textDecoration: "line-through" },
              {
                tag: [tags.link, tags.url],
                color: "var(--foreground)",
                textDecoration: "underline",
              },
              {
                tag: [
                  tags.meta,
                  tags.processingInstruction,
                  tags.contentSeparator,
                ],
                color: "var(--muted-foreground)",
              },
              { tag: tags.monospace, color: "var(--foreground)" },
            ]),
          ),
          EditorView.lineWrapping,
          placeholder("Write your note in Markdown…"),
          EditorView.contentAttributes.of({
            id: "note-content",
            "aria-label": "Content · Markdown",
            "aria-multiline": "true",
            spellcheck: "true",
          }),
          EditorState.transactionFilter.of((tr) =>
            tr.newDoc.length > 100000 ? [] : tr,
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
  }, [value]);
  function format(before: string, after = "", line = false) {
    const view = editor.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const start = line ? view.state.doc.lineAt(from).from : from;
    const text = view.state.sliceDoc(start, to);
    const insert = line
      ? text
          .split("\n")
          .map((part) => before + part)
          .join("\n")
      : before + text + after;
    view.dispatch({
      changes: { from: start, to, insert },
      selection: {
        anchor: start + before.length,
        head: start + insert.length - after.length,
      },
      scrollIntoView: true,
    });
    view.focus();
  }
  const tools = [
    { label: "Bold", icon: Bold, run: () => format("**", "**") },
    { label: "Italic", icon: Italic, run: () => format("_", "_") },
    { label: "Heading", icon: Heading2, run: () => format("## ", "", true) },
    { label: "Bullet list", icon: List, run: () => format("- ", "", true) },
    {
      label: "Task list",
      icon: ListChecks,
      run: () => format("- [ ] ", "", true),
    },
    { label: "Link", icon: Link, run: () => format("[", "](https://)") },
    { label: "Code", icon: Code, run: () => format("`", "`") },
    { label: "Quote", icon: Quote, run: () => format("> ", "", true) },
    {
      label: "Undo",
      icon: Undo2,
      run: () => {
        if (editor.current) {
          undo(editor.current);
          editor.current.focus();
        }
      },
    },
    {
      label: "Redo",
      icon: Redo2,
      run: () => {
        if (editor.current) {
          redo(editor.current);
          editor.current.focus();
        }
      },
    },
  ];
  return (
    <div className="markdown-editor">
      <div
        className="markdown-editor-toolbar"
        role="group"
        aria-label="Markdown formatting"
      >
        {tools.map(({ label, icon: Icon, run }) => (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            title={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={run}
          >
            <Icon />
          </Button>
        ))}
      </div>
      <div ref={host} />
      <div className="markdown-editor-count" aria-live="off">
        {value.length.toLocaleString()} / 100,000
      </div>
    </div>
  );
}
