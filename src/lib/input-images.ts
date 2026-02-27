import type { TurnImageInput } from "./types";

export const MAX_TURN_IMAGES = 6;
export const MAX_TURN_IMAGE_BYTES = 15 * 1024 * 1024;

function makeImageId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `img-${Date.now()}-${random}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read image"));
    };
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

export async function readTurnImages(
  files: FileList | File[],
  existingCount = 0,
): Promise<{ images: TurnImageInput[]; errors: string[] }> {
  const list = Array.from(files);
  const errors: string[] = [];
  const images: TurnImageInput[] = [];

  for (const file of list) {
    if (existingCount + images.length >= MAX_TURN_IMAGES) {
      errors.push(`Maximum ${MAX_TURN_IMAGES} images per message.`);
      break;
    }

    if (!file.type.startsWith("image/")) {
      errors.push(`${file.name}: unsupported file type`);
      continue;
    }

    if (file.size > MAX_TURN_IMAGE_BYTES) {
      errors.push(`${file.name}: exceeds ${Math.floor(MAX_TURN_IMAGE_BYTES / (1024 * 1024))}MB`);
      continue;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      images.push({
        id: makeImageId(),
        name: file.name,
        mimeType: file.type || "image/png",
        bytes: file.size,
        dataUrl,
      });
    } catch {
      errors.push(`${file.name}: failed to read`);
    }
  }

  return { images, errors };
}

export function extractClipboardImageFiles(event: ClipboardEvent): File[] {
  const files: File[] = [];
  const items = event.clipboardData?.items ?? [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file || !file.type.startsWith("image/")) continue;
    files.push(file);
  }
  return files;
}
