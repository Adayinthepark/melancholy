"use client";
import { useState, useEffect } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Mark } from "./brand";
import { post } from "@/lib/client";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(value: string) {
    setBusy(true);
    setError("");
    try {
      await post("/login", { key: value });
      onLogin();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = fragment.get("key");
    const ticket = fragment.get("ticket");
    if (value || ticket) {
      history.replaceState(null, "", window.location.pathname);
      if (value) void login(value);
      else {
        setBusy(true);
        void post("/redeem", { ticket })
          .then(onLogin)
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }
    }
  }, []);
  return (
    <main className="login-page">
      <a className="login-wordmark" href="/">
        <Mark />
        melancholy
      </a>
      <form
        className="login-form"
        onSubmit={(e) => {
          e.preventDefault();
          void login(key);
        }}
      >
        <div className="login-title">
          <h1>Open your workspace</h1>
          <p>
            {typeof window !== "undefined"
              ? window.location.host
              : "melancholy"}
          </p>
        </div>
        <FieldGroup>
          <Field data-invalid={!!error}>
            <FieldLabel htmlFor="workspace-key">Workspace key</FieldLabel>
            <Input
              id="workspace-key"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-invalid={!!error}
            />
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </Field>
          <Button type="submit" disabled={busy || !key}>
            {busy ? (
              <Loader2 className="spin" data-icon="inline-start" />
            ) : (
              "Continue"
            )}
            {!busy && <ArrowRight data-icon="inline-end" />}
          </Button>
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
