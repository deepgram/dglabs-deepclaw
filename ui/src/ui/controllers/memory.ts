import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  MemoryFileEntry,
  MemoryFilesGetResult,
  MemoryFilesListResult,
  MemoryFilesSetResult,
} from "../types.ts";

export type MemoryState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  memoryLoading: boolean;
  memoryError: string | null;
  memoryFilesList: MemoryFilesListResult | null;
  memoryFileContents: Record<string, string>;
  memoryFileDrafts: Record<string, string>;
  memoryFileActive: string | null;
  memorySaving: boolean;
};

function mergeFileEntry(
  list: MemoryFilesListResult | null,
  entry: MemoryFileEntry,
): MemoryFilesListResult | null {
  if (!list) {
    return list;
  }
  const hasEntry = list.files.some((file) => file.name === entry.name);
  const nextFiles = hasEntry
    ? list.files.map((file) => (file.name === entry.name ? entry : file))
    : [...list.files, entry];
  return { ...list, files: nextFiles };
}

export async function loadMemoryFiles(state: MemoryState) {
  if (!state.client || !state.connected || state.memoryLoading) {
    return;
  }
  state.memoryLoading = true;
  state.memoryError = null;
  try {
    const res = await state.client.request<MemoryFilesListResult | null>("memory.files.list", {});
    if (res) {
      state.memoryFilesList = res;
      if (
        state.memoryFileActive &&
        !res.files.some((file) => file.name === state.memoryFileActive)
      ) {
        state.memoryFileActive = null;
      }
    }
  } catch (err) {
    state.memoryError = String(err);
  } finally {
    state.memoryLoading = false;
  }
}

export async function loadMemoryFileContent(state: MemoryState, name: string) {
  if (!state.client || !state.connected || state.memoryLoading) {
    return;
  }
  if (Object.hasOwn(state.memoryFileContents, name)) {
    return;
  }
  state.memoryLoading = true;
  state.memoryError = null;
  try {
    const res = await state.client.request<MemoryFilesGetResult | null>("memory.files.get", {
      name,
    });
    if (res?.file) {
      const content = res.file.content ?? "";
      state.memoryFilesList = mergeFileEntry(state.memoryFilesList, res.file);
      state.memoryFileContents = { ...state.memoryFileContents, [name]: content };
      if (!Object.hasOwn(state.memoryFileDrafts, name)) {
        state.memoryFileDrafts = { ...state.memoryFileDrafts, [name]: content };
      }
    }
  } catch (err) {
    state.memoryError = String(err);
  } finally {
    state.memoryLoading = false;
  }
}

export async function saveMemoryFile(state: MemoryState, name: string, content: string) {
  if (!state.client || !state.connected || state.memorySaving) {
    return;
  }
  state.memorySaving = true;
  state.memoryError = null;
  try {
    const res = await state.client.request<MemoryFilesSetResult | null>("memory.files.set", {
      name,
      content,
    });
    if (res?.file) {
      state.memoryFilesList = mergeFileEntry(state.memoryFilesList, res.file);
      state.memoryFileContents = { ...state.memoryFileContents, [name]: content };
      state.memoryFileDrafts = { ...state.memoryFileDrafts, [name]: content };
    }
  } catch (err) {
    state.memoryError = String(err);
  } finally {
    state.memorySaving = false;
  }
}
