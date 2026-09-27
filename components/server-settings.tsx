"use client";
import { useState } from "react";
import { Copy, Plus, Server as ServerIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api, post } from "@/lib/client";
import type { Runtime, Server } from "@/lib/protocol";

export function ServerSettings({
  open,
  onOpenChange,
  servers,
  onChange,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  servers: Server[];
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("codex");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    token: string;
    runtime: Runtime;
  } | null>(null);
  const [remove, setRemove] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    try {
      const result = await post<{ token: string; runtime: Runtime }>(
        "/servers",
        { name, runtime },
      );
      setCreated(result);
      setName("");
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeServer(id: string) {
    try {
      await api(`/servers/${id}`, { method: "DELETE" });
      setRemove(null);
      await onChange();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const configuration = created
    ? JSON.stringify(
        {
          url:
            typeof window !== "undefined"
              ? window.location.origin
              : "https://async.love",
          token: created.token,
          runtime: created.runtime,
          cwd: "/path/to/your/project",
          permission: "read-only",
        },
        null,
        2,
      )
    : "";
  const command =
    "npx --yes --package=github:adayinthepark/melancholy melancholy-connect --config ./melancholy.json";
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setCreated(null);
      }}
    >
      <DialogContent className="settings-dialog sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Servers</DialogTitle>
          <DialogDescription>
            Connect a machine with Codex or Claude Code installed.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="connection-instructions">
            <p>
              Save as <code>melancholy.json</code> on your server. Set{" "}
              <code>cwd</code> to your project directory.
            </p>
            <CodeCopy value={configuration} />
            <p>Keep this file private, then run:</p>
            <CodeCopy value={"chmod 600 melancholy.json\n" + command} />
            <p className="text-muted-foreground">
              The token is shown once. Existing CLI login and model settings are
              used.
            </p>
            <Button variant="outline" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        ) : (
          <>
            {servers.length > 0 && (
              <div className="server-list">
                {servers.map((server) => (
                  <div key={server.id} className="server-row">
                    <ServerIcon />
                    <div className="server-description">
                      <strong>{server.name}</strong>
                      <span>
                        {server.runtime === "codex" ? "Codex" : "Claude Code"}
                        {server.hostname ? ` on ${server.hostname}` : ""}
                      </span>
                      {server.cwd && <code>{server.cwd}</code>}
                    </div>
                    <Badge variant={server.online ? "secondary" : "outline"}>
                      {server.online ? "Connected" : "Offline"}
                    </Badge>
                    {remove === server.id ? (
                      <div className="flex gap-1">
                        <Button
                          variant="destructive"
                          size="xs"
                          onClick={() => void removeServer(server.id)}
                        >
                          Remove
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => setRemove(null)}
                        >
                          Keep
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${server.name}`}
                        onClick={() => setRemove(server.id)}
                      >
                        <Trash2 data-icon="inline-start" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {servers.length > 0 && <Separator />}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="server-name">Server name</FieldLabel>
                  <Input
                    id="server-name"
                    placeholder="workstation"
                    required
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="server-runtime">Agent</FieldLabel>
                  <Select
                    value={runtime}
                    onValueChange={(v) => setRuntime(v as Runtime)}
                  >
                    <SelectTrigger id="server-runtime" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="codex">Codex</SelectItem>
                        <SelectItem value="claude">Claude Code</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Button type="submit" disabled={busy || !name.trim()}>
                  <Plus data-icon="inline-start" />
                  {busy ? "Creating…" : "Connect server"}
                </Button>
              </FieldGroup>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
function CodeCopy({ value }: { value: string }) {
  return (
    <div className="config-code">
      <pre>{value}</pre>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy configuration"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => toast("Copied"))
        }
      >
        <Copy data-icon="inline-start" />
      </Button>
    </div>
  );
}
