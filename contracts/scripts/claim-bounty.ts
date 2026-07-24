import {
  claimBounty,
  positiveInteger,
  readArgument,
} from "./bounty-contract";

async function main(): Promise<void> {
  const issueNumber = positiveInteger(
    readArgument("issue-number"),
    "issue-number",
  );
  const claimant = readArgument("claimant");
  const result = await claimBounty(issueNumber, claimant);

  console.log(
    JSON.stringify({
      operation: "claimBounty",
      issueNumber: issueNumber.toString(),
      claimant,
      ...result,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
