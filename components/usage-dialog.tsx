"use client";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { api } from "@/lib/client";
type Row = {
  server_id: string;
  server_name: string;
  room_id: string;
  room_name: string;
  root_id: string;
  thread_id: string;
  model: string | null;
  runtime: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
};
export function UsageDialog({
  open,
  onOpenChange,
  roomId,
  threadId,
  serverId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  roomId?: string;
  threadId?: string;
  serverId?: string;
}) {
  const [totals, setTotals] = useState({
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
  });
  const [limited, setLimited] = useState(false);
  const [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (roomId) params.set("room", roomId);
    if (threadId) params.set("thread", threadId);
    if (serverId) params.set("server", serverId);
    void api<{ rows: Row[]; totals: typeof totals; limited: boolean }>(
      "/chat/usage?" + params,
    )
      .then((r) => {
        if (live) {
          setRows(r.rows);
          setTotals(r.totals);
          setLimited(r.limited);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [open, roomId, threadId, serverId]);
  const count = (key: "input_tokens" | "output_tokens" | "cached_tokens") =>
    totals[key].toLocaleString();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="usage-dialog sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Token usage</DialogTitle>
          <DialogDescription>
            Reported by connected agents. Input includes cached tokens. Earlier
            runs without usage reports are excluded.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert">{error}</p>
        ) : loading ? (
          <p>Loading…</p>
        ) : (
          <>
            <div className="usage-totals">
              <span>
                <strong>{count("input_tokens")}</strong>Input
              </span>
              <span>
                <strong>{count("output_tokens")}</strong>Output
              </span>
              <span>
                <strong>{count("cached_tokens")}</strong>Cached input
              </span>
            </div>
            {limited && (
              <p className="text-xs text-muted-foreground">
                Totals cover all recorded runs. Showing the 500 most recently
                active groups.
              </p>
            )}
            {rows.length ? (
              <div className="usage-table">
                <table>
                  <thead>
                    <tr>
                      <th>Server / model</th>
                      <th>Conversation</th>
                      <th>Runs</th>
                      <th>Input</th>
                      <th>Output</th>
                      <th>Cached</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <td>
                          {r.server_name || "Removed server"}
                          <small>{r.model || r.runtime}</small>
                        </td>
                        <td>
                          {r.room_name || "Earlier conversation"}
                          {r.root_id && r.root_id !== r.room_id && (
                            <a href={"/thread/" + r.root_id}>Open thread</a>
                          )}
                        </td>
                        <td>{r.runs}</td>
                        <td>{r.input_tokens.toLocaleString()}</td>
                        <td>{r.output_tokens.toLocaleString()}</td>
                        <td>{r.cached_tokens.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No usage reported yet.</p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
