// SPDX-License-Identifier: MIT
/*
   Copyright (c) 2024, SCANOSS

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   THE SOFTWARE.
 */

import { context, getOctokit } from '@actions/github';
import * as core from '@actions/core';
import * as inputs from '../app.input';
import type { Endpoints } from '@octokit/types';

const prEvents = ['pull_request', 'pull_request_review', 'pull_request_review_comment'];
const FIND_FIRST_RUN_EVENT = 'workflow_dispatch';

// Use the types from @octokit/types
type WorkflowRunsResponse = Endpoints['GET /repos/{owner}/{repo}/actions/runs']['response'];
type WorkflowRun = WorkflowRunsResponse['data']['workflow_runs'][number];

/**
 * Determines if the current GitHub workflow run was triggered by a pull request event.
 */
export function isPullRequest(): boolean {
  return prEvents.includes(context.eventName);
}

/**
 * Gets the SHA of the commit being processed in the current workflow run.
 */
export function getSHA(): string {
  let sha = context.sha;
  if (isPullRequest()) {
    const pull = context.payload.pull_request;
    if (pull?.head.sha) {
      sha = pull?.head.sha;
    }
  }

  return sha;
}

/**
 * Resolves the correct repository owner, repo name, and SHA for fork-safe URL generation.
 * For pull requests from forks, this ensures URLs point to the correct repository and commit.
 */
export function resolveRepoAndSha(): { owner: string; repo: string; sha: string } {
  if (isPullRequest()) {
    const pull = context.payload.pull_request;
    if (pull?.head) {
      // For PRs, use the head repository and SHA to ensure we point to the correct branch/fork
      return {
        owner: pull.head.repo?.owner.login || context.repo.owner,
        repo: pull.head.repo?.name || context.repo.repo,
        sha: pull.head.sha || context.sha
      };
    }
  }

  // Default to context values for non-PR scenarios
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    sha: context.sha
  };
}

// Hidden marker used to find the action's previous report comment so it can
// be updated in place. Editing a comment does not trigger GitHub
// notifications, so repeated scans on the same PR don't email subscribers.
const REPORT_COMMENT_MARKER = '<!-- scanoss-scan-report -->';

/**
 * Creates or updates the scan report comment on the current pull request.
 * The first run creates the comment; subsequent runs edit it in place.
 */
export async function createCommentOnPR(message: string): Promise<void> {
  const octokit = getOctokit(inputs.GITHUB_TOKEN);
  const body = `${REPORT_COMMENT_MARKER}\n${message}`;

  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    issue_number: context.issue.number,
    owner: context.repo.owner,
    repo: context.repo.repo,
    per_page: 100
  });
  const existing = comments.find(c => c.body?.includes(REPORT_COMMENT_MARKER));

  if (existing) {
    core.debug(`Updating existing PR comment ${existing.id}`);
    await octokit.rest.issues.updateComment({
      comment_id: existing.id,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body
    });
  } else {
    core.debug('Creating comment on PR');
    await octokit.rest.issues.createComment({
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      body
    });
  }
}

/**
 * Gets the first workflow run ID for linking purposes.
 * For workflow_dispatch events, finds the original triggering run.
 */
export async function getFirstRunId(): Promise<number> {
  let firstRunId = context.runId;
  if (context.eventName === FIND_FIRST_RUN_EVENT) {
    const firstRun = await loadFirstRun(context.repo.owner, context.repo.repo);
    if (firstRun) {
      core.info(`First Run ID found: ${firstRun.id}`);
      firstRunId = firstRun.id;
    }
  }
  return firstRunId;
}

/**
 * Loads the first workflow run for the current SHA and workflow.
 */
async function loadFirstRun(owner: string, repo: string): Promise<WorkflowRun | null> {
  const octokit = getOctokit(inputs.GITHUB_TOKEN);
  const sha = getSHA();

  const workflowRun = await octokit.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: context.runId
  });

  const runs = await octokit.rest.actions.listWorkflowRuns({
    owner,
    repo,
    head_sha: sha,
    workflow_id: workflowRun.data.workflow_id
  });

  // Filter by the given SHA
  const filteredRuns = runs.data.workflow_runs.filter(run => run.head_sha === sha);

  // Sort by creation date to find the first run
  const sortedRuns = filteredRuns.sort((a, b) =>
    a.created_at && b.created_at ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime() : 0
  );

  return sortedRuns.length ? sortedRuns[0] : null;
}
