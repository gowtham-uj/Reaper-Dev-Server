import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { api } from "../api.js";

export function ProjectSettings(props) {
  return (
    <div style="padding: var(--s-6); max-width: 900px;">
      <EnvEditor name={props.name} />
      <BashrcEditor name={props.name} />
      <TokenManager kind="project" name={props.name} />
    </div>
  );
}

function EnvEditor(props) {
  const [env, { refetch }] = createResource(() => props.name, async (projectName) => {
    const response = await api("/api/projects/" + encodeURIComponent(projectName) + "/env");
    if (!response.env || typeof response.env !== "object" || Array.isArray(response.env)) {
      throw new Error("The project environment response was invalid.");
    }
    return response.env;
  });
  const [entries, setEntries] = createSignal([]);
  const [loadedFor, setLoadedFor] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal(null);
  const [saveError, setSaveError] = createSignal(null);

  createEffect(() => {
    if (env.loading || env.error) return;
    const next = env();
    if (!next) return;
    setEntries(Object.entries(next).map(([key, value]) => ({ key, value: String(value) })));
    setLoadedFor(props.name);
  });

  const canEdit = () => loadedFor() === props.name && !env.loading && !env.error;

  function add() {
    setEntries([...entries(), { key: "", value: "" }]);
    setNotice(null);
  }
  function del(index) {
    setEntries(entries().filter((_, entryIndex) => entryIndex !== index));
    setNotice(null);
  }
  function set(index, field, value) {
    setEntries(entries().map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry));
    setNotice(null);
  }

  async function save(event) {
    event.preventDefault();
    if (!canEdit()) {
      setSaveError("Load the current project environment before saving changes.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    setNotice(null);
    try {
      const next = {};
      for (const entry of entries()) {
        const key = entry.key.trim();
        if (key) next[key] = entry.value;
      }
      await api("/api/projects/" + encodeURIComponent(props.name) + "/env", {
        method: "PUT",
        body: JSON.stringify({ env: next })
      });
      setNotice("Project environment saved at " + new Date().toLocaleTimeString() + ".");
      refetch();
    } catch (error) {
      setSaveError(error.message || "The project environment could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card" style="margin-bottom: var(--s-4);" aria-labelledby="project-env-heading" aria-busy={env.loading}>
      <form onSubmit={save}>
        <div class="card__head">
          <div>
            <h2 id="project-env-heading" class="card__title" style="margin: 0;">Environment</h2>
            <p class="muted" style="margin: 4px 0 0; font-size: var(--t-sm);">
              Saved for this project's terminal sessions. New windows inherit changes automatically.
            </p>
          </div>
          <div class="row">
            <button class="btn btn--ghost btn--sm" type="button" onClick={add} disabled={!canEdit() || busy()}>
              Add variable
            </button>
            <button class="btn btn--primary btn--sm" type="submit" disabled={!canEdit() || busy()}>
              {busy() ? "Saving…" : "Save environment"}
            </button>
          </div>
        </div>

        <Show when={notice()}>
          <p class="muted" role="status" aria-live="polite">{notice()}</p>
        </Show>
        <Show when={saveError()}>
          <p role="alert" style="color: var(--danger);">{saveError()}</p>
        </Show>
        <Show when={env.loading}>
          <p class="muted" role="status">Loading project environment…</p>
        </Show>
        <Show when={env.error}>
          <div role="alert">
            <p style="color: var(--danger);">Project environment could not be loaded: {env.error?.message || "Request failed."}</p>
            <button class="btn btn--outline btn--sm" type="button" onClick={() => refetch()}>Retry</button>
          </div>
        </Show>
        <Show when={canEdit()}>
          <div class="col" style="gap: 6px;">
            <For each={entries()}>{(entry, index) => (
              <div class="env-row row" style="gap: 6px; align-items: flex-end;">
                <div class="env-field field">
                  <label class="field__label" for={`project-env-key-${index()}`}>Variable name</label>
                  <input
                    id={`project-env-key-${index()}`}
                    name="project-env-key"
                    class="input mono"
                    value={entry.key}
                    onInput={(event) => set(index(), "key", event.currentTarget.value)}
                    autocomplete="off"
                  />
                </div>
                <div class="env-field field">
                  <label class="field__label" for={`project-env-value-${index()}`}>Value</label>
                  <input
                    id={`project-env-value-${index()}`}
                    name="project-env-value"
                    class="input mono"
                    value={entry.value}
                    onInput={(event) => set(index(), "value", event.currentTarget.value)}
                    autocomplete="off"
                  />
                </div>
                <button
                  class="btn btn--ghost btn--sm"
                  type="button"
                  onClick={() => del(index())}
                  aria-label={`Remove environment variable ${entry.key || index() + 1}`}
                >
                  Remove
                </button>
              </div>
            )}</For>
            <Show when={entries().length === 0}>
              <p class="muted" style="font-size: var(--t-sm);">No environment variables are configured.</p>
            </Show>
          </div>
        </Show>
      </form>
    </section>
  );
}

function BashrcEditor(props) {
  const [bashrc, { refetch }] = createResource(() => props.name, async (projectName) => {
    const response = await api("/api/projects/" + encodeURIComponent(projectName) + "/bashrc");
    if (typeof response.content !== "string") throw new Error("The Bashrc response was invalid.");
    return response.content;
  });
  const [content, setContent] = createSignal("");
  const [orig, setOrig] = createSignal("");
  const [loadedFor, setLoadedFor] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal(null);
  const [saveError, setSaveError] = createSignal(null);

  createEffect(() => {
    if (bashrc.loading || bashrc.error) return;
    const next = bashrc();
    if (typeof next !== "string") return;
    setContent(next);
    setOrig(next);
    setLoadedFor(props.name);
  });

  const canEdit = () => loadedFor() === props.name && !bashrc.loading && !bashrc.error;

  async function save(event) {
    event.preventDefault();
    if (!canEdit()) {
      setSaveError("Load the current Bashrc before saving changes.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    setNotice(null);
    try {
      await api("/api/projects/" + encodeURIComponent(props.name) + "/bashrc", {
        method: "PUT",
        body: JSON.stringify({ content: content() })
      });
      setOrig(content());
      setNotice("Bashrc saved.");
    } catch (error) {
      setSaveError(error.message || "The Bashrc could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="card" style="margin-bottom: var(--s-4);" aria-labelledby="project-bashrc-heading" aria-busy={bashrc.loading}>
      <form onSubmit={save}>
        <div class="card__head">
          <div>
            <h2 id="project-bashrc-heading" class="card__title" style="margin: 0;">Bashrc</h2>
            <p class="muted" style="margin: 4px 0 0; font-size: var(--t-sm);">
              Sourced at the start of every new project shell. Run <code class="mono">source ~/.bashrc</code> in an existing shell to apply changes there.
            </p>
          </div>
          <button
            class="btn btn--primary btn--sm"
            type="submit"
            disabled={!canEdit() || busy() || content() === orig()}
          >
            {busy() ? "Saving…" : "Save Bashrc"}
          </button>
        </div>

        <Show when={notice()}>
          <p class="muted" role="status" aria-live="polite">{notice()}</p>
        </Show>
        <Show when={saveError()}>
          <p role="alert" style="color: var(--danger);">{saveError()}</p>
        </Show>
        <Show when={bashrc.loading}>
          <p class="muted" role="status">Loading Bashrc…</p>
        </Show>
        <Show when={bashrc.error}>
          <div role="alert">
            <p style="color: var(--danger);">Bashrc could not be loaded: {bashrc.error?.message || "Request failed."}</p>
            <button class="btn btn--outline btn--sm" type="button" onClick={() => refetch()}>Retry</button>
          </div>
        </Show>
        <Show when={canEdit()}>
          <div class="field">
            <label class="field__label" for="project-bashrc">Project Bashrc</label>
            <textarea
              id="project-bashrc"
              name="project-bashrc"
              class="textarea mono"
              style="min-height: 180px;"
              value={content()}
              onInput={(event) => {
                setContent(event.currentTarget.value);
                setNotice(null);
              }}
              spellcheck={false}
            ></textarea>
          </div>
        </Show>
      </form>
    </section>
  );
}

export function TokenManager(props) {
  const tokenPath = (suffix = "") => {
    const base = props.kind === "project"
      ? "/api/projects/" + encodeURIComponent(props.name) + "/tokens"
      : "/api/api-tokens";
    return base + suffix;
  };
  const [tokens, { refetch }] = createResource(
    () => ({ kind: props.kind, name: props.name }),
    async () => {
      const response = await api(tokenPath());
      if (!Array.isArray(response.tokens)) throw new Error("The API token list response was invalid.");
      return response.tokens;
    }
  );
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [scopes, setScopes] = createSignal(["read"]);
  const [ttl, setTtl] = createSignal(365);
  const [newToken, setNewToken] = createSignal(null);
  const [error, setError] = createSignal(null);
  const [notice, setNotice] = createSignal(null);
  const [pending, setPending] = createSignal(null);
  let newTokenButton;
  let tokenNameInput;

  function openCreate() {
    setCreating(true);
    setError(null);
    queueMicrotask(() => tokenNameInput?.focus());
  }

  function closeCreate() {
    setCreating(false);
    setError(null);
    queueMicrotask(() => newTokenButton?.focus());
  }

  async function create(event) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setPending("create");
    try {
      const response = await api(tokenPath(), {
        method: "POST",
        body: JSON.stringify({ name: name() || "token", scopes: scopes(), ttlDays: Number(ttl()) })
      });
      if (typeof response.token !== "string") throw new Error("The created token value was not returned.");
      setNewToken(response);
      setName("");
      setCreating(false);
      setNotice("API token created.");
      refetch();
    } catch (createError) {
      setError(createError.message || "The API token could not be created.");
    } finally {
      setPending(null);
    }
  }

  async function revoke(token) {
    if (!confirm(`Revoke token '${token.name}'? Scripts using it will stop working.`)) return;
    setError(null);
    setNotice(null);
    setPending("revoke:" + token.id);
    try {
      await api(tokenPath("/" + token.id), { method: "DELETE" });
      setNotice(`Token ${token.name} was revoked.`);
      refetch();
      queueMicrotask(() => newTokenButton?.focus());
    } catch (revokeError) {
      setError(revokeError.message || `Token ${token.name} could not be revoked.`);
    } finally {
      setPending(null);
    }
  }

  async function rotate(token) {
    setError(null);
    setNotice(null);
    setPending("rotate:" + token.id);
    try {
      const response = await api(tokenPath("/" + token.id + "/rotate"), {
        method: "POST",
        body: JSON.stringify({ ttlDays: Number(ttl()) })
      });
      if (typeof response.token !== "string") throw new Error("The rotated token value was not returned.");
      setNewToken(response);
      setNotice(`Token ${token.name} was rotated.`);
    } catch (rotateError) {
      setError(rotateError.message || `Token ${token.name} could not be rotated.`);
    } finally {
      setPending(null);
    }
  }

  async function copyToken(value) {
    setError(null);
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(value);
      setNotice("Token copied to the clipboard.");
    } catch (copyError) {
      setError(copyError.message || "The token could not be copied.");
    }
  }

  function toggleScope(scope, checked) {
    const next = new Set(scopes());
    if (checked) next.add(scope);
    else next.delete(scope);
    setScopes(Array.from(next));
  }

  return (
    <section
      class="card"
      style="margin-bottom: var(--s-4);"
      aria-labelledby={`token-heading-${props.kind}`}
      aria-busy={tokens.loading}
    >
      <div class="card__head">
        <div>
          <h2 id={`token-heading-${props.kind}`} class="card__title" style="margin: 0;">API tokens</h2>
          <p class="muted" style="margin: 4px 0 0; font-size: var(--t-sm);">
            {props.kind === "project" && "Scoped to this project only. Scripts using this token can read, write, and execute only within it."}
            {props.kind === "global" && "Full admin access. Use for personal automation only."}
          </p>
        </div>
        <button ref={newTokenButton} class="btn btn--primary btn--sm" type="button" onClick={openCreate} aria-expanded={creating()}>
          New token
        </button>
      </div>

      <Show when={creating()}>
        <form onSubmit={create} class="card" style="background: var(--surface-2); margin-bottom: var(--s-3); padding: var(--s-4);">
          <div class="grid grid--2">
            <div class="field">
              <label class="field__label" for={`token-name-${props.kind}`}>Token name</label>
              <input
                ref={tokenNameInput}
                id={`token-name-${props.kind}`}
                name="token-name"
                class="input"
                placeholder="ci-deploy"
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <div class="field">
              <label class="field__label" for={`token-ttl-${props.kind}`}>Lifetime (days)</label>
              <input
                id={`token-ttl-${props.kind}`}
                name="token-ttl-days"
                class="input"
                type="number"
                min="1"
                max="3650"
                required
                value={ttl()}
                onInput={(event) => setTtl(event.currentTarget.value)}
              />
            </div>
          </div>
          <fieldset class="field" style="border: 0; padding: 0; margin: 0;">
            <legend class="field__label">Scopes</legend>
            <div class="row" style="gap: var(--s-3); flex-wrap: wrap;">
              <For each={["read", "write", "exec", "prompt"]}>{(scope) => (
                <label class="row" for={`token-scope-${props.kind}-${scope}`} style="gap: 4px; font-size: var(--t-sm); cursor: pointer;">
                  <input
                    id={`token-scope-${props.kind}-${scope}`}
                    name="token-scopes"
                    type="checkbox"
                    value={scope}
                    checked={scopes().includes(scope)}
                    onChange={(event) => toggleScope(scope, event.currentTarget.checked)}
                  />
                  {scope}
                </label>
              )}</For>
            </div>
          </fieldset>
          <div class="row">
            <button class="btn btn--primary" type="submit" disabled={pending() === "create"}>
              {pending() === "create" ? "Creating…" : "Create token"}
            </button>
            <button class="btn btn--ghost" type="button" onClick={closeCreate} disabled={pending() === "create"}>Cancel</button>
          </div>
        </form>
      </Show>

      <Show when={error()}>
        <p role="alert" style="color: var(--danger); font-size: var(--t-sm);">{error()}</p>
      </Show>
      <Show when={notice()}>
        <p class="muted" role="status" aria-live="polite">{notice()}</p>
      </Show>

      <Show when={newToken()}>
        <div
          class="card"
          role="status"
          aria-live="polite"
          style="background: var(--accent-muted); border-color: var(--accent); margin-bottom: var(--s-3);"
        >
          <div class="row" style="margin-bottom: 6px;">
            <strong>New token created. Copy it now; it will not be shown again.</strong>
            <div class="spacer" />
            <button class="btn btn--ghost btn--sm" type="button" onClick={() => setNewToken(null)}>Dismiss</button>
          </div>
          <div class="row" style="gap: 6px;">
            <code class="mono" style="flex: 1; padding: 6px 8px; background: var(--bg); border-radius: 4px; word-break: break-all; font-size: var(--t-xs);">
              {newToken().token}
            </code>
            <button class="btn btn--outline btn--sm" type="button" onClick={() => copyToken(newToken().token)}>Copy token</button>
          </div>
        </div>
      </Show>

      <Show when={tokens.loading}>
        <p class="muted" role="status">Loading API tokens…</p>
      </Show>
      <Show when={tokens.error}>
        <div role="alert">
          <p style="color: var(--danger);">API tokens could not be loaded: {tokens.error?.message || "Request failed."}</p>
          <button class="btn btn--outline btn--sm" type="button" onClick={() => refetch()}>Retry</button>
        </div>
      </Show>
      <Show when={!tokens.loading && !tokens.error && tokens()}>
        <Show when={tokens().length > 0} fallback={
          <p class="muted" style="font-size: var(--t-sm);">No API tokens are configured for this {props.kind}.</p>
        }>
          <table class="token-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Prefix</th>
                <th scope="col">Scopes</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <For each={tokens()}>{(token) => (
                <tr>
                  <td>{token.name}</td>
                  <td class="mono" style="color: var(--text-2);">{token.prefix}…</td>
                  <td>
                    <div class="row" style="gap: 4px; flex-wrap: wrap;">
                      <For each={token.scopes || []}>{(scope) => (
                        <span class="muted" style="font-size: 10px; padding: 1px 6px; background: var(--surface-2); border-radius: 999px;">{scope}</span>
                      )}</For>
                    </div>
                  </td>
                  <td class="muted">{new Date(token.createdAt).toLocaleDateString()}</td>
                  <td class="muted">{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : "Never"}</td>
                  <td>
                    <div class="row" style="gap: 4px; justify-content: flex-end;">
                      <button
                        class="btn btn--ghost btn--sm"
                        type="button"
                        onClick={() => rotate(token)}
                        disabled={!!pending()}
                        aria-label={`Rotate token ${token.name}`}
                      >
                        {pending() === "rotate:" + token.id ? "Rotating…" : "Rotate"}
                      </button>
                      <button
                        class="btn btn--ghost btn--sm"
                        type="button"
                        onClick={() => revoke(token)}
                        disabled={!!pending()}
                        style="color: var(--danger);"
                        aria-label={`Revoke token ${token.name}`}
                      >
                        {pending() === "revoke:" + token.id ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  </td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </Show>
      </Show>
    </section>
  );
}
