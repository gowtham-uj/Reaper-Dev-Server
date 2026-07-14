import { createSignal, onCleanup, onMount, For, Show } from "solid-js";
import { api } from "../api.js";

export function ProjectLogs(props) {
  const [lines, setLines] = createSignal([]);
  const [follow, setFollow] = createSignal(true);
  const [filter, setFilter] = createSignal("");
  let hostRef;
  let evtSrc;

  function append(text) {
    setLines((cur) => {
      const next = cur.concat(text.split("\n").filter(Boolean));
      return next.length > 2000 ? next.slice(next.length - 2000) : next;
    });
    if (follow() && hostRef) hostRef.scrollTop = hostRef.scrollHeight;
  }

  onMount(() => {
    // Initial fetch
    api("/api/projects/" + encodeURIComponent(props.name) + "/logs?lines=200").then((r) => {
      if (r && r.lines) setLines(r.lines);
    }).catch(() => {});
    // SSE tail
    try {
      evtSrc = new EventSource("/api/projects/" + encodeURIComponent(props.name) + "/logs/stream");
      evtSrc.onmessage = (e) => append(e.data);
      evtSrc.onerror = () => { /* keep trying */ };
    } catch {}
  });

  onCleanup(() => { try { evtSrc?.close(); } catch {} });

  const filtered = () => {
    const f = filter().toLowerCase();
    if (!f) return lines();
    return lines().filter((l) => l.toLowerCase().includes(f));
  };

  return (
    <div style="padding: var(--s-4) var(--s-6); display: flex; flex-direction: column; height: calc(100vh - 200px);">
      <div class="row" style="margin-bottom: var(--s-2);">
        <input class="input" placeholder="Filter…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} style="max-width: 300px;" />
        <div class="spacer" />
        <label class="row muted" style="gap: 4px; font-size: var(--t-sm);">
          <input type="checkbox" checked={follow()} onChange={(e) => setFollow(e.currentTarget.checked)} />
          Follow
        </label>
        <button class="btn btn--ghost btn--sm" onClick={() => setLines([])}>Clear view</button>
      </div>
      <div ref={hostRef} class="mono" style="flex: 1; min-height: 0; overflow: auto; background: var(--surface-1); border: 1px solid var(--border-1); border-radius: var(--r-md); padding: var(--s-3); font-size: var(--t-xs); line-height: 1.5; white-space: pre-wrap; word-break: break-word;">
        <Show when={filtered().length} fallback={<span class="muted">No log output yet. Project sessions will write to .reaper/logs/.</span>}>
          <For each={filtered()}>{(l) => <div>{l}</div>}</For>
        </Show>
      </div>
    </div>
  );
}
