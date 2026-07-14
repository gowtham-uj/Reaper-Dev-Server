import { createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api.js";
import { TokenManager } from "../components/ProjectSettings.jsx";

export default function Settings() {
  const [env, { refetch: refetchEnv }] = createResource(() => api("/api/global-env").then((r) => r.env || {}).catch(() => ({})));
  const [entries, setEntries] = createSignal([]);
  const [busy, setBusy] = createSignal(false);
  const [saved, setSaved] = createSignal(null);

  let last = null;
  function sync() {
    const e = env();
    if (e && e !== last) { last = e; setEntries(Object.entries(e).map(([k, v]) => ({ k, v }))); }
  }
  sync();

  async function save() {
    setBusy(true);
    try {
      const obj = {};
      for (const { k, v } of entries()) if (k.trim()) obj[k.trim()] = v;
      await api("/api/global-env", { method: "PUT", body: JSON.stringify({ env: obj }) });
      setSaved("Saved");
      refetchEnv();
    } catch (e) { setSaved("Error: " + e.message); }
    finally { setBusy(false); }
  }

  return (
    <div class="page">
      <div class="page__eyebrow">Admin</div>
      <h1 class="page__title">Settings</h1>
      <p class="page__lede">Global environment shared across all projects. API keys, provider URLs, and tokens go here.</p>

      <section class="card" style="margin-bottom: var(--s-4);">
        <div class="card__head">
          <div>
            <div class="card__title">Global environment</div>
            <p class="muted" style="margin: 4px 0 0; font-size: var(--t-sm);">Injected into every project's <code class="mono">tmux set-environment -g</code>.</p>
          </div>
          <div class="row">
            <Show when={saved()}><span class="muted" style="font-size: var(--t-xs);">{saved()}</span></Show>
            <button class="btn btn--ghost btn--sm" onClick={() => setEntries([...entries(), { k: "", v: "" }])}>+ Add</button>
            <button class="btn btn--primary btn--sm" onClick={save} disabled={busy()}>{busy() ? "Saving…" : "Save"}</button>
          </div>
        </div>
        <div class="col" style="gap: 6px;">
          <For each={entries()}>{(e, i) => (
            <div class="row" style="gap: 6px;">
              <input class="input mono" placeholder="KEY" value={e.k} onInput={(ev) => setEntries(entries().map((x, idx) => idx === i() ? { ...x, k: ev.currentTarget.value } : x))} style="max-width: 280px;" />
              <input class="input mono" placeholder="value" value={e.v} onInput={(ev) => setEntries(entries().map((x, idx) => idx === i() ? { ...x, v: ev.currentTarget.value } : x))} />
              <button class="btn btn--ghost btn--sm" onClick={() => setEntries(entries().filter((_, idx) => idx !== i()))} aria-label="Remove">×</button>
            </div>
          )}</For>
          <Show when={!entries().length}><p class="muted" style="font-size: var(--t-sm);">No env vars yet.</p></Show>
        </div>
      </section>

      <TokenManager kind="global" name="admin" />
    </div>
  );
}
