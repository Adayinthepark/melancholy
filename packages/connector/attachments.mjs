import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const maxBytes = 10 * 1024 * 1024;
class DownloadError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

export async function downloadAttachments(
  job,
  {
    stateDir,
    base,
    token,
    signal,
    onActivity = () => {},
    fetchImpl = fetch,
    timeoutMs = 60000,
    retryDelays = [500, 1500],
  },
) {
  const dir = join(stateDir, "attachments", job.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const paths = [];
  for (const file of job.attachments || []) {
    signal?.throwIfAborted();
    if (!/^[a-f0-9-]{36}$/.test(file.id))
      throw new Error("Invalid attachment ID.");
    const name =
      file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
    const path = join(dir, `${file.id}-${name}`);
    const activity = (status, detail) =>
      onActivity({
        type: "activity",
        id: `attachment:${file.id}`,
        title: `Download ${file.name}`,
        status,
        detail,
      });
    let attempt = 0;
    try {
      for (; attempt <= retryDelays.length; attempt++) {
        signal?.throwIfAborted();
        await activity(
          "running",
          `Downloading attachment (${attempt + 1}/${retryDelays.length + 1}).`,
        );
        let data;
        const deadline = new AbortController();
        const timer = setTimeout(
          () =>
            deadline.abort(
              new DOMException("Download timed out", "TimeoutError"),
            ),
          timeoutMs,
        );
        const requestSignal = signal
          ? AbortSignal.any([signal, deadline.signal])
          : deadline.signal;
        let response;
        try {
          response = await fetchImpl(new URL(`/api/files/${file.id}`, base), {
            headers: { Authorization: `Bearer ${token}` },
            signal: requestSignal,
            redirect: "error",
          });
          if (!response.ok) {
            const status = response.status;
            throw new DownloadError(
              [401, 403].includes(status)
                ? `Access denied (HTTP ${status}). Check the server identity and channel membership.`
                : status === 404
                  ? "File unavailable (HTTP 404): it may have been deleted or the agent no longer has access."
                  : `Download service returned HTTP ${status}.`,
              status === 408 || status === 429 || status >= 500,
            );
          }
          if (Number(response.headers.get("content-length")) > maxBytes)
            throw new DownloadError("Attachment exceeds 10 MB.");
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            requestSignal.throwIfAborted();
            size += chunk.length;
            if (size > maxBytes)
              throw new DownloadError("Attachment exceeds 10 MB.");
            chunks.push(chunk);
          }
          requestSignal.throwIfAborted();
          if (Number.isSafeInteger(file.size) && size !== file.size)
            throw new DownloadError(
              "Attachment download was incomplete.",
              true,
            );
          data = Buffer.concat(chunks, size);
        } catch (error) {
          signal?.throwIfAborted();
          const retryable =
            error instanceof DownloadError ? error.retryable : true;
          const reason = deadline.signal.aborted
            ? `Download timed out after ${timeoutMs / 1000} seconds.`
            : error instanceof DownloadError
              ? error.message
              : "Network interrupted while downloading.";
          if (!retryable || attempt === retryDelays.length)
            throw new Error(
              `Could not download attachment "${file.name}" after ${attempt + 1} attempt(s). ${reason} The agent did not start. Send a new message to retry.`,
            );
          await activity(
            "running",
            `${reason} Retrying (${attempt + 2}/${retryDelays.length + 1}).`,
          );
        } finally {
          clearTimeout(timer);
          // Release failed responses before another request, including oversized bodies.
          if (response?.body && !response.body.locked)
            await response.body.cancel().catch(() => {});
        }
        if (data) {
          signal?.throwIfAborted();
          await writeFile(path + ".tmp", data, { mode: 0o600 });
          signal?.throwIfAborted();
          await rename(path + ".tmp", path);
          paths.push(path);
          await activity(
            "completed",
            `${data.length} bytes saved for the agent.`,
          );
          break;
        }
        await delay(retryDelays[attempt], undefined, { signal });
      }
    } catch (error) {
      await activity(
        "failed",
        signal?.aborted ? "Download stopped." : error.message,
      );
      throw error;
    } finally {
      await rm(path + ".tmp", { force: true });
    }
  }
  return paths;
}
