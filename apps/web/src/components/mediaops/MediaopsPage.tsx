import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";

type Task = {
  id: string; memo_id: string; title: string; state: string; version: number;
  holder_user_id: string | null; holder_epoch: number; revision: number;
  content_hash: string; content_markdown: string;
};

const request = async <T,>(path: string, value?: object): Promise<T> => {
  const response = await fetch(`/api/v1/mediaops${path}`, {
    method: value ? "POST" : "GET", credentials: "same-origin",
    headers: value ? { "content-type": "application/json" } : undefined,
    body: value ? JSON.stringify(value) : undefined,
  });
  const data = await response.json() as { result?: T; error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message || `Request failed: ${response.status}`);
  return data.result as T;
};

/** M0 browser-only task surface. The server remains the permission boundary. */
export const MediaopsPage = ({ userId, manager }: { userId: string; manager: boolean }) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [current, setCurrent] = useState<Task | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [nextHolder, setNextHolder] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => setTasks(await request<Task[]>("/tasks"));
  const select = async (id: string) => {
    const row = await request<Task>(`/tasks/${encodeURIComponent(id)}`);
    setCurrent(row); setDraft(row.content_markdown); setError("");
  };
  useEffect(() => { void refresh().catch((cause) => setError(String(cause))); }, []);
  const act = async (operation: () => Promise<Task | void>) => {
    setBusy(true); setError("");
    try {
      const updated = await operation();
      if (updated?.id) await select(updated.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const editable = current && ["draft", "in_progress", "changes_requested"].includes(current.state);
  const holder = current?.holder_user_id === userId;
  return <main className="mx-auto max-w-5xl p-6 text-slate-900">
    <header className="mb-6 flex items-center justify-between">
      <h1 className="text-2xl font-semibold">XD MediaOps</h1>
      <Link to="/" className="text-sm underline">Back to workspace</Link>
    </header>
    {error && <p role="alert" className="mb-4 rounded bg-red-50 p-3 text-red-800">{error}</p>}
    {manager && <form className="mb-4 flex gap-2" onSubmit={(event) => {
      event.preventDefault();
      void act(async () => { const row = await request<Task>("/tasks", { title }); setTitle(""); return row; });
    }}>
      <input aria-label="New task title" className="flex-1 rounded border px-3" value={title} onChange={(event) => setTitle(event.target.value)} />
      <Button disabled={busy || !title.trim()}>Create task</Button>
    </form>}
    <div className="grid gap-5 md:grid-cols-[15rem_1fr]">
      <nav aria-label="MediaOps tasks" className="space-y-2">
        {tasks.map((task) => <button key={task.id} type="button" className="block w-full rounded border p-3 text-left"
          onClick={() => void select(task.id).catch((cause) => setError(String(cause)))}>
          <span className="block font-medium">{task.title}</span><span className="text-xs">{task.state}</span>
        </button>)}
      </nav>
      {current && <section className="space-y-3 rounded border p-4">
        <h2 className="text-xl font-medium">{current.title}</h2>
        <p className="text-sm">Status: {current.state} · Revision: {current.revision} · Holder: {current.holder_user_id ?? "none"}</p>
        {manager && <div className="flex flex-wrap gap-2">
          <input aria-label="Assignee user ID" className="rounded border px-3" value={assignee} onChange={(event) => setAssignee(event.target.value)} />
          <Button variant="outline" disabled={busy || !assignee.trim()} onClick={() => void act(async () => {
            await request(`/tasks/${current.id}/assignments`, { userId: assignee, role: "editor" });
            setAssignee("");
          })}>Assign editor</Button>
          <Button variant="outline" disabled={busy || !assignee.trim()} onClick={() => void act(async () => {
            await request(`/tasks/${current.id}/assignments`, { userId: assignee, role: "reviewer" });
            setAssignee("");
          })}>Assign reviewer</Button>
        </div>}
        {editable && (holder || manager) && <div className="flex gap-2">
          <input aria-label="Next editor user ID" className="rounded border px-3" value={nextHolder} onChange={(event) => setNextHolder(event.target.value)} />
          <Button variant="outline" disabled={busy || !nextHolder.trim()} onClick={() => void act(() => request<Task>(`/tasks/${current.id}/transfer`, {
            userId: nextHolder, expectedVersion: current.version,
          }))}>Hand off</Button>
        </div>}
        <textarea aria-label="Article Markdown" className="min-h-80 w-full rounded border p-3 font-mono text-sm"
          value={draft} onChange={(event) => setDraft(event.target.value)} readOnly={!editable || !holder || busy} />
        <div className="flex flex-wrap gap-2">
          {editable && !holder && <Button disabled={busy} onClick={() => void act(() => request<Task>(`/tasks/${current.id}/transfer`, {
            userId, expectedVersion: current.version,
          }))}>Take editing turn</Button>}
          {editable && holder && <Button disabled={busy} onClick={() => void act(() => request<Task>(`/tasks/${current.id}/save`, {
            expectedRevision: current.revision, expectedHash: current.content_hash,
            holderEpoch: current.holder_epoch, markdown: draft,
          }))}>Save</Button>}
          {editable && holder && <Button variant="outline" disabled={busy || draft !== current.content_markdown}
            onClick={() => void act(() => request<Task>(`/tasks/${current.id}/submit`, {
              expectedVersion: current.version, revision: current.revision,
              hash: current.content_hash, holderEpoch: current.holder_epoch,
            }))}>Submit for review</Button>}
          {current.state === "submitted" && <Button variant="outline" disabled={busy}
            onClick={() => void act(() => request<Task>(`/tasks/${current.id}/review`, { decision: "reviewed", expectedVersion: current.version }))}>Reviewed</Button>}
          {current.state === "submitted" && <Button variant="outline" disabled={busy}
            onClick={() => void act(() => request<Task>(`/tasks/${current.id}/review`, { decision: "changes_requested", expectedVersion: current.version }))}>Request changes</Button>}
          {manager && current.state === "reviewed" && <Button disabled={busy}
            onClick={() => void act(() => request<Task>(`/tasks/${current.id}/approve`, { expectedVersion: current.version }))}>Final approval</Button>}
        </div>
        <p className="text-xs text-slate-600">Save and wait for the server revision before submitting. A conflict keeps this local text visible for copying.</p>
      </section>}
    </div>
  </main>;
};
