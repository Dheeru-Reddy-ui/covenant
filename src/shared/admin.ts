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

export interface AdminView {
  leadDays: number;
  minLeadDays: number;
  maxLeadDays: number;
  lastDailyRun: { atMs: number; source: string; contracts: number; due: number; opened: string[]; failed: number } | null;
  projects: Array<{ id: string; key: string; name: string }>;
  sample: SampleStatus | null;
  appId: string;
}
