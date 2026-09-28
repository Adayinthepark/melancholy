import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
const headers = { Origin: "http://127.0.0.1:3017" };
// Full Chromium implements Notifications; the minimal headless shell reports denied.
test.use({ channel: "chromium" });
test("installs a service worker, handles visible push and caches only public offline assets", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["notifications"], {
    origin: "http://127.0.0.1:3017",
  });
  const client = await context.newCDPSession(page);
  let registrationId = "";
  client.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    registrationId =
      registrations.find((r) => r.scopeURL === "http://127.0.0.1:3017/")
        ?.registrationId || registrationId;
  });
  await client.send("ServiceWorker.enable");
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => registrationId).not.toBe("");
  const manifest = await (
    await context.request.get("/manifest.webmanifest")
  ).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.id).toBe("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  expect(
    (await context.request.get("/icons/apple-touch-icon.png")).headers()[
      "content-type"
    ],
  ).toContain("image/png");
  const root = "12345678-1234-1234-1234-123456789abc";
  await client.send("ServiceWorker.deliverPushMessage", {
    origin: "http://127.0.0.1:3017",
    registrationId,
    data: JSON.stringify({
      title: "Test workspace",
      body: "You have a new message.",
      tag: "browser-test",
      url: "/thread/" + root,
    }),
  });
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await (await navigator.serviceWorker.ready).getNotifications()).map(
          (n) => ({ title: n.title, body: n.body, url: n.data.url }),
        ),
      ),
    )
    .toContainEqual({
      title: "Test workspace",
      body: "You have a new message.",
      url: "http://127.0.0.1:3017/thread/" + root,
    });
  await client.send("ServiceWorker.deliverPushMessage", {
    origin: "http://127.0.0.1:3017",
    registrationId,
    data: JSON.stringify({ tag: "unsafe-test", url: "https://evil.test" }),
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await (await navigator.serviceWorker.ready).getNotifications()).find(
            (n) => n.tag === "unsafe-test",
          )?.data.url,
      ),
    )
    .toBe("http://127.0.0.1:3017/");
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (await caches.keys()).map(async (key) =>
          (await (await caches.open(key)).keys()).map(
            (r) => new URL(r.url).pathname,
          ),
        ),
      )
    ).flat(),
  );
  expect(cached.sort()).toEqual(["/icons/icon-192.png", "/offline.html"]);
  await context.setOffline(true);
  await page.goto("/?room=general");
  await expect(
    page.getByRole("heading", { name: "You’re offline" }),
  ).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { name: "You’re offline" }),
  ).toHaveCount(0);
});

test("profile enables, tests and disables a device subscription without requesting permission on load", async ({
  page,
  context,
}) => {
  await context.request.post("/api/login", { headers, data: { key } });
  await context.grantPermissions(["notifications"], {
    origin: "http://127.0.0.1:3017",
  });
  await page.addInitScript(() => {
    (window as any).__permissionRequests = 0;
    const permission = Notification.requestPermission.bind(Notification);
    Notification.requestPermission = () => {
      (window as any).__permissionRequests++;
      return permission();
    };
    let subscription: any = null;
    PushManager.prototype.getSubscription = async () => subscription;
    PushManager.prototype.subscribe = async function (options) {
      const pair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const encode = (v: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(v)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=/g, "");
      const json = {
        endpoint: "https://web.push.apple.com/" + crypto.randomUUID(),
        keys: {
          p256dh: encode(await crypto.subtle.exportKey("raw", pair.publicKey)),
          auth: encode(crypto.getRandomValues(new Uint8Array(16)).buffer),
        },
      };
      subscription = {
        options,
        toJSON: () => json,
        unsubscribe: async () => {
          subscription = null;
          return true;
        },
      };
      return subscription;
    };
  });
  await page.route("**/api/push/test", (route) =>
    route.fulfill({ json: { accepted: true } }),
  );
  await page.goto("/settings/workspace");
  await page
    .getByRole("button", { name: "Profile settings", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(
    0,
  );
  await page
    .getByRole("button", { name: "Enable notifications", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Notifications are enabled." }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__permissionRequests)).toBe(
    1,
  );
  await page
    .getByRole("button", { name: "Send test notification", exact: true })
    .click();
  await expect(
    page.getByText("Push service accepted the test.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Disable notifications", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Notifications are off." }),
  ).toBeVisible();
  const response = await (await context.request.get("/api/push/status")).json();
  expect(response.subscriptions).toEqual([]);
});

test("shows iPhone installation instructions before asking for notification permission", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1",
    baseURL: "http://127.0.0.1:3017",
  });
  try {
    await context.request.post("/api/login", { headers, data: { key } });
    const page = await context.newPage();
    await page.goto("/settings/workspace");
    await page
      .getByRole("button", { name: "Profile settings", exact: true })
      .click();
    await expect(
      page.getByText(
        "In Safari, tap Share → Add to Home Screen, then open the installed app.",
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Enable notifications", exact: true }),
    ).toBeDisabled();
    await page.locator(".device-settings").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: "/tmp/melancholy-pwa-phone.png" });
  } finally {
    await context.close();
  }
});
