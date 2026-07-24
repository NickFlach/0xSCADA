import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSON_SCHEMA, load } from "js-yaml";
import { describe, expect, test } from "vitest";

type WorkflowStep = {
  id?: string;
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  if?: string;
  steps: WorkflowStep[];
};

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
};

const workflowPath = resolve(
  process.cwd(),
  ".github/workflows/bounty-management.yml",
);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = load(workflowSource, { schema: JSON_SCHEMA }) as Workflow;
const smokeWorkflowSource = readFileSync(
  resolve(
    process.cwd(),
    ".github/workflows/bounty-contract-smoke.yml",
  ),
  "utf8",
);

function job(name: string): WorkflowJob {
  const selected = workflow.jobs[name];
  if (!selected) {
    throw new Error(`Missing workflow job: ${name}`);
  }
  return selected;
}

function step(selectedJob: WorkflowJob, idOrName: string): WorkflowStep {
  const selected = selectedJob.steps.find(
    (candidate) =>
      candidate.id === idOrName || candidate.name === idOrName,
  );
  if (!selected) {
    throw new Error(`Missing workflow step: ${idOrName}`);
  }
  return selected;
}

const approvedWallet = "0x1111111111111111111111111111111111111111";

async function runAuthorization(options?: {
  issueLabels?: string[];
  permission?: string;
  claimAssociation?: string;
  claimCommand?: string;
  claimUser?: string;
  claimWallet?: string;
}) {
  const authorization = step(job("handle-payment"), "authorize");
  const script = authorization.with?.script ?? "";
  const outputs: Record<string, string> = {};
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission: options?.permission ?? "write" },
        }),
      },
      pulls: {
        get: async () => ({
          data: {
            state: "closed",
            merged_at: "2026-07-23T00:00:00Z",
            base: {
              repo: { full_name: "NickFlach/0xSCADA" },
              ref: "main",
            },
            body: "Closes #486",
            user: { login: "external-contributor" },
          },
        }),
      },
      issues: {
        get: async () => ({
          data: {
            labels: (
              options?.issueLabels ?? [
                "bounty:medium",
                "bounty:claimed",
              ]
            ).map((name) => ({ name })),
          },
        }),
        listComments: async () => ({ data: [] }),
      },
    },
    paginate: async () => {
      const claimUser = options?.claimUser ?? "external-contributor";
      const claimWallet = options?.claimWallet ?? approvedWallet;
      return [
        {
          id: 10,
          created_at: "2026-07-23T00:00:00Z",
          user: { login: "maintainer" },
          author_association: options?.claimAssociation ?? "MEMBER",
          body:
            options?.claimCommand ??
            `/claim @${claimUser} ${claimWallet}`,
        },
        {
          id: 11,
          created_at: "2026-07-23T00:01:00Z",
          user: { login: "github-actions[bot]" },
          author_association: "NONE",
          body:
            `✅ **Bounty Claimed!**\n\n` +
            `**Wallet**: \`${claimWallet}\`\n` +
            `**Claimant**: @${claimUser}\n` +
            `**Approval comment ID**: \`10\``,
        },
      ];
    },
  };
  const context = {
    repo: { owner: "NickFlach", repo: "0xSCADA" },
    payload: { repository: { default_branch: "main" } },
  };
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
  };
  const runtimeProcess = {
    env: {
      DISPATCH_ACTOR: "maintainer",
      PAYOUT_PR_NUMBER: "518",
      PAYOUT_ISSUE_NUMBER: "486",
      PAYOUT_RECIPIENT_WALLET: approvedWallet,
    },
  };
  const execute = new Function(
    "github",
    "context",
    "core",
    "process",
    `return (async () => {\n${script}\n})();`,
  ) as (
    github: unknown,
    context: unknown,
    core: unknown,
    runtimeProcess: unknown,
  ) => Promise<void>;

  await execute(github, context, core, runtimeProcess);
  return outputs;
}

async function runClaimValidation(options?: {
  command?: string;
  labels?: string[];
  proposalBody?: string;
  proposalUser?: string;
}) {
  const validation = step(job("handle-claim"), "Validate claim approval");
  const script = validation.with?.script ?? "";
  const outputs: Record<string, string> = {};
  const github = {
    rest: {
      issues: {
        get: async () => ({
          data: {
            state: "open",
            labels: (
              options?.labels ?? ["bounty:medium", "ai-agent-friendly"]
            ).map((name) => ({ name })),
          },
        }),
        listComments: async () => ({ data: [] }),
      },
    },
    paginate: async () => [
      {
        id: 1,
        user: {
          login: options?.proposalUser ?? "external-contributor",
        },
        body:
          options?.proposalBody ??
          `Wallet: ${approvedWallet}\nTimeline: 3 days\nApproach: Add tests first`,
      },
    ],
  };
  const context = {
    repo: { owner: "NickFlach", repo: "0xSCADA" },
    issue: { number: 486 },
  };
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value;
    },
  };
  const runtimeProcess = {
    env: {
      CLAIM_COMMAND:
        options?.command ??
        `/agent-claim @external-contributor ${approvedWallet}`,
      CLAIM_COMMENT_ID: "2",
    },
  };
  const execute = new Function(
    "github",
    "context",
    "core",
    "process",
    `return (async () => {\n${script}\n})();`,
  ) as (
    github: unknown,
    context: unknown,
    core: unknown,
    runtimeProcess: unknown,
  ) => Promise<void>;

  await execute(github, context, core, runtimeProcess);
  return outputs;
}

