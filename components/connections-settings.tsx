"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Choice } from "./team-settings";
import { api, post } from "@/lib/client";
import type { Connection } from "@/lib/workbench";
import { toast } from "sonner";
export function ConnectionsSettings() {
  const [connections, setConnections] = useState<Connection[]>([]),
    [provider, setProvider] = useState("github"),
    [name, setName] = useState(""),
    [token, setToken] = useState(""),
    [accountId, setAccountId] = useState(""),
    [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState("");
  async function refresh() {
    setConnections(
      (await api<{ connections: Connection[] }>("/chat/connections"))
        .connections,
    );
  }
  useEffect(() => {
    void refresh().catch((e) => toast.error(e.message));
  }, []);
  return (
    <div className="settings-section">
      <p className="text-sm text-muted-foreground">
        Connect GitHub and Cloudflare using API tokens. Choose which channels
        can use each connection in their repository settings.
      </p>
      <div>
        {connections.map((c) => (
          <div className="person-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>
                {c.provider} · {c.identity}
              </small>
            </div>
            {removing === c.id ? (
              <>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() =>
                    void api("/chat/connections/" + c.id, { method: "DELETE" })
                      .then(refresh)
                      .catch((e) => toast.error(e.message))
                  }
                >
                  Disconnect
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setRemoving("")}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setRemoving(c.id)}
              >
                Disconnect
              </Button>
            )}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void post("/chat/connections", {
            provider,
            name,
            token,
            ...(provider === "cloudflare" && accountId ? { accountId } : {}),
          })
            .then(async () => {
              setToken("");
              setName("");
              await refresh();
              toast("Connection added");
            })
            .catch((e) => toast.error(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="connection-provider">Service</FieldLabel>
            <Choice
              id="connection-provider"
              value={provider}
              onChange={setProvider}
              options={[
                { value: "github", label: "GitHub" },
                { value: "cloudflare", label: "Cloudflare" },
              ]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connection-name">Connection name</FieldLabel>
            <Input
              id="connection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={60}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="connection-token">
              {provider === "github" ? "GitHub token" : "Cloudflare API token"}
            </FieldLabel>
            <Input
              id="connection-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              {provider === "github"
                ? "Use a token with access to your repositories. Reading and editing issues requires Issues read/write. Coding and publishing also need the appropriate repository permissions."
                : "Use an API token with the Cloudflare account permissions needed for your tasks."}
            </p>
          </Field>
          {provider === "cloudflare" && (
            <Field>
              <FieldLabel htmlFor="cf-account">Account ID</FieldLabel>
              <Input
                id="cf-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                pattern="[a-f0-9]{32}"
              />
            </Field>
          )}
          <Button disabled={busy}>
            {busy ? "Checking connection…" : "Connect"}
          </Button>
        </FieldGroup>
      </form>
    </div>
  );
}
