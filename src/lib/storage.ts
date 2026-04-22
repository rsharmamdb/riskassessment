"use client";

export type LlmProvider = "openai" | "anthropic" | "mongogpt";

export interface Settings {
  gleanMcpUrl: string;
  gleanToken: string;
  llmProvider: LlmProvider;
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  mongogptUrl: string;
  mongogptModel: string;
  mongogptToken: string;
  kanopyOidcPath: string;
}

const KEY = "risksi.settings.v1";

export const DEFAULT_SETTINGS: Settings = {
  gleanMcpUrl: "https://mongodb-be.glean.com/mcp/default",
  gleanToken: "",
  llmProvider: "mongogpt",
  openaiApiKey: "",
  openaiModel: "gpt-4o",
  anthropicApiKey: "",
  anthropicModel: "claude-sonnet-4-5",
  // PremServ-style base URL (no path); server resolves to /api/v1/messages
  mongogptUrl: "https://mongogpt.aix.prod.corp.mongodb.com",
  mongogptModel: "",
  mongogptToken: "",
  kanopyOidcPath: "",
};

export function loadSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, JSON.stringify(s));
}

const ASSESSMENT_KEY = "risksi.assessment.v1";

export function loadAssessment<T>(): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ASSESSMENT_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveAssessment<T>(state: T): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(ASSESSMENT_KEY, JSON.stringify(state));
}

export function clearAssessment(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(ASSESSMENT_KEY);
}
