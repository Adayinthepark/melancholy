"use client";
import { useEffect, useState } from "react";
import { Bell, Download } from "lucide-react";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Separator } from "./ui/separator";
import { usePwa } from "./pwa-provider";
import { api, post } from "@/lib/client";
import { toast } from "sonner";
type Status = {
  configured: boolean;
  publicKey: string | null;
  subscriptions: { id: string }[];
};
function publicKey(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
async function registration() {
  await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "The app could not prepare notifications. Reload and try again.",
            ),
          ),
        10000,
      ),
    ),
  ]);
}
export function DeviceSettings() {
  const { install, standalone } = usePwa();
  const [status, setStatus] = useState<Status | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [supported, setSupported] = useState(false),
    [ios, setIos] = useState(false),
    [permission, setPermission] = useState<NotificationPermission>("default");
  async function refresh() {
    const next = await api<Status>("/push/status");
    setStatus(next);
    if ("Notification" in window) setPermission(Notification.permission);
    const worker =
      "serviceWorker" in navigator
        ? await navigator.serviceWorker.getRegistration("/")
        : null;
    const subscription = await worker?.pushManager?.getSubscription();
    setEnabled(!!subscription && next.subscriptions.length > 0);
  }
  useEffect(() => {
    setSupported(
      "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window,
    );
    setIos(
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
    );
    void refresh().catch((e) => setError(e.message));
  }, []);
  async function change(enable: boolean) {
    setBusy(true);
    setError("");
    try {
      // iOS requires the permission prompt directly from the user gesture, before any network await.
      if (enable) {
        const granted = await Notification.requestPermission();
        setPermission(granted);
        if (granted !== "granted") return;
        const worker = await registration();
        let subscription = await worker.pushManager.getSubscription();
        // A new VAPID key requires a fresh browser subscription.
        const key = publicKey(status!.publicKey!);
        if (
          subscription?.options.applicationServerKey &&
          String(new Uint8Array(subscription.options.applicationServerKey)) !==
            String(key)
        ) {
          await subscription.unsubscribe();
          subscription = null;
        }
        if (!subscription)
          subscription = await worker.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          });
        try {
          await post("/push/subscriptions", subscription.toJSON());
        } catch (e) {
          await subscription.unsubscribe();
          throw e;
        }
      } else {
        await api("/push/subscriptions", { method: "DELETE" });
        const worker = await navigator.serviceWorker.getRegistration("/");
        await (await worker?.pushManager.getSubscription())?.unsubscribe();
        for (const notification of (await worker?.getNotifications()) || [])
          notification.close();
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="device-settings">
      <Separator />
      <FieldGroup>
        <Field>
          <FieldLabel>Install app</FieldLabel>
          <FieldDescription>
            {standalone
              ? "Installed on this device."
              : ios
                ? "In Safari, tap Share → Add to Home Screen, then open the installed app."
                : "Install from your browser’s address bar or menu to open the workspace as an app."}
          </FieldDescription>
          {install && !standalone && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void install.prompt()}
            >
              <Download data-icon="inline-start" />
              Install app
            </Button>
          )}
        </Field>
        <Field>
          <FieldLabel>Notifications on this device</FieldLabel>
          <FieldDescription>
            Direct messages, mentions, replies to threads you participate in,
            and agent task results. Message content stays private.
          </FieldDescription>
          <p className="device-status" role="status">
            {error ||
              (!status
                ? "Checking notification settings…"
                : !status.configured
                  ? "Push notifications have not been configured by the workspace owner."
                  : ios && !standalone
                    ? "Requires iOS / iPadOS 16.4 or later and installation on the Home Screen."
                    : !supported
                      ? "This browser does not support Web Push."
                      : permission === "denied"
                        ? "Notifications are blocked. Allow them in your browser or device settings, then reopen this page."
                        : enabled
                          ? "Notifications are enabled."
                          : "Notifications are off.")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={
                busy ||
                !status?.configured ||
                !supported ||
                (ios && !standalone) ||
                (permission === "denied" && !enabled)
              }
              onClick={() => void change(!enabled)}
            >
              <Bell data-icon="inline-start" />
              {busy
                ? "Updating…"
                : enabled
                  ? "Disable notifications"
                  : "Enable notifications"}
            </Button>
            {enabled && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void post("/push/test")
                    .then(() =>
                      toast(
                        "Push service accepted the test. Check this device’s notifications.",
                      ),
                    )
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Send test notification
              </Button>
            )}
          </div>
          <FieldDescription>
            Signing out stops notifications for this browser session.{" "}
            <a
              href="https://github.com/adayinthepark/melancholy/blob/main/docs/pwa.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              Setup and troubleshooting
            </a>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </div>
  );
}
