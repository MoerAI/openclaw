import { beforeAll, describe, expect, it, vi } from "vitest";
import type { InputFileLimits } from "./input-files.js";

const fetchWithSsrFGuardMock = vi.fn();

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

let fetchWithGuard: typeof import("./input-files.js").fetchWithGuard;
let extractImageContentFromSource: typeof import("./input-files.js").extractImageContentFromSource;
let extractFileContentFromSource: typeof import("./input-files.js").extractFileContentFromSource;

beforeAll(async () => {
  ({ fetchWithGuard, extractImageContentFromSource, extractFileContentFromSource } =
    await import("./input-files.js"));
});

describe("fetchWithGuard", () => {
  it("rejects oversized streamed payloads and cancels the stream", async () => {
    let canceled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new Uint8Array([5, 6, 7, 8]));
        }
        // keep stream open; cancel() should stop it once maxBytes exceeded
      },
      cancel() {
        canceled = true;
      },
    });

    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      }),
      release,
      finalUrl: "https://example.com/file.bin",
    });

    await expect(
      fetchWithGuard({
        url: "https://example.com/file.bin",
        maxBytes: 6,
        timeoutMs: 1000,
        maxRedirects: 0,
      }),
    ).rejects.toThrow("Content too large");

    // Allow cancel() microtask to run.
    await waitForMicrotaskTurn();

    expect(canceled).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("base64 size guards", () => {
  it.each([
    {
      kind: "images",
      expectedError: "Image too large",
      run: async (data: string) => {
        return await extractImageContentFromSource(
          { type: "base64", data, mediaType: "image/png" },
          {
            allowUrl: false,
            allowedMimes: new Set(["image/png"]),
            maxBytes: 6,
            maxRedirects: 0,
            timeoutMs: 1,
          },
        );
      },
    },
    {
      kind: "files",
      expectedError: "File too large",
      run: async (data: string) => {
        return await extractFileContentFromSource({
          source: { type: "base64", data, mediaType: "text/plain", filename: "x.txt" },
          limits: {
            allowUrl: false,
            allowedMimes: new Set(["text/plain"]),
            maxBytes: 6,
            maxChars: 100,
            maxRedirects: 0,
            timeoutMs: 1,
            pdfTimeoutMs: 60_000,
            pdf: { maxPages: 1, maxPixels: 1, minTextChars: 1 },
          },
        });
      },
    },
  ] as const)("rejects oversized base64 $kind before decoding", async (testCase) => {
    const data = Buffer.alloc(7).toString("base64");
    const fromSpy = vi.spyOn(Buffer, "from");
    await expect(testCase.run(data)).rejects.toThrow(testCase.expectedError);

    // Regression check: oversize reject happens before Buffer.from(..., "base64") allocates.
    const base64Calls = fromSpy.mock.calls.filter((args) => (args as unknown[])[1] === "base64");
    expect(base64Calls).toHaveLength(0);
    fromSpy.mockRestore();
  });
});

describe("input image base64 validation", () => {
  it("rejects malformed base64 payloads", async () => {
    await expect(
      extractImageContentFromSource(
        {
          type: "base64",
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
          mediaType: "image/png",
        },
        {
          allowUrl: false,
          allowedMimes: new Set(["image/png"]),
          maxBytes: 1024 * 1024,
          maxRedirects: 0,
          timeoutMs: 1,
        },
      ),
    ).rejects.toThrow("invalid 'data' field");
  });

  it("normalizes whitespace in valid base64 payloads", async () => {
    const image = await extractImageContentFromSource(
      {
        type: "base64",
        data: " aGVs bG8= \n",
        mediaType: "image/png",
      },
      {
        allowUrl: false,
        allowedMimes: new Set(["image/png"]),
        maxBytes: 1024 * 1024,
        maxRedirects: 0,
        timeoutMs: 1,
      },
    );
    expect(image.data).toBe("aGVsbG8=");
  });
});

describe("PDF extraction error handling", () => {
  function makePdfLimits(overrides?: Partial<InputFileLimits>): InputFileLimits {
    return {
      allowUrl: false,
      allowedMimes: new Set(["application/pdf"]),
      maxBytes: 50 * 1024 * 1024,
      maxChars: 200_000,
      maxRedirects: 0,
      timeoutMs: 10_000,
      pdfTimeoutMs: 60_000,
      pdf: { maxPages: 4, maxPixels: 4_000_000, minTextChars: 200 },
      ...overrides,
    };
  }

  it("returns graceful error when PDF extraction times out", async () => {
    // Use a very short timeout to trigger the timeout path
    const limits = makePdfLimits({ pdfTimeoutMs: 1 });

    // Create a minimal (invalid) PDF buffer that will cause pdfjs to hang or fail
    const fakePdfBuffer = Buffer.from("%PDF-1.4 fake content that is not a real PDF");

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: fakePdfBuffer.toString("base64"),
        mediaType: "application/pdf",
        filename: "test.pdf",
      },
      limits,
    });

    // Should return a result (not throw), with an error message in text
    expect(result.filename).toBe("test.pdf");
    expect(result.text).toMatch(/PDF processing failed/);
  });

  it("returns graceful error when PDF buffer is malformed", async () => {
    const limits = makePdfLimits({ pdfTimeoutMs: 5_000 });
    const garbageBuffer = Buffer.from("this is not a PDF at all");

    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: garbageBuffer.toString("base64"),
        mediaType: "application/pdf",
        filename: "garbage.pdf",
      },
      limits,
    });

    expect(result.filename).toBe("garbage.pdf");
    expect(result.text).toMatch(/PDF processing failed/);
  });

  it("does not hang the session on PDF failure", async () => {
    const limits = makePdfLimits({ pdfTimeoutMs: 500 });
    const fakePdfBuffer = Buffer.from("%PDF-1.4 incomplete");

    const start = Date.now();
    const result = await extractFileContentFromSource({
      source: {
        type: "base64",
        data: fakePdfBuffer.toString("base64"),
        mediaType: "application/pdf",
        filename: "slow.pdf",
      },
      limits,
    });
    const elapsed = Date.now() - start;

    // Should complete within the timeout window (with some margin)
    expect(elapsed).toBeLessThan(5_000);
    expect(result.text).toMatch(/PDF processing failed/);
  });
});
