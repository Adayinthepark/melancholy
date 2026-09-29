"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Person } from "@/lib/chat";
import { api } from "@/lib/client";
import { PersonAvatar } from "./person-avatar";
import { Avatar, AvatarImage, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Field, FieldGroup, FieldLabel, FieldDescription } from "./ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function BotAvatarEditor({
  person,
  onChange,
}: {
  person: Person;
  onChange: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  async function save(remove = false) {
    setBusy(true);
    try {
      await api("/chat/bots/" + person.id + "/avatar", {
        method: remove ? "DELETE" : "POST",
        ...(remove
          ? {}
          : { body: file!, headers: { "Content-Type": file!.type } }),
      });
      await onChange();
      setOpen(false);
      toast.success(remove ? "Bot avatar removed." : "Bot avatar updated.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        aria-label={"Change avatar for " + person.name}
        onClick={() => {
          setFile(null);
          setOpen(true);
        }}
      >
        Avatar
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{person.name} · avatar</DialogTitle>
            <DialogDescription>
              Shown in conversations, messages and bot settings.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {preview ? (
              <Avatar size="lg">
                <AvatarImage src={preview} alt="New bot avatar preview" />
                <AvatarFallback>{person.name.slice(0, 2)}</AvatarFallback>
              </Avatar>
            ) : (
              <PersonAvatar person={person} className="bot-avatar-preview" />
            )}
            <Field>
              <FieldLabel htmlFor={"bot-avatar-" + person.id}>
                Avatar image
              </FieldLabel>
              <Input
                id={"bot-avatar-" + person.id}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy}
                onChange={(event) => {
                  const chosen = event.target.files?.[0];
                  if (!chosen) return;
                  if (
                    chosen.size > 2 * 1024 * 1024 ||
                    !["image/png", "image/jpeg", "image/webp"].includes(
                      chosen.type,
                    )
                  ) {
                    toast.error(
                      "Choose a PNG, JPEG or WebP image, up to 2 MB.",
                    );
                    event.target.value = "";
                    setFile(null);
                    return;
                  }
                  setFile(chosen);
                }}
              />
              <FieldDescription>
                PNG, JPEG or WebP, up to 2 MB. Square images work best.
              </FieldDescription>
            </Field>
            <div className="flex gap-2">
              <Button disabled={busy || !file} onClick={() => void save()}>
                Save avatar
              </Button>
              {!!person.avatar_key && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void save(true)}
                >
                  Remove avatar
                </Button>
              )}
            </div>
          </FieldGroup>
        </DialogContent>
      </Dialog>
    </>
  );
}
