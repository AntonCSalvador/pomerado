import { expect, it } from "vitest";
import {
  accepts,
  acceptsSource,
  bytesMatchType,
  contentRefusal,
  declaredRefusal,
  isProgram,
  sniffedType,
  typeOfName,
} from "../../src/runtime/file-types.js";

const bytes = (...parts: readonly (string | readonly number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((character) => character.charCodeAt(0)) : [...part],
    ),
  );
const pdf = bytes("%PDF-1.7\n");
const png = bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const zip = bytes("PK", [3, 4, 20, 0]);
const text = bytes("date,amount\n2026-01-02,12.50\n");

it.each([
  { file: pdf, type: "application/pdf" },
  { file: png, type: "image/png" },
  { file: bytes([0xff, 0xd8, 0xff, 0xe0]), type: "image/jpeg" },
  { file: bytes("RIFF", [1, 2, 3, 4], "WEBP"), type: "image/webp" },
  { file: zip, type: "application/zip" },
  { file: text, type: undefined },
  { file: bytes("%PD"), type: undefined },
  { file: bytes("BM", [0x36, 0, 0, 0]), type: "image/bmp" },
  { file: bytes("ID3", [4, 0]), type: "audio/mpeg" },
  { file: bytes("RIFF", [1, 2, 3, 4], "WAVE"), type: "audio/wav" },
  { file: bytes([0, 0, 0, 0x18], "ftypisom"), type: "video/mp4" },
  // Archives the host does not take prove no type.
  { file: bytes([0x1f, 0x8b, 8, 0]), type: undefined },
  { file: bytes("Rar!", [0x1a, 0x07, 0]), type: undefined },
])("first bytes prove $type", ({ file, type }) => {
  expect(sniffedType(file)).toBe(type);
});

it.each([
  { file: pdf, declared: "application/pdf", ok: true },
  { file: pdf, declared: "Application/PDF; charset=binary", ok: true },
  { file: pdf, declared: "application/octet-stream", ok: true },
  // A zip container may be an Office document.
  {
    file: zip,
    declared: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ok: true,
  },
  // Bytes that prove one type are not another.
  { file: png, declared: "application/pdf", ok: false },
  { file: png, declared: "text/csv", ok: false },
  // A type with a signature needs it.
  { file: text, declared: "application/pdf", ok: false },
  { file: text, declared: "image/png", ok: false },
  // Text has no signature: any UTF-8 without NUL is taken as declared.
  { file: text, declared: "text/csv", ok: true },
  { file: bytes([0xff, 0xfe, 0x00, 0x41]), declared: "text/csv", ok: false },
  // A type the host does not take is never the file's.
  { file: bytes([0x1f, 0x8b, 8, 0]), declared: "application/gzip", ok: false },
  { file: text, declared: "text/html", ok: false },
  { file: bytes("ID3", [4, 0]), declared: "audio/mpeg", ok: true },
])("bytes against declared $declared: $ok", ({ file, declared, ok }) => {
  expect(bytesMatchType(file, declared)).toBe(ok);
});

it.each([
  { file: bytes("MZ", [0x90, 0]), name: "report.pdf", program: true },
  { file: bytes([0x7f], "ELF", [2, 1]), name: "data", program: true },
  { file: bytes([0xcf, 0xfa, 0xed, 0xfe]), name: "tool", program: true },
  { file: bytes("#!/bin/sh\necho hi\n"), name: "notes.txt", program: true },
  { file: text, name: "setup.EXE", program: true },
  { file: text, name: "install.sh", program: true },
  { file: text, name: "bundle.js", program: true },
  { file: text, name: "Setup.DMG", program: true },
  { file: pdf, name: "report.pdf", program: false },
  { file: text, name: "export.csv", program: false },
])("a program is refused whatever its name: $name", ({ file, name, program }) => {
  expect(isProgram(file, name)).toBe(program);
});

it.each([
  { accept: "", name: "a.bin", type: "application/octet-stream", ok: true },
  { accept: ".pdf,.png", name: "Scan.PDF", type: "application/pdf", ok: true },
  { accept: "image/*", name: "photo.jpg", type: "image/jpeg", ok: true },
  { accept: "image/*", name: "report.pdf", type: "application/pdf", ok: false },
  { accept: "application/pdf", name: "report", type: "application/pdf", ok: true },
  { accept: " .csv , text/plain ", name: "a.txt", type: "text/plain", ok: true },
  { accept: ".csv", name: "a.txt", type: "text/plain", ok: false },
])("accept $accept takes $name: $ok", ({ accept, name, type, ok }) => {
  expect(accepts(accept, { name, mediaType: type })).toBe(ok);
});

it("names give a media type, else the generic octet stream", () => {
  expect(typeOfName("statement.CSV")).toBe("text/csv");
  expect(typeOfName("song.mp3")).toBe("audio/mpeg");
  expect(typeOfName("memo.wav")).toBe("audio/wav");
  expect(typeOfName("clip.mp4")).toBe("video/mp4");
  expect(typeOfName("scan.bmp")).toBe("image/bmp");
  expect(typeOfName("archive")).toBe("application/octet-stream");
  expect(typeOfName(".pdf")).toBe("application/octet-stream");
});

it("the page code's accept check is the same function", () => {
  const pageAccepts = new Function(`return (${acceptsSource});`)() as typeof accepts;
  for (const [accept, name, mediaType] of [
    [".pdf", "a.PDF", "application/pdf"],
    ["image/*", "a.pdf", "application/pdf"],
    ["text/plain", "a.txt", "text/plain; charset=utf-8"],
  ] as const)
    expect(pageAccepts(accept, { name, mediaType })).toBe(accepts(accept, { name, mediaType }));
});

// The host takes these types, refusing a program by name, declared type or content.
it.each([
  { name: "archive.gz", type: "application/gzip", refusal: "unsupported_type" },
  { name: "book.epub", type: "application/epub+zip", refusal: "unsupported_type" },
  { name: "page.html", type: "text/html", refusal: "unsupported_type" },
  { name: "setup.exe", type: "application/octet-stream", refusal: "executable" },
  { name: "report.pdf", type: "application/x-sh", refusal: "executable" },
  { name: "report.pdf", type: "Application/PDF; charset=binary", refusal: undefined },
  { name: "song.mp3", type: "audio/mpeg", refusal: undefined },
  { name: "memo.doc", type: "application/msword", refusal: undefined },
])("declared $name as $type: $refusal", ({ name, type, refusal }) => {
  expect(declaredRefusal(name, type)).toBe(refusal);
});

it.each([
  { type: "application/pdf", file: pdf, refusal: undefined },
  { type: "application/pdf", file: bytes("MZ", [0x90, 0]), refusal: "executable" },
  { type: "image/png", file: pdf, refusal: "content_mismatch" },
  { type: "image/bmp", file: bytes("BM", [0x36, 0]), refusal: undefined },
  { type: "video/mp4", file: bytes([0, 0, 0, 0x18], "ftypmp42"), refusal: undefined },
  { type: "application/octet-stream", file: bytes([0x1f, 0x8b, 8, 0]), refusal: undefined },
  { type: "application/gzip", file: bytes([0x1f, 0x8b, 8, 0]), refusal: "unsupported_type" },
])("content of $type: $refusal", ({ type, file, refusal }) => {
  expect(contentRefusal(type, file)).toBe(refusal);
});
