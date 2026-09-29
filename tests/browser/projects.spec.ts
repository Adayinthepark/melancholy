import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const origin = "http://127.0.0.1:3017",
  headers = { Origin: origin };
const key = readFileSync(".dev.vars", "utf8")
  .match(/^WORKSPACE_KEY=(.+)$/m)![1]
  .trim();
test("Casual settings and channel Notes, Files, Issues and Timer on desktop and mobile", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.request.post("/api/login", { headers, data: { key } });
  const server = await (
    await context.request.post("/api/servers", {
      headers,
      data: { name: "Project test " + Date.now(), runtime: "codex" },
    })
  ).json();
  const name = "project-ui-" + Date.now();
  await page.goto("/settings/workspace/casual");
  await page.getByLabel("Enable Casual chat for workspace members").check();
  await page.getByLabel("Reasoning agent").click();
  await page
    .getByRole("option", { name: server.name + " · Server", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save Casual chat", exact: true })
    .click();
  await expect(page.getByText("Casual chat settings saved.")).toBeVisible();
  await page.getByRole("link", { name: "Back to workspace" }).click();
  await page.getByRole("button", { name: "Casual chat", exact: true }).click();
  await expect(page.getByPlaceholder("Message Casual chat")).toBeVisible();
  await page.getByRole("button", { name: "Create channel from idea" }).click();
  await page.getByLabel("Channel name", { exact: true }).fill(name);
  await page.getByLabel("Topic", { exact: true }).fill("Project workspace");
  await page
    .getByLabel("Project brief · saved to Notes")
    .fill("## Goal\nA project that keeps its decisions.");
  await page
    .getByText("GitHub repository & Cloudflare Workers", { exact: true })
    .click();
  await expect(
    page.getByLabel("GitHub repository", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create channel", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const roomId = new URL(page.url()).searchParams.get("room")!;
  await context.request.post("/api/chat/rooms/" + roomId + "/members", {
    headers,
    data: { personId: server.id },
  });
  const sections = page.getByRole("navigation", { name: "Channel sections" });
  await sections.getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: /Project brief/ }).click();
  await expect(
    page.getByRole("heading", { name: "Goal", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New note", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Architecture decision");
  await page
    .getByLabel("Content · Markdown")
    .fill("## Decision\nUse a private R2 bucket.");
  await sections.getByRole("button", { name: "Chat", exact: true }).click();
  await sections.getByRole("button", { name: "Notes", exact: true }).click();
  await expect(page.getByLabel("Content · Markdown")).toHaveValue(
    "## Decision\nUse a private R2 bucket.",
  );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Decision", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save note", exact: true }).click();
  await expect(page.getByText("Note saved.", { exact: true })).toBeVisible();
  await sections.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("Upload channel file").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Project report"),
  });
  await expect(
    page.getByRole("link", { name: "report.txt", exact: true }),
  ).toBeVisible();
  await sections.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(
    page.getByText("Repositories & connections", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Repositories & connections", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Workers", exact: true }),
  ).toBeVisible();
  await page.reload();
  await sections.getByRole("button", { name: "Timer", exact: true }).click();
  await page.getByRole("button", { name: "New timer", exact: true }).click();
  await page.getByLabel("Task name", { exact: true }).fill("Review tomorrow");
  await page
    .getByLabel("Instructions", { exact: true })
    .fill("Read the project notes and summarize next steps.");
  await page.getByLabel("Agent", { exact: true }).click();
  await page.getByRole("option", { name: server.name, exact: true }).click();
  await page.getByRole("button", { name: "Create timer", exact: true }).click();
  await expect(
    page.getByText("Review tomorrow", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.getByText("Paused", { exact: true })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await page.evaluate(
        (d) => document.documentElement.classList.toggle("dark", d),
        dark,
      );
      for (const section of ["Notes", "Files", "Timer"]) {
        await sections
          .getByRole("button", { name: section, exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: section, exact: true }),
        ).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        if (section === "Notes")
          await expect(
            page.getByRole("button", { name: /Architecture decision/ }),
          ).toBeVisible();
        if (section === "Files")
          await expect(
            page.getByRole("link", { name: "report.txt", exact: true }),
          ).toBeVisible();
        if (section === "Timer")
          await expect(
            page.getByText("Review tomorrow", { exact: true }),
          ).toBeVisible();
        await page.screenshot({
          path:
            "/tmp/melancholy-project-" +
            section +
            "-" +
            width +
            "-" +
            dark +
            ".png",
        });
      }
    }
  }
  expect(errors).toEqual([]);
  await context.request.put("/api/chat/casual/settings", {
    headers,
    data: { enabled: false, botId: null },
  });
  await context.request.delete("/api/servers/" + server.id, { headers });
});
