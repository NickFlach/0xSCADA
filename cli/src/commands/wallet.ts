import { Command } from "commander";
import ora from "ora";
import {
  output,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  outputWarning,
  outputTable,
  setOutputOptions,
  colors,
  formatDate,
} from "../output.js";
import {
  listWallets,
  addWallet,
  removeWallet,
  setDefaultWallet,
  getWallet,
  signMessage,
  type WalletEntry,
} from "../secure-storage.js";
import { getApiClient } from "../api.js";

export function registerWalletCommand(program: Command): void {
  const wallet = program
    .command("wallet")
    .description("Manage blockchain wallets");

  // List wallets
  wallet
    .command("list")
    .description("List all configured wallets")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const wallets = listWallets();

        if (options.json) {
          output(wallets);
          return;
        }

        if (wallets.length === 0) {
          outputWarning("No wallets configured");
          console.log();
          console.log(
            colors.dim("Use 'wallet add --name <name> --keyfile <path>' to add a wallet")
          );
          console.log();
          return;
        }

        outputSection("Configured Wallets");
        outputTable(
          ["Name", "Address", "Source", "Default", "Created"],
          wallets.map((w) => [
            w.name,
            w.address,
            w.keyfilePath ? "Keyfile" : "Private Key",
            w.isDefault ? colors.success("Yes") : colors.dim("No"),
            formatDate(w.createdAt),
          ])
        );
        console.log();
      } catch (error) {
        outputError(
          "Failed to list wallets",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Add wallet
  wallet
    .command("add")
    .description("Add a new wallet")
    .requiredOption("--name <name>", "Name for the wallet")
    .option("--keyfile <path>", "Path to keystore JSON file")
    .option("--private-key <key>", "Private key (not recommended for production)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      if (!options.keyfile && !options.privateKey) {
        outputError(
          "No key source provided",
          "Use --keyfile <path> or --private-key <key>"
        );
        return;
      }

      if (options.privateKey) {
        outputWarning(
          "Using --private-key is not recommended. Consider using --keyfile instead."
        );
      }

      try {
        const newWallet = addWallet(
          options.name,
          options.keyfile,
          options.privateKey
        );

        if (options.json) {
          output({
            success: true,
            wallet: {
              name: newWallet.name,
              address: newWallet.address,
              isDefault: newWallet.isDefault,
            },
          });
          return;
        }

        outputSuccess(`Wallet '${options.name}' added successfully`);
        console.log();
        outputKeyValue([
          { key: "Name", value: newWallet.name },
          { key: "Address", value: newWallet.address },
          {
            key: "Source",
            value: newWallet.keyfilePath
              ? `Keyfile (${newWallet.keyfilePath})`
              : "Private Key",
          },
          { key: "Default", value: newWallet.isDefault ? "Yes" : "No" },
        ]);
        console.log();

        if (newWallet.isDefault) {
          console.log(
            colors.dim("This wallet has been set as the default wallet.")
          );
          console.log();
        }
      } catch (error) {
        outputError(
          "Failed to add wallet",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Remove wallet
  wallet
    .command("remove <name>")
    .description("Remove a wallet")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((name: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const success = removeWallet(name);

        if (!success) {
          outputError("Wallet not found", `No wallet with name '${name}' exists`);
          return;
        }

        if (options.json) {
          output({ success: true, message: "Wallet removed" });
          return;
        }

        outputSuccess(`Wallet '${name}' has been removed`);
        console.log();
      } catch (error) {
        outputError(
          "Failed to remove wallet",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Get balance
  wallet
    .command("balance [name]")
    .description("Get wallet balance (uses default wallet if name not specified)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (name: string | undefined, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const targetWallet = getWallet(name);

        if (!targetWallet) {
          if (name) {
            outputError("Wallet not found", `No wallet with name '${name}' exists`);
          } else {
            outputError(
              "No default wallet",
              "Add a wallet first with 'wallet add --name <name> --keyfile <path>'"
            );
          }
          return;
        }

        const spinner = options.json ? null : ora("Fetching balance...").start();

        // Try to get balance from blockchain API
        const api = getApiClient();

        try {
          // Note: This is a placeholder - the actual implementation would
          // call a blockchain RPC endpoint to get the balance
          const response = await api.getBlockchainStatus();

          spinner?.stop();

          // Simulated balance for demo purposes
          const balance = {
            wallet: targetWallet.name,
            address: targetWallet.address,
            balance: "0.0",
            currency: "ETH",
            blockchainEnabled: response.success && response.data?.enabled,
          };

          if (options.json) {
            output(balance);
            return;
          }

          outputSection(`Balance: ${targetWallet.name}`);
          outputKeyValue([
            { key: "Address", value: targetWallet.address },
            { key: "Balance", value: `${balance.balance} ${balance.currency}` },
            {
              key: "Blockchain",
              value: balance.blockchainEnabled
                ? colors.success("Connected")
                : colors.warning("Not connected"),
            },
          ]);
          console.log();

          if (!balance.blockchainEnabled) {
            console.log(
              colors.dim(
                "Note: Blockchain is not enabled. Balance shown may not be accurate."
              )
            );
            console.log();
          }
        } catch (apiError) {
          spinner?.fail("Failed to fetch balance");

          // Still show wallet info even if API fails
          if (options.json) {
            output({
              wallet: targetWallet.name,
              address: targetWallet.address,
              balance: null,
              error: "Failed to fetch balance from blockchain",
            });
            return;
          }

          outputKeyValue([
            { key: "Wallet", value: targetWallet.name },
            { key: "Address", value: targetWallet.address },
            { key: "Balance", value: colors.dim("Unable to fetch") },
          ]);
          console.log();
          console.log(
            colors.dim("Could not connect to blockchain to fetch balance.")
          );
          console.log();
        }
      } catch (error) {
        outputError(
          "Failed to get balance",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Sign message
  wallet
    .command("sign")
    .description("Sign a message with a wallet")
    .requiredOption("--message <message>", "Message to sign")
    .option("--wallet <name>", "Wallet name (uses default if not specified)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const targetWallet = getWallet(options.wallet);

        if (!targetWallet) {
          if (options.wallet) {
            outputError(
              "Wallet not found",
              `No wallet with name '${options.wallet}' exists`
            );
          } else {
            outputError(
              "No default wallet",
              "Add a wallet first or specify --wallet <name>"
            );
          }
          return;
        }

        const signature = signMessage(targetWallet.name, options.message);

        if (!signature) {
          outputError(
            "Signing failed",
            "Could not access wallet private key. Keyfile wallets require password."
          );
          return;
        }

        if (options.json) {
          output({
            wallet: targetWallet.name,
            address: targetWallet.address,
            message: options.message,
            signature,
          });
          return;
        }

        outputSuccess("Message signed successfully");
        console.log();
        outputKeyValue([
          { key: "Wallet", value: targetWallet.name },
          { key: "Address", value: targetWallet.address },
          { key: "Message", value: options.message },
        ]);
        console.log();
        console.log(colors.bold("Signature:"));
        console.log(`  ${colors.cyan(signature)}`);
        console.log();
      } catch (error) {
        outputError(
          "Failed to sign message",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Set default wallet
  wallet
    .command("set-default <name>")
    .description("Set a wallet as the default")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((name: string, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const success = setDefaultWallet(name);

        if (!success) {
          outputError("Wallet not found", `No wallet with name '${name}' exists`);
          return;
        }

        if (options.json) {
          output({ success: true, defaultWallet: name });
          return;
        }

        outputSuccess(`'${name}' is now the default wallet`);
        console.log();
      } catch (error) {
        outputError(
          "Failed to set default wallet",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Show wallet details
  wallet
    .command("show [name]")
    .description("Show wallet details (uses default wallet if name not specified)")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action((name: string | undefined, options) => {
      setOutputOptions({ json: options.json, color: options.color });

      try {
        const targetWallet = getWallet(name);

        if (!targetWallet) {
          if (name) {
            outputError("Wallet not found", `No wallet with name '${name}' exists`);
          } else {
            outputError(
              "No default wallet",
              "Add a wallet first with 'wallet add --name <name> --keyfile <path>'"
            );
          }
          return;
        }

        if (options.json) {
          output({
            name: targetWallet.name,
            address: targetWallet.address,
            source: targetWallet.keyfilePath ? "keyfile" : "private-key",
            keyfilePath: targetWallet.keyfilePath,
            isDefault: targetWallet.isDefault,
            createdAt: targetWallet.createdAt,
          });
          return;
        }

        outputSection(`Wallet: ${targetWallet.name}`);
        outputKeyValue([
          { key: "Address", value: targetWallet.address },
          {
            key: "Source",
            value: targetWallet.keyfilePath
              ? `Keyfile`
              : "Private Key (encrypted)",
          },
          {
            key: "Keyfile Path",
            value: targetWallet.keyfilePath || colors.dim("N/A"),
          },
          {
            key: "Default",
            value: targetWallet.isDefault ? colors.success("Yes") : "No",
          },
          { key: "Created", value: formatDate(targetWallet.createdAt) },
        ]);
        console.log();
      } catch (error) {
        outputError(
          "Failed to show wallet",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