describe("bounty-management workflow security contract", () => {
  test("uses explicit dispatch inputs instead of an automatic merge payout", () => {
    expect(Object.keys(workflow.on).sort()).toEqual([
      "issue_comment",
      "schedule",
      "workflow_dispatch",
    ]);

    const dispatch = workflow.on.workflow_dispatch as {
      inputs: Record<string, { required: boolean; type: string }>;
    };
    expect(dispatch.inputs).toMatchObject({
      pr_number: { required: true, type: "string" },
      issue_number: { required: true, type: "string" },
      recipient_wallet: { required: true, type: "string" },
    });
  });

  test("allows only trusted repository associations to trigger /claim", () => {
    const gate = job("handle-claim").if ?? "";

    expect(gate).toContain("github.event.issue.pull_request == null");
    expect(gate).toContain(
      "github.event.comment.author_association == 'OWNER'",
    );
    expect(gate).toContain(
      "github.event.comment.author_association == 'MEMBER'",
    );
    expect(gate).toContain(
      "github.event.comment.author_association == 'COLLABORATOR'",
    );
    expect(workflowSource).not.toContain("addAssignees");
    expect(job("handle-claim").concurrency).toMatchObject({
      group: "bounty-contract-transactions",
      "cancel-in-progress": false,
    });
    expect(job("handle-payment").concurrency).toEqual(
      job("handle-claim").concurrency,
    );
    expect(job("check-expired-claims").concurrency).toEqual(
      job("handle-claim").concurrency,
    );

    const authorization = step(
      job("handle-claim"),
      "Authorize claim approver",
    );
    expect(authorization.env).toMatchObject({
      CLAIM_APPROVER: "${{ github.event.comment.user.login }}",
    });
    expect(authorization.with?.script).toContain(
      "getCollaboratorPermissionLevel",
    );
    expect(authorization.with?.script).toContain(
      "trustedPermissions.has",
    );
  });

  test("binds an exact approved wallet to a contributor proposal", async () => {
    await expect(runClaimValidation()).resolves.toMatchObject({
      valid: "true",
      wallet: approvedWallet,
      claimant: "external-contributor",
      timeline: "3 days",
      tier: "bounty:medium",
    });
  });

  test("allows an exact claim retry to reconcile a partial GitHub update", async () => {
    await expect(
      runClaimValidation({
        labels: [
          "bounty:medium",
          "ai-agent-friendly",
          "bounty:claimed",
        ],
      }),
    ).resolves.toMatchObject({
      valid: "true",
      wallet: approvedWallet,
      claimant: "external-contributor",
    });

    const marking = step(job("handle-claim"), "Mark issue claimed");
    expect(marking.with?.script).toContain("alreadyConfirmed");
    expect(marking.with?.script).toContain(
      "Matching bounty claim confirmation already exists",
    );
    expect(marking.with?.script).toContain("github-actions[bot]");
    expect(marking.env).toMatchObject({
      CLAIM_APPROVAL_COMMENT_ID: "${{ github.event.comment.id }}",
    });
  });

  test("rejects malformed wallets and incomplete contributor proposals", async () => {
    const overlongWallet = `${approvedWallet}f`;
    await expect(
      runClaimValidation({
        command: `/claim @external-contributor ${overlongWallet}`,
      }),
    ).resolves.toMatchObject({ valid: "false" });
    await expect(
      runClaimValidation({
        proposalBody:
          `Wallet: ${overlongWallet}\nTimeline: 3 days\nApproach: Tests`,
      }),
    ).resolves.toMatchObject({ valid: "false" });
    await expect(
      runClaimValidation({
        proposalBody: `Wallet: ${approvedWallet}\nTimeline: 3 days`,
      }),
    ).resolves.toMatchObject({ valid: "false" });
  });

  test("validates the dispatcher and exact payout tuple before using secrets", () => {
    const payment = job("handle-payment");
    const gate = payment.if ?? "";
    expect(gate).toContain("github.event_name == 'workflow_dispatch'");
    expect(gate).toContain(
      "github.ref_name == github.event.repository.default_branch",
    );

    const authorization = step(payment, "authorize");
    const script = authorization.with?.script ?? "";
    expect(authorization.env).toMatchObject({
      DISPATCH_ACTOR: "${{ github.actor }}",
      PAYOUT_PR_NUMBER: "${{ inputs.pr_number }}",
      PAYOUT_ISSUE_NUMBER: "${{ inputs.issue_number }}",
      PAYOUT_RECIPIENT_WALLET: "${{ inputs.recipient_wallet }}",
    });
    expect(script).toContain("getCollaboratorPermissionLevel");
    expect(script).toContain("pr.data.merged_at");
    expect(script).toContain("pr.data.base.ref !== defaultBranch");
    expect(script).toContain("closingReference.test");
    expect(script).toContain("bounty:claimed");
    expect(script).toContain("bounty:paid");
    expect(script).toContain("trustedAssociations.has");
    expect(script).toContain("claim?.[1]?.toLowerCase() === prAuthor");
    expect(script).toContain("claim?.[2]?.toLowerCase() === wallet");
    expect(script).toContain("github-actions[bot]");
    expect(script).toContain("Approval comment ID");
    expect(script).toContain("activeConfirmation");
    expect(script).toContain(".sort(");
    expect(script).not.toContain("${{ inputs.");

    const checkout = step(payment, "Checkout trusted default branch");
    expect(checkout.with).toMatchObject({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
    });

    const execution = step(payment, "Execute payment on smart contract");
    expect(execution.run).toContain('--issue-number "$PAYOUT_ISSUE_NUMBER"');
    expect(execution.run).toContain('--pr-number "$PAYOUT_PR_NUMBER"');
    expect(execution.run).toContain('--recipient "$PAYOUT_RECIPIENT_WALLET"');
    expect(execution.run).not.toContain("${{ inputs.");
  });

  test("treats the display-only network name as a repository variable", () => {
    expect(workflowSource).toContain("${{ vars.BOUNTY_NETWORK }}");
    expect(workflowSource).not.toContain("${{ secrets.BOUNTY_NETWORK }}");
  });

  test("preserves the live Anvil claim and payout lifecycle smoke job", () => {
    expect(smokeWorkflowSource).toContain("live-anvil:");
    expect(smokeWorkflowSource).toContain("anvil > /tmp/anvil.log");
    expect(smokeWorkflowSource).toContain(
      "contracts/scripts/claim-bounty.ts",
    );
    expect(smokeWorkflowSource).toContain(
      "contracts/scripts/pay-bounty.ts",
    );
    expect(smokeWorkflowSource).toContain(
      "contracts/scripts/expire-claim.ts",
    );
  });

  test("expires the on-chain claim before releasing the GitHub claim", () => {
    const expiration = step(
      job("check-expired-claims"),
      "Find expired claims",
    );
    const script = expiration.with?.script ?? "";

    expect(expiration.env).toMatchObject({
      BOUNTY_CONTRACT_ADDRESS: "${{ secrets.BOUNTY_CONTRACT_ADDRESS }}",
      BOUNTY_PRIVATE_KEY: "${{ secrets.BOUNTY_PRIVATE_KEY }}",
      RPC_URL: "${{ secrets.BOUNTY_RPC_URL }}",
    });
    expect(script).toContain("contracts/scripts/expire-claim.ts");
    expect(script).toContain("await exec.exec(");
    expect(script.indexOf("await exec.exec(")).toBeLessThan(
      script.indexOf("await github.rest.issues.removeLabel("),
    );
    expect(script).toContain(".sort(");
    expect(script).toContain("github-actions[bot]");
    expect(script).toContain("failures.push(");
    expect(script).toContain("core.setFailed(");
  });

  test("accepts a trusted dispatch for an exact merged-PR bounty tuple", async () => {
    await expect(runAuthorization()).resolves.toMatchObject({
      pr_number: "518",
      issue_number: "486",
      wallet: approvedWallet,
      tier: "medium",
      pr_author: "external-contributor",
    });
  });

  test("allows an exact payment retry to reconcile partial GitHub updates", async () => {
    await expect(
      runAuthorization({
        issueLabels: ["bounty:medium", "bounty:paid"],
      }),
    ).resolves.toMatchObject({
      pr_number: "518",
      issue_number: "486",
      wallet: approvedWallet,
    });

    const confirmation = step(
      job("handle-payment"),
      "Post payment confirmation",
    );
    expect(confirmation.with?.script).toContain("hasPrConfirmation");
    expect(confirmation.with?.script).toContain("hasIssueConfirmation");
    expect(confirmation.with?.script).toContain("github-actions[bot]");
  });

  test("rejects unauthorized dispatchers and untrusted claim comments", async () => {
    await expect(
      runAuthorization({ permission: "read" }),
    ).rejects.toThrow("not authorized to approve bounty payouts");
    await expect(
      runAuthorization({ claimAssociation: "CONTRIBUTOR" }),
    ).rejects.toThrow("references no trusted approval command");
    await expect(
      runAuthorization({
        claimWallet: "0x2222222222222222222222222222222222222222",
      }),
    ).rejects.toThrow("Latest successful claim does not bind PR author");
    await expect(
      runAuthorization({ claimUser: "different-contributor" }),
    ).rejects.toThrow("Latest successful claim does not bind PR author");
    await expect(
      runAuthorization({
        claimCommand:
          `/claim @external-contributor ${approvedWallet}f`,
      }),
    ).rejects.toThrow("references no trusted approval command");
  });
});
