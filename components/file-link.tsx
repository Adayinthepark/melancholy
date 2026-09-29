"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import type { Attachment } from "@/lib/protocol";
import { formatSize } from "@/lib/file-size";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogFooter,
} from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";
import { MessageMarkdown } from "./message-markdown";

export function isMarkdownFile(file: Pick<Attachment, "name" | "type">) {
  return (
    /\.(md|markdown|mdown)$/i.test(file.name) ||
    /^(text\/markdown|text\/x-markdown)(;|$)/i.test(file.type)
  );
}

const PREVIEW_LIMIT = 1024 * 1024;
async function readMarkdown(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > PREVIEW_LIMIT)
        throw new Error(
          "This document is too large to preview. Download it to read the full file.",
        );
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Reuse the authorized download endpoint; file bytes never enter a persistent cache.
export function FileLink({
  file,
  children,
  className,
}: {
  file: Attachment;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const href = "/api/files/" + encodeURIComponent(file.id);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setText(null);
    setError("");
    void (async () => {
      if (file.size > PREVIEW_LIMIT)
        throw new Error(
          "This document is too large to preview. Download it to read the full file.",
        );
      const response = await fetch(href, {
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "Sign in again to open this document."
            : [403, 404, 410].includes(response.status)
              ? "This file is no longer available, or you no longer have access."
              : "Could not load the document. Try again.",
        );
      const content = await readMarkdown(response);
      if (!controller.signal.aborted) setText(content);
    })().catch((e) => {
      if (!controller.signal.aborted)
        setError(
          e instanceof TypeError
            ? "Could not read this Markdown file. Try again or download the original."
            : e.message,
        );
    });
    return () => controller.abort();
  }, [open, href, file.size, attempt]);
  if (!isMarkdownFile(file))
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={className}
          aria-label={"Open " + file.name}
        >
          {children}
        </button>
      </DialogTrigger>
      <DialogContent className="markdown-file-dialog">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle className="break-words">{file.name}</DialogTitle>
          <DialogDescription>
            Markdown · {formatSize(file.size)}
          </DialogDescription>
        </DialogHeader>
        <div className="markdown-file-content">
          {error ? (
            <div className="flex flex-col items-start gap-3">
              <p role="alert">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </Button>
            </div>
          ) : text === null ? (
            <div
              role="status"
              aria-label="Loading document"
              className="flex flex-col gap-3"
            >
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : text ? (
            <div className="markdown">
              <MessageMarkdown text={text} />
            </div>
          ) : (
            <p className="text-muted-foreground">This document is empty.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" asChild>
            <a href={href} download={file.name}>
              <Download data-icon="inline-start" />
              Download original
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
