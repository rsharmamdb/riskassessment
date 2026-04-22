"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Input,
  Label,
  Pill,
  Select,
} from "@/components/ui";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type LlmProvider,
  type Settings,
} from "@/lib/storage";
import { resolveMongoGptModelsUrl } from "@/lib/mongogpt-url";

interface TokenStatusResp {
  ok: boolean;
  cached: boolean;
  expiresAt: number | null;
  minutesRemaining: number | null;
  binaryPath: string | null;
  configured: boolean;
}

interface GleanStatusResp {
  ok: boolean;
  status: {
    hasToken: boolean;
    expiresAt?: number;
    expiresInSeconds?: number;
    scope?: string;
    resource?: string;
    authServer?: string;
    clientId?: string;
    hasRefreshToken?: boolean;
    stale?: boolean;
  };
}

interface MintResp {
  ok: boolean;
  token?: string;
  expiresAt?: number;
  mintedAt?: number;
  binaryPath?: string;
  actions?: Array<
    "used-cached" | "installed-binary" | "wrote-config" | "ran-login"
  >;
  error?: string;
}

const ACTION_LABELS: Record<NonNullable<MintResp["actions"]>[number], string> = {
  "used-cached": "Reused cached token",
  "installed-binary": "Downloaded kanopy-oidc binary",
  "wrote-config": "Wrote ~/.kanopy/config.yaml",
  "ran-login": "Completed kanopy-oidc login (SSO)",
};

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("returnTo") || "/cases";

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState<"glean" | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const [tokenStatus, setTokenStatus] = useState<TokenStatusResp | null>(null);
  const [mintingToken, setMintingToken] = useState(false);
  const [mintMsg, setMintMsg] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const [availableModels, setAvailableModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [gleanStatus, setGleanStatus] = useState<GleanStatusResp["status"] | null>(
    null,
  );
  const [gleanMsg, setGleanMsg] = useState<
    { ok: boolean; msg: string } | null
  >(null);
  const [gleanBusy, setGleanBusy] = useState(false);

  // One-shot guard for auto-bootstrap so we don't retrigger SSO on re-render.
  const bootstrapAttempted = useRef(false);

  const refreshStatus = useCallback(async (): Promise<TokenStatusResp | null> => {
    try {
      const res = await fetch("/api/mongogpt/token");
      const json = (await res.json()) as TokenStatusResp;
      setTokenStatus(json);
      return json;
    } catch {
      return null;
    }
  }, []);

  const refreshModels = useCallback(
    async (url: string) => {
      setLoadingModels(true);
      setModelsError(null);
      try {
        const res = await fetch("/api/mongogpt/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
        const json = (await res.json()) as {
          ok: boolean;
          models?: string[];
          error?: string;
        };
        if (json.ok && json.models) {
          setAvailableModels(json.models);
          setSettings((s) => {
            if (!s.mongogptModel || !json.models!.includes(s.mongogptModel)) {
              return { ...s, mongogptModel: json.models![0] };
            }
            return s;
          });
        } else {
          setAvailableModels([]);
          setModelsError(json.error || "Failed to load models");
        }
      } catch (err) {
        setAvailableModels([]);
        setModelsError((err as Error).message);
      } finally {
        setLoadingModels(false);
      }
    },
    [],
  );

  const ensureToken = useCallback(
    async (opts?: { force?: boolean; redirectAfter?: boolean }) => {
      setMintingToken(true);
      setMintMsg({
        ok: true,
        msg: opts?.force
          ? "Re-running kanopy-oidc login… complete SSO in the browser window that opens."
          : "Checking MongoGPT token… a browser window may open for SSO on first run.",
      });
      try {
        const res = await fetch("/api/mongogpt/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: !!opts?.force }),
        });
        const json = (await res.json()) as MintResp;
        if (!json.ok || !json.token) {
          setMintMsg({ ok: false, msg: json.error || "Failed to mint token." });
          await refreshStatus();
          return null;
        }
        const actionText =
          json.actions && json.actions.length
            ? json.actions.map((a) => ACTION_LABELS[a]).join(" → ")
            : "Token ready";
        setMintMsg({ ok: true, msg: `${actionText}. Fetching model list…` });
        await refreshStatus();
        await refreshModels(settings.mongogptUrl);

        if (opts?.redirectAfter) {
          setMintMsg({
            ok: true,
            msg: `${actionText}. Redirecting to ${returnTo}…`,
          });
          setTimeout(() => router.push(returnTo), 800);
        } else {
          setMintMsg({ ok: true, msg: `${actionText}.` });
        }
        return json.token;
      } catch (err) {
        setMintMsg({ ok: false, msg: (err as Error).message });
        return null;
      } finally {
        setMintingToken(false);
      }
    },
    [refreshModels, refreshStatus, returnTo, router, settings.mongogptUrl],
  );

  const refreshGleanStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/glean/login/status");
      const json = (await res.json()) as GleanStatusResp;
      setGleanStatus(json.status);
      return json.status;
    } catch {
      return null;
    }
  }, []);

  function signInGlean() {
    const target = new URL("/api/glean/login/start", window.location.origin);
    if (settings.gleanMcpUrl) target.searchParams.set("resource", settings.gleanMcpUrl);
    target.searchParams.set(
      "returnTo",
      `/settings${returnTo && returnTo !== "/cases" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`,
    );
    window.location.assign(target.toString());
  }

  async function signOutGlean() {
    setGleanBusy(true);
    try {
      await fetch("/api/glean/login/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      setGleanMsg({ ok: true, msg: "Signed out of Glean." });
      await refreshGleanStatus();
    } catch (err) {
      setGleanMsg({ ok: false, msg: (err as Error).message });
    } finally {
      setGleanBusy(false);
    }
  }

  useEffect(() => {
    setSettings(loadSettings());
    void refreshGleanStatus();
  }, [refreshGleanStatus]);

  // Show a banner when we land here from the OAuth callback.
  useEffect(() => {
    const status = searchParams.get("gleanLogin");
    if (!status) return;
    if (status === "success") {
      const expiresAt = Number(searchParams.get("gleanExpiresAt") || 0);
      const msg = expiresAt
        ? `Signed in to Glean. Token expires ${new Date(expiresAt).toLocaleString()}.`
        : "Signed in to Glean.";
      setGleanMsg({ ok: true, msg });
      void refreshGleanStatus();
      // If there's a deeper returnTo, bounce after a beat so the user sees the confirmation.
      const deeper = searchParams.get("returnTo");
      if (deeper && deeper !== "/settings") {
        setTimeout(() => router.push(deeper), 900);
      }
    } else if (status === "error") {
      const err = searchParams.get("gleanLoginError") || "Unknown error";
      setGleanMsg({ ok: false, msg: `Glean login failed: ${err}` });
    }
  }, [searchParams, refreshGleanStatus, router]);

  // When provider is mongogpt, probe status and auto-bootstrap if no valid token.
  useEffect(() => {
    if (settings.llmProvider !== "mongogpt") return;
    if (bootstrapAttempted.current) return;
    bootstrapAttempted.current = true;

    void (async () => {
      const status = await refreshStatus();
      if (status?.cached) {
        void refreshModels(settings.mongogptUrl);
        return;
      }
      // Only auto-trigger SSO if the user reached this page with an explicit
      // returnTo (meaning something upstream asked them to sign in).
      if (searchParams.get("returnTo")) {
        void ensureToken({ redirectAfter: true });
      }
    })();
  }, [
    settings.llmProvider,
    settings.mongogptUrl,
    ensureToken,
    refreshModels,
    refreshStatus,
    searchParams,
  ]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  }

  function persist(next: Settings) {
    saveSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  function save() {
    persist(settings);
  }

  async function testGlean() {
    setTesting("glean");
    setTestResult(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server: "glean",
          tool: "search",
          args: { query: "connectivity" },
          token: settings.gleanToken,
          url: settings.gleanMcpUrl,
        }),
      });
      const json = await res.json();
      if (json.ok) setTestResult("Glean MCP connection OK");
      else setTestResult(`Failed: ${json.error}`);
    } catch (err) {
      setTestResult(`Error: ${(err as Error).message}`);
    } finally {
      setTesting(null);
    }
  }

  const cacheBadge = (() => {
    if (!tokenStatus) return null;
    if (tokenStatus.cached) {
      const mins = tokenStatus.minutesRemaining ?? 0;
      const display =
        mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
      return <Pill tone="success">Token cached • expires in {display}</Pill>;
    }
    if (tokenStatus.binaryPath) {
      return <Pill tone="warn">No valid token — SSO required</Pill>;
    }
    return <Pill tone="warn">kanopy-oidc not installed yet</Pill>;
  })();

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-ink-400 mt-1">
          MongoGPT tokens live server-side in{" "}
          <code className="text-ink-200">~/.kanopy/risksi-token.json</code> and
          refresh automatically. OpenAI / Anthropic / Glean keys still live in
          your browser&apos;s localStorage.
        </p>
      </div>

      <Card>
        <CardHeader
          title="LLM provider"
          subtitle="Used for comment-signal extraction, risk aggregation, and Risk Register synthesis."
          right={<Pill tone="accent">Required</Pill>}
        />
        <CardBody className="space-y-4">
          <div>
            <Label>Provider</Label>
            <Select
              value={settings.llmProvider}
              onChange={(e) =>
                update("llmProvider", e.target.value as LlmProvider)
              }
            >
              <option value="mongogpt">MongoGPT (Kanopy OIDC)</option>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </Select>
          </div>

          {settings.llmProvider === "mongogpt" ? (
            <>
              <div>
                <Label>
                  MongoGPT API URL{" "}
                  <span className="text-ink-500 font-normal">
                    (PremServ / LLM Inference — base host only)
                  </span>
                </Label>
                <Input
                  value={settings.mongogptUrl}
                  onChange={(e) => update("mongogptUrl", e.target.value)}
                  placeholder="https://mongogpt.aix.prod.corp.mongodb.com"
                />
                <p className="text-[11px] text-ink-500 mt-1">
                  Same as PremServ: requests go to{" "}
                  <code className="text-ink-300">…/api/v1/messages</code> with{" "}
                  <code className="text-ink-300">X-Kanopy-Authorization</code>{" "}
                  (server fills the JWT via kanopy-oidc).
                </p>
              </div>

              <div className="rounded-md border border-ink-800 bg-ink-950/40 px-4 py-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-ink-100">
                      Kanopy OIDC
                    </div>
                    <div className="text-xs text-ink-400">
                      The server manages the{" "}
                      <code className="text-ink-200">kanopy-oidc</code> binary,{" "}
                      <code className="text-ink-200">~/.kanopy/config.yaml</code>
                      , and the SSO login. First use opens a browser for SSO;
                      the resulting JWT is cached until it expires.
                    </div>
                  </div>
                  {cacheBadge}
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <Button
                    variant="secondary"
                    loading={mintingToken}
                    onClick={() => ensureToken({ force: true })}
                  >
                    {tokenStatus?.cached
                      ? "Re-login (force refresh)"
                      : "Sign in via SSO"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refreshStatus()}
                    disabled={mintingToken}
                  >
                    Check status
                  </Button>
                  {tokenStatus?.binaryPath && (
                    <span
                      className="text-xs text-ink-500 truncate max-w-[28rem]"
                      title={tokenStatus.binaryPath}
                    >
                      {tokenStatus.binaryPath}
                    </span>
                  )}
                </div>

                {mintMsg && (
                  <div
                    className={`text-xs ${mintMsg.ok ? "text-[#8dc572]" : "text-[#be6464]"}`}
                  >
                    {mintMsg.msg}
                  </div>
                )}
              </div>

              <div>
                <Label>
                  Model{" "}
                  <span className="text-ink-500 font-normal">
                    (discovered from{" "}
                    {resolveMongoGptModelsUrl(settings.mongogptUrl)})
                  </span>
                </Label>
                {availableModels && availableModels.length > 0 ? (
                  <Select
                    value={settings.mongogptModel}
                    onChange={(e) => update("mongogptModel", e.target.value)}
                  >
                    <option value="">Select a model…</option>
                    {availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    value={settings.mongogptModel}
                    onChange={(e) => update("mongogptModel", e.target.value)}
                    placeholder="select after signing in"
                  />
                )}
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={loadingModels}
                    onClick={() => refreshModels(settings.mongogptUrl)}
                    disabled={!tokenStatus?.cached}
                  >
                    Refresh model list
                  </Button>
                  {modelsError ? (
                    <span className="text-xs text-[#be6464]">{modelsError}</span>
                  ) : availableModels ? (
                    <span className="text-xs text-ink-500">
                      {availableModels.length} models discovered
                    </span>
                  ) : tokenStatus?.cached ? (
                    <span className="text-xs text-ink-500">
                      Click refresh to load models.
                    </span>
                  ) : (
                    <span className="text-xs text-ink-500">
                      Sign in to populate this list.
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : settings.llmProvider === "openai" ? (
            <>
              <div>
                <Label>OpenAI API key</Label>
                <Input
                  type="password"
                  value={settings.openaiApiKey}
                  onChange={(e) => update("openaiApiKey", e.target.value)}
                  placeholder="sk-…"
                />
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={settings.openaiModel}
                  onChange={(e) => update("openaiModel", e.target.value)}
                  placeholder="gpt-4o"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <Label>Anthropic API key</Label>
                <Input
                  type="password"
                  value={settings.anthropicApiKey}
                  onChange={(e) => update("anthropicApiKey", e.target.value)}
                  placeholder="sk-ant-…"
                />
              </div>
              <div>
                <Label>Model</Label>
                <Input
                  value={settings.anthropicModel}
                  onChange={(e) => update("anthropicModel", e.target.value)}
                  placeholder="claude-sonnet-4-5"
                />
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Glean (MCP)"
          subtitle="Same endpoint as PremServ predefined Glean server (mongodb-be.glean.com/mcp/default). SSO or static token."
        />
        <CardBody className="space-y-4">
          <div>
            <Label>MCP URL</Label>
            <Input
              value={settings.gleanMcpUrl}
              onChange={(e) => update("gleanMcpUrl", e.target.value)}
              placeholder="https://mongodb-be.glean.com/mcp/default"
            />
          </div>

          <div className="rounded-md border border-ink-800 bg-ink-950/40 px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="space-y-1">
                <div className="text-sm font-medium text-ink-100">
                  Sign in via SSO (OAuth 2.1)
                </div>
                <div className="text-xs text-ink-400 max-w-xl">
                  The app registers itself as a Glean OAuth client via DCR,
                  does PKCE + auth-code in your browser, and caches the tokens
                  server-side in{" "}
                  <code className="text-ink-200">~/.risksi/glean-oauth.json</code>.
                  Refreshed automatically until the refresh token expires.
                </div>
              </div>
              {gleanStatus?.hasToken ? (
                (() => {
                  const secs = gleanStatus.expiresInSeconds ?? 0;
                  const display =
                    secs <= 0
                      ? "expired"
                      : secs > 3600
                        ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
                        : `${Math.max(0, Math.floor(secs / 60))}m`;
                  return (
                    <Pill tone={gleanStatus.stale ? "warn" : "success"}>
                      SSO token • {display}
                    </Pill>
                  );
                })()
              ) : (
                <Pill tone="warn">Not signed in</Pill>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button variant="secondary" onClick={signInGlean}>
                {gleanStatus?.hasToken ? "Re-sign in" : "Sign in via SSO"}
              </Button>
              {gleanStatus?.hasToken && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={signOutGlean}
                  disabled={gleanBusy}
                >
                  Sign out
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refreshGleanStatus()}
                disabled={gleanBusy}
              >
                Check status
              </Button>
              {gleanStatus?.scope && (
                <span
                  className="text-[11px] text-ink-500 truncate max-w-xs"
                  title={gleanStatus.scope}
                >
                  scopes: {gleanStatus.scope}
                </span>
              )}
            </div>

            {gleanMsg && (
              <div
                className={`text-xs ${gleanMsg.ok ? "text-[#8dc572]" : "text-[#be6464]"}`}
              >
                {gleanMsg.msg}
              </div>
            )}
          </div>

          <div>
            <Label>
              Static API token{" "}
              <span className="text-ink-500 font-normal">
                (optional — overrides SSO when set)
              </span>
            </Label>
            <Input
              type="password"
              value={settings.gleanToken}
              onChange={(e) => update("gleanToken", e.target.value)}
              placeholder="glnt_…"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              loading={testing === "glean"}
              onClick={testGlean}
              disabled={!settings.gleanToken}
            >
              Test static token
            </Button>
            {testResult && (
              <span
                className={`text-xs ${testResult.startsWith("Glean") ? "text-[#8dc572]" : "text-[#be6464]"}`}
              >
                {testResult}
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={save}>Save settings</Button>
        <Link href={returnTo} className="text-sm text-ink-300 hover:text-ink-50">
          ← Back
        </Link>
        {saved && <Pill tone="success">Saved</Pill>}
      </div>
    </div>
  );
}
