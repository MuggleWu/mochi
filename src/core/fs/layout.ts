/**
 * 应用私有目录的布局。
 *
 * 平铺保真：`notes/` 下的文件名 = 仓库根目录的文件名（含 `.md`）。
 * 实测依据：真实仓库根目录 10,076 个文件，非法字符 0、折叠重名 0、
 * 最长 180 字节 —— 平铺无需改名或转义。
 */
export const NOTES_DIR = 'notes';
export const TRASH_DIR = 'trash';
export const STATE_DIR = 'state';

export const MANIFEST_FILE = `${STATE_DIR}/manifest.json`;
export const META_FILE = `${STATE_DIR}/meta.json`;
export const GRAMS_FILE = `${STATE_DIR}/grams.bin`;

export const noteFile = (path: string): string => `${NOTES_DIR}/${path}`;
export const trashFile = (name: string): string => `${TRASH_DIR}/${name}`;
