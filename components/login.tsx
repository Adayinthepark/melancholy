"use client";
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { post } from "@/lib/client";
export function Login({ onLogin }: { onLogin: () => void }) {
  const [mode, setMode] = useState<"member" | "owner" | "join">("member"),
    [key, setKey] = useState(""),
    [handle, setHandle] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [invite, setInvite] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const consumed = useRef(false);
  async function submit(path: string, data: unknown) {
    setBusy(true);
    setError("");
    try {
      await post(path, data);
      onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    const params = new URLSearchParams(location.hash.slice(1)),
      ticket = params.get("ticket"),
      invitation = params.get("invite"),
      value = params.get("key");
    if (ticket || invitation || value)
      history.replaceState(null, "", location.pathname + location.search);
    if (invitation) {
      setInvite(invitation);
      setMode("join");
    } else if (ticket) void submit("/redeem", { ticket });
    else if (value) void submit("/login", { key: value });
  }, []);
  return (
    <main className="login-page">
      <a className="login-wordmark" href="/">
        melancholy
      </a>
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(
            mode === "join" ? "/join" : "/login",
            mode === "owner"
              ? { key }
              : mode === "join"
                ? { ticket: invite, name, handle, password }
                : { handle, password },
          );
        }}
      >
        <div className="login-title">
          <h1>{mode === "join" ? "Join workspace" : "Sign in"}</h1>
          <p>{typeof window !== "undefined" ? location.host : "melancholy"}</p>
        </div>
        <FieldGroup>
          {mode === "owner" ? (
            <Field>
              <FieldLabel htmlFor="workspace-key">Workspace key</FieldLabel>
              <Input
                id="workspace-key"
                type="password"
                autoComplete="current-password"
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
          ) : (
            <>
              {mode === "join" && (
                <Field>
                  <FieldLabel htmlFor="join-name">Display name</FieldLabel>
                  <Input
                    id="join-name"
                    required
                    maxLength={60}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor="login-handle">Username</FieldLabel>
                <Input
                  id="login-handle"
                  autoComplete="username"
                  required
                  pattern="[a-z][a-z0-9_-]{1,39}"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.toLowerCase())}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete={
                    mode === "join" ? "new-password" : "current-password"
                  }
                  required
                  minLength={mode === "join" ? 12 : 1}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === "join" && (
                  <p className="text-muted-foreground text-xs">
                    At least 12 characters.
                  </p>
                )}
              </Field>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" />
            ) : mode === "join" ? (
              "Join workspace"
            ) : (
              "Continue"
            )}
          </Button>
          {mode !== "join" && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMode(mode === "owner" ? "member" : "owner");
                setError("");
              }}
            >
              {mode === "owner"
                ? "Use username and password"
                : "Use workspace key"}
            </Button>
          )}
        </FieldGroup>
      </form>
      <a
        className="login-source"
        href="https://github.com/adayinthepark/melancholy"
        target="_blank"
        rel="noopener noreferrer"
      >
        Source code
      </a>
    </main>
  );
}
