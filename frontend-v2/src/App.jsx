import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { api } from "./api.js";
import { currentUser as user, setCurrentUser as setUser } from "./auth.js";

export function App(props) {
  const [bootstrapState, setBootstrapState] = createSignal("loading");
  const navigate = useNavigate();
  const location = useLocation();

  const isLoginRoute = createMemo(() => location.pathname === "/login");

  async function bootstrap() {
    setBootstrapState("loading");
    try {
      const response = await api("/api/auth/me");
      setUser(response.user);
      setBootstrapState("ready");
    } catch (error) {
      if (error?.status === 401) {
        setUser(null);
        setBootstrapState("ready");
        return;
      }
      setBootstrapState("error");
    }
  }

  onMount(() => {
    const handleUnauthorized = (event) => {
      setUser(null);
      const currentTarget = `${location.pathname}${location.search}${location.hash}`;
      const next = safeReturnTarget(event.detail?.next) || safeReturnTarget(currentTarget) || "/projects";
      navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
    };

    window.addEventListener("reaper:unauthorized", handleUnauthorized);
    onCleanup(() => window.removeEventListener("reaper:unauthorized", handleUnauthorized));
    bootstrap();
  });

  createEffect(() => {
    if (bootstrapState() !== "ready" || user() || isLoginRoute()) return;
    const currentTarget = `${location.pathname}${location.search}${location.hash}`;
    const next = safeReturnTarget(currentTarget) || "/projects";
    navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  });

  return (
    <Show
      when={bootstrapState() !== "loading"}
      fallback={
        <main id="main" class="login" aria-busy="true">
          <div class="muted">Checking your session…</div>
        </main>
      }
    >
      <Show
        when={bootstrapState() !== "error"}
        fallback={
          <main id="main" class="login">
            <div class="login__card">
              <div class="login__eyebrow">Connection issue</div>
              <h1 class="login__title">Unable to verify your session</h1>
              <p class="login__lede" role="alert">
                Your sign-in state has not changed. Check your connection or wait for the server to recover, then try again.
              </p>
              <button class="btn btn--primary btn--lg btn--block" type="button" onClick={bootstrap}>
                Retry
              </button>
            </div>
          </main>
        }
      >
        <Show when={isLoginRoute()}>
          {props.children}
        </Show>
        <Show when={!isLoginRoute()}>
          <Show
            when={user()}
            fallback={
              <main id="main" class="login">
                <div class="muted">Redirecting to sign in…</div>
              </main>
            }
          >
            <Shell user={user()}>
              {props.children}
            </Shell>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

const MOBILE_SIDEBAR_QUERY = "(max-width: 720px)";
const RETURN_TARGET_ORIGIN = "https://reaper.local";

export function safeReturnTarget(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const target = new URL(value, RETURN_TARGET_ORIGIN);
    if (
      target.origin !== RETURN_TARGET_ORIGIN ||
      target.pathname === "/login" ||
      target.pathname.startsWith("/login/")
    ) {
      return null;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

function Shell(props) {
  const loc = useLocation();
  const nav = useNavigate();
  const [isNarrow, setIsNarrow] = createSignal(
    typeof window !== "undefined" && window.matchMedia(MOBILE_SIDEBAR_QUERY).matches
  );
  const [desktopSidebarExpanded, setDesktopSidebarExpanded] = createSignal(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = createSignal(false);
  const [logoutState, setLogoutState] = createSignal("idle");
  const [logoutError, setLogoutError] = createSignal("");
  const sidebarExpanded = createMemo(() =>
    isNarrow() ? mobileSidebarOpen() : desktopSidebarExpanded()
  );
  const isActive = (p) => loc.pathname === p || (p === "/projects" && loc.pathname === "/") || (p !== "/" && loc.pathname.startsWith(p + "/"));
  const initial = (props.user?.username || "?").slice(0, 2).toUpperCase();
  let sidebarToggle;

  const closeMobileSidebar = () => setMobileSidebarOpen(false);

  createEffect(() => {
    const route = `${loc.pathname}${loc.search}${loc.hash}`;
    if (route) closeMobileSidebar();
  });

  onMount(() => {
    const media = window.matchMedia(MOBILE_SIDEBAR_QUERY);
    const syncViewport = (event) => {
      setIsNarrow(event.matches);
      closeMobileSidebar();
    };
    const closeOnEscape = (event) => {
      if (event.key !== "Escape" || !isNarrow() || !mobileSidebarOpen()) return;
      closeMobileSidebar();
      sidebarToggle?.focus();
    };

    setIsNarrow(media.matches);
    media.addEventListener("change", syncViewport);
    document.addEventListener("keydown", closeOnEscape);
    onCleanup(() => {
      media.removeEventListener("change", syncViewport);
      document.removeEventListener("keydown", closeOnEscape);
    });
  });

  function toggleSidebar() {
    if (isNarrow()) {
      setMobileSidebarOpen((open) => !open);
      return;
    }
    setDesktopSidebarExpanded((expanded) => !expanded);
  }

  async function logout() {
    if (logoutState() === "pending") return;
    setLogoutState("pending");
    setLogoutError("");
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      setUser(null);
      nav("/login", { replace: true });
    } catch {
      setLogoutError("Sign out failed. Your session is still active.");
      setLogoutState("idle");
    }
  }

  return (
    <>
      <a class="skip" href="#main">Skip to main content</a>
      <div
        class="app"
        classList={{
          "app--sidebar-collapsed": !isNarrow() && !desktopSidebarExpanded(),
          "app--sidebar-open": isNarrow() && mobileSidebarOpen()
        }}
      >
        <header class="app__topbar">
          <A href="/projects" class="brand" onClick={closeMobileSidebar}>
            <span class="brand__mark">R</span>
            Reaper
          </A>
          <button
            ref={sidebarToggle}
            type="button"
            class="btn btn--ghost btn--sm sidebar-toggle"
            aria-controls="primary-navigation"
            aria-expanded={sidebarExpanded()}
            onClick={toggleSidebar}
          >
            {isNarrow()
              ? (mobileSidebarOpen() ? "Close navigation" : "Open navigation")
              : (desktopSidebarExpanded() ? "Hide sidebar" : "Show sidebar")}
          </button>
          <span class="crumb">{pageEyebrow(loc.pathname)}</span>
          <div class="spacer" />
          <Show when={logoutError()}>
            <span id="logout-error" role="alert" style={{ color: "var(--danger)", "font-size": "var(--t-xs)" }}>{logoutError()}</span>
          </Show>
          <span class="userchip">
            <span class="userchip__avatar">{initial}</span>
            {props.user.username}
          </span>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            disabled={logoutState() === "pending"}
            aria-describedby={logoutError() ? "logout-error" : undefined}
            onClick={logout}
          >
            {logoutState() === "pending" ? "Signing out…" : logoutError() ? "Retry sign out" : "Sign out"}
          </button>
        </header>
        <nav id="primary-navigation" class="app__sidebar" aria-label="Primary">
          <div class="nav-group">
            <div class="nav-group__title">Workspace</div>
            <A href="/projects" class="nav-item" onClick={closeMobileSidebar} aria-current={isActive("/projects") ? "page" : undefined} classList={{ "nav-item--active": isActive("/projects") }}>Projects</A>
          </div>
          <div class="nav-group">
            <div class="nav-group__title">Admin</div>
            <A href="/settings" class="nav-item" onClick={closeMobileSidebar} aria-current={isActive("/settings") ? "page" : undefined} classList={{ "nav-item--active": isActive("/settings") }}>Settings</A>
            <A href="/audit" class="nav-item" onClick={closeMobileSidebar} aria-current={isActive("/audit") ? "page" : undefined} classList={{ "nav-item--active": isActive("/audit") }}>Audit</A>
          </div>
        </nav>
        <Show when={isNarrow() && mobileSidebarOpen()}>
          <button
            class="sidebar-backdrop"
            type="button"
            onClick={closeMobileSidebar}
            aria-label="Close navigation"
          ></button>
        </Show>

        <main id="main" class="app__main">{props.children}</main>
      </div>

      <nav class="bottomnav" aria-label="Primary mobile">
        <A href="/projects" class="bottomnav__item" onClick={closeMobileSidebar} aria-current={isActive("/projects") ? "page" : undefined} classList={{ "bottomnav__item--active": isActive("/projects") }}>Projects</A>
        <A href="/settings" class="bottomnav__item" onClick={closeMobileSidebar} aria-current={isActive("/settings") ? "page" : undefined} classList={{ "bottomnav__item--active": isActive("/settings") }}>Settings</A>
      </nav>
    </>
  );
}

function pageEyebrow(path) {
  if (path.startsWith("/projects/")) return "Project";
  if (path === "/projects") return "Projects";
  if (path === "/settings") return "Settings";
  if (path === "/audit") return "Audit";
  return "";
}
