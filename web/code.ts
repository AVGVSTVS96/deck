import { Editor, type EditorFactory } from "@pierre/diffs/edit";
import type { FileDiffOptions, FileOptions } from "@pierre/diffs/react";

export const createEditor: EditorFactory<undefined, undefined> = (type, options, key) => new Editor(type, options, key);

const shared = {
  theme: { light: "pierre-light", dark: "pierre-dark" },
  themeType: "system",
  overflow: "wrap",
  disableFileHeader: true,
} as const;

export const fileOptions: FileOptions<undefined, undefined> = shared;
export const diffOptions: FileDiffOptions<undefined, undefined> = { ...shared, diffStyle: "unified", lineDiffType: "word" };
