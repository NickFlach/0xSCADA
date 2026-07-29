import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  open: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  randomUUID: vi.fn(() => "fixed-uuid"),
  file: {
    writeFile: vi.fn(),
    sync: vi.fn(),
    close: vi.fn(),
  },
  directory: {
    sync: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  open: mocks.open,
  rename: mocks.rename,
  rm: mocks.rm,
}));

import { writeFileAtomicDurable } from "../atomic-file";

describe("writeFileAtomicDurable ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rm.mockResolvedValue(undefined);
    mocks.open.mockImplementation(async (_path, flags) =>
      flags === "wx" ? mocks.file : mocks.directory,
    );
  });

  it("fsyncs the file, renames it, then fsyncs the containing directory", async () => {
    const target = "state/queue.json";
    const temporary = `${target}.${process.pid}.fixed-uuid.tmp`;

    await writeFileAtomicDurable(target, "payload");

    expect(mocks.mkdir).toHaveBeenCalledWith("state", { recursive: true });
    expect(mocks.open).toHaveBeenNthCalledWith(1, temporary, "wx");
    expect(mocks.file.writeFile).toHaveBeenCalledWith("payload");
    expect(mocks.rename).toHaveBeenCalledWith(temporary, target);
    expect(mocks.open).toHaveBeenNthCalledWith(2, "state", "r");

    const order = [
      mocks.file.writeFile,
      mocks.file.sync,
      mocks.file.close,
      mocks.rename,
      mocks.open,
      mocks.directory.sync,
      mocks.directory.close,
    ].map((mock) => mock.mock.invocationCallOrder.at(-1));
    expect(order.every((call, index) =>
      index === 0 || call! > order[index - 1]!,
    )).toBe(true);
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("closes the file and removes its unique temporary file on failure", async () => {
    const failure = new Error("file fsync failed");
    mocks.file.sync.mockRejectedValueOnce(failure);
    const target = "state/queue.json";
    const temporary = `${target}.${process.pid}.fixed-uuid.tmp`;

    await expect(writeFileAtomicDurable(target, "payload")).rejects.toBe(
      failure,
    );

    expect(mocks.file.close).toHaveBeenCalledOnce();
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledWith(temporary, { force: true });
  });

  it("closes the directory and reports a directory-fsync failure", async () => {
    const failure = Object.assign(new Error("directory fsync failed"), {
      code: "EIO",
    });
    mocks.directory.sync.mockRejectedValueOnce(failure);

    await expect(
      writeFileAtomicDurable("state/queue.json", "payload"),
    ).rejects.toBe(failure);

    expect(mocks.rename).toHaveBeenCalledOnce();
    expect(mocks.directory.close).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledOnce();
  });
});
