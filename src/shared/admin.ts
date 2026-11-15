/** What the admin page's resolvers send to the UI. Types only. */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'manual';

export interface PreflightCheck {
  key: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warning, a failure or a manual check. */
  fix: string | null;
}

export interface SampleStatus {
  status: 'queued' | 'running' | 'done' | 'failed';
  projectKey: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  contracts: Array<{ key: string; summary: string; extraction: string }>;
  related: string[];
  step: string;
  error: string | null;
}

/** What one-click setup found or made. `changed` is false when everything was already in place. */
export interface SetupResult {
  project: { key: string; name: string; created: boolean };
  workType: { name: string; created: boolean } | null;
  sample: 'started' | 'already_loaded' | 'loading';
  changed: boolean;
  notes: string[];
}

/** The admin's quality panel: the offline eval and trap scores this version was built with, and how reviewers have treated its output. */
export interface QualityView {
  eval: { noticeExact: number; noticeTotal: number; allExact: number; allTotal: number; wrong: number; quotesVerified: number; quotesReturned: number; contracts: number; on: string; model: string; extractorVersion: number };
  traps: { passed: number; total: number };
  /** On this site: obligations approved, approved without any edit, rejected, and still waiting. */
  approvals: { approved: number; unedited: number; rejected: number; pending: number };
}

export interface AccessLogView {
  /** Reads in the last 30 days, by channel. */
  last30Days: { panel: number; rovo: number; mcp: number };
  recent: Array<{ accountId: string; channel: 'panel' | 'rovo' | 'mcp'; action: string; obligationId: string; kindLabel: string | null; issueKey: string | null; atMs: number }>;
  keepDays: number;
}

export interface AdminView {
  leadDays: number;
  minLeadDays: number;
  maxLeadDays: number;
  lastDailyRun: { atMs: number; source: string; contracts: number; due: number; opened: string[]; failed: number } | null;
  projects: Array<{ id: string; key: string; name: string }>;
  sample: SampleStatus | null;
  appId: string;
  quality: QualityView;
  access: AccessLogView;
}
