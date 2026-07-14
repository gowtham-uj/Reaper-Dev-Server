import { createSignal } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { api } from "../api.js";
import { setCurrentUser } from "../auth.js";
import { safeReturnTarget } from "../App.jsx";

export default function Login() {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal(null);
  const nav = useNavigate();
  const location = useLocation();
  const returnTarget = () =>
    safeReturnTarget(new URLSearchParams(location.search).get("next")) || "/projects";

  async function submit(e) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const session = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username(), password: password() })
      });
      setCurrentUser(session.user);
      nav(returnTarget(), { replace: true });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="login">
      <form class="login__card" onSubmit={submit}>
        <div class="login__brand">
          <span class="brand__mark">R</span> Reaper
        </div>
        <div class="login__eyebrow">Sign in</div>
        <h1 class="login__title">Welcome back</h1>
        <p class="login__lede">Sign in to access your development environment.</p>

        <div class="field">
          <label class="field__label" for="u">Username</label>
          <input id="u" class="input" autocomplete="username" required minlength="3"
                 value={username()} onInput={(e) => setUsername(e.currentTarget.value)} />
        </div>

        <div class="field">
          <label class="field__label" for="p">Password</label>
          <input id="p" class="input" type="password" autocomplete="current-password" required minlength="1"
                 value={password()} onInput={(e) => setPassword(e.currentTarget.value)} />
        </div>

        {err() ? <div class="toast toast--err" style="position: static; margin-bottom: 12px;">{err()}</div> : null}

        <button class="btn btn--primary btn--lg btn--block" type="submit" disabled={busy()}>
          {busy() ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
