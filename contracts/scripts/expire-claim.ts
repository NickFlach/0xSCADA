import {
  expireClaim,
  positiveInteger,
  readArgument,
} from "./bounty-contract";

async function main(): Promise<void> {
  const issueNumber = positiveInteger(
    readArgument("issue-number"),
    "issue-number",
  );
  const result = await expireClaim(issueNumber);

  console.log(
    JSON.stringify({
      operation: "expireClaim",
      issueNumber: issueNumber.toString(),
      ...result,
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
