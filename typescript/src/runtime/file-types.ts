/**
 * File type checks from a file's first bytes, its name and a declared media type. They read
 * bytes only: nothing here decompresses, opens or renders a file.
 */

/**
 * Which files the host takes: a declared media type must be one below and the leading bytes must
 * match it; executables are refused by name, declared type and content. Pomerado never opens,
 * decompresses or renders a file, so a type is checked, not parsed, and there is no malware
 * scanning.
 */

/** Why a file's type is refused: a type the host does not take, a program, or other bytes. */
export type FileTypeRefusal = "unsupported_type" | "executable" | "content_mismatch";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.byteLength >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(Buffer.from(text, "latin1"));

const pdf = (bytes: Uint8Array) => startsWith(bytes, ascii("%PDF-"));
const png = (bytes: Uint8Array) =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff]);
const gif = (bytes: Uint8Array) =>
  startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"));
const riff = (form: string) => (bytes: Uint8Array) =>
  startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii(form), 8);
const isoMedia =
  (...brands: readonly string[]) =>
  (bytes: Uint8Array) =>
    startsWith(bytes, ascii("ftyp"), 4) &&
    brands.some((brand) => startsWith(bytes, ascii(brand), 8));
const tiff = (bytes: Uint8Array) =>
  startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
const zip = (bytes: Uint8Array) =>
  startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]);
const compoundDocument = (bytes: Uint8Array) =>
  startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const mp3 = (bytes: Uint8Array) =>
  startsWith(bytes, ascii("ID3")) ||
  (bytes.byteLength >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);

/**
 * Text: valid UTF-8 without NUL in the bytes read. The window may end inside a character, so
 * only a complete one is judged.
 */
const text = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
    // error-reporting-allow: parse-predicate bytes the decoder throws on are not text, which is the answer
  } catch {
    return false;
  }
};
const anyContent = () => true;

const ooxml = "application/vnd.openxmlformats-officedocument";
/** Each accepted media type and the check its leading bytes must pass. */
const accepted: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  "application/pdf": pdf,
  "image/png": png,
  "image/jpeg": jpeg,
  "image/gif": gif,
  "image/webp": riff("WEBP"),
  "image/heic": isoMedia("heic", "heix", "mif1", "msf1"),
  "image/heif": isoMedia("heic", "heix", "mif1", "msf1"),
  "image/tiff": tiff,
  "image/bmp": (bytes) => startsWith(bytes, ascii("BM")),
  "audio/mpeg": mp3,
  "audio/wav": riff("WAVE"),
  "video/mp4": isoMedia("isom", "iso2", "mp41", "mp42", "avc1", "M4V "),
  "application/zip": zip,
  [`${ooxml}.wordprocessingml.document`]: zip,
  [`${ooxml}.spreadsheetml.sheet`]: zip,
  [`${ooxml}.presentationml.presentation`]: zip,
  "application/vnd.oasis.opendocument.text": zip,
  "application/vnd.oasis.opendocument.spreadsheet": zip,
  "application/msword": compoundDocument,
  "application/vnd.ms-excel": compoundDocument,
  "application/vnd.ms-powerpoint": compoundDocument,
  "text/plain": text,
  "text/csv": text,
  "text/markdown": text,
  "text/calendar": text,
  "text/xml": text,
  "application/xml": text,
  "application/json": text,
  // Bytes of no particular type; only the executable check applies.
  "application/octet-stream": anyContent,
};

/** Leading bytes of programs a computer runs directly. */
const executableContent = (bytes: Uint8Array) =>
  startsWith(bytes, ascii("MZ")) ||
  startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) ||
  [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ].some((signature) => startsWith(bytes, signature)) ||
  startsWith(bytes, ascii("#!"));

const executableExtensions = new Set([
  "exe",
  "dll",
  "com",
  "scr",
  "msi",
  "msp",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  "cpl",
  "jar",
  "sh",
  "bash",
  "zsh",
  "csh",
  "command",
  "app",
  "pkg",
  "dmg",
  "deb",
  "rpm",
  "apk",
  "appimage",
  "run",
  "elf",
  "so",
  "dylib",
  "lnk",
  "reg",
  "scf",
  "gadget",
  "msc",
  "ipa",
  "xap",
]);
const executableTypes = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-sh",
  "application/x-csh",
  "application/x-msi",
  "application/x-ms-installer",
  "application/vnd.microsoft.portable-executable",
  "application/java-archive",
  "application/x-apple-diskimage",
  "application/vnd.android.package-archive",
  "application/x-bat",
  "text/x-shellscript",
  "application/javascript",
  "text/javascript",
]);

/** A media type as stored: its lowercase type and subtype, parameters dropped. */
export const essenceOf = (mediaType: string) => mediaType.split(";")[0]?.trim().toLowerCase() ?? "";

/** A name or declared type the host refuses outright, before any byte arrives. */
export const declaredRefusal = (name: string, mediaType: string): FileTypeRefusal | undefined => {
  const essence = essenceOf(mediaType);
  const extension = /\.([A-Za-z0-9]{1,16})$/.exec(name)?.[1]?.toLowerCase();
  if (
    executableTypes.has(essence) ||
    (extension !== undefined && executableExtensions.has(extension))
  )
    return "executable";
  return accepted[essence] === undefined ? "unsupported_type" : undefined;
};

/** Whether a file's leading bytes are refused for its declared type. */
export const contentRefusal = (
  mediaType: string,
  leading: Uint8Array,
): FileTypeRefusal | undefined => {
  if (executableContent(leading)) return "executable";
  const matches = accepted[essenceOf(mediaType)];
  if (matches === undefined) return "unsupported_type";
  return matches(leading) ? undefined : "content_mismatch";
};

