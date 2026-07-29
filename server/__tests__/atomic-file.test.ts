import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomicDurable } from "../atomic-file";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("writeFileAtomicDurable compatibility", () => {
  it("creates missing parents and atomically replaces an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "0xscada-atomic-"));
    temporaryDirectories.push(directory);
    const parent = join(directory, "nested");
    const target = join(parent, "state.json");

    await writeFileAtomicDurable(target, "first\n");
    expect(await readFile(target, "utf8")).toBe("first\n");

    await writeFile(target, "old contents", "utf8");
    await writeFileAtomicDurable(target, new TextEncoder().encode("second\n"));

    expect(await readFile(target, "utf8")).toBe("second\n");
    expect(await readdir(parent)).toEqual(["state.json"]);
  });
});
