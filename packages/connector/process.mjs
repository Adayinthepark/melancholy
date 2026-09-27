export function killTree(child, graceMs = 5000) {
  if (!child.pid) return;
  const signal = (name) => {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // The process group already exited.
    }
  };
  signal("SIGTERM");
  const force = setTimeout(() => signal("SIGKILL"), graceMs);
  force.unref();
  child.once("close", () => clearTimeout(force));
}
