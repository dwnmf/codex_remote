import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  extractClipboardImageFiles,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_IMAGES,
  readTurnImages,
} from "./input-images";

const ORIGINAL_FILE_READER = globalThis.FileReader;

class MockFileReader {
  result: string | ArrayBuffer | null = null;
  onload: ((this: FileReader) => void) | null = null;
  onerror: ((this: FileReader) => void) | null = null;

  readAsDataURL(file: File): void {
    if (file.name.includes("fail-read")) {
      queueMicrotask(() => this.onerror?.call(this as unknown as FileReader));
      return;
    }

    const mimeType = file.type || "application/octet-stream";
    this.result = `data:${mimeType};base64,AAAA`;
    queueMicrotask(() => this.onload?.call(this as unknown as FileReader));
  }
}

function makeImageFile(name: string, type = "image/png", contents = "abc"): File {
  return new File([contents], name, { type });
}

beforeEach(() => {
  globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
});

afterEach(() => {
  if (ORIGINAL_FILE_READER) {
    globalThis.FileReader = ORIGINAL_FILE_READER;
    return;
  }
  delete (globalThis as { FileReader?: typeof FileReader }).FileReader;
});

describe("readTurnImages", () => {
  test("reads valid image files", async () => {
    const result = await readTurnImages([makeImageFile("a.png"), makeImageFile("b.jpg", "image/jpeg")]);

    expect(result.errors).toEqual([]);
    expect(result.images).toHaveLength(2);
    expect(result.images[0].name).toBe("a.png");
    expect(result.images[0].mimeType).toBe("image/png");
    expect(result.images[0].dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("rejects unsupported types and oversized files", async () => {
    const tooLarge = {
      name: "huge.png",
      type: "image/png",
      size: MAX_TURN_IMAGE_BYTES + 1,
    } as File;
    const textFile = makeImageFile("note.txt", "text/plain");

    const result = await readTurnImages([textFile, tooLarge]);

    expect(result.images).toEqual([]);
    expect(result.errors).toEqual(["note.txt: unsupported file type", "huge.png: exceeds 15MB"]);
  });

  test("handles read failures without aborting other files", async () => {
    const ok = makeImageFile("ok.png");
    const fail = makeImageFile("fail-read.png");

    const result = await readTurnImages([fail, ok]);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].name).toBe("ok.png");
    expect(result.errors).toEqual(["fail-read.png: failed to read"]);
  });

  test("enforces max image cap when existingCount is negative", async () => {
    const files = Array.from({ length: MAX_TURN_IMAGES + 1 }, (_, index) =>
      makeImageFile(`img-${index + 1}.png`),
    );

    const result = await readTurnImages(files, -10);

    expect(result.images).toHaveLength(MAX_TURN_IMAGES);
    expect(result.errors).toEqual([`Maximum ${MAX_TURN_IMAGES} images per message.`]);
  });

  test("accepts image mime types case-insensitively", async () => {
    const uppercaseType = {
      name: "upper.png",
      type: "IMAGE/PNG",
      size: 3,
    } as File;

    const result = await readTurnImages([uppercaseType]);

    expect(result.errors).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].mimeType).toBe("image/png");
  });
});

describe("extractClipboardImageFiles", () => {
  test("returns only image file clipboard items", () => {
    const image = {
      name: "clip.png",
      type: "IMAGE/PNG",
      size: 3,
    } as File;
    const text = {
      name: "notes.txt",
      type: "text/plain",
      size: 4,
    } as File;

    const event = {
      clipboardData: {
        items: [
          { kind: "string", getAsFile: () => null },
          { kind: "file", getAsFile: () => text },
          { kind: "file", getAsFile: () => image },
        ],
      },
    } as unknown as ClipboardEvent;

    expect(extractClipboardImageFiles(event)).toEqual([image]);
  });
});
