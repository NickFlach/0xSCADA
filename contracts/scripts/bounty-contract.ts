import {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
} from "ethers";

const BOUNTY_PAYMENT_ABI = [
  "function claimBounty(uint256 issueNumber, address claimant)",
  "function expireClaim(uint256 issueNumber)",
  "function payBounty(uint256 issueNumber, uint256 prNumber, address recipient)",
  "function getBounty(uint256 issueNumber) view returns (tuple(uint256 issueNumber, uint256 amount, address token, uint8 status, address claimant, uint256 claimedAt, uint256 claimTimeout, string metadata, bool isAgentFriendly, uint256 createdAt, address createdBy))",
  "function getPayment(uint256 issueNumber) view returns (tuple(uint256 issueNumber, uint256 prNumber, address[] recipients, uint256[] amounts, uint256 paidAt))",
  "function isClaimExpired(uint256 issueNumber) view returns (bool)",
] as const;

const BOUNTY_STATUS = {
  OPEN: 0,
  CLAIMED: 1,
  PAID: 3,
} as const;

export type TransactionResult = {
  transactionHash: string | null;
  alreadyApplied: boolean;
};

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizePrivateKey(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}

async function connect(): Promise<Contract> {
  const rpcUrl = requireEnvironment("RPC_URL");
  const contractAddress = getAddress(
    requireEnvironment("BOUNTY_CONTRACT_ADDRESS"),
  );
  const privateKey = normalizePrivateKey(
    requireEnvironment("BOUNTY_PRIVATE_KEY"),
  );

  const provider = new JsonRpcProvider(rpcUrl);
  const code = await provider.getCode(contractAddress);
  if (code === "0x") {
    throw new Error(
      `No contract is deployed at BOUNTY_CONTRACT_ADDRESS (${contractAddress})`,
    );
  }

  return new Contract(
    contractAddress,
    BOUNTY_PAYMENT_ABI,
    new Wallet(privateKey, provider),
  );
}

async function waitForSuccess(
  operation: string,
  transaction: { hash: string; wait: () => Promise<{ status: number | null } | null> },
): Promise<TransactionResult> {
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${operation} transaction failed: ${transaction.hash}`);
  }

  return {
    transactionHash: transaction.hash,
    alreadyApplied: false,
  };
}

export function readArgument(name: string): string {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required argument: ${flag}`);
  }
  return value;
}

export function positiveInteger(value: string, name: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

export async function claimBounty(
  issueNumber: bigint,
  claimant: string,
): Promise<TransactionResult> {
  const contract = await connect();
  const normalizedClaimant = getAddress(claimant);
  const bounty = await contract.getBounty(issueNumber);
  if (BigInt(bounty.issueNumber) !== issueNumber) {
    throw new Error(`Bounty ${issueNumber} is not registered`);
  }

  const status = Number(bounty.status);
  if (status === BOUNTY_STATUS.CLAIMED) {
    if (getAddress(bounty.claimant) !== normalizedClaimant) {
      throw new Error(`Bounty ${issueNumber} is claimed by another wallet`);
    }
    return { transactionHash: null, alreadyApplied: true };
  }
  if (status !== BOUNTY_STATUS.OPEN) {
    throw new Error(`Bounty ${issueNumber} is not open`);
  }

  const transaction = await contract.claimBounty(
    issueNumber,
    normalizedClaimant,
  );
  return waitForSuccess("claimBounty", transaction);
}

export async function expireClaim(
  issueNumber: bigint,
): Promise<TransactionResult> {
  const contract = await connect();
  const bounty = await contract.getBounty(issueNumber);
  if (BigInt(bounty.issueNumber) !== issueNumber) {
    throw new Error(`Bounty ${issueNumber} is not registered`);
  }

  const status = Number(bounty.status);
  if (status === BOUNTY_STATUS.OPEN) {
    return { transactionHash: null, alreadyApplied: true };
  }
  if (status !== BOUNTY_STATUS.CLAIMED) {
    throw new Error(`Bounty ${issueNumber} is not claimed`);
  }
  if (!(await contract.isClaimExpired(issueNumber))) {
    throw new Error(`Bounty ${issueNumber} has not expired`);
  }

  const transaction = await contract.expireClaim(issueNumber);
  return waitForSuccess("expireClaim", transaction);
}

export async function payBounty(
  issueNumber: bigint,
  prNumber: bigint,
  recipient: string,
): Promise<TransactionResult> {
  const contract = await connect();
  const normalizedRecipient = getAddress(recipient);
  const bounty = await contract.getBounty(issueNumber);
  if (BigInt(bounty.issueNumber) !== issueNumber) {
    throw new Error(`Bounty ${issueNumber} is not registered`);
  }

  const status = Number(bounty.status);
  if (status === BOUNTY_STATUS.PAID) {
    const payment = await contract.getPayment(issueNumber);
    const samePayment =
      BigInt(payment.issueNumber) === issueNumber &&
      BigInt(payment.prNumber) === prNumber &&
      payment.recipients.length === 1 &&
      getAddress(payment.recipients[0]) === normalizedRecipient;
    if (!samePayment) {
      throw new Error(
        `Bounty ${issueNumber} was already paid with different details`,
      );
    }
    return { transactionHash: null, alreadyApplied: true };
  }
  if (status !== BOUNTY_STATUS.CLAIMED) {
    throw new Error(`Bounty ${issueNumber} is not claimed`);
  }
  if (getAddress(bounty.claimant) !== normalizedRecipient) {
    throw new Error(`Recipient is not the claimant for bounty ${issueNumber}`);
  }

  const transaction = await contract.payBounty(
    issueNumber,
    prNumber,
    normalizedRecipient,
  );
  return waitForSuccess("payBounty", transaction);
}
