"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChatFileDrop } from "./chat-file-drop";
import { ArrowUp, AtSign, Paperclip, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Attachment as FileAttachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentActions,
  AttachmentAction,
} from "./ui/attachment";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { encodeMentions, mentionLabel } from "@/lib/mentions";
import { api } from "@/lib/client";
import type { Person } from "@/lib/chat";
import type { Attachment } from "@/lib/protocol";
export function ChatComposer({
  roomId,
  parentId,
  people,
  label,
  onSend,
  progress,
}: {
  roomId: string;
  parentId?: string;
  people: Person[];
  label: string;
  progress?: ReactNode;
  onSend: (draft: {
    id: string;
    text: string;
    attachments: Attachment[];
    parentId?: string;
  }) => void;
}) {
  const [text, setText] = useState(""),
    [files, setFiles] = useState<Attachment[]>([]),
    [uploading, setUploading] = useState(false),
    [mention, setMention] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    uploadController = useRef<AbortController | null>(null);
  useEffect(() => () => uploadController.current?.abort(), []);
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
      .replace(/@[\w-]*$/, "@" + mentionLabel(p, people) + " ");
    setText(before + text.slice(cursor));
    setMention(null);
    setTimeout(() => {
      input.current?.focus();
      input.current?.setSelectionRange(before.length, before.length);
    }, 0);
  }
  function send() {
    if (uploading || (!text.trim() && !files.length)) return;
    onSend({
      id: crypto.randomUUID(),
      text: encodeMentions(text.trim(), people),
      attachments: files,
      parentId,
    });
    setText("");
    setFiles([]);
    setMention(null);
    input.current?.focus();
  }
  async function upload(selected: File[]) {
    if (!selected.length) return;
    if (uploadController.current) {
      toast.error("Please wait for the current upload to finish.");
      return;
    }
    const available = 8 - files.length;
    if (selected.length > available)
      toast.error("You can attach up to 8 files per message.");
    if (available <= 0) return;
    const controller = new AbortController();
    uploadController.current = controller;
    setUploading(true);
    try {
      for (const file of selected.slice(0, available)) {
        if (controller.signal.aborted) break;
        try {
          if (file.size > 10 * 1024 * 1024)
            throw new Error("Files must be 10 MB or smaller.");
          const form = new FormData();
          form.append("file", file);
          const added = await api<Attachment>("/chat/files?room=" + roomId, {
            method: "POST",
            body: form,
            signal: controller.signal,
          });
          if (!controller.signal.aborted)
            setFiles((current) => [...current, added]);
        } catch (e) {
          if (!controller.signal.aborted)
            toast.error(`${file.name}: ${(e as Error).message}`);
        }
      }
    } finally {
      uploadController.current = null;
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  useChatFileDrop(upload);
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
      {progress}
      <input
        className="sr-only"
        type="file"
        multiple
        ref={fileInput}
        aria-label="Upload files"
        onChange={(e) => void upload(Array.from(e.target.files || []))}
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
            <FileAttachment key={f.id} size="xs">
              <AttachmentMedia>
                <Paperclip />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{f.name}</AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  size="icon-xs"
                  variant="ghost"
                  aria-label={"Remove " + f.name}
                  onClick={() =>
                    setFiles((current) => current.filter((x) => x.id !== f.id))
                  }
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </FileAttachment>
          ))}
        </div>
      )}
      <InputGroup>
        <InputGroupTextarea
          ref={input}
          aria-label={parentId ? "Thread reply" : "Message"}
          placeholder={label}
          value={text}
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
          <InputGroupButton
            className="composer-send ml-auto"
            variant="default"
            size="icon-sm"
            aria-label={parentId ? "Send reply" : "Send message"}
            disabled={uploading || (!text.trim() && !files.length)}
            onClick={() => void send()}
          >
            <ArrowUp />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}