/** Media types by file extension, for names whose type the caller did not declare. */
const extensionTypes: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  msg: "application/vnd.ms-outlook",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  txt: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  md: "text/markdown",
  rtf: "application/rtf",
  ics: "text/calendar",
  vcf: "text/vcard",
};

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** The media type a name's extension implies, or `application/octet-stream`. */
export const typeOfName = (name: string) =>
  extensionTypes[extensionOf(name)] ?? "application/octet-stream";

/*
 * A download's checks: a program is never moved, and a download is labelled with the type its
 * first bytes prove, else the server's. Only a strong signature proves a type, so text keeps the
 * server's label.
 */

/** A signature: bytes at an offset, `undefined` matching any byte. */
type Signature = readonly [offset: number, bytes: readonly (number | undefined)[]];

/** Names of programs and installers whose bytes need not carry a signature. */
const programExtensions = new Set([
  "apk",
  "app",
  "bat",
  "cmd",
  "com",
  "cpl",
  "dll",
  "exe",
  "jar",
  "msi",
  "ps1",
  "scr",
  "sh",
  "vbs",
]);

/** Types a file's first bytes prove, with every declared type those bytes may carry. */
const knownTypes: readonly {
  readonly type: string;
  readonly signatures: readonly Signature[];
  readonly carries: readonly string[];
}[] = [
  { type: "application/pdf", signatures: [[0, ascii("%PDF-")]], carries: [] },
  {
    type: "image/png",
    signatures: [[0, [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a]]],
    carries: [],
  },
  { type: "image/jpeg", signatures: [[0, [0xff, 0xd8, 0xff]]], carries: ["image/jpg"] },
  { type: "image/gif", signatures: [[0, ascii("GIF87a")], [0, ascii("GIF89a")]], carries: [] },
  {
    type: "image/webp",
    signatures: [[0, [...ascii("RIFF"), undefined, undefined, undefined, undefined, ...ascii("WEBP")]]],
    carries: [],
  },
  {
    type: "image/tiff",
    signatures: [
      [0, [0x49, 0x49, 0x2a, 0x00]],
      [0, [0x4d, 0x4d, 0x00, 0x2a]],
    ],
    carries: [],
  },
  { type: "image/heic", signatures: [[4, ascii("ftypheic")], [4, ascii("ftypmif1")]], carries: ["image/heif"] },
  {
    type: "application/zip",
    signatures: [[0, ascii("PK\x03\x04")], [0, ascii("PK\x05\x06")]],
    // Office and other formats that are zip containers.
    carries: [
      "application/x-zip-compressed",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/epub+zip",
    ],
  },
  { type: "application/gzip", signatures: [[0, [0x1f, 0x8b]]], carries: ["application/x-gzip"] },
  {
    type: "application/x-cfb",
    signatures: [[0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]]],
    // Legacy Office documents and Outlook messages share the compound file format.
    carries: [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.ms-outlook",
    ],
  },
  { type: "application/vnd.rar", signatures: [[0, ascii("Rar!\x1a\x07")]], carries: ["application/x-rar-compressed"] },
  {
    type: "application/x-7z-compressed",
    signatures: [[0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]]],
    carries: [],
  },
];

const matches = (bytes: Uint8Array, [offset, expected]: Signature) =>
  bytes.length >= offset + expected.length &&
  expected.every((byte, index) => byte === undefined || bytes[offset + index] === byte);

/** Whether the bytes or the name make the file a program, which the host never moves. */
export const isProgram = (bytes: Uint8Array, name: string) =>
  executableContent(bytes) || programExtensions.has(extensionOf(name));

/** The type the file's first bytes prove, if they prove one. */
export const sniffedType = (bytes: Uint8Array): string | undefined =>
  knownTypes.find(({ signatures }) => signatures.some((signature) => matches(bytes, signature)))
    ?.type;

/**
 * Whether the bytes may be the declared type. Bytes that prove a type must be that type or one it
 * carries (a zip may be a .docx), unless the declaration is the generic octet stream. A type with a
 * signature that the bytes lack is refused, so a "PDF" whose bytes are not a PDF is not one. A type
 * without a signature, such as text or CSV, is taken as declared.
 */
export const bytesMatchType = (bytes: Uint8Array, declared: string) => {
  const type = essenceOf(declared);
  if (type === "application/octet-stream") return true;
  const sniffed = knownTypes.find(({ signatures }) =>
    signatures.some((signature) => matches(bytes, signature)),
  );
  if (sniffed !== undefined) return sniffed.type === type || sniffed.carries.includes(type);
  return !knownTypes.some((known) => known.type === type || known.carries.includes(type));
};

/**
 * Whether a file input's `accept` attribute takes a file with this name and media type: an
 * empty attribute takes any file; otherwise one entry must match, an extension such as `.pdf`
 * against the name, `image/*` against the type's top level, or a full media type. It uses
 * nothing outside itself, so the host's page code runs this same function (`acceptsSource`).
 */
export const accepts = (
  accept: string,
  file: { readonly name: string; readonly mediaType: string },
): boolean => {
  const entries = accept
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return true;
  const type = (file.mediaType.split(";")[0] ?? "").trim().toLowerCase();
  const name = file.name.toLowerCase();
  return entries.some((entry) =>
    entry.startsWith(".")
      ? name.endsWith(entry)
      : entry.endsWith("/*")
        ? type.startsWith(entry.slice(0, -1))
        : entry === type,
  );
};

/** `accepts` as JavaScript source, for page code that checks an input's `accept` itself. */
export const acceptsSource = accepts.toString();
