import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionRun } from "./contract";

type Artifact = {
  repo: string;
  workflowName?: string;
  workflowPath?: string;
  url?: string;
  runId?: string;
  at?: string;
  capturedAt?: string;
};

type Imported = { metrics?: { tokens: number; costUSD: number; models: string[] } };

async function read<T>(state: string, name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(state, name), "utf8"));
  } catch {
    return fallback;
  }
}

/** Claude usage per Actions run, as tokenhub imported it from each run's capture step, newest first. */
export async function actionRuns(state: string, accounts: Record<string, string>): Promise<ActionRun[]> {
  const [artifacts, backfill, imported] = await Promise.all([
    read<Record<string, Artifact>>(state, "github-artifacts.json", {}),
    read<Record<string, Artifact>>(state, "github-backfill-artifacts.json", {}),
    read<Record<string, Imported>>(state, "github-imported.json", {}),
  ]);

  return Object.entries({ ...backfill, ...artifacts })
    .flatMap(([key, a]) => {
      const metrics = imported[key]?.metrics;
      const at = Date.parse(a.at ?? a.capturedAt ?? "");

      if (!metrics?.tokens || Number.isNaN(at)) return [];

      return [
        {
          at,
          repo: a.repo,
          workflow: a.workflowName ?? a.workflowPath ?? "",
          url: a.url ?? `https://github.com/${a.repo}/actions/runs/${a.runId}`,
          account: accounts[a.repo] ?? null,
          ...metrics,
        },
      ];
    })
    .toSorted((a, b) => b.at - a.at);
}
