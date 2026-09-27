"use client";
import { useRef, useState } from "react";
import { ArrowUp, AtSign, Paperclip, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { api, post } from "@/lib/client";
import type { Person } from "@/lib/chat";
import type { Attachment } from "@/lib/protocol";
export function ChatComposer({
  roomId,
  parentId,
  people,
  label,
  onSent,
}: {
  roomId: string;
  parentId?: string;
  people: Person[];
  label: string;
  onSent: () => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState<Attachment[]>([]),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [mention, setMention] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    pending = useRef<{
      id: string;
      text: string;
      attachments: string[];
    } | null>(null);
  function change(value: string) {
    setText(value);
    const match = value
      .slice(0, input.current?.selectionStart ?? value.length)
      .match(/(?:^|\s)@([\w-]*)$/);
    setMention(match?.[1] ?? null);
  }
  function select(p: Person) {
    const cursor = input.current?.selectionStart ?? text.length;
    const before = text
      .slice(0, cursor)
      .replace(/@[\w-]*$/, "@" + p.handle + " ");
    setText(before + text.slice(cursor));
    setMention(null);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(before.length, before.length);
    }, 0);
  }
  async function send() {
    if (busy || uploading || (!text.trim() && !files.length)) return;
    setBusy(true);
    const value = { text: text.trim(), attachments: files.map((f) => f.id) };
    if (
      !pending.current ||
      pending.current.text !== value.text ||
      pending.current.attachments.join() !== value.attachments.join()
    )
      pending.current = { id: crypto.randomUUID(), ...value };
    try {
      await post("/chat/rooms/" + roomId + "/messages", {
        ...pending.current,
        parentId,
      });
      setText("");
      setFiles([]);
      setMention(null);
      pending.current = null;
      await onSent();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(selected: FileList | null) {
    if (!selected) return;
    setUploading(true);
    try {
      const added: Attachment[] = [];
      for (const file of Array.from(selected).slice(0, 8 - files.length)) {
        if (file.size > 10 * 1024 * 1024)
          throw new Error("Files must be 10 MB or smaller.");
        const form = new FormData();
        form.append("file", file);
        added.push(
          await api<Attachment>("/chat/files?room=" + roomId, {
            method: "POST",
            body: form,
          }),
        );
      }
      setFiles((current) => [...current, ...added]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const choices =
    mention === null
      ? []
      : people
          .filter(
            (p) =>
              p.handle.includes(mention.toLowerCase()) ||
              p.name.toLowerCase().includes(mention.toLowerCase()),
          )
          .slice(0, 8);
  return (
    <div className="chat-composer">
      <input
        className="sr-only"
        type="file"
        multiple
        ref={fileInput}
        aria-label="Upload files"
        onChange={(e) => void upload(e.target.files)}
      />
      {choices.length > 0 && (
        <div
          className="mention-picker"
          role="listbox"
          aria-label="Mention a member"
        >
          {choices.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(p)}
            >
              <strong>{p.name}</strong>
              <span>
                @{p.handle}
                {p.kind === "bot" ? " · bot" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <span key={f.id}>
              {f.name}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={"Remove " + f.name}
                onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
              >
                <X />
              </Button>
            </span>
          ))}
        </div>
      )}
      <InputGroup>
        <InputGroupTextarea
          ref={input}
          aria-label={parentId ? "Thread reply" : "Message"}
          placeholder={label}
          value={text}
          disabled={busy}
          rows={2}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setMention(null);
              return;
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              if (choices.length && mention !== null) {
                select(choices[0]);
                return;
              }
              void send();
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            aria-label={parentId ? "Attach to reply" : "Attach file"}
            disabled={uploading || files.length >= 8}
            onClick={() => fileInput.current?.click()}
          >
            {uploading ? <Loader2 className="spin" /> : <Paperclip />}
          </InputGroupButton>
          <InputGroupButton
            size="icon-xs"
            variant="ghost"
            aria-label="Mention member"
            onClick={() => {
              setText((v) => v + (v && !v.endsWith(" ") ? " @" : "@"));
              setMention("");
              input.current?.focus();
            }}
          >
            <AtSign />
          </InputGroupButton>
          <span className="composer-hint">Markdown supported</span>
          <InputGroupButton
            className="ml-auto"
            size="icon-sm"
            aria-label={parentId ? "Send reply" : "Send message"}
            disabled={busy || uploading || (!text.trim() && !files.length)}
            onClick={() => void send()}
          >
            <ArrowUp />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
