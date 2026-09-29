import { mkdir, lstat, realpath, readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, sep } from "node:path";

export async function outputDirectory(cwd, runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error("Invalid run ID.");
  let dir = cwd;
  for (const segment of [".melancholy", "outputs", runId]) {
    dir = join(dir, segment);
    await mkdir(dir, { mode: 0o700 }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const stat = await lstat(dir);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (await realpath(dir)) !== dir
    )
      throw new Error("Delivery directory must not contain symbolic links.");
  }
  return dir;
}
export async function collectArtifacts(root) {
  const result = [];
  const canonical = await realpath(root);
  if (canonical !== root || (await lstat(root)).isSymbolicLink())
    throw new Error("Delivery directory changed.");
  let entries = 0;
  async function visit(dir, depth) {
    if (depth > 4)
      throw new Error("Delivery directories may be at most four levels deep.");
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (++entries > 100) throw new Error("Too many delivery files.");
      if (entry.name.startsWith(".") || /\.(tmp|part)$/i.test(entry.name))
        continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Symbolic links cannot be delivered.");
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile())
        throw new Error("Only regular files can be delivered.");
      if (
        /^(?:id_rsa|id_ed25519|credentials)(?:\.|$)|\.(?:pem|key)$/i.test(
          entry.name,
        )
      )
        throw new Error("Credential files cannot be delivered.");
      const resolved = await realpath(path);
      if (!resolved.startsWith(canonical + sep))
        throw new Error("Delivery path escaped its directory.");
      const handle = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1)
          throw new Error("Linked files cannot be delivered.");
        if (stat.size > 10 * 1024 * 1024)
          throw new Error("Delivery files must be 10 MB or smaller.");
        if (result.length >= 16)
          throw new Error("At most sixteen deliveries per task.");
        const data = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < data.length) {
          const { bytesRead } = await handle.read(
            data,
            offset,
            data.length - offset,
            offset,
          );
          if (!bytesRead)
            throw new Error("Delivery file changed while reading.");
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
          throw new Error("Delivery file changed while reading.");
        result.push({
          name: relative(root, path).split(sep).join("-").slice(0, 240),
          data,
        });
      } finally {
        await handle.close();
      }
    }
  }
  await visit(root, 0);
  if (new Set(result.map((f) => f.name)).size !== result.length)
    throw new Error("Delivery names must be unique.");
  return result;
}
export function deliveryInstructions(dir) {
  return `\n\nDeliverables: Put the final documents and generated files you want to share with the user in ${dir} (also MELANCHOLY_OUTPUT_DIR). This directory is collected after the turn: .md/.markdown documents become channel Notes, other files become private chat attachments and Files. Use complete UTF-8 Markdown, and write temporary files with .tmp suffix before renaming. Do not copy source trees, credentials, dependencies or intermediate files. Limits: 16 deliveries, at most 8 non-Markdown files, 10 MB per file and 99,000 characters per Markdown document. Only regular files are collected; no symbolic/hard links. Deliverables in direct messages are downloadable files. If the server policy prevents writing, explain that limitation. Refer to deliverables by filename in your final reply; the chat adds document and download cards automatically. Do not link to server filesystem paths. Do not claim a delivery is saved in the workspace until the connector publishes it.`;
}
