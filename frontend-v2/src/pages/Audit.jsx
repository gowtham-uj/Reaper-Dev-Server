import { createResource, For, Show } from "solid-js";
import { api } from "../api.js";

export default function Audit() {
  const [entries] = createResource(() => api("/api/audit").then((r) => r.audit || []).catch(() => []));
  return (
    <div class="page">
      <div class="page__eyebrow">Admin</div>
      <h1 class="page__title">Audit log</h1>
      <p class="page__lede">Last 200 events: logins, token creation, project operations, bot blocks.</p>
      <Show when={!entries.loading} fallback={<div class="muted">Loading…</div>}>
        <div class="card" style="padding: 0;">
          <table class="token-table">
            <thead><tr><th style="width: 180px;">When</th><th style="width: 120px;">User</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              <For each={entries()}>{(e) => (
                <tr>
                  <td class="muted mono" style="font-size: var(--t-xs);">{new Date(e.ts).toLocaleString()}</td>
                  <td>{e.user}</td>
                  <td class="mono" style="font-size: var(--t-xs);">{e.action}</td>
                  <td class="muted mono" style="font-size: 10px; word-break: break-all;">{JSON.stringify({ ...e, ts: undefined, user: undefined, action: undefined, ip: undefined })}</td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </div>
      </Show>
    </div>
  );
}
